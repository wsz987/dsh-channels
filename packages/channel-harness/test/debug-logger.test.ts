import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { CHANNELS_DEBUG_ENV, installDebugConsoleExporter } from '../src/debug-logger.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('installDebugConsoleExporter', () => {
  it('stays off by default', () => {
    vi.stubEnv(CHANNELS_DEBUG_ENV, '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ctx = new Context();

    installDebugConsoleExporter(ctx);
    ctx.logger('channel-harness').info('hidden');
    expect(info).not.toHaveBeenCalled();
  });

  it('exports channel diagnostics and filters other namespaces', () => {
    vi.stubEnv(CHANNELS_DEBUG_ENV, '1');
    const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = new Context();
    installDebugConsoleExporter(ctx);
    const logger = ctx.logger('channel-harness');
    const telegramLogger = ctx.logger('channel-telegram');

    logger.debug('debug', { value: 1 });
    logger.info('info', { value: 2 });
    logger.warn('warn', { value: 3 });
    logger.error('error', { value: 4 });
    telegramLogger.info('telegram inbound', { parts: [{ type: 'image', localDataBytes: 123 }] });
    ctx.logger('other').error('hidden');

    expect(consoleInfo).toHaveBeenNthCalledWith(
      1,
      `[channel-harness] console diagnostics enabled (${CHANNELS_DEBUG_ENV}=1)`,
    );
    expect(consoleDebug).toHaveBeenCalledWith('debug {"value":1}');
    expect(consoleInfo).toHaveBeenNthCalledWith(2, 'info {"value":2}');
    expect(consoleWarn).toHaveBeenCalledWith('warn {"value":3}');
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('error {"value":4}');
    expect(consoleInfo).toHaveBeenNthCalledWith(
      3,
      'telegram inbound {"parts":[{"type":"image","localDataBytes":123}]}',
    );
  });
});
