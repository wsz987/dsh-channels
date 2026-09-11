import { Service, type Context } from '@deepseek-ai/cordis';
import type {
  ChannelAttachmentContext,
  ChannelAttachmentDescriptor,
  ChannelAttachmentProvider,
  ChannelImageStoreInput,
  ResolvedChannelAttachment,
  StoredBinaryPart,
} from '@wsz987/channel-harness';
import { FileChannelInboundAssetStore } from './attachments/store.js';
import { DEFAULT_ATTACHMENT_POLICY } from './attachments/policy.js';
import { createAttachmentExtractor } from './attachments/pipeline-extractor.js';
import { storeBinaryPart } from './attachments/pipeline.js';
import { installReadChannelAttachmentTool } from './attachments/tool-read.js';
import { resolveAttachment } from './attachment-resolver.js';
import { sanitizeFilename } from './attachments/filename.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    channelFiles: ChannelFileService;
  }
}

export class ChannelFileService extends Service implements ChannelAttachmentProvider {
  readonly storeBackend: FileChannelInboundAssetStore;
  private readonly extractor = createAttachmentExtractor(DEFAULT_ATTACHMENT_POLICY);

  constructor(ctx: Context) {
    super(ctx, 'channelFiles');
    this.storeBackend = new FileChannelInboundAssetStore();
  }

  store(context: ChannelAttachmentContext, part: StoredBinaryPart) {
    return storeBinaryPart(this.storeBackend, context, part, {
      extractor: this.extractor,
    });
  }

  /**
   * Mirror one inbound image into the private asset store under the HARNESS
   * attachmentId (the model-visible `sha256:…` ref id) so the outbox can
   * resolve it for outbound sends (issue #7). The harness image seam stays
   * authoritative; images are content assets with no text extraction, so the
   * stored asset is born `readable: false` / `not-needed`.
   */
  async storeImage(
    context: ChannelAttachmentContext,
    image: ChannelImageStoreInput,
  ): Promise<ChannelAttachmentDescriptor | undefined> {
    const asset = await this.storeBackend.put({
      attachmentId: image.attachmentId,
      sessionId: context.sessionId,
      channelId: context.channelId,
      accountId: context.accountId,
      conversationId: context.conversationId,
      ...(context.conversationType ? { conversationType: context.conversationType } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
      messageId: context.messageId,
      kind: 'image',
      name: sanitizeFilename(image.name ?? 'image'),
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
      data: image.data,
    });
    return {
      attachmentId: asset.attachmentId,
      name: asset.name,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      durable: true,
      readable: false,
    };
  }

  installCompatibilityTools(agentContext: Context): Promise<void> {
    return installReadChannelAttachmentTool(agentContext, {
      store: this.storeBackend,
    });
  }

  /** @deprecated use installCompatibilityTools. */
  installTools(agentContext: Context): Promise<void> {
    return this.installCompatibilityTools(agentContext);
  }

  resolveAttachment(
    attachmentId: string,
    sessionId: string,
  ): Promise<ResolvedChannelAttachment> {
    return resolveAttachment(attachmentId, sessionId, this.storeBackend, {
      policy: DEFAULT_ATTACHMENT_POLICY,
    });
  }
}

