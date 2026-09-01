/**
 * Pure parser for free-text answers to a channel-presented Harness question.
 *
 * Non-button adapters (`interactiveActions` absent / false) still receive the
 * question as numbered plain text; the user replies with a number, the exact
 * option label, a multi-select index list, "跳过", or arbitrary custom text.
 * This module turns that raw inbound text into a structured answer — nothing
 * here touches adapters, backends, sessions or platform payloads, so it is a
 * straightforward unit test target.
 *
 * Rules (no fuzzy matching on purpose — a free sentence must not be mistaken
 * for an option):
 *
 * - single-select: `"1"` -> options[0]; exact label -> that option;
 *   `"跳过"` / `"跳过本题"` -> skip; any other non-empty text -> custom.
 * - multi-select: `1,3`, `1，3` (full-width comma) and `1 3` (whitespace
 *   separated) select numbered options; a single exact label also counts.
 *   Labels are returned in OPTIONS order, deduplicated. Any index out of
 *   range -> `{ kind: 'invalid', reason: 'option-out-of-range' }`. Ordinary
 *   text that matches no legal option -> custom.
 * - Empty text -> invalid.
 */
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types';

export type ParsedQuestionTextAnswer =
  | { kind: 'skip' }
  | { kind: 'selected'; labels: string[] }
  | { kind: 'custom'; text: string }
  | { kind: 'invalid'; reason: string };

const SKIP_WORDS = new Set(['跳过', '跳过本题']);

/**
 * Split multi-select input into candidate index tokens. Accepts full-width
 * commas and any run of whitespace/separators.
 */
function splitMultiSelectIndexes(rawText: string): string[] {
  // Normalise full-width comma + any comma/space runs into a single comma.
  return rawText
    .replace(/[\uFF0C]/g, ',')
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function isNumeric(token: string): boolean {
  return /^\d+$/.test(token);
}

function parseMultiSelect(question: AskUserQuestionItem, rawText: string): ParsedQuestionTextAnswer {
  const options = question.options ?? [];
  const selectedLabels = new Set<string>();
  const tokens = splitMultiSelectIndexes(rawText);

  for (const token of tokens) {
    if (!isNumeric(token)) {
      // A single exact label is allowed as one selection; anything else falls
      // through to custom below.
      return { kind: 'custom', text: rawText };
    }
    const index = Number(token) - 1;
    if (index < 0 || index >= options.length) {
      return { kind: 'invalid', reason: 'option-out-of-range' };
    }
    selectedLabels.add(options[index]!.label);
  }

  if (selectedLabels.size === 0) {
    return { kind: 'custom', text: rawText };
  }
  // Output in OPTIONS order, not user input order.
  const ordered = options
    .filter((option) => selectedLabels.has(option.label))
    .map((option) => option.label);
  return { kind: 'selected', labels: ordered };
}

export function parseQuestionTextAnswer(
  question: AskUserQuestionItem,
  rawText: string,
): ParsedQuestionTextAnswer {
  const text = rawText.trim();
  if (text.length === 0) return { kind: 'invalid', reason: 'empty' };
  if (SKIP_WORDS.has(text)) return { kind: 'skip' };
  if (question.multiSelect && (question.options?.length ?? 0) > 0) {
    // Only route to multi-select parsing when options exist AND the input
    // really looks like index input. Single exact labels still work here.
    if (question.options?.some((option) => option.label === text)) {
      return { kind: 'selected', labels: [text] };
    }
    const multi = parseMultiSelect(question, text);
    // parseMultiSelect already returns custom for non-numeric text, so a
    // plain-text label that passed the exact match above is the only way in
    // that doesn't already return a valid answer.
    return multi;
  }
  const options = question.options ?? [];
  const numeric = /^\d+$/.test(text) ? Number(text) - 1 : -1;
  if (numeric >= 0 && numeric < options.length) {
    return { kind: 'selected', labels: [options[numeric]!.label] };
  }
  const match = options.find((option) => option.label === text);
  if (match) return { kind: 'selected', labels: [match.label] };
  return { kind: 'custom', text };
}