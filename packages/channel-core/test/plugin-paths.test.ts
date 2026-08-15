import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CHANNELS_DATA_DIR_NAME,
  resolveChannelDataDirectory,
} from '../src/paths.ts';

describe('channel-core data directory', () => {
  it('defaults to the plugin namespace under ~/.dsh, independent of cwd', () => {
    const expected = join(homedir(), '.dsh', CHANNELS_DATA_DIR_NAME);

    expect(resolveChannelDataDirectory({}, resolve('first-cwd'))).toBe(expected);
    expect(resolveChannelDataDirectory({}, resolve('second-cwd'))).toBe(expected);
  });

  it('honors DSH_HOME through the official Harness home resolver', () => {
    const dshHome = resolve('custom-dsh-home');
    expect(resolveChannelDataDirectory({ DSH_HOME: dshHome })).toBe(
      join(dshHome, CHANNELS_DATA_DIR_NAME),
    );
  });

  it('keeps DSH_CHANNELS_DATA_DIR as the highest-priority override', () => {
    const cwd = resolve('launch-dir');
    expect(
      resolveChannelDataDirectory(
        { DSH_HOME: resolve('ignored-home'), DSH_CHANNELS_DATA_DIR: 'channel-state' },
        cwd,
      ),
    ).toBe(join(cwd, 'channel-state'));
  });
});
