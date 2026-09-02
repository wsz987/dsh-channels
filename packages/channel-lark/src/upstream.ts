/**
 * Lark upstream contract — the platform-neutral surface implemented by the
 * official `@larksuiteoapi/node-sdk` driver stack.
 *
 * The upstream is the OFFICIAL SDK only:
 * - inbound  — `LarkSdkUpstream` (WSClient + EventDispatcher,
 *   `im.message.receive_v1` / `card.action.trigger`);
 * - outbound — `LarkOpenApiOutbound` (im.v1.* messages/media + CardKit 2.0
 *   card entities and native streaming).
 *
 * Every operation in this contract is expressed in official-SDK semantics —
 * there is no self-hosted gateway and no legacy `/message/*` / `/card/*`
 * endpoint. Credentials never appear in this module (clients are built
 * elsewhere from resolved config/credentials).
 */
import type { OutboundActionRow } from '@wsz987/channel-core';

/** Minimal media reference for the basic outbound image send. */
export interface LarkMediaRef {
  type: 'image';
  url?: string;
  dataUri?: string;
  name?: string;
  /** Human-readable description; used as the send name when the part has none. */
  alt?: string;
}

/**
 * Outbound generic-file reference. localData carries the trusted bytes
 * (preferred; the adapter never re-downloads), url/dataUri are fallbacks. The
 * file_type sent to the SDK is derived from name by the outbound driver.
 */
export interface LarkFileRef {
  type: 'file';
  /** Trusted bytes already held by the adapter (preferred over url/dataUri). */
  localData?: Uint8Array;
  url?: string;
  dataUri?: string;
  /** Human-readable filename; drives the SDK file_name + derived file_type. */
  name?: string;
  mimeType?: string;
}

/**
 * Outbound surface of the official OpenAPI client: plain message/media sends,
 * Card JSON 2.0 interactive cards, and CardKit 2.0 card-entity + native
 * streaming operations. Implemented by `LarkOpenApiOutbound` and delegated
 * through `LarkSdkUpstream`; tests inject a fake OpenAPI client.
 */
export interface LarkOutbound {
  /** Send a plain text message (buffered fallback). */
  sendText(to: string, text: string): Promise<unknown>;

  /** Send a basic media message (e.g. a plain image). */
  sendMedia(to: string, media: LarkMediaRef): Promise<unknown>;

  /** Send a generic file message. */
  sendFile(to: string, file: LarkFileRef): Promise<unknown>;

  /**
   * Send an official Feishu interactive-card button set (Card JSON 2.0
   * buttons with `behaviors[].value`).
   */
  sendInteractive(to: string, text: string, actions: OutboundActionRow[]): Promise<unknown>;

  /**
   * Rewrite an already-sent interactive card, for example to remove completed
   * actions. Card edit boundary:
   * - PLAIN SENT MESSAGE CARDS (`im.v1.message.create` with the full Card JSON
   *   2.0 body inline) are rewritten via `im.v1.message.patch`.
   * - CARDKIT CARD ENTITIES (`cardkit.v1.card.create` → card reference) are
   *   updated via the CardKit surface (`updateCardElementContent` /
   *   `finishStreamingCard`, or the `cardkit.v1.card.update`/`batchUpdate`
   *   client methods) — never by this `message.patch` path.
   */
  updateInteractive(cardId: string, text: string, actions: OutboundActionRow[]): Promise<unknown>;

  /**
   * Create a CardKit 2.0 card entity from a serialized Card JSON 2.0 spec.
   * Returns the entity `card_id` used by later element/settings updates.
   */
  createCardEntity(cardJson: string): Promise<{ cardId: string }>;

  /**
   * Send a card reference (`{ type: "card", data: { card_id } }`) for an
   * existing CardKit entity. Returns the sent message id. A card entity may
   * only be sent once.
   */
  sendCardEntity(conversationId: string, cardId: string): Promise<{ messageId: string }>;

  /**
   * Native streaming update of one card element's content (the official
   * "typewriter" interface). `sequence` must increase monotonically per card;
   * `uuid` is the stable request id for idempotency.
   */
  updateCardElementContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
    uuid: string,
  ): Promise<unknown>;

  /** Disable streaming mode and write the final summary (preview text). */
  finishStreamingCard(cardId: string, sequence: number, summary: string): Promise<unknown>;

  /** Resolve the official chat mode for a card action before ACL admission. */
  getChatType?(conversationId: string): Promise<'p2p' | 'group' | undefined>;
  startTyping?(messageId: string): Promise<void>;
  stopTyping?(messageId: string): Promise<void>;
}

/**
 * A CardKit streaming card that has been created and whose card reference has
 * been sent. The reply handle owns this state across rollovers.
 */
export interface LarkStreamingCardRef {
  /** CardKit entity id. */
  cardId: string;
  /** Message id of the interactive card reference already sent. */
  messageId: string;
  /** Stable id of the markdown element inside the card (matches the entity JSON). */
  elementId: string;
}

/** Full upstream driver: official SDK inbound receive + outbound delegate. */
export interface LarkUpstream extends LarkOutbound {
  /**
   * Keep the inbound WS long-connection open and forward each raw inbound
   * payload to `onMessage` until `signal` aborts. Raw payloads are
   * unstructured — the mapper owns shape validation.
   */
  receive(
    signal: AbortSignal,
    onMessage: (raw: unknown) => void,
  ): Promise<void>;
}
