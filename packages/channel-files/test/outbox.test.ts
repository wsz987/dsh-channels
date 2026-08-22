/**
 * M6 durable outbox service tests (plan §95 matrix).
 *
 * Covers the durable binding authority path: current binding PASS, restart
 * PASS (a NEW service against the same on-disk files), old session after /new
 * DENY (OUTBOX_NO_BINDING), ambiguous binding DENY, foreign attachment DENY,
 * attachment send (FilePart.localData === stored bytes), and capability
 * fail-closed.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelOutboxService,
  FileBindingStore,
  SESSION_BINDING_SCHEMA_VERSION,
  type SessionBinding,
  type SessionBindingStore,
} from '@wsz987/channel-harness';
import { FileChannelInboundAssetStore } from '../src/attachments/store.ts';
import { DEFAULT_ATTACHMENT_POLICY } from '../src/attachments/policy.ts';
import { resolveAttachment } from '../src/attachment-resolver.ts';
import type { ChannelAdapter, ChannelLogger, OutboundMessage, SendResult } from '@wsz987/channel-core';

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    channelId: 'qq',
    accountId: 'main',
    conversationId: 'u1',
    conversationType: 'dm',
    sessionId: 's1',
    route: { model: 'm' },
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const silentLogger: ChannelLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

interface CapturedSend {
  target: unknown;
  message: OutboundMessage;
}

function makeFakeAdapter(opts: {
  id?: string;
  proactiveText?: boolean;
  proactiveMedia?: boolean;
  sendError?: unknown;
} = {}) {
  const sent: CapturedSend[] = [];
  const adapter = {
    id: opts.id ?? 'qq',
    capabilities: {
      text: true,
      image: true,
      file: true,
      audio: true,
      video: true,
      markdown: false,
      cards: false,
      reactions: false,
      threads: false,
      streaming: 'buffered',
    },
    outboxCapabilities: {
      proactiveText: opts.proactiveText ?? true,
      proactiveMedia: opts.proactiveMedia ?? true,
    },
    send: async (target: unknown, message: OutboundMessage): Promise<SendResult> => {
      if (opts.sendError !== undefined) throw opts.sendError;
      sent.push({ target, message });
      return { delivered: true, messageId: 'mid-1' };
    },
  };
  return { adapter: adapter as unknown as ChannelAdapter, sent };
}

function buildService(opts: {
  bindingStore: SessionBindingStore;
  adapter: ChannelAdapter;
  store?: FileChannelInboundAssetStore;
}) {
  return new ChannelOutboxService({
    bindingStore: opts.bindingStore,
    getAdapter: () => opts.adapter,
    attachmentResolver: opts.store
      ? (attachmentId, sessionId) => resolveAttachment(attachmentId, sessionId, opts.store!, {
          policy: DEFAULT_ATTACHMENT_POLICY,
        })
      : undefined,
    logger: silentLogger,
  });
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-outbox-'));
}

/** A FileBindingStore backed by a real on-disk JSON file inside a fresh temp dir. */
async function tempBindings(): Promise<{ store: FileBindingStore; dir: string }> {
  const dir = await tempRoot();
  return { store: new FileBindingStore(join(dir, 'bindings.json')), dir };
}

