/**
 * Bundle update check — prompt-only npm dist-tag check for
 * `@wsz987/dsh-channels` (the bundle users install).
 *
 * The official Harness has no plugin update mechanism (`dsh plugin` is a pnpm
 * passthrough; `dsh-host-plugin-inventory` is a read-only loader projection),
 * so this control-plane module adds a lightweight runtime hint:
 *
 * - Checks `https://registry.npmjs.org/@wsz987/dsh-channels/{latest,next}`
 *   (single-tag manifests, far lighter than a full packument), 15s timeout,
 *   offline/timeout/validation failures are swallowed into a debug log — a
 *   check failure must NEVER produce a user-facing error.
 * - Registry responses are EXTERNAL input and validated with zod `safeParse`
 *   (a `version` that is not a legal semver string is treated as offline).
 * - The result is cached in the shared ChannelStorage under a versioned key
 *   with a configurable TTL (default 24h); an in-memory copy avoids repeated
 *   disk reads within the same process. A cache written for a different
 *   installed version is discarded, so the first run after an upgrade
 *   re-checks immediately.
 * - Comparison rules (prerelease-aware, hand-written — no semver dependency):
 *     * stable install  → compared against the `latest` tag only;
 *     * prerelease install → compared against max(latest, next);
 *     * strictly greater than the installed version prompts.
 * - Version-line rule: when the target's major.minor differs from the
 *   installed version the hint must carry the TWO-STEP upgrade commands
 *   (Harness CLI first, then re-add the bundle); same line → single
 *   `plugin update` command.
 *
 * This feature only ever PROMPTS. It never installs, upgrades or mutates
 * anything outside its own cache key.
 */
import pkg from '../package.json' with { type: 'json' };
import type { ChannelStorage } from '@wsz987/channel-core';
import { z } from 'zod';

/** The bundle package users install (checked on the npm registry). */
export const BUNDLE_PACKAGE = '@wsz987/dsh-channels';

/** npm registry base. External endpoint; responses are untrusted input. */
const REGISTRY_BASE = 'https://registry.npmjs.org';

/** Dist-tags consulted by the check (in priority order). */
export type BundleDistTag = 'latest' | 'next';

/** Registry fetch timeout (mirrors scripts/check-upstream.mjs). */
export const FETCH_TIMEOUT_MS = 15000;

/** Durable cache key (versioned so future format changes invalidate old rows). */
export const UPDATE_CHECK_STORAGE_KEY = 'update-check:v1';

/** Cache schema version marker persisted alongside the snapshot. */
const CACHE_FORMAT = 1;

/**
 * The installed bundle version. By release convention every runtime-family
 * package (the bundle + its ten dependencies, see docs/release.md) moves in
 * lockstep — each changeset lists the whole family and every package.json
 * carries the same version — so this package's own version IS the installed
 * `@wsz987/dsh-channels` version. Keep the family lockstep when bumping;
 * `test/update-check.test.ts` asserts this package's version equals the
 * bundle's.
 */
export const BUNDLE_VERSION: string = pkg.version;

/** One upgrade command, plus the hint metadata the UI/command plane renders. */
export interface BundleUpdateInfo {
  /** Target version string, e.g. "0.6.0". */
  version: string;
  /** Which dist-tag provided the target. */
  tag: BundleDistTag;
  /** Target sits on a different major.minor line than the installed bundle. */
  crossLine: boolean;
  /** Advisory upgrade commands in execution order. Nothing is auto-installed. */
  commands: string[];
}

/** Sanitized, read-only DTO served to channel-web and the /version command. */
export interface BundleUpdateStatus {
  /** Installed @wsz987/dsh-channels version (workspace lockstep version). */
  currentVersion: string;
  /** Present only when a strictly newer version was found per the tag rules. */
  update?: BundleUpdateInfo;
  /** Epoch ms of the last completed registry check; absent before the first. */
  checkedAt?: number;
}

/** Narrow logger seam (satisfied by a Cordis logger; kept structural). */
export interface UpdateCheckLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

