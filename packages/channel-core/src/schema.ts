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
import type { ChannelMediaCapabilities } from './capabilities.js';
import { BINARY_KINDS } from './media/hydration.js';

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

const inboundBinaryCapabilitySchema = z.enum(['bytes', 'locator', 'unsupported'], {
  error: "capabilities.media.inbound[<kind>] must be 'bytes' | 'locator' | 'unsupported'",
});

const outboundBinaryCapabilitySchema = z.enum(['bytes', 'unsupported'], {
  error: "capabilities.media.outbound[<kind>] must be 'bytes' | 'unsupported'",
});

/**
 * `ChannelMediaCapabilities` shape validated at the contract boundary:
 * per-binary-kind inbound and outbound media precision. Values under any kind
 * key must be one of the declared literals; missing kinds are allowed (partial
 * record), while unknown kind keys are rejected so the runtime contract stays
 * aligned with `BinaryKind`. Extra object keys outside the inbound/outbound
 * maps pass through (loose).
 */
export const mediaCapabilitiesSchema: z.ZodType<ChannelMediaCapabilities> = z.object({
  inbound: z.partialRecord(z.enum(BINARY_KINDS), inboundBinaryCapabilitySchema, {
    error: 'capabilities.media.inbound must be a record of BinaryKind -> inbound capability',
  }),
  outbound: z.partialRecord(z.enum(BINARY_KINDS), outboundBinaryCapabilitySchema, {
    error: 'capabilities.media.outbound must be a record of BinaryKind -> outbound capability',
  }),
}, {
  error: 'capabilities.media must be a ChannelMediaCapabilities object',
}).loose();

/**
 * `ChannelCapabilities` shape validated at the contract boundary: the nine
 * transport flags must be booleans, `streaming` one of the three modes, and
 * the optional directional `media` map (when present) a valid
 * `ChannelMediaCapabilities`. Additional keys (e.g. `maxTextLength` /
 * `maxFileSize`) are carried through unvalidated.
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
  media: mediaCapabilitiesSchema.optional(),
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
 * `ConversationRef` shape for events crossing a trust boundary. `externalId`
 * and `name` are optional display/mapping metadata discovered by adapters;
 * they must never be consumed by the Access Gate (authorization keys off
 * `id` only). Unknown keys pass through (loose), and both new fields are
 * optional so pre-existing events without them keep validating unchanged.
 */
export const conversationRefSchema = z.object({
  id: z.string({ error: 'conversation.id must be a non-empty string' }).min(1, {
    error: 'conversation.id must be a non-empty string',
  }),
  type: z.enum(['dm', 'group'], {
    error: "conversation.type must be 'dm' | 'group'",
  }),
  threadId: z.string().optional(),
  externalId: z.string().min(1, {
    error: 'conversation.externalId must be a non-empty string when present',
  }).optional(),
  name: z.string().min(1, {
    error: 'conversation.name must be a non-empty string when present',
  }).optional(),
}, {
  error: 'conversation must be a ConversationRef object',
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
