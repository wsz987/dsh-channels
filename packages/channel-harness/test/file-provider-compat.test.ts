/**
 * ChannelAttachmentProvider compatibility.
 *
 * The canonical provider port is `ChannelAttachmentProvider`; the deprecated
 * `ChannelFile*` aliases keep old imports working. `installCompatibilityTools`
 * is OPTIONAL — a provider without it (or one still carrying the legacy
 * `installTools` member) must remain assignable and must still install its
 * tools at runtime.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { installAttachmentCompatibilityTools, liveAttachmentProvider } from '../src/file-provider.ts';
import type {
  ChannelAttachmentContext,
  ChannelAttachmentDescriptor,
  ChannelAttachmentProvider,
  ChannelFileContext,
  ChannelFileDescriptor,
  ChannelFileProvider,
} from '../src/file-provider.ts';
import type { StoredBinaryPart } from '../src/message-converter.ts';

const baseStore = async (_context: ChannelAttachmentContext, _part: StoredBinaryPart) =>
  undefined;
const baseResolve = async () => ({ kind: 'file' as const, data: new Uint8Array(), name: 'a.bin' });

// 1. installCompatibilityTools is optional: a provider WITHOUT it satisfies
//    the canonical interface (tool install is not core).
const providerWithoutTools = {
  store: baseStore,
  resolveAttachment: baseResolve,
} satisfies ChannelAttachmentProvider;

// 2. A provider WITH the compatibility path also satisfies it.
const providerWithTools = {
  store: baseStore,
  resolveAttachment: baseResolve,
  installCompatibilityTools: async (_agentContext: Context) => {},
} satisfies ChannelAttachmentProvider;

// 3. Deprecated aliases stay assignable from the canonical interfaces.
const legacyProvider: ChannelFileProvider = providerWithTools;
const legacyContext: ChannelAttachmentContext = {} as ChannelFileContext;
const legacyDescriptor: ChannelAttachmentDescriptor = {} as ChannelFileDescriptor;

// 4. A legacy implementation that still carries the old member name satisfies
//    the new port during the compatibility cycle.
const legacyShaped = {
  store: baseStore,
  resolveAttachment: baseResolve,
  installTools: async () => {},
};
const legacyShapedProvider: ChannelAttachmentProvider = legacyShaped;

describe('ChannelAttachmentProvider compatibility', () => {
  it('accepts providers with and without installCompatibilityTools', () => {
    expect(providerWithoutTools).toBeDefined();
    expect(providerWithTools).toBeDefined();
    expect(legacyProvider).toBeDefined();
    expect(legacyShapedProvider).toBeDefined();
  });

  it('keeps deprecated ChannelFile* aliases structurally identical', () => {
    expect(legacyContext).toBeDefined();
    expect(legacyDescriptor).toBeDefined();
  });

  it('runs the legacy installTools hook at runtime', async () => {
    const installTools = vi.fn(async (_agentContext: Context) => {});
    const provider: ChannelFileProvider = {
      store: baseStore,
      resolveAttachment: baseResolve,
      installTools,
    };
    const agentContext = {} as Context;

    await installAttachmentCompatibilityTools(provider, agentContext);

    expect(installTools).toHaveBeenCalledOnce();
    expect(installTools).toHaveBeenCalledWith(agentContext);
  });

  it('prefers installCompatibilityTools and never double-installs', async () => {
    const installCompatibilityTools = vi.fn(async (_agentContext: Context) => {});
    const installTools = vi.fn(async (_agentContext: Context) => {});
    const provider: ChannelAttachmentProvider = {
      store: baseStore,
      resolveAttachment: baseResolve,
      installCompatibilityTools,
      installTools,
    };

    await installAttachmentCompatibilityTools(provider, {} as Context);

    expect(installCompatibilityTools).toHaveBeenCalledOnce();
    expect(installTools).not.toHaveBeenCalled();
  });
});

describe('liveAttachmentProvider', () => {
  it('observes a provider mounted AFTER the live view was created (issue #7)', async () => {
    let mounted: ChannelAttachmentProvider | undefined;
    const live = liveAttachmentProvider(() => mounted);
    const context = {} as ChannelAttachmentContext;
    const part = { type: 'image', localData: new Uint8Array([1]) } as StoredBinaryPart;

    // Absent at wiring time: no throw, no store, unresolved attachment.
    await expect(live.store(context, part)).resolves.toBeUndefined();
    await expect(live.resolveAttachment('sha256:abc', 's-1')).rejects.toThrow(
      'channelFiles service is unavailable',
    );

    // Mounted later: every call sees the provider without re-wiring the bridge.
    const store = vi.fn(async () => undefined);
    const resolveAttachment = vi.fn(async () => ({
      kind: 'image' as const,
      data: new Uint8Array([1, 2]),
      name: 'photo.png',
    }));
    mounted = { store, resolveAttachment };

    await live.store(context, part);
    await expect(live.resolveAttachment('sha256:abc', 's-1')).resolves.toMatchObject({ kind: 'image' });
    expect(store).toHaveBeenCalledOnce();
    expect(resolveAttachment).toHaveBeenCalledWith('sha256:abc', 's-1');
  });

  it('delegates storeImage and the compatibility tool install lazily', async () => {
    const storeImage = vi.fn(async () => undefined);
    const installTools = vi.fn(async (_agentContext: Context) => {});
    let mounted: ChannelAttachmentProvider | undefined = { store: baseStore, resolveAttachment: baseResolve, storeImage, installTools };
    const live = liveAttachmentProvider(() => mounted);

    await live.installCompatibilityTools?.({} as Context);
    expect(installTools).toHaveBeenCalledOnce();

    const context = {} as ChannelAttachmentContext;
    await live.storeImage?.(context, { attachmentId: 'sha256:abc', data: new Uint8Array([1]) });
    expect(storeImage).toHaveBeenCalledOnce();

    // A provider that ships neither optional hook stays a no-op (never throws).
    mounted = { store: baseStore, resolveAttachment: baseResolve };
    await expect(live.installCompatibilityTools?.({} as Context)).resolves.toBeUndefined();
    await expect(
      live.storeImage?.(context, { attachmentId: 'sha256:abc', data: new Uint8Array([1]) }),
    ).resolves.toBeUndefined();
  });
});
