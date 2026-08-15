/**
 * Harness Home (`$DSH_HOME`, fallback `~/.dsh`) path resolution (plan M0).
 *
 * channel-harness keeps its persistent state (the binding store) and its
 * channel workspace root under the Harness Home instead of the process cwd,
 * so bindings no longer "disappear" when the host is started from a different
 * directory (plan §2.4 / §5.2).
 *
 * The `~` prefix in an explicit `$DSH_HOME` is expanded against the OS home
 * directory; unset `$DSH_HOME` falls back to `~/.dsh`.
 */
import {
  resolveDshHome as resolveHarnessHome,
} from '@deepseek-ai/dsh-home-paths';
import {
  CHANNELS_DATA_DIR_NAME,
  resolveChannelDataDirectory,
} from '@wsz987/channel-core';
import { join } from 'node:path';

export { CHANNELS_DATA_DIR_NAME };

/**
 * Resolve the Harness Home directory. Uses `$DSH_HOME` when set (a leading
 * `~` is expanded against `homedir()`), otherwise `~/.dsh`.
 */
export function resolveDshHome(): string {
  return resolveHarnessHome();
}

/** Channel plugin persistent data directory: `<dsh-home>/dsh-channels`. */
export function resolveChannelDataDir(): string {
  return resolveChannelDataDirectory();
}

/** Default binding store path: `<dsh-home>/dsh-channels/bindings.json`. */
export function resolveDefaultBindingStorePath(): string {
  return join(resolveChannelDataDir(), 'bindings.json');
}
