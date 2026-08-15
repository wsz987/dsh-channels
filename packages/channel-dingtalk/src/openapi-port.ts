/**
 * DingTalkOpenApiPort — the thin official DingTalk OpenAPI port (plan §30 / §33).
 *
 * Two layers make up the DingTalk adapter (plan §30):
 *
 *   DingTalkStreamPort      -> dingtalk-stream SDK (own module: stream-upstream.ts)
 *   DingTalkOpenApiPort     -> official DingTalk OpenAPI (this port)
 *
 * This port is deliberately SMALL (plan §33). It is the outbound counterpart to
 * the stream callbacks: everything that is an HTTP call back into DingTalk
 * (access token, proactive robot messages, media upload/send, AI Card
 * create/update/finish, opaque-mediaId resolution) lives here.
 *
 * Behavior oracle (plan §32 / §33): the official connector
 * `@dingtalk-real-ai/dingtalk-connector@0.8.24`. Its npm exports are only
 * `.` and `./bundled` and its root entry depends on OpenClaw, so the package
 * cannot be used as a host-neutral SDK today (plan §32). Therefore THIS adapter
 * re-implements the thin OpenAPI calls itself — mirroring the connector's
 * token / HTTP patterns — and records the corresponding official-behavior basis
 * on every method (`DingTalkOpenApiPortImpl.OFFICIAL_BASIS`). If the connector
 * later exposes host-neutral `./media` / `./messaging` / `./openapi`
 * subpaths, the internal implementation is swapped out without touching the
 * adapter (plan §34 "Adapter 无需改").
 *
 * No second DingTalk SDK is introduced (plan §31 / §86 / §93). The port never
 * hand-writes a Stream websocket protocol — that is dingtalk-stream's job.
 */
import type { ChannelTarget } from '@wsz987/channel-core';

/**
 * Capability flags the harness outbox reads to decide whether proactive sends
 * are available (plan §71). Fails CLOSED: a feature is only `true` when its
 * official OAPI path is actually implemented and wired by the adapter.
 */
export interface OutboxCapabilities {
  /** Proactive plain-text send to a conversationId via the official OAPI. */
  proactiveText: boolean;
  /** Proactive media (image/file) send via official upload + media send. */
  proactiveMedia: boolean;
}

/** Result of `getAccessToken`. Kept intentionally minimal. */
export interface AccessTokenResult {
  accessToken: string;
  expireInMs: number;
}

/** Credentials + optional clock used to mint the application access token. */
export interface DingTalkOpenApiCredentials {
  clientId?: string;
  clientSecret?: string;
  /** Injectable clock for token-expiry caching (tests). */
  now?: () => number;
}

/** Target of a proactive robot message (plan §69: official proactive API). */
export interface ProactiveTextInput {
  /** Robot's open conversation id (group) or, for a DM, the recipient userId. */
  conversationId: string;
  /** The robot code (usually the AppKey). */
  robotCode: string;
  /** Plain text to send. */
  text: string;
  /** `'group'` uses robot groupMessages/send; `'dm'` uses oToMessages/batchSend. */
  conversationType?: 'dm' | 'group';
}

/** Payload to upload a media file via the official robot file-upload endpoint. */
export interface MediaUploadInput {
  /** Robot code (usually the AppKey). */
  robotCode: string;
  /** File name used to carry the correct content type and display name. */
  fileName: string;
  /** MIME type of the uploaded bytes (used as the request content type). */
  mimeType?: string;
  /** The raw bytes of the file to upload. */
  data: Uint8Array;
  /** Target conversation, when the platform requires an agentId/space for upload. */
  target?: ChannelTarget;
}

/** Result of a successful media upload: a DingTalk `mediaId`. */
export interface MediaUploadResult {
  mediaId: string;
}

