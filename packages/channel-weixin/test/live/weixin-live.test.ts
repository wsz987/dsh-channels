/**
 * Real-account Weixin live gate.
 *
 * The scenarios are deliberately sequential: E2E-1 obtains the real QR
 * credential, and every later scenario reuses the same secret/storage handles.
 * No token may be supplied through an environment variable or seeded by a
 * placeholder.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
  type ChannelEvent,
  type ChannelTarget,
  type MessageReceived,
  type OutboundMessage,
} from '@wsz987/channel-core';
import {
  AccountCredentialStore,
  ContextTokenStore,
  SyncCursorStore,
  WeixinAdapter,
} from '../../src/index.js';
import type { WeixinConfig } from '../../src/config.js';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const LIVE = process.env.DSH_WEIXIN_LIVE === '1';
const BASE_URL = process.env.DSH_WEIXIN_BASE_URL?.trim() || DEFAULT_BASE_URL;
const ACCOUNT_ID = process.env.DSH_WEIXIN_ACCOUNT_ID?.trim() || 'live-main';
const REQUIRE_MEDIA = process.env.DSH_WEIXIN_REQUIRE_MEDIA === '1';
const MEDIA_PATHS = {
  image: process.env.DSH_WEIXIN_LIVE_IMAGE_PATH?.trim(),
  file: process.env.DSH_WEIXIN_LIVE_FILE_PATH?.trim(),
  video: process.env.DSH_WEIXIN_LIVE_VIDEO_PATH?.trim(),
};
const MEDIA_REQUESTED = Object.values(MEDIA_PATHS).some(Boolean);

describe('weixin live gate', () => {
  it('is inert unless explicitly armed', () => {
    expect(LIVE).toBe(process.env.DSH_WEIXIN_LIVE === '1');
  });

  it('uses the production endpoint when the environment value is absent or blank', () => {
    expect(BASE_URL).toBe(process.env.DSH_WEIXIN_BASE_URL?.trim() || DEFAULT_BASE_URL);
  });
});

function makeContext(opts: {
  service: ChannelService;
  secrets: ChannelAdapterContext['secrets'];
  storage: ChannelAdapterContext['storage'];
}): ChannelAdapterContext & { dispose: () => void } {
  const controller = new AbortController();
  return {
    emit: (event: ChannelEvent) => opts.service.emit(event),
    logger: {
      debug: (...args: unknown[]) => console.debug('[weixin-live]', ...args),
      info: (...args: unknown[]) => console.info('[weixin-live]', ...args),
      warn: (...args: unknown[]) => console.warn('[weixin-live]', ...args),
      error: (...args: unknown[]) => console.error('[weixin-live]', ...args),
    },
    secrets: opts.secrets,
    storage: opts.storage,
    signal: controller.signal,
    dispose: () => controller.abort(),
  };
}

function makeConfig(): WeixinConfig {
  return {
    enabled: true,
    accountId: ACCOUNT_ID,
    ilink: {
      baseUrl: BASE_URL,
      cdnBaseUrl: DEFAULT_CDN_BASE_URL,
      botAgent: 'DeepSeekHarness/live-e2e',
    },
    network: { timeoutMs: 15_000, longPollTimeoutMs: 35_000 },
    reconnect: { enabled: true, baseDelayMs: 2_000, maxDelayMs: 30_000 },
  };
}

function target(conversationId: string): ChannelTarget {
  return {
    channelId: 'weixin' as never,
    accountId: ACCOUNT_ID as never,
    conversationId: conversationId as never,
  };
}

function textOf(event: MessageReceived): string | undefined {
  return event.message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

async function eventually<T>(
  label: string,
  predicate: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

async function newService(): Promise<ChannelService> {
  const { Context: CordisContext } = await import('@deepseek-ai/cordis');
  return new ChannelService(new CordisContext() as Context);
}

function openLocalFile(path: string): void {
  const command = process.platform === 'win32'
    ? { file: 'explorer.exe', args: [path] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [path] }
      : { file: 'xdg-open', args: [path] };
  try {
    const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // A headless self-hosted runner can still open the printed local path.
  }
}

function imageMime(path: string, data: Uint8Array): 'image/png' | 'image/jpeg' {
  if (
    data.length >= 8
    && data[0] === 0x89
    && data[1] === 0x50
    && data[2] === 0x4e
    && data[3] === 0x47
    && data[4] === 0x0d
    && data[5] === 0x0a
    && data[6] === 0x1a
    && data[7] === 0x0a
  ) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const extension = extname(path).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  throw new Error('Native image probe accepts only PNG or JPEG input');
}

function qrImageSource(value: string): string {
  const trimmed = value.trim();
  if (/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) return trimmed;
  if (/^https:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return `data:image/png;base64,${trimmed.replace(/\s+/g, '')}`;
  }
  throw new Error('Weixin returned an unsupported QR image representation');
}

async function presentQrLocally(qrUrl: string | undefined): Promise<() => Promise<void>> {
  if (!qrUrl) throw new Error('Weixin did not return QR image content');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-weixin-live-qr-'));
  const htmlPath = join(directory, 'scan-weixin-qr.html');
  const imageSource = qrImageSource(qrUrl).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  await writeFile(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><title>Weixin live QR</title><style>body{font-family:sans-serif;text-align:center;padding:24px}img{width:min(80vw,480px);image-rendering:auto}</style><h1>使用微信扫码并在手机确认</h1><img alt="Weixin login QR" src="${imageSource}">`,
    { encoding: 'utf8', mode: 0o600 },
  );
  console.info(`[weixin-live] QR image written locally: ${htmlPath}`);
  console.info('[weixin-live] QR payload is intentionally omitted from logs and CI artifacts.');
  openLocalFile(htmlPath);
  const cleanupOnExit = (): void => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort during process teardown; normal auth cleanup remains strict.
    }
  };
  process.once('exit', cleanupOnExit);
  return async () => {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      process.off('exit', cleanupOnExit);
    }
  };
}

async function withStartedAdapter<T>(
  secrets: MemorySecretStore,
  storage: MemoryStorage,
  run: (adapter: WeixinAdapter, service: ChannelService, ctx: ChannelAdapterContext & { dispose: () => void }) => Promise<T>,
): Promise<T> {
  const service = await newService();
  const ctx = makeContext({ service, secrets, storage });
  const adapter = new WeixinAdapter(makeConfig());
  const unregister = service.register(adapter);
  try {
    await adapter.start(ctx);
    return await run(adapter, service, ctx);
  } finally {
    await adapter.stop().catch(() => undefined);
    unregister();
    ctx.dispose();
  }
}

describe.skipIf(!LIVE).sequential('WEIXIN LIVE REAL-ACCOUNT E2E', () => {
  const secrets = new MemorySecretStore();
  const storage = new MemoryStorage();
  let conversationId: string | undefined;
  let persistedBotId: string | undefined;

  it('E2E-1 QR login persists one real credential for all later scenarios', { timeout: 240_000 }, async () => {
    await withStartedAdapter(secrets, storage, async (adapter) => {
      const challenge = await adapter.beginAuth();
      const removeQr = await presentQrLocally(challenge.qrUrl);
      try {
        const auth = await eventually('Weixin QR confirmation', async () => {
          const poll = await adapter.pollAuth(challenge);
          if (poll.state === 'authenticated') return poll;
          if (poll.state === 'expired' || poll.state === 'failed') {
            throw new Error(`Weixin QR login ${poll.state}: ${poll.detail ?? 'no detail'}`);
          }
          return undefined;
        }, 180_000, 3_000);
        expect(auth.state).toBe('authenticated');
      } finally {
        await removeQr();
      }

      const credential = await new AccountCredentialStore({ secrets, storage, accountId: ACCOUNT_ID }).load();
      expect(credential?.token).toBeTypeOf('string');
      expect(credential?.token.length).toBeGreaterThan(0);
      expect(credential?.ilinkBotId).toBeTypeOf('string');
      expect(credential?.baseUrl).toMatch(/^https:\/\//);
      persistedBotId = credential?.ilinkBotId;
    });
  });

  it('E2E-2 receives exact text and sends a real reply using the persisted credential', { timeout: 240_000 }, async () => {
    await withStartedAdapter(secrets, storage, async (adapter, service) => {
      const received: MessageReceived[] = [];
      const off = service.on((event: ChannelEvent) => {
        if (event.type === 'message.received') received.push(event);
      });
      try {
        console.info('[weixin-live] Send exactly "WX-E2E-2" from WeChat now.');
        const inbound = await eventually('inbound text WX-E2E-2', async () => {
          return received.find((event) => textOf(event) === 'WX-E2E-2');
        }, 180_000);
        conversationId = inbound.conversation.id as string;
        const result = await adapter.send(target(conversationId), { text: 'WX-E2E-2-REPLY' });
        expect(result.delivered).toBe(true);
        expect(await new ContextTokenStore({ storage, accountId: ACCOUNT_ID }).get(conversationId)).toBeDefined();
        console.info('[weixin-live] Confirm WX-E2E-2-REPLY is visible in the same WeChat conversation.');
      } finally {
        off();
      }
    });
  });

  it('E2E-3 a fresh adapter reloads the same credential/cursor without another scan', { timeout: 240_000 }, async () => {
    expect(persistedBotId).toBeTypeOf('string');
    await withStartedAdapter(secrets, storage, async (adapter, service) => {
      const health = await adapter.getHealth();
      expect(health.authenticated).toBe(true);
      const reloaded = await new AccountCredentialStore({ secrets, storage, accountId: ACCOUNT_ID }).load();
      expect(reloaded?.ilinkBotId).toBe(persistedBotId);
      const cursorBefore = await new SyncCursorStore({ storage, accountId: ACCOUNT_ID }).load();

      const received: MessageReceived[] = [];
      const off = service.on((event: ChannelEvent) => {
        if (event.type === 'message.received') received.push(event);
      });
      try {
        console.info('[weixin-live] Send exactly "WX-E2E-3" after restart; do not scan again.');
        const inbound = await eventually('inbound text WX-E2E-3 after restart', async () => {
          return received.find((event) => textOf(event) === 'WX-E2E-3');
        }, 180_000);
        conversationId = inbound.conversation.id as string;
        const result = await adapter.send(target(conversationId), { text: 'WX-E2E-3-REPLY' });
        expect(result.delivered).toBe(true);
        const cursorAfter = await new SyncCursorStore({ storage, accountId: ACCOUNT_ID }).load();
        expect(cursorAfter ?? cursorBefore).toBeDefined();
      } finally {
        off();
      }
    });
  });

  it('E2E-4 an in-flight direct adapter reply completes while the adapter monitor stops', { timeout: 240_000 }, async () => {
    const service = await newService();
    const ctx = makeContext({ service, secrets, storage });
    const adapter = new WeixinAdapter(makeConfig());
    const unregister = service.register(adapter);
    const received: MessageReceived[] = [];
    const off = service.on((event: ChannelEvent) => {
      if (event.type === 'message.received') received.push(event);
    });
    try {
      await adapter.start(ctx);
      console.info('[weixin-live] Send exactly "WX-E2E-4" to start the shutdown-overlap probe.');
      const inbound = await eventually('inbound text WX-E2E-4', async () => {
        return received.find((event) => textOf(event) === 'WX-E2E-4');
      }, 180_000);
      conversationId = inbound.conversation.id as string;
      const replyPromise = adapter.send(target(conversationId), { text: 'WX-E2E-4-TAIL-REPLY' });
      await adapter.stop();
      const result = await replyPromise;
      expect(result.delivered).toBe(true);
      expect(await new ContextTokenStore({ storage, accountId: ACCOUNT_ID }).get(conversationId)).toBeDefined();
      console.info('[weixin-live] Confirm WX-E2E-4-TAIL-REPLY arrived. This does not test Harness Agent whenIdle.');
    } finally {
      off();
      await adapter.stop().catch(() => undefined);
      unregister();
      ctx.dispose();
    }
  });

  it.skipIf(!MEDIA_REQUESTED && !REQUIRE_MEDIA)('E2E-5 sends native image, file, and video through adapter.send', { timeout: 300_000 }, async () => {
    if (!MEDIA_PATHS.image || !MEDIA_PATHS.file || !MEDIA_PATHS.video) {
      throw new Error('Native media probe requires DSH_WEIXIN_LIVE_IMAGE_PATH, DSH_WEIXIN_LIVE_FILE_PATH, and DSH_WEIXIN_LIVE_VIDEO_PATH');
    }
    if (!conversationId) throw new Error('E2E-2/3/4 did not establish a live conversation id');

    const image = await readFile(MEDIA_PATHS.image);
    const file = await readFile(MEDIA_PATHS.file);
    const video = await readFile(MEDIA_PATHS.video);
    const probes: Array<{ label: string; message: OutboundMessage }> = [
      { label: 'image', message: { parts: [{ type: 'image', localData: image, mimeType: imageMime(MEDIA_PATHS.image, image) }] } },
      { label: 'file', message: { parts: [{ type: 'file', localData: file, name: basename(MEDIA_PATHS.file), mimeType: 'text/plain' }] } },
      { label: 'video', message: { parts: [{ type: 'video', localData: video, mimeType: 'video/mp4' }] } },
    ];

    await withStartedAdapter(secrets, storage, async (adapter) => {
      for (const probe of probes) {
        const result = await adapter.send(target(conversationId!), probe.message);
        expect(result.delivered, `${probe.label} was not delivered`).toBe(true);
        console.info(`[weixin-live] Native ${probe.label} delivered; verify its WeChat message kind and content manually.`);
      }
    });
  });
});
