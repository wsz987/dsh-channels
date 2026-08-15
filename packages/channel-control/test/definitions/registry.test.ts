/**
 * ChannelDefinitionRegistry unit tests (doc §14 / M2 Task 1).
 */
import { describe, expect, it } from 'vitest';
import { ChannelDuplicateError, isChannelError } from '@wsz987/channel-core';
import { ChannelDefinitionRegistry } from '../../src/definitions/registry.js';
import type { ChannelDefinition } from '../../src/index.js';

function makeDef(id: string): ChannelDefinition {
  return {
    id,
    setup: { fields: [], authMethods: ['credentials'] },
    getConfiguredState: async () => ({ configured: false, fields: {} }),
    saveConfig: async () => {},
    createAdapter: async () => {
      throw new Error('not used');
    },
  } as ChannelDefinition;
}

describe('ChannelDefinitionRegistry', () => {
  it('registers and lists in registration order', () => {
    const reg = new ChannelDefinitionRegistry();
    reg.register(makeDef('qq'));
    reg.register(makeDef('lark'));
    reg.register(makeDef('dingtalk'));

    expect(reg.list().map((d) => d.id)).toEqual(['qq', 'lark', 'dingtalk']);
    expect(reg.has('qq')).toBe(true);
    expect(reg.has('weixin')).toBe(false);
  });

  it('duplicate registration throws a stable ChannelDuplicateError', () => {
    const reg = new ChannelDefinitionRegistry();
    reg.register(makeDef('qq'));
    expect(() => reg.register(makeDef('qq'))).toThrow(ChannelDuplicateError);
    // Stable channel error code for the duplicate case.
    expect(() => reg.register(makeDef('qq'))).toThrowError(
      expect.objectContaining({ code: 'CHANNEL_DUPLICATE_ID' }),
    );
    expect(isChannelError(new ChannelDuplicateError(), 'CHANNEL_DUPLICATE_ID')).toBe(true);
  });

  it('get returns the registered definition or undefined', () => {
    const reg = new ChannelDefinitionRegistry();
    const def = makeDef('lark');
    reg.register(def);
    expect(reg.get('lark')).toBe(def);
    expect(reg.get('qq')).toBeUndefined();
  });

  it('requires a definition or raises a stable ChannelError', () => {
    const reg = new ChannelDefinitionRegistry();
    const def = makeDef('qq');
    reg.register(def);
    expect(reg.require('qq')).toBe(def);
    expect(() => reg.require('missing')).toThrowError(
      expect.objectContaining({ code: 'CHANNEL_ERROR' }),
    );
  });

  it('unregister removes a definition and reports whether it existed', () => {
    const reg = new ChannelDefinitionRegistry();
    reg.register(makeDef('weixin'));
    expect(reg.unregister('weixin')).toBe(true);
    expect(reg.has('weixin')).toBe(false);
    expect(reg.unregister('weixin')).toBe(false);
  });
});
