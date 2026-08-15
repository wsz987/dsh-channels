import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { env } from 'node:process';
import { join, resolve } from 'node:path';

export const CHANNELS_DATA_DIR_NAME = 'dsh-channels';

/** Resolve the shared persistent-data root used by all channel packages. */
export function resolveChannelDataDirectory(
  environment: Record<string, string | undefined> = env,
  cwd = process.cwd(),
): string {
  const override = environment.DSH_CHANNELS_DATA_DIR?.trim();
  if (override) return resolve(cwd, expandHomePath(override));
  return join(resolveDshHome(undefined, environment), CHANNELS_DATA_DIR_NAME);
}
