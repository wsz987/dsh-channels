import type { Context } from '@deepseek-ai/cordis';
import type { StoredBinaryPart } from './message-converter.js';

export interface ChannelAttachmentContext {
  sessionId: string;
  channelId: string;
  accountId: string;
  conversationId: string;
  conversationType?: 'dm' | 'group';
  threadId?: string;
  messageId: string;
}

export interface ChannelAttachmentDescriptor {
  attachmentId: string;
  name: string;
  mimeType?: string;
  bytes: number;
  durable: boolean;
  readable: boolean;
}

export type ResolvedChannelAttachmentKind = 'image' | 'file' | 'audio' | 'video';

export interface ResolvedChannelAttachment {
  kind: ResolvedChannelAttachmentKind;
  data: Uint8Array;
  name: string;
  mimeType?: string;
}

/** Input for mirroring one inbound image into the private asset store. */
export interface ChannelImageStoreInput {
  /**
   * The HARNESS attachment id (the model-visible `sha256:…` ref id) — the
   * mirror MUST be stored under exactly this id so the outbox can resolve
   * the image for outbound sends (issue #7).
   */
  attachmentId: string;
  data: Uint8Array;
  mimeType?: string;
  name?: string;
}

/**
 * Optional generic-attachment capability supplied by an extension package.
 * Core responsibility: `store` / `resolveAttachment` / session ACL.
 * Tool registration (`read_channel_attachment`) is NOT part of the core
 * contract — `installCompatibilityTools` is optional and keeps the tool
 * registered while it is the compatibility path; once Harness
 * ships a native generic-attachment surface this method can be dropped.
 */
export interface ChannelAttachmentProvider {
  store(
    context: ChannelAttachmentContext,
    part: StoredBinaryPart,
  ): Promise<ChannelAttachmentDescriptor | undefined>;
  resolveAttachment(
    attachmentId: string,
    sessionId: string,
  ): Promise<ResolvedChannelAttachment>;
  /**
   * Optional image mirror (issue #7): store the inbound image bytes under
   * the harness attachment id so `send_channel_message` can re-send them.
   * Best-effort by contract — absent or failing implementations leave the
   * harness image seam authoritative; the outbound resolution then simply
   * misses for images.
   */
  storeImage?(
    context: ChannelAttachmentContext,
    image: ChannelImageStoreInput,
  ): Promise<ChannelAttachmentDescriptor | undefined>;
  installCompatibilityTools?(agentContext: Context): Promise<void>;
  /**
   * @deprecated implement {@link installCompatibilityTools} instead. Retained
   * for one compatibility cycle so providers built against the former
   * ChannelFileProvider contract keep registering their agent-scoped tools.
   */
  installTools?(agentContext: Context): Promise<void>;
}

/** @internal Install at most one provider tool hook, preferring the new name. */
export async function installAttachmentCompatibilityTools(
  provider: ChannelAttachmentProvider,
  agentContext: Context,
): Promise<void> {
  const install = provider.installCompatibilityTools ?? provider.installTools;
  await install?.call(provider, agentContext);
}

/**
 * Live view over the OPTIONAL attachment-provider seam.
 *
 * The provider is resolved through `resolve()` on EVERY call instead of being
 * captured once at bridge startup. The bundle's `channels-files` row starts
 * CONCURRENTLY with `channels-harness` (the Cordis entry group creates every
 * row through `Promise.allSettled`), so a startup snapshot is a race: the
 * harness fiber can apply first and permanently wire itself to “no provider”
 * while `channelFiles` mounts a moment later — which silently disables the
 * outbound attachment resolver (issue #7) and the inbound image mirror.
 *
 * Resolving live also keeps the documented contract of the extension honest:
 * deleting the `channels-files` row stays a supported configuration (absent
 * stays absent, nothing becomes a hard dependency).
 */
export function liveAttachmentProvider(
  resolve: () => ChannelAttachmentProvider | undefined,
): ChannelAttachmentProvider {
  return {
    async store(context, part) {
      return resolve()?.store(context, part);
    },
    async resolveAttachment(attachmentId, sessionId) {
      const provider = resolve();
      if (!provider) {
        throw new Error(
          'no channel attachment provider is mounted (the channelFiles service is unavailable)',
        );
      }
      return provider.resolveAttachment(attachmentId, sessionId);
    },
    async storeImage(context, image) {
      return resolve()?.storeImage?.(context, image);
    },
    async installCompatibilityTools(agentContext) {
      const provider = resolve();
      if (!provider) return;
      await installAttachmentCompatibilityTools(provider, agentContext);
    },
  };
}

/**
 * @deprecated use {@link ChannelAttachmentProvider}
 */
export type ChannelFileProvider = ChannelAttachmentProvider;

/**
 * @deprecated use {@link ChannelAttachmentContext}
 */
export type ChannelFileContext = ChannelAttachmentContext;

/**
 * @deprecated use {@link ChannelAttachmentDescriptor}
 */
export type ChannelFileDescriptor = ChannelAttachmentDescriptor;
