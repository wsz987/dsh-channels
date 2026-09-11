import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  createQuestionInteraction,
  selectQuestionBackend,
} from '../src/interactions/question-backend.ts';
import { WaterfallQuestionBackend } from '../src/interactions/question-waterfall-backend.ts';
import { ChannelQuestionPresenter } from '../src/interactions/question-presenter.ts';
import type { AgentManager } from '../src/agent-manager.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { QuestionAdapter, testLogger } from './question-test-utils.ts';

afterEach(() => {
  vi.clearAllMocks();
});

const fakeCtx = new Context();

const deps = {
  agentManager: {} as AgentManager,
  replyContexts: new ReplyContextStore(),
  getAdapter: () => undefined,
  logger: testLogger,
  timeoutMs: 300_000,
};

describe('question backend selection (diagnostic probe, answerer always composed)', () => {
  it('selects the waterfall backend when the userQuestions service is mounted', () => {
    const backend = selectQuestionBackend(
      { ctx: fakeCtx, getUserQuestions: () => ({}) as never },
      deps,
    );
    expect(backend).toBeInstanceOf(WaterfallQuestionBackend);
    expect(backend.kind).toBe('waterfall');
    expect(testLogger.warn).not.toHaveBeenCalled();
  });

  it('still composes the answerer (warn only) when the service is not mounted yet', () => {
    // A concurrent row group / hot-reloaded patch may mount the service AFTER
    // the bridge; disabling presentation here would be permanent.
    const backend = selectQuestionBackend(
      { ctx: fakeCtx, getUserQuestions: () => undefined },
      deps,
    );
    expect(backend).toBeInstanceOf(WaterfallQuestionBackend);
    expect(testLogger.warn).toHaveBeenCalledWith(
      '[channel-harness] the userQuestions service is not mounted yet; the channel question answerer is registered anyway and claims asks as soon as the service appears',
    );
    expect(testLogger.error).not.toHaveBeenCalled();
  });

  it('assembles a presenter wired to the probed backend', () => {
    const adapter = new QuestionAdapter();
    const presenter = createQuestionInteraction({
      ...deps,
      ctx: fakeCtx,
      getUserQuestions: () => ({}) as never,
      getAdapter: () => adapter as never,
    });
    expect(presenter).toBeInstanceOf(ChannelQuestionPresenter);
    presenter.start();
    void presenter.stop();
  });

  it('composes a presenter even when the service is absent', () => {
    const presenter = createQuestionInteraction({
      ...deps,
      ctx: fakeCtx,
      getUserQuestions: () => undefined,
    });
    expect(presenter).toBeInstanceOf(ChannelQuestionPresenter);
  });
});
