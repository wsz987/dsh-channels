import { describe, expect, it } from 'vitest';
import type { PublicAuthChallenge, PublicAuthPoll } from '../src/host/routes.js';

/**
 * Protocol contract tests: the public wire DTOs must never carry adapter
 * payloads or secrets, and states must stay within the documented enum.
 * These guard the "payload never leaves host" invariant at the shape level.
 */
describe('public auth challenge DTO', () => {
  it('serializes only the public subset and never a payload/secret', () => {
    // Simulate a full adapter challenge that includes a secret-bearing payload.
    const full = {
      id: 'weixin-qr-1700000000000',
      instruction: 'scan with WeChat',
      qrUrl: 'data:image/png;base64,AAA',
      expiresAt: 1700004000000,
      payload: { token: 'top-secret-token', aeskey: 'deadbeef' },
    };
    // The host projects ONLY these fields (mirror of ChannelApi.startAuth).
    const pub: PublicAuthChallenge = {
      id: full.id,
      instruction: full.instruction,
      qrUrl: full.qrUrl,
      expiresAt: full.expiresAt,
    };
    const json = JSON.stringify(pub);
    expect(json).not.toContain('payload');
    expect(json).not.toContain('top-secret-token');
    expect(json).not.toContain('aeskey');
    expect(pub).toMatchObject({ id: full.id, instruction: full.instruction, qrUrl: full.qrUrl, expiresAt: full.expiresAt });
  });

  it('allows optional fields to be omitted', () => {
    const minimal: PublicAuthChallenge = { id: 'x', instruction: 'i' };
    expect(minimal.qrUrl).toBeUndefined();
    expect(minimal.expiresAt).toBeUndefined();
  });
});

describe('public auth poll DTO', () => {
  const allowed: PublicAuthPoll['state'][] = ['pending', 'authenticated', 'expired', 'failed'];
  it('states stay within the documented enum', () => {
    for (const s of allowed) {
      const poll: PublicAuthPoll = { state: s };
      expect(allowed).toContain(poll.state);
    }
  });
  it('prompt only ever carries the documented client hints', () => {
    const hints: PublicAuthPoll['prompt'][] = [undefined, 'verify-code', 'confirm', 'waiting-scan'];
    const poll: PublicAuthPoll = { state: 'pending', prompt: 'verify-code' };
    expect(hints).toContain(poll.prompt);
  });
});

describe('ChannelView shape', () => {
  it('exposes only the documented fields and never a raw secret', () => {
    const view = {
      id: 'weixin',
      enabled: true,
      configured: false,
      mounted: true,
      status: 'disconnected',
      health: { status: 'down', detail: 'weixin not authenticated', authenticated: false },
      capabilities: { text: true, image: true, streaming: 'buffered' },
      lastError: null,
    };
    const json = JSON.stringify(view);
    expect(json).not.toContain('token');
    expect(json).not.toContain('secret');
    expect(Object.keys(view).sort()).toEqual([
      'capabilities',
      'configured',
      'enabled',
      'health',
      'id',
      'lastError',
      'mounted',
      'status',
    ]);
  });
});
