/**
 * M4 read_channel_attachment tool tests (plan §94 matrix).
 *
 * Uses a REAL FileChannelInboundAssetStore pointed at a temp dir (mirroring
 * asset-store.test.ts). The ACL is sessionId-bound: same cwd + different
 * session is DENIED (plan §42), unknown id NOT_FOUND, own session PASS.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChannelInboundAssetStore } from '../src/attachments/store.js';
import {
  registerReadChannelAttachmentTool,
  AttachmentReadError,
} from '../src/attachments/tool-read.js';
import { DEFAULT_ATTACHMENT_POLICY } from '../src/attachments/policy.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-tool-'));
}

type Exec = any;

async function putFile(
  store: FileChannelInboundAssetStore,
  opts: { id: string; session: string; name: string; lines: string[] },
): Promise<void> {
  const data = new TextEncoder().encode(opts.lines.join('\n'));
  await store.put({
    attachmentId: opts.id,
    sessionId: opts.session,
    channelId: 'weixin',
    accountId: 'main',
    conversationId: 'u1',
    conversationType: 'dm',
    messageId: 'msg',
    kind: 'file',
    name: opts.name,
    data,
  });
  await store.putExtracted(opts.id, { text: opts.lines.join('\n'), format: 'text' });
}

function execFor(sessionId: string | undefined, signal: AbortSignal = new AbortController().signal): Exec {
  const base = {
    signal,
    deferContext: () => {},
    concludeTurn: () => {},
  };
  return sessionId === undefined ? base : { ...base, agent: { id: sessionId } };
}

describe('read_channel_attachment ACL (plan §53 / §94)', () => {
  it('own session asset -> PASS', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      await putFile(store, { id: 'att-own', session: 's1', name: 'own.txt', lines: ['line one', 'line two'] });
      const def = registerReadChannelAttachmentTool({ store });
      const result: any = await def.execute(
        { attachment_id: 'att-own' },
        execFor('s1'),
      );
      expect(result.readable).toBe(true);
      expect(result.text).toContain('line one');
      expect(result.name).toBe('own.txt');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('other session -> ATTACHMENT_ACCESS_DENIED', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      await putFile(store, { id: 'att-a', session: 'sA', name: 'a.txt', lines: ['secret'] });
      const def = registerReadChannelAttachmentTool({ store });
      await expect(def.execute({ attachment_id: 'att-a' }, execFor('sB'))).rejects.toMatchObject({
        code: 'ATTACHMENT_ACCESS_DENIED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('unknown id -> ATTACHMENT_NOT_FOUND', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      const def = registerReadChannelAttachmentTool({ store });
      await expect(def.execute({ attachment_id: 'nope' }, execFor('s1'))).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('same cwd + other session -> ATTACHMENT_ACCESS_DENIED', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      await putFile(store, { id: 'att-c', session: 'sX', name: 'c.txt', lines: ['x'] });
      await putFile(store, { id: 'att-d', session: 'sY', name: 'd.txt', lines: ['y'] });
      const def = registerReadChannelAttachmentTool({ store });
      // Same store root (same cwd), but the asset belongs to sX while the caller is sY.
      await expect(def.execute({ attachment_id: 'att-c' }, execFor('sY'))).rejects.toMatchObject({
        code: 'ATTACHMENT_ACCESS_DENIED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('read_channel_attachment pagination + caps (plan §94)', () => {
  it('offset -> PASS', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      await putFile(store, { id: 'att-p', session: 's1', name: 'p.txt', lines: ['L1', 'L2', 'L3'] });
      const def = registerReadChannelAttachmentTool({ store });
      const r: any = await def.execute({ attachment_id: 'att-p', offset: 2 }, execFor('s1'));
      expect(r.offset).toBe(2);
      expect(r.text).toContain('L2');
      expect(r.text).not.toContain('L1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('limit -> PASS', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      await putFile(store, { id: 'att-l', session: 's1', name: 'l.txt', lines: ['A', 'B', 'C'] });
      const def = registerReadChannelAttachmentTool({ store });
      const r: any = await def.execute({ attachment_id: 'att-l', limit: 2 }, execFor('s1'));
      expect(r.limit).toBe(2);
      expect(r.returned).toBe(2);
      expect(r.truncated).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('output max -> PASS (returned window stays within the output cap)', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      const policy = {
        maxInboundBytes: 104857600,
        extract: { maxInputBytes: 33554432, maxOutputBytes: 12 },
      };
      const storeWithCap = new FileChannelInboundAssetStore({ root, policy });
      await storeWithCap.put({
        attachmentId: 'att-cap',
        sessionId: 's1',
        channelId: 'wx',
        accountId: 'a',
        conversationId: 'c',
        messageId: 'm',
        kind: 'file',
        name: 'cap.txt',
        data: new TextEncoder().encode('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
      });
      await storeWithCap.putExtracted('att-cap', { text: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', format: 'text' });
      const def = registerReadChannelAttachmentTool({ store: storeWithCap, policy });
      // The file/read cap is 12 bytes; the tool degrades an over-cap read into a
      // bounded (empty here) window instead of overflowing the model surface.
      const r: any = await def.execute({ attachment_id: 'att-cap' }, execFor('s1'));
      expect(r.readable).toBe(true);
      expect(new TextEncoder().encode(r.text).byteLength).toBeLessThanOrEqual(12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('abort -> PASS (an aborted signal rejects the execution)', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      await putFile(store, { id: 'att-abort', session: 's1', name: 'ab.txt', lines: ['x', 'y'] });
      const def = registerReadChannelAttachmentTool({ store });
      const controller = new AbortController();
      controller.abort();
      await expect(def.execute({ attachment_id: 'att-abort' }, execFor('s1', controller.signal))).rejects.toBeInstanceOf(Error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('non-ready asset returns readable:false', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      // No putExtracted -> not-ready.
      await store.put({
        attachmentId: 'att-nr',
        sessionId: 's1',
        channelId: 'wx',
        accountId: 'a',
        conversationId: 'c',
        messageId: 'm',
        kind: 'file',
        name: 'x.bin',
        data: new Uint8Array([1, 2, 3]),
      });
      const def = registerReadChannelAttachmentTool({ store });
      const r: any = await def.execute({ attachment_id: 'att-nr' }, execFor('s1'));
      expect(r.readable).toBe(false);
      expect(r.text).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('read_channel_attachment schema + render (plan §94)', () => {
  it('schema -> PASS (only attachment_id/offset/limit parameters)', async () => {
    const store = new FileChannelInboundAssetStore({ root: await tempRoot() });
    const def: any = registerReadChannelAttachmentTool({ store });
    const params = def.parameters as { properties: Record<string, any> };
    // defineTool compiles the parameter map into a JSON-Schema object root.
    expect(params.properties).toBeDefined();
    expect(Object.keys(params.properties).sort()).toEqual(['attachment_id', 'limit', 'offset']);
    expect(params.properties['attachment_id']).toMatchObject({ type: 'string' });
  });

  it('render -> PASS (descriptor leads the surface)', async () => {
    const root = await tempRoot();
    try {
      const store = new FileChannelInboundAssetStore({ root });
      await putFile(store, { id: 'att-render', session: 's1', name: 'render.txt', lines: ['body'] });
      const def: any = registerReadChannelAttachmentTool({ store });
      const value = await def.execute({ attachment_id: 'att-render' }, execFor('s1'));
      const blocks = def.output.render({ attachment_id: 'att-render' }, value);
      const text = blocks.map((b: any) => b.text).join('');
      expect(text).toContain('att-render');
      expect(text).toContain('render.txt');
      expect(text).toContain('readable');
      expect(text).toContain('body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
