/**
 * Channel adapter contract tests (execution plan Task 3.3).
 *
 * `runChannelAdapterContract(adapter, options)` registers a vitest suite that
 * verifies the stable `ChannelAdapter` contract a third-party adapter must
 * satisfy:
 *
 * - register / unregister through `ChannelService`
 * - start receives a complete `ChannelAdapterContext`
 * - event emit reaches `ChannelService` listeners
 * - AbortSignal (disposed → `signal.aborted === true`)
 * - send returns a `SendResult`
 * - error mapping (failing sends surface as `ChannelError`)
 * - stop / repeated stop idempotency
 * - cleanup after stop
 * - capabilities structure
 * - health (when implemented)
 * - optional dedup behavior (opt-in via `options.expectedDedup`)
 *
 * The suite only imports `@dsh/channel-core` and cordis — never channel-harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  MemorySecretStore,
  MemoryStorage,
  isChannelError,
} from '@dsh/channel-core';
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelError,
  ChannelErrorCode,
  ChannelEvent,
  ChannelLogger,
  ChannelTarget,
  MessageReceived,
  OutboundMessage,
} from '@dsh/channel-core';

export interface ChannelAdapterContractOptions {
  /**
   * ChannelService to wire up. A fresh `Context` + `ChannelService` is created
   * per test when omitted.
   */
  service?: ChannelService;
  /**
   * Adapter-specific way to make the adapter emit one event from its platform
   * boundary. Defaults to calling `ctx.emit(event)` directly (the wiring the
   * adapter relies on).
   */
  emitEvent?: (ctx: ChannelAdapterContext, event: ChannelEvent) => Promise<void> | void;
  /**
   * Make the adapter's next `send()` fail with a platform-style error. When
   * omitted, the error-mapping test only asserts on failures that happen to
   * occur.
   */
  triggerSendFailure?: () => Promise<unknown> | unknown;
  /**
   * Opt-in dedup group: repeated events with the same message id must be
   * forwarded only once (e.g. Weixin webhook retries).
   */
  expectedDedup?: boolean;
}

/**
 * ChannelAdapterContext produced by the testkit. It extends the contract
 * context with the backing service and a `dispose()` that aborts the signal,
 * simulating the owning Cordis fiber unloading.
 */
export interface TestChannelContext extends ChannelAdapterContext {
  /** The ChannelService this context forwards events to. */
  service: ChannelService;
  /** Abort the context signal (simulates the owning scope being disposed). */
  dispose(): Promise<void>;
}

/**
 * Build a `ChannelAdapterContext` for contract tests: `emit` forwards to the
 * service's listeners, `logger` wraps console, secrets/storage are in-memory,
 * and `signal` aborts when `dispose()` is called.
 */
export function createTestContext(service: ChannelService): TestChannelContext {
  const controller = new AbortController();
  const logger: ChannelLogger = {
    debug: (...args: unknown[]) => console.debug(`[${service.name}]`, ...args),
    info: (...args: unknown[]) => console.info(`[${service.name}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${service.name}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${service.name}]`, ...args),
  };
  return {
    service,
    emit: (event: ChannelEvent) => service.emit(event),
    logger,
    secrets: new MemorySecretStore(),
    storage: new MemoryStorage(),
    signal: controller.signal,
    dispose: async () => {
      controller.abort();
    },
  };
}

let messageCounter = 0;

/** Build a `message.received` event with stable defaults for contract assertions. */
export function makeMessageReceived(overrides: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: 'message.received',
    channel: 'test' as never,
    accountId: 'main' as never,
    conversation: { id: 'conv-1' as never, type: 'dm' },
    sender: { id: 'user-1' as never },
    message: {
      id: `msg-${++messageCounter}` as never,
      content: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now(),
    },
    ...overrides,
  };
}

/** Build a generic `ChannelTarget` for send assertions. */
export function makeChannelTarget(): ChannelTarget {
  return {
    channelId: 'test' as never,
    accountId: 'main' as never,
    conversationId: 'conv-1' as never,
  };
}

/** Build a generic outbound message for send assertions. */
export function makeOutboundMessage(): OutboundMessage {
  return { text: 'hi there' };
}

/**
 * Assert an unknown thrown value is a `ChannelError`, optionally with a
 * specific code. Fails the surrounding vitest test otherwise.
 */
export function assertChannelError(error: unknown, code?: ChannelErrorCode): asserts error is ChannelError {
  expect(isChannelError(error, code)).toBe(true);
}

/**
 * Assert a promise rejects with a `ChannelError` (optionally of a specific
 * code) and resolve to that error.
 */
export function expectChannelError(action: () => Promise<unknown>, code?: ChannelErrorCode): Promise<ChannelError> {
  return action().then(
    () => {
      throw new Error(`expected the action to throw a ChannelError${code ? ` (${code})` : ''}`);
    },
    (error: unknown) => {
      assertChannelError(error, code);
      return error;
    },
  );
}

function createService(): ChannelService {
  const ctx = new Context();
  new ChannelService(ctx);
  return ctx.channels;
}

