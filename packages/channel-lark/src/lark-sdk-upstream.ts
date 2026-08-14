/**
 * Lark SDK-mode upstream driver (official `@larksuiteoapi/node-sdk`).
 *
 * This driver replaces only the INBOUND leg of the legacy self-hosted gateway
 * integration: robot messages arrive over the official SDK's WebSocket
 * long-connection (`WSClient` + `EventDispatcher`, event
 * `im.message.receive_v1`) and are mapped into the SAME raw shape the gateway
 * long-poll driver produces (`{ type, msgId, eventId, senderId,
 * conversationId, threadId, content, ... }`), so the existing mapper + dedup
 * pipeline is untouched. Thread replies are preserved: the SDK's
 * `message.thread_id` / `root_id` / `parent_id` map into the raw
 * `threadId` the mapper uses to build the thread-scoped SessionBinding.
 *
 * OUTBOUND is deliberately delegated: message send / media / editable card
 * create-update are HTTP calls, not part of the WS long-connection event
 * path. `LarkSdkUpstream` forwards every outbound method to an injected
 * `LarkUpstream` (the existing HTTP driver over `HttpTransport`). This
 * bounded split keeps the change small and fully offline-testable; a future
 * iteration can point outbound at the Lark OpenAPI base without touching the
 * inbound path.
 *
 * Credentials never appear in this module (the client is built elsewhere from
 * config) and are never logged. Live verification against a real Lark app
 * (AppId/AppSecret) is a manual step — the offline tests inject a fake WS
 * client and drive a real `EventDispatcher` with v1 event envelopes.
 */