describe('durable binding authority (plan §58 / §95)', () => {
  it('current durable binding PASS: adapter.send called with the binding-derived target', async () => {
    const dir = await tempRoot();
    try {
      const store = new FileBindingStore(join(dir, 'bindings.json'));
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'priv' }));
      const { adapter, sent } = makeFakeAdapter();
      const service = buildService({ bindingStore: store, adapter });
      const result = await service.send('S', { text: 'hello' });
      expect(result.delivered).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].target).toMatchObject({
        channelId: 'qq',
        accountId: 'main',
        conversationId: 'priv',
        conversationType: 'dm',
      });
      expect(sent[0].message.text).toBe('hello');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('restart PASS: a NEW service against the same on-disk files still sends', async () => {
    const dir = await tempRoot();
    try {
      const bindingsFile = join(dir, 'bindings.json');
      // First instance writes the binding.
      await new FileBindingStore(bindingsFile).put(makeBinding({ sessionId: 'R', conversationId: 'c' }));

      // Second (fresh) service against the SAME files — durable authority, not
      // any in-memory agent cache.
      const reopened = new FileBindingStore(bindingsFile);
      const { adapter, sent } = makeFakeAdapter();
      const service = buildService({ bindingStore: reopened, adapter });
      const result = await service.send('R', { text: 'after restart' });
      expect(result.delivered).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].target).toMatchObject({ conversationId: 'c' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('old session after /new DENY: retired A has no binding -> OUTBOX_NO_BINDING, B unaffected', async () => {
    const dir = await tempRoot();
    try {
      const store = new FileBindingStore(join(dir, 'bindings.json'));
      // A was retired, B is current.
      await store.put(makeBinding({ sessionId: 'A', conversationId: 'a' }));
      await store.delete('qq:main:a');
      await store.put(makeBinding({ sessionId: 'B', conversationId: 'b' }));
      const { adapter, sent } = makeFakeAdapter();
      const service = buildService({ bindingStore: store, adapter });
      await expect(service.send('A', { text: 'x' })).rejects.toMatchObject({
        code: 'OUTBOX_NO_BINDING',
      });
      expect(sent).toHaveLength(0);
      const result = await service.send('B', { text: 'ok' });
      expect(result.delivered).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ambiguous binding DENY: two current bindings for one session -> OUTBOX_AMBIGUOUS_BINDING, no send', async () => {
    const dir = await tempRoot();
    try {
      const store = new FileBindingStore(join(dir, 'bindings.json'));
      await store.put(makeBinding({ sessionId: 'DUP', conversationId: 'one' }));
      await store.put(makeBinding({ sessionId: 'DUP', conversationId: 'two' }));
      const { adapter, sent } = makeFakeAdapter();
      const service = buildService({ bindingStore: store, adapter });
      await expect(service.send('DUP', { text: 'x' })).rejects.toMatchObject({
        code: 'OUTBOX_AMBIGUOUS_BINDING',
      });
      expect(sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('foreign attachment DENY: asset owned by B, send as A -> ATTACHMENT_ACCESS_DENIED', async () => {
    const dir = await tempRoot();
    try {
      const bindings = new FileBindingStore(join(dir, 'bindings.json'));
      await bindings.put(makeBinding({ sessionId: 'A', conversationId: 'a' }));
      await bindings.put(makeBinding({ sessionId: 'B', conversationId: 'b' }));
      const assets = new FileChannelInboundAssetStore({ root: join(dir, 'assets') });
      await assets.put({
        attachmentId: 'att-b',
        sessionId: 'B',
        channelId: 'qq',
        accountId: 'main',
        conversationId: 'b',
        messageId: 'm',
        kind: 'file',
        name: 'b.txt',
        data: new TextEncoder().encode('owned by B'),
      });
      const { adapter, sent } = makeFakeAdapter();
      const service = buildService({ bindingStore: bindings, adapter, store: assets });
      await expect(service.send('A', { attachmentId: 'att-b' })).rejects.toMatchObject({
        code: 'ATTACHMENT_ACCESS_DENIED',
      });
      expect(sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('missing attachment id -> ATTACHMENT_NOT_FOUND', async () => {
    const dir = await tempRoot();
    try {
      const store = new FileBindingStore(join(dir, 'bindings.json'));
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const assets = new FileChannelInboundAssetStore({ root: join(dir, 'assets') });
      const { adapter, sent } = makeFakeAdapter();
      const service = buildService({ bindingStore: store, adapter, store: assets });
      await expect(service.send('S', { attachmentId: 'nope' })).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
      expect(sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('attachment send (plan §63)', () => {
  it.each(['file', 'audio', 'video'] as const)(
    'attachment_id preserves stored %s kind and localData',
    async (kind) => {
      const dir = await tempRoot();
      try {
        const bindings = new FileBindingStore(join(dir, 'bindings.json'));
        await bindings.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
        const assets = new FileChannelInboundAssetStore({ root: join(dir, 'assets') });
        const bytes = new TextEncoder().encode('attachment-bytes');
        await assets.put({
          attachmentId: 'att-1',
          sessionId: 'S',
          channelId: 'qq',
          accountId: 'main',
          conversationId: 'c',
          messageId: 'm',
          kind,
          name: 'report.pdf',
          mimeType: 'application/pdf',
          data: bytes,
        });
        const { adapter, sent } = makeFakeAdapter();
        const service = buildService({ bindingStore: bindings, adapter, store: assets });
        const result = await service.send('S', { attachmentId: 'att-1' });
        expect(result.delivered).toBe(true);
        expect(sent).toHaveLength(1);
        const parts = sent[0].message.parts;
        expect(parts).toHaveLength(1);
        const part = parts![0];
        expect(part.type).toBe(kind);
        expect('localData' in part && part.localData).toBeInstanceOf(Uint8Array);
        expect('localData' in part && Array.from(part.localData!)).toEqual(Array.from(bytes));
        expect('name' in part && part.name).toBe('report.pdf');
        // The store re-verifies mime by magic sniffing (plan §47): text bytes are
        // sniffed text/plain, overriding the adapter hint.
        expect('mimeType' in part && part.mimeType).toBe('text/plain');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('a generic resolver can preserve image kind without a channel-specific branch', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const { adapter, sent } = makeFakeAdapter();
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const service = new ChannelOutboxService({
        bindingStore: store,
        getAdapter: () => adapter,
        attachmentResolver: async () => ({
          kind: 'image',
          data: bytes,
          name: 'photo.png',
          mimeType: 'image/png',
        }),
        logger: silentLogger,
      });

      await service.send('S', { attachmentId: 'image-1' });

      expect(sent[0].message.parts).toEqual([{
        type: 'image',
        localData: bytes,
        name: 'photo.png',
        mimeType: 'image/png',
      }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the adapter cannot send the resolved media kind', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const { adapter, sent } = makeFakeAdapter();
      adapter.capabilities.audio = false;
      const service = new ChannelOutboxService({
        bindingStore: store,
        getAdapter: () => adapter,
        attachmentResolver: async () => ({
          kind: 'audio',
          data: new Uint8Array([1, 2]),
          name: 'voice.wav',
          mimeType: 'audio/wav',
        }),
        logger: silentLogger,
      });

      await expect(service.send('S', { attachmentId: 'audio-1' })).rejects.toMatchObject({
        code: 'OUTBOX_CAPABILITY_UNAVAILABLE',
      });
      expect(sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('proactive capability gate (plan §69 / §71)', () => {
  it('fail closed: outboxCapabilities.proactiveText=false -> OUTBOX_CAPABILITY_UNAVAILABLE', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const { adapter, sent } = makeFakeAdapter({ proactiveText: false });
      const service = buildService({ bindingStore: store, adapter });
      await expect(service.send('S', { text: 'x' })).rejects.toMatchObject({
        code: 'OUTBOX_CAPABILITY_UNAVAILABLE',
      });
      expect(sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fail closed: proactiveMedia=false with an attachment -> OUTBOX_CAPABILITY_UNAVAILABLE', async () => {
    const { store, dir } = await tempBindings();
    const assetsDir = await tempRoot();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const { adapter, sent } = makeFakeAdapter({ proactiveMedia: false });
      const assets = new FileChannelInboundAssetStore({ root: assetsDir });
      const service = buildService({ bindingStore: store, adapter, store: assets });
      await expect(service.send('S', { attachmentId: 'att-x' })).rejects.toMatchObject({
        code: 'OUTBOX_CAPABILITY_UNAVAILABLE',
      });
      expect(sent).toHaveLength(0);
    } finally {
      await rm(assetsDir, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('default derivation (no outboxCapabilities getter) -> proactiveText true', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const adapter = {
        id: 'qq',
        capabilities: { image: false, file: false },
        send: async (_t: unknown, _m: OutboundMessage): Promise<SendResult> => ({ delivered: true }),
      } as unknown as ChannelAdapter;
      const service = buildService({ bindingStore: store, adapter });
      const result = await service.send('S', { text: 'hi' });
      expect(result.delivered).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('default derivation allows proactive media when only video=true', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const sent: OutboundMessage[] = [];
      const adapter = {
        id: 'qq',
        capabilities: {
          text: true,
          image: false,
          file: false,
          audio: false,
          video: true,
          markdown: false,
          cards: false,
          reactions: false,
          threads: false,
          streaming: 'buffered',
        },
        send: async (_target: unknown, message: OutboundMessage): Promise<SendResult> => {
          sent.push(message);
          return { delivered: true };
        },
      } as unknown as ChannelAdapter;
      const service = new ChannelOutboxService({
        bindingStore: store,
        getAdapter: () => adapter,
        attachmentResolver: async () => ({
          kind: 'video',
          data: new Uint8Array([1, 2, 3]),
          name: 'clip.mp4',
          mimeType: 'video/mp4',
        }),
        logger: silentLogger,
      });

      await expect(service.send('S', { attachmentId: 'video-1' })).resolves.toMatchObject({
        delivered: true,
      });
      expect(sent[0].parts?.[0]).toMatchObject({ type: 'video', name: 'clip.mp4' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no adapter for the bound channel -> OUTBOX_CAPABILITY_UNAVAILABLE', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', channelId: 'ghost', conversationId: 'c' }));
      const service = new ChannelOutboxService({
        bindingStore: store,
        getAdapter: () => undefined,
        logger: silentLogger,
      });
      await expect(service.send('S', { text: 'x' })).rejects.toMatchObject({
        code: 'OUTBOX_CAPABILITY_UNAVAILABLE',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no text and no attachment -> typed validation failure', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const { adapter } = makeFakeAdapter();
      const service = buildService({ bindingStore: store, adapter });
      await expect(service.send('S', {})).rejects.toMatchObject({
        code: 'OUTBOX_CAPABILITY_UNAVAILABLE',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('send error propagation (never swallowed)', () => {
  it('adapter.send rejection propagates to the caller', async () => {
    const { store, dir } = await tempBindings();
    try {
      await store.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
      const { adapter } = makeFakeAdapter({ sendError: new Error('platform down') });
      const service = buildService({ bindingStore: store, adapter });
      await expect(service.send('S', { text: 'x' })).rejects.toThrow('platform down');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
