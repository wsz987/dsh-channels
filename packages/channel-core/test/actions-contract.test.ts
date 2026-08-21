/**
 * Generic outbound actions contract (plan §3.6 / §20.11).
 *
 * Verifies the new platform-agnostic interaction surface added to channel-core:
 * `OutboundMessage.actions` (button rows), the optional
 * `capabilities.interactiveActions` flag, and the optional `ChannelAdapter.edit?`
 * method. Keeps the contract free of Telegram-specific fields.
 */
import { describe, expect, it } from 'vitest';
import {
  capabilitiesSchema,
  defineChannelAdapter,
  isChannelAdapter,
  type OutboundMessage,
} from '../src/index.js';

describe('OutboundMessage.actions (generic interactive buttons)', () => {
  it('carries action rows with id / label / optional style', () => {
    const message: OutboundMessage = {
      text: 'choose',
      actions: [
        {
          actions: [
            { id: 'a1', label: 'Yes', style: 'primary' },
            { id: 'a2', label: 'No', style: 'danger' },
          ],
        },
        { actions: [{ id: 'a3', label: 'Skip' }] },
      ],
    };
    expect(message.actions).toHaveLength(2);
    expect(message.actions?.[0]?.actions[0]).toMatchObject({ id: 'a1', label: 'Yes', style: 'primary' });
    // No Telegram-specific field leaks into the generic contract.
    expect(Object.keys(message)).not.toContain('callback_data');
    expect(message.actions?.[1]?.actions[0]?.style).toBeUndefined();
  });

  it('actions is optional and defaults to absent', () => {
    const plain: OutboundMessage = { text: 'hi' };
    expect(plain.actions).toBeUndefined();
  });
});

describe('capabilities.interactiveActions', () => {
  it('is an optional boolean accepted by the capabilities schema', () => {
    const parsed = capabilitiesSchema.safeParse({
      text: true,
      image: false,
      file: false,
      audio: false,
      video: false,
      markdown: false,
      cards: false,
      reactions: false,
      threads: false,
      streaming: 'edit',
      interactiveActions: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('is optional — an adapter may omit it', () => {
    const parsed = capabilitiesSchema.safeParse({
      text: true,
      image: false,
      file: false,
      audio: false,
      video: false,
      markdown: false,
      cards: false,
      reactions: false,
      threads: false,
      streaming: 'buffered',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('interactiveActions');
  });
});

describe('ChannelAdapter.edit? (optional in-place edit)', () => {
  it('is an optional method accepted by defineChannelAdapter', () => {
    const adapter = defineChannelAdapter({
      id: 'telegram',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: true,
        cards: false,
        reactions: false,
        threads: true,
        streaming: 'edit',
        interactiveActions: true,
      },
      async start() {},
      async stop() {},
      async send() {
        return { delivered: true };
      },
      async edit() {
        return { delivered: true };
      },
    });
    expect(typeof adapter.edit).toBe('function');
    expect(isChannelAdapter(adapter)).toBe(true);
  });

  it('is optional — adapters without it are still valid', () => {
    const adapter = defineChannelAdapter({
      id: 'plain',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: false,
        cards: false,
        reactions: false,
        threads: false,
        streaming: 'buffered',
      },
      async start() {},
      async stop() {},
      async send() {
        return { delivered: true };
      },
    });
    expect(adapter.edit).toBeUndefined();
    expect(isChannelAdapter(adapter)).toBe(true);
  });

  it('rejects an edit that is not a function when present', () => {
    const broken = {
      id: 'x',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: false,
        cards: false,
        reactions: false,
        threads: false,
        streaming: 'buffered',
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      send: () => Promise.resolve({ delivered: true }),
      edit: 'not-a-function',
    };
    expect(() => defineChannelAdapter(broken as never)).toThrowError(/edit must be a function when present/);
  });
});
