/**
 * Web-profile question backend: the official ApiProxy mux transport
 * (upgrade plan §5.1 / §21 P0-3).
 *
 * In the Web profile the ApiProxy gateway is itself the registered
 * `UserQuestionProvider`; it forwards every `ask_user_question` as a
 * `question/requested` mux frame and accepts the answer through the public
 * `respond()` client-response entry. Because a Context allows exactly one
 * user-questions provider, this backend NEVER calls `registerProvider` — it
 * only consumes the official stream and answers through the official RPC.
 *
 * All contract types come from `@deepseek-ai/dsh-host-apiproxy/api`
 * (`MuxFrame`, `QuestionResponsePayload`, `RpcRequest`, `ClientResponse`,
 * `RpcId`, …) — no local protocol clone remains. Inbound envelopes cross a
 * trust boundary, so they are still zod-safeParsed here; the frame schemas
 * below are composed from the OFFICIAL exported
 * `askUserQuestionItemSchema` and otherwise mirror the official
 * `muxFrameSchema` members one-for-one (source:
 * `@deepseek-ai/dsh-host-apiproxy` 0.1.1-rc.2,
 * `lib/types/api/events.schema.ts`). Two-level parse discipline matches the
 * official carrier: a minimal envelope admission, then a per-frame parse
 * dispatched by `payload.type`. Frame types this backend does not own
 * (session events, approvals, …) are ignored silently — they belong to other
 * consumers and unknown future frames must not warn.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  RpcId,
  type ApiProxy,
  type ClientResponse,
  type QuestionResponsePayload,
  type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api';
import { askUserQuestionItemSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ChannelLogger } from '@wsz987/channel-core';
import type {
  QuestionInteractionBackend,
  QuestionInteractionCancellation,
  QuestionInteractionRequest,
  QuestionInteractionResolution,
  QuestionInteractionSink,
} from './question-backend.js';

/**
 * Narrow channel view over the official Host ApiProxy contract — only the
 * question surfaces (mux stream + server-request response entry), derived
 * from `@deepseek-ai/dsh-host-apiproxy/api` instead of a local duplicate.
 */
export type ChannelQuestionApiProxy = Pick<ApiProxy, 'events' | 'respond'>;

/** Official mux-open request type (narrow form with the correlation id). */
type MuxOpenRequest = Parameters<ChannelQuestionApiProxy['events']['mux']>[0];

/** Minimal envelope admission: rpcId + a frame-shaped payload slot. */
const muxEnvelopeSchema = z.object({
  rpcId: z.string(),
  payload: z.object({ type: z.string() }).passthrough(),
});

/**
 * `question/requested` member of the official `MuxFrame` union. The question
 * list reuses the official `askUserQuestionItemSchema`, so `detail` /
 * `header` / `options` / `multiSelect` / `intent` (incl. `plan-review`)
 * validate and flow through verbatim. `sessionId` is the official branded
 * `SessionId`; on the wire that is a string check, so `z.string()` here is
 * runtime-identical. Aligned with `muxFrameSchema` (apiproxy 0.1.1-rc.2).
 */
const questionRequestedFrameSchema = z.object({
  type: z.literal('question/requested'),
  sessionId: z.string(),
  questions: z.array(askUserQuestionItemSchema).min(1),
});

/** `question/resolved` member of the official `MuxFrame` union. */
const questionResolvedFrameSchema = z.object({
  type: z.literal('question/resolved'),
  sessionId: z.string(),
  questionRpcId: z.string(),
  outcome: z.enum(['answered', 'cancelled']),
});

export interface ApiProxyQuestionBackendOptions {
  apiProxy: ChannelQuestionApiProxy;
  logger: ChannelLogger;
}

/**
 * Consumes official ApiProxy mux frames and answers through the official
 * client-response entry. One backend instance owns one mux stream.
 */
export class ApiProxyQuestionBackend implements QuestionInteractionBackend {
  readonly kind = 'apiproxy' as const;

  private sink?: QuestionInteractionSink;
  private streamAbort?: AbortController;

  constructor(private readonly options: ApiProxyQuestionBackendOptions) {}

  start(sink: QuestionInteractionSink): void {
    this.sink = sink;
    if (this.streamAbort) return;
    const controller = new AbortController();
    this.streamAbort = controller;
    const request: MuxOpenRequest = {
      rpcId: RpcId(randomUUID()),
      payload: {},
    };
    void this.consumeMux(request, controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        this.options.logger.error('[channel-harness] question mux failed', error);
      }
    });
  }

  async stop(): Promise<void> {
    this.sink = undefined;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
  }

  async resolve(submission: QuestionInteractionResolution): Promise<void> {
    const value: QuestionResponsePayload = {
      sessionId: SessionId(submission.sessionId),
      answer: submission.answer,
    };
    const message: ClientResponse = {
      type: 'client-response',
      rpcId: RpcId(submission.key),
      result: { ok: true, value },
    };
    const receipt = await this.options.apiProxy.respond(message);
    if (!receipt.accepted) {
      this.options.logger.warn('[channel-harness] question answer was rejected', {
        sessionId: submission.sessionId,
        reason: receipt.reason,
      });
    }
  }

  async cancel(cancellation: QuestionInteractionCancellation): Promise<void> {
    const message: ClientResponse = {
      type: 'client-response',
      rpcId: RpcId(cancellation.key),
      result: {
        ok: false,
        error: {
          code: 'cancelled',
          message: cancellation.reason,
          details: {},
        },
      },
    };
    await this.options.apiProxy.respond(message).catch(() => undefined);
  }

  /** Testable entry point for one official ApiProxy mux envelope. */
  async handleMuxEnvelope(input: unknown): Promise<void> {
    const envelope = muxEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      this.options.logger.warn('[channel-harness] invalid question mux envelope');
      return;
    }
    if (envelope.data.payload.type === 'question/requested') {
      const frame = questionRequestedFrameSchema.safeParse(envelope.data.payload);
      if (!frame.success) {
        this.options.logger.warn('[channel-harness] invalid question/requested frame');
        return;
      }
      if (!this.sink) return;
      const request: QuestionInteractionRequest = {
        key: envelope.data.rpcId,
        sessionId: frame.data.sessionId,
        questions: frame.data.questions,
      };
      await this.sink.questionRequested(request);
    } else if (envelope.data.payload.type === 'question/resolved') {
      const frame = questionResolvedFrameSchema.safeParse(envelope.data.payload);
      if (!frame.success) {
        this.options.logger.warn('[channel-harness] invalid question/resolved frame');
        return;
      }
      if (!this.sink) return;
      await this.sink.questionSettledExternally(frame.data.questionRpcId);
    }
    // Every other official MuxFrame member (session events, approvals, queue
    // snapshots, …) belongs to other consumers — ignore silently, including
    // unknown future frame types.
  }

  private async consumeMux(request: MuxOpenRequest, signal: AbortSignal): Promise<void> {
    for await (const envelope of this.options.apiProxy.events.mux(request, signal)) {
      await this.handleMuxEnvelope(envelope);
    }
  }
}