/** Internal snapshot of one completed check (also the persisted cache body). */
interface UpdateCheckSnapshot {
  checkedAt: number;
  /** Installed version the snapshot was computed against. */
  currentVersion: string;
  latest: string;
  next?: string;
}

export interface BundleUpdateCheckerOptions {
  /** Installed bundle version; defaults to this package's lockstep version. */
  currentVersion?: string;
  /** Whether the check runs at all (config `updateCheck.enabled`). */
  enabled: boolean;
  /** Cache TTL in hours (config `updateCheck.intervalHours`). */
  intervalHours: number;
  /** Lazily resolved durable storage; absent → memory-only caching. */
  getStorage?: () => ChannelStorage | undefined;
  /** Logger for the single info line (update found) and debug diagnostics. */
  logger?: UpdateCheckLogger;
  /** Injectable clock (tests). */
  now?: () => number;
}

const silentLogger: UpdateCheckLogger = { debug() {}, info() {} };

/* ------------------------------------------------------------------ */
/* semver (hand-written, prerelease-aware — no new dependency)         */
/* ------------------------------------------------------------------ */

/** Official semver regex (no leading v/=; build metadata tolerated). */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; null for a stable release. */
  pre: string[] | null;
}

/** Parse a strict semver string, or undefined when malformed. */
export function parseSemver(version: string): ParsedSemver | undefined {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] !== undefined ? match[4].split('.') : null,
  };
}

/** Whether a version string is a legal strict semver (with/without suffixes). */
export function isSemverString(version: string): boolean {
  return SEMVER_RE.test(version.trim());
}

function isNumericIdentifier(identifier: string): boolean {
  return /^[0-9]+$/.test(identifier);
}

/** Semver §11 prerelease precedence: numeric < alphanumeric, longer wins ties. */
function comparePrereleaseIdentifiers(a: string[], b: string[]): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const xNum = isNumericIdentifier(x);
    const yNum = isNumericIdentifier(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (xNum) return -1; // numeric identifiers always have lower precedence
    if (yNum) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1; // larger identifier set wins
}

/**
 * Full semver precedence compare. Build metadata is ignored. Callers must
 * pre-validate inputs with parseSemver; an unparseable side compares equal
 * (never greater), so a malformed value can never fabricate an update hint.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1; // release > prerelease
  if (pb.pre === null) return -1;
  return comparePrereleaseIdentifiers(pa.pre, pb.pre);
}

/* ------------------------------------------------------------------ */
/* Trust boundary: zod schemas for external input                      */
/* ------------------------------------------------------------------ */

/** A registry manifest only needs a legal semver `version` field. */
const registryManifestSchema = z
  .object({ version: z.string().refine(isSemverString, 'version must be a strict semver string') })
  .loose();

/** Durable cache body (own storage is re-validated on load: storage can corrupt). */
const storedSnapshotSchema = z
  .object({
    v: z.literal(CACHE_FORMAT),
    checkedAt: z.number(),
    currentVersion: z.string().refine(isSemverString),
    latest: z.string().refine(isSemverString),
    next: z.string().refine(isSemverString).optional(),
  })
  .loose();

/* ------------------------------------------------------------------ */
/* Update evaluation (pure; unit-testable without I/O)                 */
/* ------------------------------------------------------------------ */

/** Same-line upgrade: `plugin update` already refreshes within the range. */
const SAME_LINE_COMMANDS = [
  'npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels',
];

/** Cross-line upgrade: Harness CLI FIRST, then re-add the bundle (order matters). */
const CROSS_LINE_COMMANDS = [
  'npm i -g @deepseek-ai/dsh@latest',
  'npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest',
];

/**
 * Evaluate the prompt from dist-tag versions against the installed version.
 * Pure function; malformed versions are ignored (they can never prompt).
 */
