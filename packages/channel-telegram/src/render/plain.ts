/**
 * Plain fallback + MarkdownV2 escaping renderers (plan §5.3 / §20.9).
 *
 * - `renderPlain(source)`   — best-effort plain-text fallback, segmented at the
 *   regular 4096 grapheme-safe limit. Used when a rich/formatted send fails
 *   with a *format* error (and only then).
 * - `renderPlainCaption()`  — the 1024-caption variant.
 * - `escapeMarkdownV2(...)` — full escaping of MarkdownV2 special characters.
 *   The adapter NEVER sends raw Agent Markdown as MarkdownV2
 *   (plan §5.3 red line); a `markdown-v2` config mode must pass every literal
 *   through this escape first.
 *
 * The plain fallback is deliberately structural: it strips Markdown markup so
 * the user still sees readable text (headers, bold, code) instead of raw
 * `**`/`#`/backticks, while never throwing on unfinished Markdown.
 */
import { tokenizeMarkdown, type MarkdownBlock } from './markdown.js';
import { splitByGraphemes } from './segment.js';
import { CAPTION_MAX, REGULAR_MESSAGE_MAX } from '../rich-message.js';

/** Strip inline Markdown from a single line/paragraph. */
export function inlineMarkdownToPlain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** Render one block to plain text. */
export function blockToPlain(block: MarkdownBlock): string {
  switch (block.kind) {
    case 'heading':
      return block.text;
    case 'code':
      return block.code;
    case 'table':
      return [
        `| ${block.header.join(' | ')} |`,
        ...block.rows.map((row) => `| ${row.join(' | ')} |`),
      ].join('\n');
    case 'blockquote':
      return block.content.split('\n').map((line) => `> ${line}`).join('\n');
    case 'list':
      return block.items
        .map((item, idx) => `${block.ordered ? `${idx + 1}.` : '-'} ${inlineMarkdownToPlain(item)}`)
        .join('\n');
    case 'paragraph':
      return inlineMarkdownToPlain(block.text);
  }
}

/** Convert Markdown source to a single plain-text string. */
export function markdownToPlain(source: string): string {
  if (source.length === 0) return '';
  return tokenizeMarkdown(source)
    .map(blockToPlain)
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** Segment plain text into ≤ `limit` grapheme chunks. */
export function segmentPlain(text: string, limit = REGULAR_MESSAGE_MAX): string[] {
  return splitByGraphemes(text, limit);
}

/** Plain fallback for regular messages (4096). */
export function renderPlain(source: string, limit = REGULAR_MESSAGE_MAX): string[] {
  if (source.length === 0) return [];
  return segmentPlain(markdownToPlain(source), limit);
}

/** Plain fallback for media captions (1024). */
export function renderPlainCaption(source: string, limit = CAPTION_MAX): string[] {
  if (source.length === 0) return [''];
  const chunks = segmentPlain(markdownToPlain(source), limit);
  return chunks.length > 0 ? chunks : [''];
}

/** Characters Telegram's MarkdownV2 parser reserves; each must be escaped. */
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/**
 * Escape a piece of literal text for Telegram MarkdownV2 so it cannot be
 * interpreted as formatting. This is the ONLY sanctioned way to send Agent
 * Markdown in `markdown-v2` mode — never pass raw Agent Markdown as the body.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL, '\\$&');
}

/**
 * Render MarkdownV2-escaped chunks. `markdown-v2` is an expert-compat mode:
 * the RAW Agent Markdown is fully escaped so Telegram never interprets it as
 * formatting (plan §5.3 red line — never send raw Agent Markdown as a
 * MarkdownV2 body). The visible text keeps its original markdown source.
 */
export function renderMarkdownV2(source: string, limit = REGULAR_MESSAGE_MAX): string[] {
  if (source.length === 0) return [];
  return splitByGraphemes(escapeMarkdownV2(source), limit);
}
