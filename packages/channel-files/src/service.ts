import { Service, type Context } from '@deepseek-ai/cordis';
import type {
  ChannelFileContext,
  ChannelFileProvider,
  ResolvedChannelAttachment,
  StoredBinaryPart,
} from '@wsz987/channel-harness';
import { FileChannelInboundAssetStore } from './attachments/store.js';
import { DEFAULT_ATTACHMENT_POLICY } from './attachments/policy.js';
import { createAttachmentExtractor } from './attachments/pipeline-extractor.js';
import { storeBinaryPart } from './attachments/pipeline.js';
import { installReadChannelAttachmentTool } from './attachments/tool-read.js';
import { resolveAttachment } from './attachment-resolver.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    channelFiles: ChannelFileService;
  }
}

export class ChannelFileService extends Service implements ChannelFileProvider {
  readonly storeBackend: FileChannelInboundAssetStore;
  private readonly extractor = createAttachmentExtractor(DEFAULT_ATTACHMENT_POLICY);

  constructor(ctx: Context) {
    super(ctx, 'channelFiles');
    this.storeBackend = new FileChannelInboundAssetStore();
  }

  store(context: ChannelFileContext, part: StoredBinaryPart) {
    return storeBinaryPart(this.storeBackend, context, part, {
      extractor: this.extractor,
    });
  }

  installTools(agentContext: Context): Promise<void> {
    return installReadChannelAttachmentTool(agentContext, {
      store: this.storeBackend,
    });
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

