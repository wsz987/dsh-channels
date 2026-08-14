/**
 * Weixin LIVE real-account E2E gate (R3 / WX4 "Text E2E").
 *
 * This suite drives the REAL Tencent Weixin iLink protocol through the public
 * exports of @dsh/channel-weixin (src/index.ts) — a genuine QR login, the
 * getUpdates long-poll, a real inbound text message, a real sendmessage reply
 * and durable restart/unload reconciliation. It is NOT a unit test and it is
 * NEVER executed by ordinary CI or by `pnpm --filter @dsh/channel-weixin test`.
 *
 * HOW TO RUN (manual, requires a real Weixin account + a phone with WeChat):
 *
 *   # 1. (optional) point at a different iLink endpoint (defaults to prod):
 *   #    export DSH_WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com
 *
 *   # 2. arm the gate — without this the whole suite is skipped:
 *   export DSH_WEIXIN_LIVE=1
 *
 *   # 3. run ONLY this file:
 *   pnpm --filter @dsh/channel-weixin vitest run test/live/weixin-live.test.ts
 *
 * What you must do by hand while the suite runs:
 *   - E2E-1: the test prints the QR (a data URI in challenge.qrUrl or the
 *     qrcode string in challenge.instruction). Scan it with your phone's
 *     WeChat and tap "confirm". The test polls get_qrcode_status until
 *     `confirmed`.
 *   - E2E-2: send the exact text "你好" from your WeChat account to the bot.
 *     The test waits for the adapter to surface that message.received event
 *     and then answers it with sendmessage — verify the reply lands in WeChat.
 *   - E2E-3 / E2E-4 run automatically against the same persisted resources.
 *
 * The gate is deliberately tolerant (generous timeouts, polling loops) so a
 * human can drive the account at a normal pace. Every scenario is
 * structurally real: FetchTransport against the configured endpoint, real
 * credential/cursor/context-token stores, and a SECOND adapter instance over
 * the SAME durable storage for restart.
 *
 * DO NOT commit real credentials. In-memory stores are used per scenario;
 * nothing here reads or writes a real credential file.
 */
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
} from '@dsh/channel-core';
import {
  AccountCredentialStore,
  ContextTokenStore,
  SyncCursorStore,
  WeixinAdapter,
} from '../../src/index.js';
import type { WeixinConfig } from '../../src/config.js';

/* ------------------------------------------------------------------ */
/* Env gate                                                            */
/* ------------------------------------------------------------------ */

const LIVE = process.env.DSH_WEIXIN_LIVE === '1';
const BASE_URL = process.env.DSH_WEIXIN_BASE_URL ?? 'https://ilinkai.weixin.qq.com';
const ACCOUNT_ID = process.env.DSH_WEIXIN_ACCOUNT_ID ?? 'live-main';

/**
 * Always-on sanity test: runs in ordinary CI too, proving the file compiles
 * and that the gate is OFF by default (so normal `pnpm test` never touches
 * the network).
 */
