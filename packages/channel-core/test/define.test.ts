import { describe, expect, it } from 'vitest';
import {
  defineChannelAdapter,
  isChannelAdapter,
  type ChannelAdapter,
  type ChannelCapabilities,
} from '../src/index.js';
import { getAdapterManifest } from '../../channel-compat/src/manifest.ts';

const validCapabilities: ChannelCapabilities = {
  text: true,
  image: false,
  file: false,
  audio: false,
  video: false,
  markdown: true,
  cards: false,
  reactions: false,
  threads: false,
  streaming: 'buffered',
};

function makeValidAdapter(): ChannelAdapter {
  return defineChannelAdapter({
    id: 'example',
    capabilities: validCapabilities,
    async start() {},
    async stop() {},
    async send() {
      return { delivered: true };
    },
  });
}

describe('defineChannelAdapter (Task 17.1)', () => {
  it('is an identity: returns the exact same object', () => {
    const adapter = makeValidAdapter();
    expect(defineChannelAdapter(adapter)).toBe(adapter);
  });

  it('accepts an inline object literal and returns it unchanged', () => {
    const input = {
      id: 'inline',
      capabilities: validCapabilities,
      async start() {},
      async stop() {},
      async send() {
        return { delivered: true };
      },
    };
    const out = defineChannelAdapter(input);
    expect(out).toBe(input);
    expect(isChannelAdapter(out)).toBe(true);
  });

  it('accepts optional members (createReply/beginAuth/pollAuth/getHealth)', () => {
    const adapter = defineChannelAdapter({
      id: 'full',
      capabilities: validCapabilities,
      async start() {},
      async stop() {},
      async send() {
        return { delivered: true };
      },
      async createReply() {
        return {
          append: async () => {},
          replace: async () => {},
          finish: async () => {},
          fail: async () => {},
        };
      },
      async beginAuth() {
        return { id: 'c1', instruction: 'scan' };
      },
      async pollAuth() {
        return { state: 'authenticated' };
      },
      async getHealth() {
        return { status: 'ok', detail: 'connected', authenticated: true };
      },
    });
    expect(typeof adapter.createReply).toBe('function');
    expect(typeof adapter.beginAuth).toBe('function');
    expect(typeof adapter.pollAuth).toBe('function');
    expect(typeof adapter.getHealth).toBe('function');
  });

  it('throws a descriptive TypeError when a required method is missing', () => {
    const missingSend = {
      id: 'broken',
      capabilities: validCapabilities,
      async start() {},
      async stop() {},
    };
    expect(() => defineChannelAdapter(missingSend as never)).toThrowError(
      /defineChannelAdapter: invalid adapter 'broken'/,
    );
    expect(() => defineChannelAdapter(missingSend as never)).toThrowError(/send must be a function/);
  });

  it('throws when several fields are wrong at once and lists them all', () => {
    const broken = {
      capabilities: { text: 'yes', streaming: 'magic' },
      start: 'not a function',
    };
    try {
      defineChannelAdapter(broken as never);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      const message = (error as Error).message;
      expect(message).toContain('id must be a non-empty string');
      expect(message).toContain('capabilities.text must be a boolean');
      expect(message).toContain("capabilities.streaming must be one of 'native' | 'edit' | 'buffered'");
      expect(message).toContain('start must be a function');
      expect(message).toContain('stop must be a function');
      expect(message).toContain('send must be a function');
    }
  });

  it('validates the capabilities shape', () => {
    const badStreaming = {
      id: 'cap',
      capabilities: { ...validCapabilities, streaming: 'instant' },
      async start() {},
      async stop() {},
      async send() {
        return { delivered: true };
      },
    };
    expect(() => defineChannelAdapter(badStreaming as never)).toThrowError(
      /capabilities.streaming must be one of/,
    );

    const badFlag = {
      id: 'cap2',
      capabilities: { ...validCapabilities, image: 'yes' },
      async start() {},
      async stop() {},
      async send() {
        return { delivered: true };
      },
    };
    expect(() => defineChannelAdapter(badFlag as never)).toThrowError(
      /capabilities.image must be a boolean/,
    );
  });

  it('rejects non-object input', () => {
    expect(() => defineChannelAdapter(null as never)).toThrowError(/expected an adapter object/);
  });

  it('keeps the concrete type so a manifest field is preserved', () => {
    const manifest = {
      id: 'example',
      adapterVersion: '0.1.0',
      upstream: {
        reference: 'example http gateway',
        testedVersion: '1.0.0',
        versionRange: '*',
        strategy: 'source',
      },
      status: 'untested' as const,
    };
    const adapter = defineChannelAdapter({
      id: 'example',
      capabilities: validCapabilities,
      manifest,
      async start() {},
      async stop() {},
      async send() {
        return { delivered: true };
      },
    });
    // The returned object still carries the manifest field...
    expect(adapter.manifest).toBe(manifest);
    // ...and channel-compat's structural reader picks it up.
    expect(getAdapterManifest(adapter)).toEqual(manifest);
  });

  it('works with the ChannelAdapter contract check (isChannelAdapter)', () => {
    const adapter = makeValidAdapter();
    expect(isChannelAdapter(adapter)).toBe(true);
    expect(isChannelAdapter({ id: 'x' })).toBe(false);
  });
});