/** Send an already-uploaded media id as a robot image/file message. */
export interface MediaSendInput {
  /** Robot's open conversation id (group) or, for a DM, the recipient userId. */
  conversationId: string;
  /** The robot code (usually the AppKey). */
  robotCode: string;
  /** The `mediaId` returned by `uploadMedia`. */
  mediaId: string;
  /** `'image'` -> sampleImage robot message; `'file'` -> sampleFile. */
  msgtype: 'image' | 'file';
  /** Display file name for the `'file'` message type. */
  name?: string;
  /** `'group'` -> robot groupMessages/send; `'dm'` -> oToMessages/batchSend. */
  conversationType?: 'dm' | 'group';
}

/** Result of any proactive / media robot message send. */
export interface RobotMessageSendResult {
  /** The platform message id when reported. */
  messageId?: string;
  /** Raw platform response for diagnostics. */
  raw?: unknown;
}

/** One opaque-platform-handle resolution (plan §32A): locator -> trusted bytes. */
export interface ResolvedMedia {
  /** Trusted bytes already downloaded by the platform upstream. */
  data: Uint8Array;
  /** MIME type hint, when the platform reports one. */
  mimeType?: string;
  /** Byte size, when known. */
  size?: number;
}

/** The thin official DingTalk OpenAPI port (plan §33 plus §32A hard-download). */
export interface DingTalkOpenApiPort {
  /** Mint (and cache) the application access token. */
  getAccessToken(): Promise<string>;

  /** Send a proactive plain-text message to a conversation (plan §35 / §69). */
  sendProactiveText(input: ProactiveTextInput): Promise<RobotMessageSendResult>;

  /** Upload a media file, returning the DingTalk mediaId (plan §86 media upload). */
  uploadMedia(input: MediaUploadInput): Promise<MediaUploadResult>;

  /** Send an uploaded mediaId as a robot image/file message (plan §86 media send). */
  sendMedia(input: MediaSendInput): Promise<RobotMessageSendResult>;

  /** Create an AI Card with initial content. */
  createCard(target: ChannelTarget, text: string): Promise<{ cardId: string }>;

  /** Update an AI Card's body text. */
  updateCard(cardId: string, text: string): Promise<unknown>;

  /** Finalize an AI Card. */
  finishCard(cardId: string, text?: string): Promise<unknown>;

  /**
   * Resolve an opaque platform handle (a DingTalk mediaId / downloadCode) into
   * trusted bytes (plan §32A). Official behavior basis: the connector's
   * `downloadMediaByCode` / `getFileDownloadUrl` — POST
   * `/v1.0/robot/messageFiles/download` with `{ downloadCode, robotCode }`
   * returns a `downloadUrl`, which is then fetched as raw bytes. A genuine
   * http(s) `ref` is fetched directly. Throws a typed error when the ref is
   * opaque and no `downloadCode` context is available (fail closed, no
   * invented download protocol).
   */
  resolveMedia(
    ref: string,
    options?: {
      signal?: AbortSignal;
      name?: string;
      /** Per-message download code from the inbound callback (official schema). */
      downloadCode?: string;
      /** Robot code (AppKey); required for the official download API. */
      robotCode?: string;
    },
  ): Promise<ResolvedMedia>;

  /**
   * Resolve an opaque platform handle into a download URL, when the platform
   * can hand one back. Optional refinement of `resolveMedia`.
   */
  getMediaDownloadUrl?(
    ref: string,
    options?: { signal?: AbortSignal; downloadCode?: string; robotCode?: string },
  ): Promise<string | undefined>;
}

/** A minimal, injectable subset of the port used by inbound hydration. */
export interface MediaResolverLike {
  /** Resolve one opaque media handle into trusted bytes (plan §32A). */
  resolveMedia(
    ref: string,
    options?: {
      signal?: AbortSignal;
      name?: string;
      /** Per-message download code from the inbound callback (official schema). */
      downloadCode?: string;
      /** Robot code (AppKey); required for the official download API. */
      robotCode?: string;
    },
  ): Promise<ResolvedMedia>;
}