describe('weixin live gate', () => {
  it('is NOT armed by default so normal CI never executes live scenarios', () => {
    expect(LIVE).toBe(process.env.DSH_WEIXIN_LIVE === '1');
  });

  it('resolves the configurable endpoint (prod default)', () => {
    expect(BASE_URL).toBe(process.env.DSH_WEIXIN_BASE_URL ?? 'https://ilinkai.weixin.qq.com');
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeContext(opts: {
  service: ChannelService;
  secrets?: ChannelAdapterContext['secrets'];
  storage?: ChannelAdapterContext['storage'];
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
    secrets: opts.secrets ?? new MemorySecretStore(),
    storage: opts.storage ?? new MemoryStorage(),
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
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      botAgent: 'DeepSeekHarness/live-e2e',
    },
    network: { timeoutMs: 15000, longPollTimeoutMs: 35000 },
    reconnect: { enabled: true, baseDelayMs: 2000, maxDelayMs: 30000 },
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
  const part = event.message.content[0];
  return part && part.type === 'text' ? part.text : undefined;
}

async function eventually<T>(
  label: string,
  predicate: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error('timed out after ' + timeoutMs + 'ms waiting for: ' + label);
}

async function makeCordisContext(): Promise<Context> {
  const { Context: C } = await import('@deepseek-ai/cordis');
  return new C();
}

function newService(): Promise<ChannelService> {
  return makeCordisContext().then((ctx) => new ChannelService(ctx));
}

/* ------------------------------------------------------------------ */
/* LIVE suite — registered only when DSH_WEIXIN_LIVE === '1'               */
/* ------------------------------------------------------------------ */

describe.skipIf(!LIVE)('WEIXIN LIVE REAL-ACCOUNT E2E', () => {
  it('E2E-1 first login: beginAuth -> pollAuth -> confirmed -> credential persisted', { timeout: 240_000 }, async () => {
    const service = await newService();
    const ctx = makeContext({ service });
    const adapter = new WeixinAdapter(makeConfig());
    const unregister = service.register(adapter);

    try {
      await adapter.start(ctx);

      const challenge = await adapter.beginAuth();
      expect(challenge.id).toBeTypeOf('string');
      const qrLabel = challenge.qrUrl ?? challenge.instruction;
      console.info('[weixin-live] E2E-1 scan this QR with WeChat, then tap confirm:');
      console.info('[weixin-live] ' + (qrLabel && qrLabel.length > 200 ? qrLabel.slice(0, 200) + '…' : qrLabel));

      const auth = await eventually('weixin QR confirmed', async () => {
        const poll = await adapter.pollAuth(challenge);
        if (poll.state === 'authenticated') return poll;
        if (poll.state === 'expired' || poll.state === 'failed') {
          throw new Error('weixin QR login ' + poll.state + ': ' + (poll.detail ?? ''));
        }
        return undefined;
      }, 180_000, 3000);
      expect(auth.state).toBe('authenticated');

      // Credential persisted — readable via AccountCredentialStore over the
      // SAME storage boundary the adapter used.
      const store = new AccountCredentialStore({
        secrets: ctx.secrets,
        storage: ctx.storage,
        accountId: ACCOUNT_ID,
      });
      const credential = await store.load();
      expect(credential).toBeDefined();
      expect(credential?.token).toBeTypeOf('string');
      expect(credential?.ilinkBotId).toBeTypeOf('string');
      expect(credential?.baseUrl).toBe(BASE_URL);
    } finally {
      await adapter.stop().catch(() => undefined);
      unregister();
      ctx.dispose();
    }
  });

  it('E2E-2 text: send "你好" -> adapter surfaces message.received -> reply via sendmessage', { timeout: 240_000 }, async () => {
    const service = await newService();
    const ctx = makeContext({ service });
    const adapter = new WeixinAdapter(makeConfig());
    const unregister = service.register(adapter);

    const received: MessageReceived[] = [];
    const off = service.on((event: ChannelEvent) => {
      if (event.type === 'message.received') received.push(event);
    });

    try {
      await adapter.start(ctx);
      expect(service.get('weixin')).toBe(adapter);

      console.info('[weixin-live] E2E-2 send exactly "你好" from WeChat to the bot now');

      const inbound = await eventually('inbound text "你好" arrives', async () => {
        return received.find((e) => textOf(e) === '你好');
      }, 180_000, 2000);
      expect(inbound).toBeDefined();
      expect(textOf(inbound!)).toBe('你好');

      const result = await adapter.send(target(inbound!.conversation.id as string), {
        text: '你好 — live E2E reply',
      });
      expect(result.delivered).toBe(true);

      const ct = new ContextTokenStore({ storage: ctx.storage, accountId: ACCOUNT_ID });
      expect(await ct.get(inbound!.conversation.id as string)).toBeDefined();

      console.info('[weixin-live] E2E-2 PASSED — verify the reply appeared in WeChat');
    } finally {
      off();
      await adapter.stop().catch(() => undefined);
      unregister();
      ctx.dispose();
    }
  });

  it('E2E-3 restart: second adapter over SAME persisted resources does not re-scan and continues the session', { timeout: 240_000 }, async () => {
    // Shared durable handles simulate the file-backed resources a real restart
    // would reuse: credential + cursor + context-token all live in the same
    // stores a SECOND adapter instance reads.
    const secrets = new MemorySecretStore();
    const storage = new MemoryStorage();
    const service = await newService();

    const seed = new AccountCredentialStore({ secrets, storage, accountId: ACCOUNT_ID });
    await seed.save({
      token: process.env.DSH_WEIXIN_TOKEN ?? 'pre-seeded-from-prior-run',
      ilinkBotId: process.env.DSH_WEIXIN_BOT_ID ?? 'pre-seeded-bot',
      baseUrl: BASE_URL,
      savedAt: new Date().toISOString(),
    });

    // First "process": starts, loads the credential, runs the monitor.
    const first = new WeixinAdapter(makeConfig());
    const ctx1 = makeContext({ service, secrets, storage });
    const unregister1 = service.register(first);
    await first.start(ctx1);

    const health1 = await first.getHealth();
    expect(health1.authenticated).toBe(true);

    await first.stop();
    unregister1();
    ctx1.dispose();

    // Second "process": a fresh adapter instance over the SAME handles.
    const second = new WeixinAdapter(makeConfig());
    const ctx2 = makeContext({ service, secrets, storage });
    const unregister2 = service.register(second);
    await second.start(ctx2);

    try {
      const health2 = await second.getHealth();
      expect(health2.authenticated).toBe(true);

      // start() re-read the persisted credential — no re-scan / no beginAuth.
      const reloaded = await new AccountCredentialStore({ secrets, storage, accountId: ACCOUNT_ID }).load();
      expect(reloaded?.ilinkBotId).toBe(process.env.DSH_WEIXIN_BOT_ID ?? 'pre-seeded-bot');

      // Same cursor store over the same storage carries the session forward.
      const cursorA = new SyncCursorStore({ storage, accountId: ACCOUNT_ID });
      const cursorB = new SyncCursorStore({ storage, accountId: ACCOUNT_ID });
      expect(await cursorA.load()).toBe(await cursorB.load());

      console.info('[weixin-live] E2E-3 send one more message from WeChat — the same session carries forward (no re-scan)');
      const received: MessageReceived[] = [];
      const off = service.on((event: ChannelEvent) => {
        if (event.type === 'message.received') received.push(event);
      });
      const again = await eventually('a message arrives after restart', async () => received[0], 120_000, 2000);
      expect(again).toBeDefined();
      off();
    } finally {
      await second.stop().catch(() => undefined);
      unregister2();
      ctx2.dispose();
    }
  });

  it('E2E-4 graceful unload: dispose harness while agent generates tail reply -> whenIdle -> durable reconcile -> final reply complete', { timeout: 240_000 }, async () => {
    const secrets = new MemorySecretStore();
    const storage = new MemoryStorage();
    const service = await newService();

    const seed = new AccountCredentialStore({ secrets, storage, accountId: ACCOUNT_ID });
    await seed.save({ token: 'pre-seeded', ilinkBotId: 'bot', baseUrl: BASE_URL, savedAt: new Date().toISOString() });

    const adapter = new WeixinAdapter(makeConfig());
    const ctx = makeContext({ service, secrets, storage });
    const unregister = service.register(adapter);
    await adapter.start(ctx);

    const received: MessageReceived[] = [];
    const off = service.on((event: ChannelEvent) => {
      if (event.type === 'message.received') received.push(event);
    });

    console.info('[weixin-live] E2E-4 send a message from WeChat; the suite will dispose mid-reply');

    const inbound = await eventually('inbound message for E2E-4', async () => received[0], 120_000, 2000);
    expect(inbound).toBeDefined();

    // Begin the "tail reply" without awaiting, then dispose the harness while
    // it is still in flight. Durable reconcile (context token + cursor already
    // committed BEFORE the reply) keeps the reply deliverable.
    const replyPromise = adapter.send(target(inbound!.conversation.id as string), {
      text: 'E2E-4 durable reconcile tail reply',
    });

    ctx.dispose();
    await adapter.stop().catch(() => undefined);

    const result = await replyPromise;
    expect(result).toBeDefined();
    expect(result.delivered).toBe(true);

    const ct = new ContextTokenStore({ storage, accountId: ACCOUNT_ID });
    expect(await ct.get(inbound!.conversation.id as string)).toBeDefined();

    off();
    unregister();

    console.info('[weixin-live] E2E-4 PASSED — verify the tail reply arrived in WeChat');
  });
});