export function evaluateBundleUpdate(
  currentVersion: string,
  tags: { latest?: string; next?: string },
): BundleUpdateInfo | undefined {
  const current = parseSemver(currentVersion);
  if (!current) return undefined;
  const candidates: Array<{ tag: BundleDistTag; version: string; parsed: ParsedSemver }> = [];
  if (tags.latest !== undefined && isSemverString(tags.latest)) {
    candidates.push({ tag: 'latest', version: tags.latest, parsed: parseSemver(tags.latest)! });
  }
  // Prerelease installs also consider the `next` dist-tag; stable installs
  // never get prompted onto a prerelease.
  if (current.pre !== null && tags.next !== undefined && isSemverString(tags.next)) {
    candidates.push({ tag: 'next', version: tags.next, parsed: parseSemver(tags.next)! });
  }
  if (candidates.length === 0) return undefined;
  let target = candidates[0]!;
  for (const candidate of candidates) {
    if (compareSemver(candidate.version, target.version) > 0) target = candidate;
  }
  if (compareSemver(target.version, currentVersion) <= 0) return undefined;
  const crossLine = target.parsed.major !== current.major || target.parsed.minor !== current.minor;
  return {
    version: target.version,
    tag: target.tag,
    crossLine,
    commands: crossLine ? [...CROSS_LINE_COMMANDS] : [...SAME_LINE_COMMANDS],
  };
}

/* ------------------------------------------------------------------ */
/* Checker                                                             */
/* ------------------------------------------------------------------ */

/**
 * [BundleUpdateChecker] — TTL-cached, offline-tolerant npm dist-tag check.
 * Never throws: every failure path (disabled, offline, timeout, schema
 * rejection, storage error) degrades to "no update known".
 */
export class BundleUpdateChecker {
  private readonly currentVersion: string;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly getStorage: () => ChannelStorage | undefined;
  private readonly logger: UpdateCheckLogger;
  private readonly now: () => number;
  /** In-memory snapshot so a process reads storage at most once per cache. */
  private memory: UpdateCheckSnapshot | undefined;
  private inflight: Promise<void> | undefined;

