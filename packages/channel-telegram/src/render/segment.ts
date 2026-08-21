/**
 * Unicode-safe segmentation helpers (execution plan §7.2 / §20.8).
 *
 * The legacy splitter (`Array.from(text)` + code-point slicing in the streaming
 * reply) can cut a grapheme cluster (emoji ZWJ sequences, flags, variation
 * selectors, combining marks) in the middle, producing broken glyphs and, worse,
 * breaking a Markdown code fence / table row mid-stream.
 *
 * This module is the single place that performs caller-visible character math
 * for fallback/plain output. It uses `Intl.Segmenter(grapheme)` so a user-visible
 * character never spans two messages.
 */
import {
  CAPTION_MAX,
  REGULAR_MESSAGE_MAX,
  RICH_MESSAGE_MAX_UTF8,
} from '../rich-message.js';

let segmenter: Intl.Segmenter | undefined;

/** Lazily-built, shared grapheme segmenter (Node >= 16 has Intl.Segmenter). */
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((s) => s.segment);
}

const encoder = new TextEncoder();

/** UTF-8 byte length used by Telegram Rich Message limits. */
export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Split by UTF-8 byte budget without cutting a grapheme cluster. */
export function splitByUtf8Graphemes(text: string, maxBytes: number): string[] {
  if (text.length === 0) return [];
  if (maxBytes <= 0) return [text];
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const grapheme of graphemes(text)) {
    const bytes = utf8Length(grapheme);
    if (current && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    if (bytes > maxBytes) {
      if (current) chunks.push(current);
      chunks.push(grapheme);
      current = '';
      currentBytes = 0;
      continue;
    }
    current += grapheme;
    currentBytes += bytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Total visible length of `text` in grapheme clusters (not code points). Used
 * for the caption / regular rich-message length gates.
 */
export function visibleLength(text: string): number {
  return graphemes(text).length;
}

/**
 * Split `text` into chunks not exceeding `maxLength` grapheme clusters.
 *
 * Guarantees:
 * - no chunk exceeds `maxLength` grapheme clusters
 * - never cuts a grapheme cluster in half
 * - joins graphemes back into the original text in order
 */
export function splitByGraphemes(text: string, maxLength: number): string[] {
  if (maxLength <= 0) return text.length === 0 ? [] : [text];
  if (text.length === 0) return [];
  return splitGraphemeList(graphemes(text), maxLength).map((list) => list.join(''));
}

/**
 * Split an already-linearized grapheme array into chunks of at most `maxLength`
 * clusters. This is the low-level primitive used by the block-aware renderer
 * (which works over logical text ranges, not arbitrary code-point slices).
 */
export function splitGraphemeList(graphemeList: string[], maxLength: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const g of graphemeList) {
    current.push(g);
    if (current.length >= maxLength) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Hard-limit a single text to `maxLength` grapheme clusters, truncating at a
 * grapheme boundary (never mid-cluster). Used for placeholder text and editor
 * previews where splitting is not desired.
 */
export function truncateGraphemes(text: string, maxLength: number): string {
  return graphemes(text).slice(0, maxLength).join('');
}

/** Return the LAST `n` grapheme clusters of `text` (never mid-cluster). */
export function tailGraphemes(text: string, n: number): string {
  if (n <= 0) return '';
  return graphemes(text).slice(-n).join('');
}

/** Built-in message length limits for plain/regular output. */
export const LIMITS = {
  regular: REGULAR_MESSAGE_MAX, // 4096
  caption: CAPTION_MAX, // 1024
  rich: RICH_MESSAGE_MAX_UTF8, // 32768
} as const;
