/**
 * read_channel_attachment — the M4 Harness tool (plan §52 / §53 / §54 / §94).
 *
 * Lets the model read a stored channel asset's extracted text, paginated by
 * optional offset/limit. It accepts ONLY { attachment_id, offset, limit } —
 * never session_id / path / channel_id / conversation_id (plan §53), and its
 * ACL is bound to the SESSION that owns the asset, never the workspace cwd.
 *
 * Agent-scoped registration (plan §81): installReadChannelAttachmentTool
 * registers through the official @deepseek-ai/dsh-tools ctx.tools.register on
 * the agent's own scope, so it shadows nothing globally and is disposed with
 * the agent.
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_ATTACHMENT_POLICY, type AttachmentPolicy } from './policy.js';
import { renderDescriptor } from './render.js';
import type { StoredAssetDescriptor } from './types.js';
import type { ChannelInboundAssetStore } from './store.js';
import type { Context } from '@deepseek-ai/cordis';

/** Stable, machine-routable tool failure code (plan §53). */
export type AttachmentReadErrorCode = 'ATTACHMENT_NOT_FOUND' | 'ATTACHMENT_ACCESS_DENIED';

/** Typed ACL error carried as a HarnessError so the tool pipeline records a stable code. */
export class AttachmentReadError extends HarnessError {
  constructor(code: AttachmentReadErrorCode, message: string) {
    super(message, code);
    this.name = 'AttachmentReadError';
  }
}

/** Default number of extracted lines returned when limit is omitted. */
const DEFAULT_LINE_LIMIT = 200;
/** Hard bound on the paginated window so a model can never request an unbounded dump. */
const MAX_LINE_LIMIT = 1000;

export interface RegisterReadChannelAttachmentToolOptions {
  /** The private channel asset store backing the tool. */
  store: ChannelInboundAssetStore;
  /** Byte caps; defaults to the plan §49 defaults. */
  policy?: AttachmentPolicy;
}

/** The tool definition, ready to register on an Agent scope. */
export function registerReadChannelAttachmentTool(
  options: RegisterReadChannelAttachmentToolOptions,
) {
  const store = options.store;
  const policy = options.policy ?? DEFAULT_ATTACHMENT_POLICY;

  return defineTool({
    name: 'read_channel_attachment',
    description:
      'Read the extracted text of a channel-file attachment. ' +
      'Returns a descriptor plus a bounded, paginated text window (offset/limit, 1-based lines).',
    parameters: {
      attachment_id: { type: 'string', required: true, description: 'The stored attachment id to read.' },
      offset: { type: 'integer', description: '1-based line number to start from (default 1).' },
      limit: { type: 'integer', description: 'Maximum number of lines to return (default 200, max 1000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          name: { type: 'string' },
          mimeType: { type: 'string' },
          bytes: { type: 'integer' },
          readable: { type: 'boolean' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          totalLines: { type: 'integer' },
          returned: { type: 'integer' },
          truncated: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      // Plan §54: the rendered surface leads with the compact descriptor (id,
      // name, mime, size, readable) and only then the bounded window the model
      // asked for — never an unbounded raw dump.
      render: (args: unknown, value: Record<string, unknown>) => {
        const descriptor: StoredAssetDescriptor = {
          attachmentId: String(value.attachmentId ?? ''),
          name: String(value.name ?? ''),
          mimeType: value.mimeType !== undefined ? String(value.mimeType) : undefined,
          bytes: Number(value.bytes ?? 0),
          durable: true,
          readable: Boolean(value.readable),
        };
        const text = typeof value.text === 'string' ? value.text : '';
        const window = text ? '\n' + text : '';
        return [{ type: 'text', text: renderDescriptor(descriptor) + window }];
      },
    },
    async execute(
      args: { attachment_id: string; offset?: number; limit?: number },
      exec,
    ) {
      // --- Session ACL (plan §53 / §42): the key is sessionId, never cwd. ---
      const currentSessionId = exec.agent ? String(exec.agent.id) : undefined;
      const asset = await store.get(args.attachment_id);
      if (!asset) {
        throw new AttachmentReadError('ATTACHMENT_NOT_FOUND', 'attachment not found: ' + args.attachment_id);
      }
      if (currentSessionId === undefined || asset.sessionId !== currentSessionId) {
        throw new AttachmentReadError(
          'ATTACHMENT_ACCESS_DENIED',
          'attachment belongs to a different session',
        );
      }

      const descriptor: StoredAssetDescriptor = {
        attachmentId: asset.attachmentId,
        name: asset.name,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        durable: true,
        readable: asset.extraction.status === 'ready',
      };

      if (asset.extraction.status !== 'ready') {
        return {
          attachmentId: descriptor.attachmentId,
          name: descriptor.name,
          mimeType: descriptor.mimeType,
          bytes: descriptor.bytes,
          readable: false,
          offset: 0,
          limit: 0,
          totalLines: 0,
          returned: 0,
          truncated: false,
          text: '',
        };
      }

      let extracted: string | undefined;
      try {
        extracted = await store.readExtracted(asset.attachmentId, {
          maxBytes: policy.extract.maxOutputBytes,
          signal: exec.signal,
        });
      } catch (error) {
        // Cancellation must propagate; a store over-cap (output too large) is
        // degraded into a bounded window rather than a hard failure.
        if (exec.signal.aborted) throw error;
        return {
          attachmentId: descriptor.attachmentId,
          name: descriptor.name,
          mimeType: descriptor.mimeType,
          bytes: descriptor.bytes,
          readable: true,
          offset: 1,
          limit: 0,
          totalLines: 0,
          returned: 0,
          truncated: true,
          text: '',
        };
      }
      const lines = (extracted ?? '').split(/\r\n|\r|\n/);
      const totalLines = lines.length;

      const rawOffset = args.offset;
      const safeOffset = Number.isFinite(rawOffset) && (rawOffset ?? 0) > 0 ? Math.floor(rawOffset as number) : 1;
      const rawLimit = args.limit;
      const requested = Number.isFinite(rawLimit) && (rawLimit ?? 0) > 0 ? Math.floor(rawLimit as number) : DEFAULT_LINE_LIMIT;
      const limit = Math.min(requested, MAX_LINE_LIMIT);

      const start = Math.max(0, safeOffset - 1);
      const window = lines.slice(start, start + limit);
      const text = window.join('\n');
      // Bound the returned text to the output cap (safety net over the store cap).
      const capped = capByteLength(text, policy.extract.maxOutputBytes);
      const returned = capped.length > 0 ? window.length : 0;

      return {
        attachmentId: descriptor.attachmentId,
        name: descriptor.name,
        mimeType: descriptor.mimeType,
        bytes: descriptor.bytes,
        readable: true,
        offset: safeOffset,
        limit,
        totalLines,
        returned,
        truncated: start + returned < totalLines || capped !== text,
        text: capped,
      };
    },
  });
}

/** Install the tool on an Agent scoped context (plan §81 Agent-scoped registration). */
export async function installReadChannelAttachmentTool(
  agentCtx: Context,
  options: RegisterReadChannelAttachmentToolOptions,
): Promise<void> {
  const fiber = agentCtx.inject(['tools'], function* readToolScope(ctx) {
    yield ctx.tools.register(registerReadChannelAttachmentTool(options));
  });
  await fiber.await().then(() => undefined);
}

/** Trim a string to at most maxBytes UTF-8 bytes without splitting a char. */
function capByteLength(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder('utf-8').decode(encoded.subarray(0, end));
}
