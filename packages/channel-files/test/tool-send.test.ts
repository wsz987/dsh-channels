/**
 * M6 send_channel_message tool tests (plan §95 matrix).
 *
 * Covers the model-facing tool: parameters schema is EXACTLY
 * { text, attachment_id } (no recipient / channel / account / conversation /
 * user_id / openid / file_path), the request type has no recipient / file_path,
 * attachment sends resolve through the outbox, capability fail-closed, and
 * exec-signal abort handling.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChannelOutboxService,
  FileBindingStore,
  registerSendChannelMessageTool,
  SESSION_BINDING_SCHEMA_VERSION,
  type ChannelOutboundRequest,
  type SessionBinding,
} from '@wsz987/channel-harness';
import { FileChannelInboundAssetStore } from '../src/attachments/store.ts';
import { DEFAULT_ATTACHMENT_POLICY } from '../src/attachments/policy.ts';
import { resolveAttachment } from '../src/attachment-resolver.ts';
import type { ChannelAdapter, ChannelLogger, FilePart, OutboundMessage, SendResult } from '@wsz987/channel-core';

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

type Exec = any;

function execFor(sessionId: string, signal: AbortSignal = new AbortController().signal): Exec {
  return { signal, deferContext: () => {}, concludeTurn: () => {}, agent: { id: sessionId } };
}

function makeAdapter(opts: { proactiveText?: boolean; proactiveMedia?: boolean } = {}) {
  const sent: OutboundMessage[] = [];
  const adapter = {
    id: 'qq',
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
    send: async (_t: unknown, m: OutboundMessage): Promise<SendResult> => {
      sent.push(m);
      return { delivered: true, messageId: 'mid-9' };
    },
  } as unknown as ChannelAdapter;
  return { adapter, sent };
}

async function makeService(adapter: ChannelAdapter, store?: FileChannelInboundAssetStore) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-'));
  const bindings = new FileBindingStore(join(dir, 'bindings.json'));
  await bindings.put(makeBinding({ sessionId: 'S', conversationId: 'c' }));
  const service = new ChannelOutboxService({
    bindingStore: bindings,
    getAdapter: () => adapter,
    attachmentResolver: store
      ? (attachmentId, sessionId) => resolveAttachment(attachmentId, sessionId, store, {
          policy: DEFAULT_ATTACHMENT_POLICY,
        })
      : undefined,
    logger: silentLogger,
  });
  return { service, dir };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-tool-asset-'));
}

describe('send_channel_message schema (plan §62 / §95)', () => {
  it('parameter keys are EXACTLY text + attachment_id (no recipient/channel/account/conversation/user_id/openid/file_path)', async () => {
    const { adapter } = makeAdapter();
    const { service, dir } = await makeService(adapter);
    try {
      const def: any = registerSendChannelMessageTool({ outbox: service });
      const params = def.parameters as { properties: Record<string, any> };
      expect(params.properties).toBeDefined();
      expect(Object.keys(params.properties).sort()).toEqual(['attachment_id', 'text']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the request type has NO recipient field (type-level, plan §95)', () => {
    const req: ChannelOutboundRequest = { text: 'hello' };
    expect(req.text).toBe('hello');
    // @ts-expect-error - recipient must NOT exist on ChannelOutboundRequest (plan §95)
    const withRecipient: ChannelOutboundRequest = { recipient: 'someone' };
    void withRecipient;
  });

  it('the request type has NO file_path field (type-level, plan §95)', () => {
    // @ts-expect-error - model file_path must NOT exist anywhere (plan §95)
    const withFilePath: ChannelOutboundRequest = { file_path: '/tmp/x' };
    void withFilePath;
  });

  it('at least one of text/attachment_id is required by the tool execute path', async () => {
    const { adapter } = makeAdapter();
    const { service, dir } = await makeService(adapter);
    try {
      const def: any = registerSendChannelMessageTool({ outbox: service });
      await expect(def.execute({}, execFor('S'))).rejects.toMatchObject({
        code: 'INVALID_ARGS',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('send_channel_message execution (plan §95)', () => {
  it('text send: session-id-scoped, renders a confirmation with messageId', async () => {
    const { adapter, sent } = makeAdapter();
    const { service, dir } = await makeService(adapter);
    try {
      const def: any = registerSendChannelMessageTool({ outbox: service });
      const value = await def.execute({ text: 'hi' }, execFor('S'));
      expect(value.delivered).toBe(true);
      expect(value.messageId).toBe('mid-9');
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toBe('hi');
      const blocks = def.output.render({ text: 'hi' }, value);
      const text = blocks.map((b: any) => b.text).join('');
      expect(text).toContain('Message sent');
      expect(text).toContain('mid-9');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('foreign attachment DENY through the tool -> ATTACHMENT_ACCESS_DENIED, no send', async () => {
    const dir = await tempRoot();
    try {
      const assets = new FileChannelInboundAssetStore({ root: join(dir, 'assets') });
      // asset owned by another session, but the tool runs as 'S'
      await assets.put({
        attachmentId: 'att-other',
        sessionId: 'OTHER',
        channelId: 'qq',
        accountId: 'main',
        conversationId: 'x',
        messageId: 'm',
        kind: 'file',
        name: 'x.bin',
        data: new Uint8Array([9, 9]),
      });
      const { adapter, sent } = makeAdapter();
      const { service, dir: d } = await makeService(adapter, assets);
      try {
        const def: any = registerSendChannelMessageTool({ outbox: service });
        await expect(def.execute({ attachment_id: 'att-other' }, execFor('S'))).rejects.toMatchObject({
          code: 'ATTACHMENT_ACCESS_DENIED',
        });
        expect(sent).toHaveLength(0);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('attachment send through the tool: FilePart.localData === stored bytes', async () => {
    const dir = await tempRoot();
    try {
      const assets = new FileChannelInboundAssetStore({ root: join(dir, 'assets') });
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await assets.put({
        attachmentId: 'att-own',
        sessionId: 'S',
        channelId: 'qq',
        accountId: 'main',
        conversationId: 'c',
        messageId: 'm',
        kind: 'file',
        name: 'doc.pdf',
        data: bytes,
      });
      const { adapter, sent } = makeAdapter();
      const { service, dir: d } = await makeService(adapter, assets);
      try {
        const def: any = registerSendChannelMessageTool({ outbox: service });
        const value = await def.execute({ attachment_id: 'att-own' }, execFor('S'));
        expect(value.delivered).toBe(true);
        expect(sent).toHaveLength(1);
        const file = sent[0].parts![0] as FilePart;
        expect(file.type).toBe('file');
        expect(Array.from(file.localData!)).toEqual(Array.from(bytes));
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('text + attachment keeps text and preserves the stored media kind', async () => {
    const dir = await tempRoot();
    try {
      const assets = new FileChannelInboundAssetStore({ root: join(dir, 'assets') });
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await assets.put({
        attachmentId: 'video-own',
        sessionId: 'S',
        channelId: 'qq',
        accountId: 'main',
        conversationId: 'c',
        messageId: 'm',
        kind: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        data: bytes,
      });
      const { adapter, sent } = makeAdapter();
      const { service, dir: d } = await makeService(adapter, assets);
      try {
        const def: any = registerSendChannelMessageTool({ outbox: service });
        await def.execute({ text: '附言', attachment_id: 'video-own' }, execFor('S'));

        expect(sent).toHaveLength(1);
        expect(sent[0].text).toBe('附言');
        expect(sent[0].parts).toHaveLength(1);
        expect(sent[0].parts![0]).toMatchObject({
          type: 'video',
          name: 'clip.mp4',
          localData: bytes,
        });
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('send_channel_message capability + abort (plan §69/§71)', () => {
  it('capability fail-closed: proactiveText=false -> OUTBOX_CAPABILITY_UNAVAILABLE', async () => {
    const { adapter, sent } = makeAdapter({ proactiveText: false });
    const { service, dir } = await makeService(adapter);
    try {
      const def: any = registerSendChannelMessageTool({ outbox: service });
      await expect(def.execute({ text: 'x' }, execFor('S'))).rejects.toMatchObject({
        code: 'OUTBOX_CAPABILITY_UNAVAILABLE',
      });
      expect(sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('default derivation (no outboxCapabilities getter) -> proactiveText true', async () => {
    const adapter = {
      id: 'qq',
      capabilities: { image: false, file: false },
      send: async (_t: unknown, _m: OutboundMessage): Promise<SendResult> => ({ delivered: true }),
    } as unknown as ChannelAdapter;
    const { service, dir } = await makeService(adapter);
    try {
      const def: any = registerSendChannelMessageTool({ outbox: service });
      const value = await def.execute({ text: 'ok' }, execFor('S'));
      expect(value.delivered).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('abort mid-send: an aborted exec signal rejects before/at the send', async () => {
    const { adapter, sent } = makeAdapter();
    const { service, dir } = await makeService(adapter);
    try {
      const def: any = registerSendChannelMessageTool({ outbox: service });
      const controller = new AbortController();
      controller.abort();
      await expect(def.execute({ text: 'x' }, execFor('S', controller.signal))).rejects.toBeInstanceOf(Error);
      expect(sent).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
