import type { Context } from '@deepseek-ai/cordis';
import type { StoredBinaryPart } from './message-converter.js';

export interface ChannelFileContext {
  sessionId: string;
  channelId: string;
  accountId: string;
  conversationId: string;
  conversationType?: 'dm' | 'group';
  threadId?: string;
  messageId: string;
}

export interface ChannelFileDescriptor {
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

/** Optional generic-file capability supplied by an extension package. */
export interface ChannelFileProvider {
  store(
    context: ChannelFileContext,
    part: StoredBinaryPart,
  ): Promise<ChannelFileDescriptor | undefined>;
  installTools(agentContext: Context): Promise<void>;
  resolveAttachment(
    attachmentId: string,
    sessionId: string,
  ): Promise<ResolvedChannelAttachment>;
}

