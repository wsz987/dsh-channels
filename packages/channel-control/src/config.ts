/**
 * Schemastery configuration for the channel-control plugin.
 *
 * All deployment-tunable parameters live here (no hardcoded deployment
 * constants). The update check is prompt-only; disabling it only removes the
 * hint surfaces, never any channel functionality.
 */
import Schema from '@deepseek-ai/schemastery';

/** Runtime bundle update check (prompt-only; never installs anything). */
export interface UpdateCheckConfig {
  /** Whether the periodic npm dist-tag check runs. */
  enabled: boolean;
  /** Minimum hours between two registry checks (cache TTL). */
  intervalHours: number;
}

export interface Config {
  updateCheck: UpdateCheckConfig;
}

export const Config: Schema<Config> = Schema.object({
  updateCheck: Schema.object({
    enabled: Schema.boolean().default(true),
    intervalHours: Schema.natural().default(24),
  }).default({ enabled: true, intervalHours: 24 }),
});
