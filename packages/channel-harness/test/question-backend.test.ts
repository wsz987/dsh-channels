import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQuestionInteraction,
  selectQuestionBackend,
} from '../src/interactions/question-backend.ts';
import { ApiProxyQuestionBackend } from '../src/interactions/question-apiproxy-backend.ts';
import { DirectQuestionBackend } from '../src/interactions/question-direct-backend.ts';
import { ChannelQuestionPresenter } from '../src/interactions/question-presenter.ts';
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions';
import type { AgentManager } from '../src/agent-manager.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { QuestionAdapter, testLogger } from './question-test-utils.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function makeUserQuestions() {
  const registerProvider = vi.fn((provider: UserQuestionProvider) => () => {
    void provider;
  });
  return { service: { registerProvider }, registerProvider };
}

function makeApiProxy() {
  return {
    events: {
      async *mux() {
        // no frames
      },
    },
    respond: vi.fn(async () => ({ accepted: true as const })),
  };
}

const deps = {
  agentManager: {} as AgentManager,
  replyContexts: new ReplyContextStore(),
  getAdapter: () => undefined,
  logger: testLogger,
  timeoutMs: 300_000,
};

describe('question backend selection (one-shot capability probe)', () => {
  it('selects the ApiProxy backend in the Web profile and NEVER registers a provider', () => {
    const apiProxy = makeApiProxy();
    const userQuestions = makeUserQuestions();
    const backend = selectQuestionBackend(
      {
        getApiProxy: () => apiProxy as never,
        getUserQuestions: () => userQuestions.service as never,
      },
      deps,
    );
    expect(backend).toBeInstanceOf(ApiProxyQuestionBackend);
    // The Web-profile regression guard: ApiProxy is itself the registered
    // UserQuestionProvider; a second registration would throw
    // DUPLICATE_PROVIDER. The channel side must not attempt one — not even
    // on start().
    backend?.start({ questionRequested: async () => false, questionSettledExternally: async () => {} });
    expect(userQuestions.registerProvider).not.toHaveBeenCalled();
  });

  it('selects the direct backend headless and registers the official provider exactly once', () => {
    const userQuestions = makeUserQuestions();
    const backend = selectQuestionBackend(
      { getApiProxy: () => undefined, getUserQuestions: () => userQuestions.service as never },
      deps,
    );
    expect(backend).toBeInstanceOf(DirectQuestionBackend);
    expect(userQuestions.registerProvider).not.toHaveBeenCalled();
    backend?.start({ questionRequested: async () => false, questionSettledExternally: async () => {} });
    expect(userQuestions.registerProvider).toHaveBeenCalledTimes(1);
    expect(userQuestions.registerProvider).toHaveBeenCalledWith(backend);
  });

  it('fails safe with an explicit error when neither transport is mounted', () => {
    const backend = selectQuestionBackend(
      { getApiProxy: () => undefined, getUserQuestions: () => undefined },
      deps,
    );
    expect(backend).toBeUndefined();
    expect(testLogger.error).toHaveBeenCalledWith(
      '[channel-harness] user question backend unavailable: neither the public apiProxy gateway nor the userQuestions service is mounted; channel question presentation is disabled',
    );
  });

  it('assembles a presenter wired to the probed backend', () => {
    const adapter = new QuestionAdapter();
    const presenter = createQuestionInteraction({
      ...deps,
      getApiProxy: () => undefined,
      getUserQuestions: () => makeUserQuestions().service as never,
      getAdapter: () => adapter as never,
    });
    expect(presenter).toBeInstanceOf(ChannelQuestionPresenter);
    presenter?.start();
    presenter?.stop();
  });

  it('returns undefined (presenter disabled) when no transport exists', () => {
    const presenter = createQuestionInteraction({
      ...deps,
      getApiProxy: () => undefined,
      getUserQuestions: () => undefined,
    });
    expect(presenter).toBeUndefined();
  });
});
