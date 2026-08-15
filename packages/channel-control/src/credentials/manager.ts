/**
 * [CredentialManager] — the single place channel-control touches the injected
 * credential seam (doc §13, §31, §52).
 *
 * The seam is typed structurally (locally) and is never directly imported from
 * an implementation package: the concrete seam is injected at construction,
 * exactly like channel-core wires 'ctx.channels'. The manager is deliberately
 * thin. [CredentialManager.set] never returns the written value — callers only
 * learn whether the credential is configured and writable.
 */
export interface CredentialSeam {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

export interface CredentialDescribe {
  configured: boolean;
  source?: string;
  writable: boolean;
}

export class CredentialManager {
  constructor(private readonly seam: CredentialSeam) {}

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    return this.seam.resolve(ref);
  }

  async describe(ref: string): Promise<CredentialDescribe> {
    return this.seam.describe(ref);
  }

  /**
   * Write a credential. Returns { configured, writable } metadata and NEVER
   * echoes the value back.
   */
  async set(ref: string, value: string): Promise<CredentialDescribe> {
    await this.seam.set(ref, value);
    return this.seam.describe(ref);
  }

  async unset(ref: string): Promise<void> {
    await this.seam.unset(ref);
  }
}