import { EventDispatcher, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { CardCreateResult, LarkMediaRef, LarkUpstream } from './upstream.js';

/** Event type key for inbound message delivery (v1 event). */
export const MESSAGE_EVENT_KEY = 'im.message.receive_v1';

/**
 * Minimal structural dispatcher surface consumed by the driver. The real SDK
 * `EventDispatcher` satisfies it (register / invoke); the WS client invokes
 * `invoke(data, { needCheck: false })` for every inbound event frame.
 */
export interface LarkSdkDispatcher {
  /** Register handlers keyed by event type (e.g. 'im.message.receive_v1'). */
  register(handles: Record<string, (...args: any[]) => unknown>): unknown;
  /** Dispatch one raw event envelope to the registered handler. */
  invoke(data: unknown, params?: { needCheck?: boolean }): Promise<unknown>;
}

/**
 * Minimal structural WS client surface consumed by the driver. The real SDK
 * `WSClient` satisfies it (start / close); tests inject a fake without a
 * WebSocket.
 */
export interface LarkSdkClient {
  /** Open the WS long-connection and start dispatching events. */
  start(params: { eventDispatcher: LarkSdkDispatcher }): Promise<void>;
  /** Close the WS long-connection (sync in the real SDK). */
  close(params?: { force?: boolean }): void;
}

export interface LarkSdkUpstreamOptions {
  /** The WS long-connection client (real WSClient or injected fake). */
  client: LarkSdkClient;
  /** Outbound delegate: the HTTP driver over the transport (gateway endpoints). */
  outbound: LarkUpstream;
  /** Invoked after the WS connection is established (connection state). */
  onConnected?: () => void;
}

/**
 * Parsed v1 message event payload — the flat shape the `EventDispatcher`
 * delivers to the `im.message.receive_v1` handler (header + event fields
 * merged, per the SDK's RequestHandle.parse).
 */
export interface LarkMessageEventData {
  event_id?: string;
  event_type?: string;
  token?: string;
  create_time?: string;
  sender?: {
    sender_id?: { union_id?: string; user_id?: string; open_id?: string };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    create_time?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    /** JSON-encoded message body per the v1 schema, e.g. '{"text":"hi"}'. */
    content?: string;
  };
  [key: string]: unknown;
}

/** Parsed message content JSON (best-effort; empty object when absent). */
type MessageContent = Record<string, unknown>;

/**
 * Map one parsed v1 message event into the gateway raw shape consumed by the
 * inbound mapper (`{ type, msgId, eventId, senderId, conversationId,
 * threadId, content, ... }`). Returns `undefined` when the event carries no
 * message body.
 */
export function toGatewayRaw(data: LarkMessageEventData): Record<string, unknown> | undefined {
  const message = data.message;
  if (!message || typeof message !== 'object') return undefined;
  const raw: Record<string, unknown> = {
    type: message.message_type,
    msgId: message.message_id,
    eventId: data.event_id,
    senderId: senderIdOf(data.sender),
    conversationId: message.chat_id,
    // Platform chat kind ('p2p' | 'group'); the mapper derives the
    // conversation type from the chat id prefix ('oc_' → group), so this is
    // kept for observability only.
    chatType: message.chat_type,
  };
  // Thread preservation: the mapper keys Harness sessions by
  // conversation.threadId, so replies inside a thread must carry the thread
  // root. thread_id (when present) is canonical; root_id identifies the
  // thread root; parent_id is the direct parent — a fallback for plain
  // replies without a thread.
  const threadId = message.thread_id ?? message.root_id ?? message.parent_id;
  if (threadId) raw.threadId = threadId;

  const content = parseContent(message.content);
  switch (message.message_type) {
    case 'text':
      raw.content = content.text;
      break;
    case 'image':
      // SDK image bodies carry an image_key (not a URL); resolving it to a
      // media URL is a future OpenAPI call — the mapper surfaces it best-effort.
      raw.picUrl = content.image_key;
      break;
    case 'audio':
      raw.mediaUrl = content.file_key;
      raw.durationMs = content.duration;
      break;
    case 'media':
      // Feishu video messages use message_type 'media'; the mapper knows 'video'.
      raw.type = 'video';
      raw.mediaUrl = content.file_key;
      raw.durationMs = content.duration;
      break;
    case 'file':
      raw.mediaUrl = content.file_key;
      raw.title = content.file_name;
      break;
    case 'post':
      raw.content = postText(content);
      break;
    default:
      // Keep the SDK message_type; the mapper reports unknown types as
      // unsupported (honest rather than guessing).
      break;
  }
  return raw;
}

/** SDK-mode implementation of `LarkUpstream` (inbound via the SDK). */
export class LarkSdkUpstream implements LarkUpstream {
  /**
   * Real SDK dispatcher: the registered handler is invoked for every
   * `im.message.receive_v1` frame the WS client delivers. Reused across
   * reconnects (the handler is registered once per driver instance).
   */
  private readonly dispatcher: EventDispatcher;
  private registered = false;
  private onMessage?: (raw: unknown) => void;

  constructor(private readonly options: LarkSdkUpstreamOptions) {
    // No verification token needed: the WS long-connection dispatches with
    // needCheck: false (tokens/encrypt are webhook-only concerns).
    this.dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.fatal });
  }

  /**
   * Connect the WS long-connection, route inbound message events into the
   * gateway raw shape, and keep the connection open until `signal` aborts.
   */
  async receive(
    signal: AbortSignal,
    onMessage: (raw: unknown) => void,
  ): Promise<void> {
    this.onMessage = onMessage;
    this.registerOnce();
    try {
      await this.options.client.start({ eventDispatcher: this.dispatcher });
    } catch (error) {
      // Abort-driven teardown exits gracefully; other failures propagate to
      // the adapter, which owns reconnect/backoff.
      if (signal.aborted) return;
      throw error;
    }
    if (signal.aborted) {
      this.options.client.close();
      return;
    }
    this.options.onConnected?.();
    await waitForAbort(signal);
    this.options.client.close();
  }

  private registerOnce(): void {
    if (this.registered) return;
    this.dispatcher.register({
      [MESSAGE_EVENT_KEY]: (data: unknown) => {
        if (!this.onMessage) return undefined;
        const raw = toGatewayRaw(data as LarkMessageEventData);
        if (raw !== undefined) this.onMessage(raw);
        return undefined;
      },
    });
    this.registered = true;
  }

  sendText(to: string, text: string): Promise<unknown> {
    return this.options.outbound.sendText(to, text);
  }

  sendMedia(to: string, media: LarkMediaRef): Promise<unknown> {
    return this.options.outbound.sendMedia(to, media);
  }

  createCard(conversationId: string, text: string): Promise<CardCreateResult> {
    return this.options.outbound.createCard(conversationId, text);
  }

  updateCard(cardId: string, text: string): Promise<unknown> {
    return this.options.outbound.updateCard(cardId, text);
  }

  finishCard(cardId: string): Promise<unknown> {
    return this.options.outbound.finishCard(cardId);
  }

  failCard(cardId: string, reason?: string): Promise<unknown> {
    return this.options.outbound.failCard(cardId, reason);
  }
}

/** Open id first (the id Harness sessions key on), then union/user ids. */
function senderIdOf(sender: LarkMessageEventData['sender']): string | undefined {
  const id = sender?.sender_id;
  return id?.open_id ?? id?.union_id ?? id?.user_id;
}

function parseContent(content: string | undefined): MessageContent {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as MessageContent) : {};
  } catch {
    return {};
  }
}

/** Best-effort plain-text extraction from a rich-text 'post' body. */
function postText(content: MessageContent): string {
  const rows = content.content;
  if (!Array.isArray(rows)) return '';
  const segments: string[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      const item = node as { tag?: string; text?: string; [key: string]: unknown };
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        segments.push(item.text);
      }
    }
  }
  return segments.join('');
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
