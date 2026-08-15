/**
 * Classification: A — DSH glue [keep].
 *
 * `base_info` payload builder. The official equivalent is api/api.js
 * buildBaseInfo() but is OpenClaw coupled (reads bot_agent from OpenClaw config).
 * DSH keeps its own neutral builder (DSH-specific bot_agent), which is pure
 * glue, not protocol duplication.
 */
/**
 * `base_info` payload attached to every iLink request.
 */
import type { ILinkBaseInfo } from './types.js';

export const DEFAULT_BOT_AGENT = 'DeepSeekHarness';

export interface BuildBaseInfoOptions {
  /** Optional channel/app version string. */
  channelVersion?: string;
  /** Optional bot agent override; defaults to `DeepSeekHarness`. */
  botAgent?: string;
}

/** Build the `base_info` object sent with every iLink CGI request. */
export function buildBaseInfo(opts: BuildBaseInfoOptions = {}): ILinkBaseInfo {
  const info: ILinkBaseInfo = {};
  if (opts.channelVersion) info.channel_version = opts.channelVersion;
  // bot_agent falls back to DeepSeekHarness when the caller did not supply one.
  info.bot_agent = opts.botAgent ?? DEFAULT_BOT_AGENT;
  return info;
}