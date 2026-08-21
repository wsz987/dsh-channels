/**
 * Renderer entry point (plan §Phase 2 / §20.9).
 *
 * `renderMessage(source, options)` turns Agent Markdown into a concrete
 * outbound plan for one of the configured output modes. The plan is consumed by
 * the adapter's buffered send path and by the rich streaming final edit — it
 * never touches the network.
 *
 * The formatting fallback is contained here too: `sendWithFallback` tries the
 * requested mode once and, ONLY on a `format`-kind `TelegramApiError`, retries
 * the same content once as plain text. 401/403 / 429 / network / 5xx are never
 * treated as a formatting problem (plan §20.9), so there is no infinite
 * rich→plain→rich loop.
 */
import type { TelegramApiError } from '../api-error.js';
import { renderRichMarkdown } from './markdown.js';
import { renderHtml } from './html.js';
import { renderMarkdownV2, renderPlain, renderPlainCaption } from './plain.js';

export type RenderMode = 'auto' | 'rich-markdown' | 'html' | 'markdown-v2' | 'plain';

/** A concrete, ready-to-send outbound plan for one message. */
export type RenderPlan =
  | { kind: 'rich'; mode: Extract<RenderMode, 'auto' | 'rich-markdown'>; texts: string[] }
  | {
      kind: 'regular';
      mode: Exclude<RenderMode, 'auto' | 'rich-markdown'>;
      parseMode?: 'HTML' | 'MarkdownV2';
      chunks: string[];
    };

export interface RenderOptions {
  mode: RenderMode;
  /** Produce a caption-sized plan (1024) instead of the regular 4096. */
  forCaption?: boolean;
}

/** Resolve the default renderer for the adapter's Bot API 10.2 baseline. */
export function resolveMode(mode: RenderMode): Exclude<RenderMode, 'auto'> {
  if (mode === 'auto') return 'rich-markdown';
  return mode;
}

/**
 * Render Markdown source to a plan for the given mode.
 *
 * - `plain`:   plain fallback, 4096 (or 1024 caption) grapheme segments.
 * - `html`:    Telegram-safe HTML, 4096, tags/entities never split.
 * - `markdown-v2`: fully escaped MarkdownV2, 4096.
 * - `rich-markdown`: block-aware Rich Message markdown, 32768 UTF-8 bytes.
 * - `auto`: Rich Markdown (the adapter requires Bot API 10.2 or newer).
 */
export function renderMessage(source: string, options: RenderOptions): RenderPlan {
  const mode = resolveMode(options.mode);
  if (mode === 'plain') {
    const texts = options.forCaption ? renderPlainCaption(source) : renderPlain(source);
    return { kind: 'regular', mode: 'plain', chunks: texts };
  }
  if (mode === 'html') {
    return { kind: 'regular', mode: 'html', parseMode: 'HTML', chunks: renderHtml(source) };
  }
  if (mode === 'markdown-v2') {
    return {
      kind: 'regular',
      mode: 'markdown-v2',
      parseMode: 'MarkdownV2',
      chunks: renderMarkdownV2(source),
    };
  }
  // rich-markdown
  return { kind: 'rich', mode: 'rich-markdown', texts: renderRichMarkdown(source) };
}

/**
 * Whether an error is a formatting failure that warrants a one-shot plain
 * fallback. Only `format`-kind `TelegramApiError`s qualify; everything else
 * (401/403 / 429 / network / 5xx) propagates (plan §20.9).
 */
export function isFormattingFailure(error: unknown): error is TelegramApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'format'
  );
}

export type SendPlan = (plan: RenderPlan) => Promise<unknown>;

/**
 * Send a rendered plan with exactly-once formatting fallback:
 *
 * - try the requested mode;
 * - if it throws a `format`-kind error and the requested mode was not already
 *   plain, retry the SAME content once as plain text;
 * - any other error, or a format error on the plain retry, rethrows unchanged.
 *
 * This guarantees the fallback runs at most once and can never enter an
 * infinite rich→plain→rich loop.
 */
export async function sendWithFallback(source: string, options: RenderOptions, send: SendPlan): Promise<unknown> {
  const requested = resolveMode(options.mode);
  const first = renderMessage(source, options);
  try {
    return await send(first);
  } catch (error) {
    if (!isFormattingFailure(error)) throw error;
    // Only downgrade if we weren't already plain.
    if (requested === 'plain') throw error;
    const plain = renderMessage(source, { ...options, mode: 'plain' });
    return await send(plain);
  }
}
