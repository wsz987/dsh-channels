/**
 * Update-check surface tests: the v2 HTTP route, the client fetch helper, the
 * extracted `useUpdateCheck` data flow's pure pieces and the locale keys the
 * panel-bottom notice / repository footer render. Everything is offline —
 * fetch is stubbed, the control seam is a fake. There is no React renderer in
 * this package's devDependencies, so the presentation components are covered
 * by calling them as plain functions over their DTO/translator props and
 * asserting on the returned element tree (the hook itself and the section
 * mount are exercised by the built-bundle contract tests).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelApiV2, type ChannelControlLike } from '../src/host/routes-v2.js';
import { fetchUpdateCheck, type BundleUpdateInfo } from '../src/client/api.js';
import { locales } from '../src/client/locales.js';
import { BundleUpdateNotice } from '../src/client/components/BundleUpdateNotice.js';
import {
  RepoFooter,
  REPOSITORY_URL,
  REPOSITORY_README_URL,
  REPOSITORY_ISSUES_URL,
} from '../src/client/components/RepoFooter.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal control seam: only getUpdateStatus matters for these routes. */
function controlWith(status: unknown): ChannelControlLike {
  return {
    async getUpdateStatus() {
      return status as never;
    },
  } as unknown as ChannelControlLike;
}

// ---------------------------------------------------------------------------
// Minimal element-tree walkers for the pure display components (no renderer).
// ---------------------------------------------------------------------------

interface TreeElement {
  type: unknown;
  props: Record<string, unknown> | null;
}
type TreeNode = TreeElement | string | number | null | undefined | boolean | Array<TreeNode>;

function isElement(node: TreeNode): node is TreeElement {
  return typeof node === 'object' && node !== null && !Array.isArray(node) && 'props' in node;
}

/** Concatenate every text node under an element tree. */
function collectText(node: TreeNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join('');
  return collectText(node.props?.children as TreeNode);
}

interface AnchorInfo {
  href: string;
  target?: string;
  rel?: string;
  text: string;
}

/** Collect every `<a>` element with its href/target/rel and text content. */
function collectAnchors(node: TreeNode): AnchorInfo[] {
  const out: AnchorInfo[] = [];
  const walk = (current: TreeNode): void => {
    if (current == null || typeof current === 'boolean') return;
    if (typeof current === 'string' || typeof current === 'number') return;
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (isElement(current)) {
      if (current.type === 'a') {
        const props = current.props ?? {};
        out.push({
          href: String(props.href),
          target: props.target as string | undefined,
          rel: props.rel as string | undefined,
          text: collectText(current),
        });
      }
      walk(current.props?.children as TreeNode);
    }
  };
  walk(node);
  return out;
}

describe('GET /dsh-channels/api/v2/update-check (host route)', () => {
  it('serves the sanitized DTO with 200 and never a secret', async () => {
    const api = new ChannelApiV2(controlWith({
      currentVersion: '0.4.2',
      update: {
        version: '0.5.0',
        tag: 'latest',
        crossLine: true,
        commands: [
          'npm i -g @deepseek-ai/dsh@latest',
          'npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest',
        ],
      },
      checkedAt: 1_700_000_000_000,
    }));
    const result = await api.handle('GET', '/update-check', undefined);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      currentVersion: '0.4.2',
      update: {
        version: '0.5.0',
        tag: 'latest',
        crossLine: true,
        commands: [
          'npm i -g @deepseek-ai/dsh@latest',
          'npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest',
        ],
      },
      checkedAt: 1_700_000_000_000,
    });
  });

  it('serves the no-update shape unchanged', async () => {
    const api = new ChannelApiV2(controlWith({ currentVersion: '0.4.2' }));
    const result = await api.handle('GET', '/update-check', undefined);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ currentVersion: '0.4.2' });
  });

  it('is read-only: non-GET methods fall through to 404', async () => {
    const api = new ChannelApiV2(controlWith({ currentVersion: '0.4.2' }));
    const result = await api.handle('PUT', '/update-check', {});
    expect(result.status).toBe(404);
  });
});

describe('fetchUpdateCheck (client)', () => {
  it('GETs /dsh-channels/api/v2/update-check and parses the DTO', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          currentVersion: '0.4.2',
          update: {
            version: '0.4.3',
            tag: 'latest',
            crossLine: false,
            commands: ['npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels'],
          },
          checkedAt: 1,
        }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const status = await fetchUpdateCheck();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/dsh-channels/api/v2/update-check');
    expect(init?.method).toBeUndefined(); // plain GET
    expect(status.currentVersion).toBe('0.4.2');
    expect(status.update?.version).toBe('0.4.3');
    expect(status.update?.crossLine).toBe(false);
  });

  it('rejects on a non-2xx answer so the panel can drop the banner', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'no control' } }),
      }) as unknown as Response),
    );
    await expect(fetchUpdateCheck()).rejects.toMatchObject({ status: 503 });
  });
});

