/**
 * Private Channel Asset Store (plan \u00a742-\u00a747).
 *
 * Covers the on-disk v1 layout, put/get round-trip, bounded `readRaw`, atomic
 * staging publish (a half-written .staging tree is never visible to readers),
 * filename sanitization, magic MIME sniffing, SHA-256 correctness and the
 * two-phase extraction (`putExtracted` -> `readExtracted`).
 */
import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { FileChannelInboundAssetStore, AssetStoreError } from '../src/attachments/store.ts';
import { sanitizeFilename } from '../src/attachments/filename.ts';
import { verifiedMime } from '../src/attachments/mime.ts';
import { sha256Hex } from '../src/attachments/hash.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

async function mkdtempTmp(): Promise<string> {
  const dir = await import('node:os').then((os) => os.tmpdir());
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(dir, 'dsh-asset-'));
}

async function makeStore(root?: string): Promise<FileChannelInboundAssetStore> {
  const r = root ?? (await mkdtempTmp());
  return new FileChannelInboundAssetStore({ root: r });
}

describe('asset store disk layout + round-trip', () => {
  it('put writes meta.json + raw.bin under the v1 layout and get round-trips', async () => {
    const root = await mkdtempTmp();
    try {
      const store = await makeStore(root);
      const data = new TextEncoder().encode('hello asset');
      const asset = await store.put({
        attachmentId: 'att-1',
        sessionId: 'sess-1',
        channelId: 'weixin',
        accountId: 'main',
        conversationId: 'u1',
        conversationType: 'dm',
        messageId: 'msg-1',
        kind: 'file',
        name: 'note.txt',
        data,
      });
      // Layout: <root>/sessions/sess-1/msg-1/att-1/{meta.json, raw.bin}
      const dir = join(root, 'sessions', 'sess-1', 'msg-1', 'att-1');
      expect(existsSync(join(dir, 'meta.json'))).toBe(true);
      expect(existsSync(join(dir, 'raw.bin'))).toBe(true);
      const raw = await readFile(join(dir, 'raw.bin'));
      expect(Buffer.from(raw).equals(Buffer.from(data))).toBe(true);
      expect(asset.bytes).toBe(data.byteLength);
      expect(asset.sha256).toBe(sha256Hex(data));

      const reread = await store.get('att-1');
      expect(reread).toEqual(asset);
      // sha256 stored in meta matches the recomputation.
      expect(reread?.sha256).toBe(sha256Hex(data));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('get returns undefined for an unknown attachment id', async () => {
    const root = await mkdtempTmp();
    try {
      const store = await makeStore(root);
      expect(await store.get('nope')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('readRaw returns the exact bytes; readRaw is bounded by maxBytes', async () => {
    const root = await mkdtempTmp();
    try {
      const store = await makeStore(root);
      const data = new TextEncoder().encode('0123456789');
      await store.put({
        attachmentId: 'att-raw',
        sessionId: 's',
        channelId: 'weixin',
        accountId: 'main',
        conversationId: 'u1',
        messageId: 'm',
        kind: 'file',
        name: 'raw.bin',
        data,
      });
      const got = await store.readRaw('att-raw', { maxBytes: 1000 });
      expect(Buffer.from(got).toString('utf8')).toBe('0123456789');
      await expect(store.readRaw('att-raw', { maxBytes: 5 })).rejects.toBeInstanceOf(AssetStoreError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('put rejects bytes over the inbound cap', async () => {
    const root = await mkdtempTmp();
    try {
      const store = new FileChannelInboundAssetStore({
        root,
        policy: { maxInboundBytes: 16, extract: { maxInputBytes: 8, maxOutputBytes: 8 } },
      });
      const big = new Uint8Array(32);
      await expect(
        store.put({
          attachmentId: 'att-big',
          sessionId: 's',
          channelId: 'wx',
          accountId: 'a',
          conversationId: 'c',
          messageId: 'm',
          kind: 'file',
          name: 'big.bin',
          data: big,
        }),
      ).rejects.toBeInstanceOf(AssetStoreError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('atomic publish (plan \u00a744)', () => {
  it('a half-written .staging tree is never visible to get()', async () => {
    const root = await mkdtempTmp();
    try {
      const store = await makeStore(root);
      // Simulate a crash mid-write: a staging dir with a partial asset that was
      // never renamed onto the final path.
      const staging = join(root, '.staging', 'crashed-uuid');
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'raw.bin'), Buffer.from('partial'));
      await writeFile(join(staging, 'meta.json'), JSON.stringify({ attachmentId: 'att-crash' }));
      // Readers never see it because there is no durable index entry and the
      // final layout directory does not exist.
      expect(await store.get('att-crash')).toBeUndefined();
      expect(existsSync(join(root, 'sessions', 's', 'm', 'att-crash'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a fresh asset atomically (staging dir is cleaned up)', async () => {
    const root = await mkdtempTmp();
    try {
      const store = await makeStore(root);
      await store.put({
        attachmentId: 'att-ok',
        sessionId: 's',
        channelId: 'wx',
        accountId: 'a',
        conversationId: 'c',
        messageId: 'm',
        kind: 'file',
        name: 'ok.txt',
        data: new TextEncoder().encode('x'),
      });
      // No leftover staging directories.
      const staging = join(root, '.staging');
      const leftover = existsSync(staging) ? await readdir(staging) : [];
      expect(leftover).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('filename sanitization (plan \u00a747)', () => {
  it('strips path separators, control chars and leading dots', () => {
    expect(sanitizeFilename('../..\/evil.exe')).toBe('evil.exe');
    expect(sanitizeFilename('a\u0000b.txt')).toBe('ab.txt');
    expect(sanitizeFilename('.hidden')).not.toMatch(/^\./);
    expect(sanitizeFilename('  ')).toBe('attachment');
    expect(sanitizeFilename(undefined)).toBe('attachment');
  });

  it('bounds the length while preserving the extension', () => {
    const long = 'x'.repeat(200) + '.pdf';
    const out = sanitizeFilename(long, { maxLength: 20 });
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });
});

describe('MIME sniffing + SHA-256 (plan \u00a747)', () => {
  it('sniffs PNG and PDF magic despite a wrong adapter hint', () => {
    expect(verifiedMime(PNG, 'application/octet-stream')).toBe('image/png');
    expect(verifiedMime(PDF, 'text/plain')).toBe('application/pdf');
  });

  it('treats printable text as text/plain', () => {
    expect(verifiedMime(new TextEncoder().encode('hello world'), 'application/x-whatever')).toBe('text/plain');
  });
});

describe('extraction two-phase (plan \u00a743)', () => {
  it('putExtracted writes extracted.md and setExtraction exposes it via readExtracted', async () => {
    const root = await mkdtempTmp();
    try {
      const store = await makeStore(root);
      await store.put({
        attachmentId: 'att-x',
        sessionId: 's',
        channelId: 'wx',
        accountId: 'a',
        conversationId: 'c',
        messageId: 'm',
        kind: 'file',
        name: 'doc.md',
        data: new TextEncoder().encode('raw'),
      });
      // Not yet ready.
      expect(await store.readExtracted('att-x', { maxBytes: 1024 })).toBeUndefined();

      await store.putExtracted('att-x', { text: '# title\nbody', format: 'markdown' });
      const meta = await store.get('att-x');
      expect(meta?.extraction.status).toBe('ready');
      expect(meta?.extraction.format).toBe('markdown');
      const extracted = await store.readExtracted('att-x', { maxBytes: 1024 });
      expect(extracted).toContain('# title');
      expect(existsSync(join(root, 'sessions', 's', 'm', 'att-x', 'extracted.md'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('readExtracted is bounded', async () => {
    const root = await mkdtempTmp();
    try {
      const store = await makeStore(root);
      await store.put({
        attachmentId: 'att-y',
        sessionId: 's',
        channelId: 'wx',
        accountId: 'a',
        conversationId: 'c',
        messageId: 'm',
        kind: 'file',
        name: 'a.md',
        data: new TextEncoder().encode('raw'),
      });
      await store.putExtracted('att-y', { text: 'a longer extracted body', format: 'text' });
      await expect(store.readExtracted('att-y', { maxBytes: 4 })).rejects.toBeInstanceOf(AssetStoreError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
