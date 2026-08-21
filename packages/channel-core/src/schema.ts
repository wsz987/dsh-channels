/**
 * Zod schemas for the Channel Contract.
 *
 * One schema per contract shape that is validated at a trust boundary
 * (adapter registration, event ingestion, third-party verification). Keeping
 * them here means `defineChannelAdapter`, `isChannelAdapter` and the
 * `channel-verify` package all check the same shape instead of maintaining
 * parallel hand-rolled guards.
 *
 * Schemas are intentionally permissive beyond the validated surface:
 * `.loose()` keeps unknown keys (e.g. `maxTextLength` in capabilities)
 * untouched, exactly like the historical structural guards did.
 */
import { z } from 'zod';

export const STREAMING_MODES = ['native', 'edit', 'buffered'] as const;

export const CAPABILITY_FLAGS = [
  'text',
  'image',
  'file',
  'audio',
  'video',
  'markdown',
  'cards',
  'reactions',
  'threads',
] as const;

export const streamingModeSchema = z.enum(STREAMING_MODES, {
  error: "capabilities.streaming must be one of 'native' | 'edit' | 'buffered'",
});

function capabilityFlagSchema(name: string) {
  return z.boolean({ error: `capabilities.${name} must be a boolean` });
}

function adapterFunctionSchema(error: string) {
  return z.custom<(...args: never[]) => unknown>(
    (value) => typeof value === 'function',
    { error },
  );
}

/**
 * `ChannelCapabilities` shape validated at the contract boundary: the nine
 * transport flags must be booleans and `streaming` one of the three modes.
 * Additional keys (e.g. `maxTextLength` / `maxFileSize`) are carried through
 * unvalidated.
 */
export const capabilitiesSchema = z.object({
  text: capabilityFlagSchema('text'),
  image: capabilityFlagSchema('image'),
  file: capabilityFlagSchema('file'),
  audio: capabilityFlagSchema('audio'),
  video: capabilityFlagSchema('video'),
  markdown: capabilityFlagSchema('markdown'),
  cards: capabilityFlagSchema('cards'),
  reactions: capabilityFlagSchema('reactions'),
  threads: capabilityFlagSchema('threads'),
  streaming: streamingModeSchema,
  interactiveActions: capabilityFlagSchema('interactiveActions').optional(),
}, {
  error: 'capabilities must be a ChannelCapabilities object',
}).loose();

/** Loose structural adapter shape: an id plus the three required methods. */
export const channelAdapterShapeSchema = z.object({
  id: z.string(),
  start: z.function(),
  stop: z.function(),
  send: z.function(),
}).loose();

/**
 * Strict input shape accepted by `defineChannelAdapter` (dev-time only).
 * Optional contract methods must be functions when present; unknown keys
 * (e.g. `manifest`, `resolveStreamingMode`) pass through untouched.
 */
export const defineChannelAdapterInputSchema = z.object({
  id: z.string({ error: 'id must be a non-empty string' }).min(1, {
    error: 'id must be a non-empty string',
  }),
  capabilities: capabilitiesSchema,
  start: adapterFunctionSchema('start must be a function'),
  stop: adapterFunctionSchema('stop must be a function'),
  send: adapterFunctionSchema('send must be a function'),
  createReply: adapterFunctionSchema('createReply must be a function when present').optional(),
  edit: adapterFunctionSchema('edit must be a function when present').optional(),
  beginAuth: adapterFunctionSchema('beginAuth must be a function when present').optional(),
  pollAuth: adapterFunctionSchema('pollAuth must be a function when present').optional(),
  getHealth: adapterFunctionSchema('getHealth must be a function when present').optional(),
}).loose();

/**
 * Minimal event envelope shared by every `ChannelEvent` variant — the same
 * surface `isChannelEvent` has always checked (type/channel/accountId).
 */
export const channelEventEnvelopeSchema = z.object({
  type: z.string(),
  channel: z.string(),
  accountId: z.string(),
}).loose();