describe('BundleUpdateNotice (pure display component)', () => {
  const zhT = (key: string) => (locales.zh as Record<string, string>)[key] ?? key;

  const crossLineUpdate: BundleUpdateInfo = {
    version: '0.5.0',
    tag: 'latest',
    crossLine: true,
    commands: [
      'npm i -g @deepseek-ai/dsh@latest',
      'npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest',
    ],
  };

  it('renders nothing when no update is known (null DTO — silent degradation)', () => {
    expect(BundleUpdateNotice({ update: null, t: zhT })).toBeNull();
  });

  it('renders the interpolated headline, cross-line hint and command list from the DTO', () => {
    const tree = BundleUpdateNotice({ update: crossLineUpdate, t: zhT }) as unknown as TreeNode;
    const text = collectText(tree);
    expect(text).toContain('新版本 0.5.0 可用（latest）');
    expect(text).toContain('跨版本线升级');
    expect(text).toContain('npm i -g @deepseek-ai/dsh@latest');
    expect(text).toContain('npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest');
  });

  it('omits the cross-line hint for a same-line update', () => {
    const sameLine: BundleUpdateInfo = { ...crossLineUpdate, crossLine: false };
    const text = collectText(BundleUpdateNotice({ update: sameLine, t: zhT }) as unknown as TreeNode);
    expect(text).toContain('新版本 0.5.0 可用（latest）');
    expect(text).not.toContain('跨版本线升级');
  });
});

describe('RepoFooter (repository entry)', () => {
  it('links repository, README docs and issues in new tabs with noreferrer', () => {
    const anchors = collectAnchors(RepoFooter({ t: (key) => key }) as unknown as TreeNode);
    expect(anchors).toHaveLength(3);
    expect(anchors[0]).toMatchObject({ href: REPOSITORY_URL, target: '_blank' });
    expect(anchors[1]).toMatchObject({ href: REPOSITORY_README_URL, target: '_blank' });
    expect(anchors[2]).toMatchObject({ href: REPOSITORY_ISSUES_URL, target: '_blank' });
    for (const anchor of anchors) expect(anchor!.rel).toContain('noreferrer');
    expect(REPOSITORY_URL).toBe('https://github.com/wsz987/dsh-channels');
    expect(REPOSITORY_README_URL).toBe('https://github.com/wsz987/dsh-channels#readme');
    expect(REPOSITORY_ISSUES_URL).toBe('https://github.com/wsz987/dsh-channels/issues');
  });

  it('labels itself "dsh-channels <version>" from the update-check projection', () => {
    const withVersion = collectText(RepoFooter({ t: (key) => key, version: '0.4.2' }) as unknown as TreeNode);
    expect(withVersion).toContain('dsh-channels 0.4.2');
    const withoutVersion = collectText(RepoFooter({ t: (key) => key }) as unknown as TreeNode);
    expect(withoutVersion).toContain('dsh-channels');
    expect(withoutVersion).not.toContain('dsh-channels 0');
  });

  it('labels the three links from the locale dictionaries in both languages', () => {
    for (const lang of ['zh', 'en'] as const) {
      const t = (key: string) => (locales[lang] as Record<string, string>)[key] ?? key;
      const text = collectText(RepoFooter({ t }) as unknown as TreeNode);
      expect(text).toContain(locales[lang].repoFooterRepo);
      expect(text).toContain(locales[lang].repoFooterDocs);
      expect(text).toContain(locales[lang].repoFooterIssue);
    }
  });
});

describe('update notice + footer locale keys', () => {
  it('ships zh and en templates with {version}/{tag} interpolation slots', () => {
    for (const lang of ['zh', 'en'] as const) {
      const dict = locales[lang] as Record<string, string>;
      expect(dict.updateAvailable).toContain('{version}');
      expect(dict.updateAvailable).toContain('{tag}');
      expect(dict.updateCrossLineHint.length).toBeGreaterThan(0);
    }
    // The composed zh hint matches the spec'd copy 新版本 <version> 可用（<tag>）.
    expect(locales.zh.updateAvailable.replace('{version}', '0.5.0').replace('{tag}', 'latest')).toBe(
      '新版本 0.5.0 可用（latest）',
    );
    expect(locales.en.updateAvailable.replace('{version}', '0.5.0').replace('{tag}', 'next')).toBe(
      'New version 0.5.0 available (next)',
    );
  });

  it('ships the repository footer keys in zh and en', () => {
    for (const lang of ['zh', 'en'] as const) {
      const dict = locales[lang] as Record<string, string>;
      expect(dict.repoFooterRepo.length).toBeGreaterThan(0);
      expect(dict.repoFooterDocs.length).toBeGreaterThan(0);
      expect(dict.repoFooterIssue.length).toBeGreaterThan(0);
    }
    expect(locales.zh.repoFooterRepo).toBe('仓库');
    expect(locales.en.repoFooterRepo).toBe('Repository');
  });
});
