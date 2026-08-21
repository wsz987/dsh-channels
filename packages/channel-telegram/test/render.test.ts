/**
 * Renderer + formatting-fallback + segmentation tests (plan §20.2 / §20.6–§20.9).
 *
 * Covers the mandatory release-gate matrix: Rich Markdown payload, HTML payload,
 * MarkdownV2 escaping, plain fallback, format-error classifier, 401/403 NOT
 * falling back, 429 retry_after, network/5xx NOT in plain fallback, fallback at
 * most once with no infinite loop, rich 32768 / regular 4096 / caption 1024
 * segmentation, emoji/ZWJ graphemes, code fence, table, nested list, links and
 * unfinished/partial Markdown.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  TelegramApiError,
  classifyTelegramError,
  sendWithFallback,
  renderMessage,
  render,
  RICH_MESSAGE_MAX_UTF8,
  REGULAR_MESSAGE_MAX,
  CAPTION_MAX,
} from '../src/index.ts';
import { splitByGraphemes, truncateGraphemes, utf8Length, visibleLength } from '../src/render/segment.ts';
import { renderRichMarkdown } from '../src/render/markdown.ts';
import { escapeMarkdownV2, renderPlain, renderPlainCaption } from '../src/render/plain.ts';
import { renderHtml, safeHtmlSplit, escapeHtml } from '../src/render/html.ts';
import { makePreview } from '../src/streaming-reply.ts';

describe('formatting-error classifier', () => {
  it('classifies Telegram error codes into stable kinds', () => {
    expect(classifyTelegramError(400, "can't parse entities: bad entity")).toBe('format');
    expect(classifyTelegramError(400, undefined)).toBe('upstream');
    expect(classifyTelegramError(400, 'Bad Request: chat not found')).toBe('upstream');
    expect(classifyTelegramError(401, 'Unauthorized')).toBe('auth');
    expect(classifyTelegramError(403, 'Forbidden: bot was kicked')).toBe('permission');
    expect(classifyTelegramError(429, 'Too Many Requests')).toBe('rate-limit');
    expect(classifyTelegramError(500, 'Internal')).toBe('upstream');
    expect(classifyTelegramError(502, 'Bad Gateway')).toBe('upstream');
    expect(classifyTelegramError(undefined, undefined)).toBe('upstream');
  });

  it('treats retry_after as the rate-limit signal above a plain code', () => {
    expect(classifyTelegramError(400, 'Too Many Requests', { retryAfter: 30 })).toBe('rate-limit');
    expect(classifyTelegramError(undefined, undefined, { retryAfter: 5 })).toBe('rate-limit');
  });

  it('TelegramApiError preserves error_code / description / parameters', () => {
    const err = new TelegramApiError({
      method: 'sendMessage',
      errorCode: 429,
      description: 'Too Many Requests: retry after 10',
      parameters: { retryAfter: 10 },
    });
    expect(err.kind).toBe('rate-limit');
    expect(err.errorCode).toBe(429);
    expect(err.description).toContain('retry after 10');
    expect(err.parameters?.retryAfter).toBe(10);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('Rich Markdown payload', () => {
  it('explicit rich-markdown renders to a rich plan with markdown source', () => {
    const plan = renderMessage('## Hi\n\n**bold**', { mode: 'rich-markdown' });
    expect(plan.kind).toBe('rich');
    if (plan.kind === 'rich') {
      expect(plan.mode).toBe('rich-markdown');
      expect(plan.texts.join(' ')).toContain('Hi');
    }
  });

  it('auto selects Rich Markdown for the Bot API 10.2 baseline', () => {
    expect(renderMessage('## Hi', { mode: 'auto' })).toMatchObject({
      kind: 'rich',
      mode: 'rich-markdown',
    });
  });

  it('keeps a fenced code block whole (language + fences)', () => {
    const rich = renderRichMarkdown('```typescript\nconst x = 1;\n```');
    expect(rich.length).toBeGreaterThan(0);
    const joined = rich.join('');
    expect(joined).toContain('```typescript');
    expect(joined).toContain('const x = 1;');
  });

  it('keeps a table as whole rows (header + separator + rows)', () => {
    const rich = renderRichMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
    const joined = rich.join('\n');
    expect(joined).toContain('| A | B |');
    expect(joined).toContain('| 1 | 2 |');
  });

  it('preserves nested lists and links in paragraphs', () => {
    const rich = renderRichMarkdown('- one\n- two\n\n[link](https://example.com)');
    const joined = rich.join('\n');
    expect(joined).toMatch(/[*-] one/);
    expect(joined).toMatch(/[*-] two/);
    expect(joined).toContain('[link](https://example.com)');
  });

  it('does not throw on unfinished/partial markdown (unclosed fence, partial table/link)', () => {
    const partials = [
      '```typescript\nfunction test() {\n', // unclosed fence
      '| A | B |\n|---', // unfinished table
      '[link](', // unfinished link
      '**bold', // unfinished emphasis
      '<code', // unfinished inline marker
    ];
    for (const src of partials) {
      expect(() => renderRichMarkdown(src)).not.toThrow();
      expect(() => renderHtml(src)).not.toThrow();
      expect(() => renderPlain(src)).not.toThrow();
    }
  });
});

describe('HTML payload + MarkdownV2 escaping', () => {
  it('renders an HTML plan with parse mode and escapes raw < > &', () => {
    const plan = renderMessage('**b** <raw> a&b', { mode: 'html' });
    expect(plan.kind).toBe('regular');
    if (plan.kind === 'regular') {
      expect(plan.parseMode).toBe('HTML');
      expect(plan.chunks.join(' ')).toContain('&lt;raw&gt;');
      expect(plan.chunks.join(' ')).toContain('a&amp;b');
    }
  });

  it('escapeHtml escapes the three Telegram HTML metacharacters', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  it('safeHtmlSplit never splits a tag or entity across chunks', () => {
    const html = '<b>bold</b> &amp; <i>more</i>';
    const chunks = safeHtmlSplit(html, 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
      expect(chunk).not.toMatch(/<[^>]*$/);
      expect(chunk).not.toMatch(/&(?!(?:amp|lt|gt|quot);)/);
    }
  });

  it('escapes every MarkdownV2 special character', () => {
    const out = escapeMarkdownV2('a_b *x* [y](z) #tag');
    expect(out).toContain('a\\_b');
    expect(out).toContain('\\*x\\*');
    expect(out).toContain('\\[y\\]\\(z\\)');
    expect(out).toContain('#tag');
  });

  it('renderMarkdownV2 returns escaped chunks with parse mode', () => {
    const plan = renderMessage('**bold** _it_', { mode: 'markdown-v2' });
    expect(plan.kind).toBe('regular');
    if (plan.kind === 'regular') {
      expect(plan.parseMode).toBe('MarkdownV2');
      expect(plan.chunks.join('')).toContain('\\*\\*bold\\*\\*');
      expect(plan.chunks.join('')).toContain('\\_it\\_');
    }
  });
});

describe('plain fallback', () => {
  it('strips markdown markup to plain text', () => {
    const plan = renderMessage('**bold** `code` [link](https://x) # h', { mode: 'plain' });
    expect(plan.kind).toBe('regular');
    if (plan.kind === 'regular') {
      expect(plan.parseMode).toBeUndefined();
      const joined = plan.chunks.join(' ');
      expect(joined).toContain('bold');
      expect(joined).not.toContain('**');
    }
  });

  it('caption fallback is limited to 1024 graphemes', () => {
    const chunks = renderPlainCaption('x'.repeat(3000));
    for (const c of chunks) expect(visibleLength(c)).toBeLessThanOrEqual(CAPTION_MAX);
    expect(chunks.join('')).toHaveLength(3000);
  });
});

describe('segmentation gates', () => {
  it('splits regular text at 4096 grapheme clusters', () => {
    const chunks = splitByGraphemes('a'.repeat(10000), REGULAR_MESSAGE_MAX);
    for (const c of chunks) expect(visibleLength(c)).toBeLessThanOrEqual(REGULAR_MESSAGE_MAX);
    expect(chunks.join('')).toHaveLength(10000);
  });

  it('splits rich markdown so no message exceeds 32768', () => {
    const rich = renderRichMarkdown('p'.repeat(RICH_MESSAGE_MAX_UTF8 + 1000), RICH_MESSAGE_MAX_UTF8);
    expect(rich).toHaveLength(2);
    for (const text of rich) expect(utf8Length(text)).toBeLessThanOrEqual(RICH_MESSAGE_MAX_UTF8);
  });

  it('measures the rich limit in UTF-8 bytes without cutting emoji graphemes', () => {
    const emoji = '👨‍👩‍👧‍👦';
    const rich = renderRichMarkdown(emoji.repeat(100), 100);
    for (const text of rich) expect(utf8Length(text)).toBeLessThanOrEqual(100);
    expect(rich.join('')).toBe(emoji.repeat(100));
  });

  it('never splits a ZWJ family emoji or flag across chunks', () => {
    const family = '👨‍👩‍👧‍👦';
    const flag = '🇯🇵';
    const chunks = splitByGraphemes(family + flag, 1);
    expect(chunks).toEqual([family, flag]);
  });

  it('truncateGraphemes never cuts a grapheme cluster', () => {
    const family = '👨‍👩‍👧‍👦';
    const truncated = truncateGraphemes(`a${family}b`, 2);
    // 'a' is one grapheme; the family emoji is the second; 'b' is cut whole.
    expect(truncated).toBe(`a${family}`);
  });
});

describe('sendWithFallback', () => {
  it('falls back to plain exactly once on a format error', async () => {
    let calls = 0;
    const kinds: Array<{ kind: string }> = [];
    const send = vi.fn(async (plan: unknown) => {
      calls += 1;
      if (calls === 1) {
        throw new TelegramApiError({ method: 'send', kind: 'format', description: 'entity too long' });
      }
      // Second (plain) call succeeds.
      return { delivered: true };
    });
    await sendWithFallback('**x**', { mode: 'rich-markdown' }, send);
    expect(calls).toBe(2);
  });

  it('does not fall back on 401 / 403 / 429 / network / 5xx', async () => {
    for (const kind of ['auth', 'permission', 'rate-limit', 'network', 'upstream']) {
      const send = vi.fn(async () => {
        throw new TelegramApiError({ method: 'send', kind: kind as never, description: kind });
      });
      await expect(sendWithFallback('x', { mode: 'auto' }, send)).rejects.toBeInstanceOf(TelegramApiError);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('does not infinite-retry when the plain fallback itself fails', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      throw new TelegramApiError({ method: 'send', kind: 'format', description: 'still bad' });
    });
    await expect(sendWithFallback('x', { mode: 'rich-markdown' }, send)).rejects.toBeInstanceOf(TelegramApiError);
    // exactly one retry — no rich→plain→rich loop.
    expect(calls).toBe(2);
  });

  it('throws immediately when already in plain mode (no fallback)', async () => {
    const send = vi.fn(async () => {
      throw new TelegramApiError({ method: 'send', kind: 'format', description: 'bad' });
    });
    await expect(sendWithFallback('x', { mode: 'plain' }, send)).rejects.toBeInstanceOf(TelegramApiError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('streaming preview keeps updating beyond 4096', () => {
  it('returns a rolling tail preview once the text exceeds the limit', () => {
    const short = makePreview('short', REGULAR_MESSAGE_MAX);
    expect(short).toBe('short');
    const tail = 'z'.repeat(100);
    const long = makePreview('x'.repeat(4096) + tail, REGULAR_MESSAGE_MAX);
    expect(long).toContain(tail);
    expect(long.startsWith('…')).toBe(true);
    expect(long).not.toContain('x'.repeat(4000)); // not the frozen head
  });

  it('preview changes as new tail text arrives', () => {
    const p1 = makePreview('a'.repeat(4096) + '111', REGULAR_MESSAGE_MAX);
    const p2 = makePreview('a'.repeat(4096) + '222', REGULAR_MESSAGE_MAX);
    expect(p1).not.toBe(p2);
  });
});

describe('render module surface', () => {
  it('exports the render namespace helpers', () => {
    expect(render.renderMessage).toBeTypeOf('function');
    expect(render.sendWithFallback).toBeTypeOf('function');
    expect(renderMessage).toBeTypeOf('function');
  });
});
