/**
 * Pure renderer for one pending Harness question -> `OutboundMessage`.
 *
 * Pure by construction: given the pending presentation state and the official
 * `AskUserQuestionItem`, it produces the exact outbound message — no adapter
 * sends, no backend calls, no session lookups, no platform payloads. The only
 * injected dependency is `bindAction`, which maps a pending action intent to
 * its bound opaque channel-facing id (the presenter wires
 * `state.bindAction`), keeping this module a plain unit-test target.
 *
 * Presentation is capability-driven:
 *
 * - `'actions'` — native buttons via `OutboundMessage.actions` (option rows,
 *   `其他` custom, `完成` done for multi-select, `跳过本题` skip; `✓ ` toggle
 *   for multi-select; plan-review approve gets `primary`).
 * - `'text'`    — numbered plain-text options ALWAYS emitted when options
 *   exist (description is an indented note, never a gate for showing the
 *   option), plus free-text instructions. No `actions` attached. In group
 *   chats a short correlation hint (`replyToken`) is appended so the answer
 *   can be routed without platform reply correlation.
 *
 * `replyPrompt` stays a best-effort hint for free-text questions
 * (`needsTextReply`), never a usability precondition.
 */
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types';
import type { OutboundActionRow, OutboundMessage } from '@wsz987/channel-core';
import type {
  PendingChannelQuestion,
  PendingQuestionAction,
} from './question-state.js';

/** Options-mode reply instructions shown in text presentation (with options). */
const TEXT_OPTION_INSTRUCTIONS = [
  '回复 1 / 2 / 3，或直接回复选项文字。',
  '也可以直接输入自定义答案。',
  '回复"跳过"可跳过本题。',
];

/**
 * Render the current question of a pending batch as an outbound channel
 * message. Every official field is honoured: `header` / `question` / `detail`
 * as text, `options` / `multiSelect` as numbered options (+ native actions
 * when available), and `intent` as a minimal presentation cue (a plan-review
 * heading tag plus a primary-styled approve button — the answer encoding is
 * identical either way, so nothing is lost when a UI ignores the tag).
 */
export function renderQuestionMessage(
  pending: PendingChannelQuestion,
  question: AskUserQuestionItem,
  bindAction: (action: PendingQuestionAction) => string,
): OutboundMessage {
  const textMode = pending.presentationMode === 'text';
  const intent = question.intent;
  const planReview = intent?.kind === 'plan-review';
  const heading = question.header ? `**${question.header}**` : '';
  const lines = [
    planReview ? (heading ? `${heading}（计划评审）` : '**计划评审**') : heading,
    question.question,
    question.detail ?? '',
  ];

  // Numbered options are ALWAYS emitted when options exist — a description is
  // an indented note, never a condition for showing the option.
  if (question.options?.length) {
    lines.push(...question.options.map((option, index) =>
      `${index + 1}. ${option.label}${option.description ? `\n   ${option.description}` : ''}`,
    ));
  }

  const needsTextReply = pending.awaitingCustom || !question.options?.length;
  if (pending.awaitingCustom) {
    lines.push('请直接回复你的自定义答案。');
  } else if (!question.options?.length) {
    lines.push('请直接回复文字，或输入"跳过"。');
  } else if (textMode) {
    lines.push(...TEXT_OPTION_INSTRUCTIONS);
  }

  // Group text presentation carries a platform-independent correlation hint so
  // an answer can be routed when replyTo correlation is unavailable.
  if (textMode && pending.target.conversationType === 'group' && pending.replyToken) {
    lines.push(`如果当前渠道无法关联回复，请发送：${pending.replyToken} 2`);
  }

  if (textMode) {
    return {
      text: lines.filter(Boolean).join('\n\n'),
      ...(needsTextReply ? { replyPrompt: { kind: 'text' as const } } : {}),
    };
  }

  const approveLabel = planReview ? intent.approve : undefined;
  const actions: OutboundActionRow[] = [];
  if (!needsTextReply) {
    for (const [index, option] of (question.options ?? []).entries()) {
      const selected = pending.selected.has(option.label);
      actions.push({
        actions: [{
          id: bindAction({ kind: 'option', optionIndex: index }),
          label: `${selected ? '✓ ' : ''}${option.label}`,
          ...(option.label === approveLabel ? { style: 'primary' as const } : {}),
        }],
      });
    }
    if (question.options?.length) {
      actions.push({ actions: [{ id: bindAction({ kind: 'custom' }), label: '其他' }] });
      if (question.multiSelect) {
        actions.push({ actions: [{ id: bindAction({ kind: 'done' }), label: '完成', style: 'primary' }] });
      }
    }
  }
  if (!needsTextReply) {
    actions.push({ actions: [{ id: bindAction({ kind: 'skip' }), label: '跳过本题' }] });
  }
  return {
    text: lines.filter(Boolean).join('\n\n'),
    ...(needsTextReply ? { replyPrompt: { kind: 'text' as const } } : { actions }),
  };
}