  constructor(options: BundleUpdateCheckerOptions) {
    this.currentVersion = options.currentVersion ?? BUNDLE_VERSION;
    this.enabled = options.enabled;
    this.intervalMs = Math.max(0, options.intervalHours) * 3_600_000;
    this.getStorage = options.getStorage ?? (() => undefined);
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Fire-and-forget check (startup hook). Re-entrant: concurrent callers share
   * one in-flight promise; a fresh cache short-circuits without fetching.
   * Never rejects — callers may `void` it safely.
   */
  trigger(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!this.enabled) {
      this.logger.debug('[channel-control] update check disabled (updateCheck.enabled=false)');
      return Promise.resolve();
    }
    this.inflight = this.runCheck().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * Read-only status for the web control plane / /version command. Returns
   * immediately with the cached snapshot (storage-backed when the process has
   * not checked yet) and kicks a background refresh when the cache is stale
   * or absent — a first request never blocks on the registry.
   */
  async getStatus(): Promise<BundleUpdateStatus> {
    // Disabled means fully off: no hints either — even a fresh snapshot left
    // in storage by a previous (enabled) run must not surface.
    if (!this.enabled) return { currentVersion: this.currentVersion };
    if (!this.memory) {
      const stored = await this.loadStored();
      if (stored) this.memory = stored;
    }
    if (!this.isFresh(this.memory)) void this.trigger().catch(() => {});
    return this.toStatus(this.memory);
  }

  private async runCheck(): Promise<void> {
    try {
      if (this.isFresh(this.memory)) return;
      if (!this.memory) {
        const stored = await this.loadStored();
        if (stored) {
          this.memory = stored;
          if (this.isFresh(this.memory)) return;
        }
      }
      const { latest, next } = await this.fetchDistTags();
      const snapshot: UpdateCheckSnapshot = {
        checkedAt: this.now(),
        currentVersion: this.currentVersion,
        latest,
        ...(next !== undefined ? { next } : {}),
      };
      this.memory = snapshot;
      await this.persist(snapshot);
      const { update } = this.toStatus(snapshot);
      if (update) {
        // The ONE startup info line (AGENTS.md §5.2.1 spirit: no registry raw
        // payload, no noise when there is nothing to say).
        this.logger.info(
          `[channel-control] ${BUNDLE_PACKAGE} ${this.currentVersion} -> ${update.version} available ` +
            `(dist-tag: ${update.tag}, npm latest: ${latest}); upgrade is manual — see /version or the web Channels settings`,
        );
      }
    } catch (error) {
      // Offline / timeout / schema rejection: silent for the user, debug only.
      this.logger.debug('[channel-control] bundle update check skipped (offline or invalid response)', error);
    }
  }

  private isFresh(snapshot: UpdateCheckSnapshot | undefined): boolean {
    if (!snapshot) return false;
    return this.now() - snapshot.checkedAt < this.intervalMs;
  }

  private toStatus(snapshot: UpdateCheckSnapshot | undefined): BundleUpdateStatus {
    if (!snapshot) return { currentVersion: this.currentVersion };
    return {
      currentVersion: this.currentVersion,
      update: evaluateBundleUpdate(this.currentVersion, snapshot),
      checkedAt: snapshot.checkedAt,
    };
  }

  /**
   * Fetch the `latest` and `next` single-tag manifests in parallel. The next
   * tag is optional (404 → absent); latest is required for a successful
   * check. Any non-404 failure, and any zod rejection, throws so the whole
   * check is treated as offline (no partially-trusted snapshot is kept).
   */
  private async fetchDistTags(): Promise<{ latest: string; next?: string }> {
    const [latestResult, nextResult] = await Promise.allSettled([
      this.fetchManifestVersion('latest'),
      this.fetchManifestVersion('next'),
    ]);
    if (latestResult.status === 'rejected') throw latestResult.reason;
    const latest = latestResult.value;
    if (latest === undefined) throw new Error('npm latest dist-tag manifest unavailable');
    let next: string | undefined;
    if (nextResult.status === 'fulfilled') next = nextResult.value;
    return { latest, ...(next !== undefined ? { next } : {}) };
  }

  /** One tag manifest → its version. 404 → undefined (tag not published). */
  private async fetchManifestVersion(tag: BundleDistTag): Promise<string | undefined> {
    const response = await fetch(`${REGISTRY_BASE}/${BUNDLE_PACKAGE}/${tag}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${BUNDLE_PACKAGE}/${tag}: HTTP ${response.status}`);
    const body: unknown = await response.json();
    const parsed = registryManifestSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`${BUNDLE_PACKAGE}/${tag}: registry manifest failed schema validation`);
    }
    return parsed.data.version;
  }

  private async loadStored(): Promise<UpdateCheckSnapshot | undefined> {
    const storage = this.getStorage();
    if (!storage) return undefined;
    try {
      const raw = await storage.get(UPDATE_CHECK_STORAGE_KEY);
      if (raw === undefined) return undefined;
      const parsed = storedSnapshotSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return undefined;
      // A cache recorded for a different installed version (e.g. written
      // before this process upgraded) is discarded so the next check re-runs.
      if (parsed.data.currentVersion !== this.currentVersion) return undefined;
      const data = parsed.data;
      return {
        checkedAt: data.checkedAt,
        currentVersion: data.currentVersion,
        latest: data.latest,
        ...(data.next !== undefined ? { next: data.next } : {}),
      };
    } catch {
      return undefined; // missing/corrupt cache row → simply re-check
    }
  }

  private async persist(snapshot: UpdateCheckSnapshot): Promise<void> {
    const storage = this.getStorage();
    if (!storage) return;
    try {
      const body = { v: CACHE_FORMAT, ...snapshot };
      await storage.set(UPDATE_CHECK_STORAGE_KEY, JSON.stringify(body));
    } catch (error) {
      this.logger.debug('[channel-control] failed to persist update-check cache', error);
    }
  }
}
