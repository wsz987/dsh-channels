/**
 * Outbound sending: channel message → QQReplyTarget → QQSdkClient.
 *
 * Text-only messages go through `sendText`; messages carrying a media part
 * with a resolvable source go through `sendMedia` (fileType mapped from the
 * part type). A part's `localData` bytes (image or generic file) are sent via
 * `sendMedia` with the SDK `fileData` base64 carrier.
 *
 * Interactive actions (`OutboundMessage.actions`) map to the QQ platform
 * inline keyboard: one DSH action row → one QQ keyboard row, each action → one
 * `KeyboardButton`. Buttons are only attached to plain-text sends — QQ does
 * not reliably support buttons on media messages, so media + actions degrades
 * to a plain media send (documented; never fabricated).
 * Failures are wrapped in `ChannelSendError`.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  OutboundAction,
  OutboundActionRow,
  OutboundMessage,
  SendResult,
} from '@wsz987/channel-core';
import { ChannelSendError } from '@wsz987/channel-core';
import { z } from 'zod';
import type {
  QQInlineKeyboardLike,
  QQKeyboardButton,
  QQReplyTarget,
  QQSdkClient,
} from './sdk-client.js';
import {
  QQ_BUTTON_ACTION_TYPE,
  QQ_BUTTON_PERMISSION_TYPE,
  QQ_BUTTON_STYLE_DEFAULT,
  QQ_BUTTON_STYLE_PRIMARY,
} from './sdk-client.js';

export class OutboundSender {
  constructor(
    private readonly client: QQSdkClient,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const replyTarget = toReplyTarget(target);
      if (hasMedia(message)) {
        // Media messages carry no buttons: QQ does not reliably support an
        // inline keyboard on a media send, so actions are dropped (debug note,
        // never a fabricated button attachment).
        if (message.actions?.length) {
          this.logger.debug(
            `[channel-qq] media message with actions — buttons unsupported on QQ media sends; dropping actions`,
          );
        }
        const response = await this.client.sendMedia(replyTarget, message);
        return sendResult(response);
      }
      const text = message.text ?? '';
      if (message.actions?.length) {
        const keyboard = toQqKeyboard(message.actions);
        const response = await this.client.sendMarkdownWithKeyboard(replyTarget, text, keyboard);
        return sendResult(response);
      }
      const response = await this.client.sendText(replyTarget, text);
      return sendResult(response);
    } catch (error) {
      this.logger.error(
        `[channel-qq] send failed to '${target.conversationId}'`,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        `qq send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Map DSH `OutboundActionRow[]` → QQ `InlineKeyboard` shape.
 *
 * Each action's opaque `id` (the `uq_*` id minted by `QuestionStateStore`) is
 * the value that must round-trip back on a button press: it is placed in both
 * `action.data` (echoed verbatim by the platform as
 * `InteractionEvent.data.resolved.button_data`) and the button `id` (the
 * platform-stable handle). The adapter recovers the action id from
 * `button_data` on the interaction event.
 *
 * `style` maps only the QQ button render styles the platform actually
 * supports: DSH `primary` → QQ style 1 (primary fill), everything else →
 * default style 0. Unknown styles are never invented.
 */
export function toQqKeyboard(rows: OutboundActionRow[]): QQInlineKeyboardLike {
  return {
    content: {
      rows: rows.map((row) => ({ buttons: row.actions.map(toQqButton) })),
    },
  };
}

const qqMessageResponseSchema = z.object({ id: z.string().min(1) });

/** Normalize the official SDK response without trusting an unchecked cast. */
function sendResult(raw: unknown): SendResult {
  const parsed = qqMessageResponseSchema.safeParse(raw);
  return {
    delivered: true,
    ...(parsed.success ? { messageId: parsed.data.id } : {}),
    raw,
  };
}

function toQqButton(action: OutboundAction): QQKeyboardButton {
  return {
    id: action.id,
    render_data: {
      label: action.label,
      visited_label: action.label,
      style: action.style === 'primary' ? QQ_BUTTON_STYLE_PRIMARY : QQ_BUTTON_STYLE_DEFAULT,
    },
    action: {
      type: QQ_BUTTON_ACTION_TYPE,
      permission: { type: QQ_BUTTON_PERMISSION_TYPE },
      data: action.id,
      click_limit: 1,
    },
  };
}

/** Build a port `QQReplyTarget` from a DSH `ChannelTarget`. */
export function toReplyTarget(target: ChannelTarget): QQReplyTarget {
  return {
    scope: target.conversationType === 'group' ? 'group' : 'c2c',
    targetId: target.conversationId,
    msgId: target.replyToMessageId,
  };
}

/** Whether the message carries a media part with a resolvable source. */
function hasMedia(message: OutboundMessage): boolean {
  for (const part of message.parts ?? []) {
    switch (part.type) {
      case 'image':
      case 'audio':
      case 'video':
      case 'file':
        if (part.url || part.dataUri || part.localData !== undefined) return true;
        break;
      default:
        break;
    }
  }
  return false;
}
