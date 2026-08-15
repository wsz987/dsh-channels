import type { Context } from '@deepseek-ai/cordis';
import { ChannelFileService } from './service.js';

export const name = 'channel-files';

export function apply(ctx: Context): void {
  new ChannelFileService(ctx);
}

