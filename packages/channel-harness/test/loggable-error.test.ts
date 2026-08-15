import { describe, expect, it } from 'vitest';
import { toLoggableError } from '../src/loggable-error.ts';

describe('toLoggableError', () => {
  it('preserves the error name, message, stack, and cause as enumerable fields', () => {
    const cause = new TypeError('invalid cwd');
    const error = new Error('agent create failed', { cause });

    const logged = toLoggableError(error);

    expect(logged).toMatchObject({
      name: 'Error',
      message: 'agent create failed',
      cause: { name: 'TypeError', message: 'invalid cwd' },
    });
    expect(logged.stack).toContain('agent create failed');
    expect(logged.cause?.stack).toContain('invalid cwd');
    expect(JSON.parse(JSON.stringify(logged))).toMatchObject({
      name: 'Error',
      message: 'agent create failed',
      cause: { name: 'TypeError', message: 'invalid cwd' },
    });
  });
});
