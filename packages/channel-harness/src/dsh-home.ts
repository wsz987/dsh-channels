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
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the Harness Home directory. Uses `$DSH_HOME` when set (a leading
 * `~` is expanded against `homedir()`), otherwise `~/.dsh`.
 */
export function resolveDshHome(): string {
  const dshHome = process.env.DSH_HOME;
  if (dshHome) {
    return resolveHome(dshHome);
  }
  return join(homedir(), '.dsh');
}

/** Expand a leading `~`/«~<sep>» in a path against `homedir()`. */
function resolveHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~') && (value[1] === '/' || value[1] === '\\')) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

/** Channel plugin persistent data directory: `<dsh-home>/channels`. */
export function resolveChannelDataDir(): string {
  return join(resolveDshHome(), 'channels');
}

/** Default binding store path: `<dsh-home>/channels/bindings.json`. */
export function resolveDefaultBindingStorePath(): string {
  return join(resolveChannelDataDir(), 'bindings.json');
}