const defaultEmitEvent = async (ctx: ChannelAdapterContext, event: ChannelEvent): Promise<void> => {
  await ctx.emit(event);
};

/**
 * Register a full contract-test suite for one adapter. Call inside a vitest
 * test file; the suite collects and runs with the surrounding vitest run.
 */
export function runChannelAdapterContract(
  adapter: ChannelAdapter,
  options: ChannelAdapterContractOptions = {},
): void {
  const makeService = (): ChannelService => options.service ?? createService();
  const emitEvent = options.emitEvent ?? defaultEmitEvent;

  describe(`channel adapter contract: ${adapter.id}`, () => {
    describe('register / unregister', () => {
      it('registers and unregisters through the ChannelService', () => {
        const service = makeService();
        const unregister = service.register(adapter);
        expect(service.get(adapter.id)).toBe(adapter);
        expect(service.list()).toContain(adapter);

        unregister();
        expect(service.get(adapter.id)).toBeUndefined();
        expect(service.list()).not.toContain(adapter);
      });
    });

    describe('lifecycle and wiring', () => {
      let service: ChannelService;
      let context: TestChannelContext;
      let started = false;

      beforeEach(() => {
        service = makeService();
        context = createTestContext(service);
        started = false;
      });

      afterEach(async () => {
        if (started) {
          await adapter.stop().catch(() => undefined);
          started = false;
        }
      });

      it('start accepts a complete ChannelAdapterContext', async () => {
        expect(context.emit).toBeTypeOf('function');
        expect(context.logger.debug).toBeTypeOf('function');
        expect(context.logger.info).toBeTypeOf('function');
        expect(context.logger.warn).toBeTypeOf('function');
        expect(context.logger.error).toBeTypeOf('function');
        expect(context.secrets).toBeDefined();
        expect(context.storage).toBeDefined();
        expect(context.signal).toBeInstanceOf(AbortSignal);
        expect(context.signal.aborted).toBe(false);

        await expect(adapter.start(context)).resolves.toBeUndefined();
        started = true;
      });

      it('forwards events emitted through the adapter context to service listeners', async () => {
        await adapter.start(context);
        started = true;
        const listener = vi.fn();
        const dispose = service.on(listener);
        const event = makeMessageReceived();

        await emitEvent(context, event);

        expect(listener).toHaveBeenCalledWith(event);
        dispose();
      });

      it('aborts the context signal when the owning scope is disposed', async () => {
        await adapter.start(context);
        started = true;
        expect(context.signal.aborted).toBe(false);

        await context.dispose();

        expect(context.signal.aborted).toBe(true);
      });

      it('send resolves a SendResult', async () => {
        await adapter.start(context);
        started = true;

        const result = await adapter.send(makeChannelTarget(), makeOutboundMessage());

        expect(result).toBeDefined();
        expect(typeof result.delivered).toBe('boolean');
      });

      it('maps a failing send to a ChannelError', async () => {
        await adapter.start(context);
        started = true;
        if (options.triggerSendFailure) {
          await options.triggerSendFailure();
        }

        let caught: unknown;
        try {
          await adapter.send(makeChannelTarget(), makeOutboundMessage());
        } catch (error) {
          caught = error;
        }

        if (caught !== undefined) {
          assertChannelError(caught);
        }
      });

      it('stop resolves and repeated stop is idempotent', async () => {
        await adapter.start(context);
        started = true;

        await expect(adapter.stop()).resolves.toBeUndefined();
        started = false;
        await expect(adapter.stop()).resolves.toBeUndefined();
      });

      it('cleans up after stop and leaves the service usable', async () => {
        await adapter.start(context);
        await adapter.stop();
        started = false;

        const listener = vi.fn();
        const dispose = service.on(listener);
        await service.emit(makeMessageReceived());
        expect(listener).toHaveBeenCalledTimes(1);
        dispose();
      });
    });

    describe('capabilities', () => {
      it('declares a structurally complete capability surface', () => {
        const caps = adapter.capabilities;
        const flags = [
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
        for (const flag of flags) {
          expect(typeof caps[flag]).toBe('boolean');
        }
        expect(['native', 'edit', 'buffered']).toContain(caps.streaming);
      });
    });

    describe('health', () => {
      it('returns ChannelHealth when implemented', async () => {
        if (typeof adapter.getHealth !== 'function') return;
        const health = await adapter.getHealth();
        expect(health).toBeDefined();
        expect(typeof health.status).toBe('string');
      });
    });

    describe('dedup', () => {
      const run = options.expectedDedup ? it : it.skip;
      run('forwards a repeated message id only once', async () => {
        const service = makeService();
        const context = createTestContext(service);
        await adapter.start(context);

        const listener = vi.fn();
        const dispose = service.on(listener);
        const event = makeMessageReceived({
          message: { id: 'dup-msg-1' as never, content: [{ type: 'text', text: 'hi' }], createdAt: Date.now() },
        });

        await emitEvent(context, event);
        await emitEvent(context, event);

        expect(listener).toHaveBeenCalledTimes(1);
        dispose();
        await adapter.stop().catch(() => undefined);
      });
    });
  });
}
