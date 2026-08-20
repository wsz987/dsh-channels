import { describe, expect, it } from 'vitest';
import { canSaveSetup, changedSetupFields } from '../src/client/setupFormState.js';
import type { ChannelSetupDescriptor } from '../src/client/api.js';

const incompleteCredentials: ChannelSetupDescriptor = {
  authMethods: ['credentials'],
  fields: [
    { name: 'appId', kind: 'text', secret: false, configured: false, writable: true },
    { name: 'appSecret', kind: 'secret', secret: true, configured: false, writable: true },
  ],
};

describe('channel setup submission', () => {
  it('treats a secret-only edit as a setup draft', () => {
    expect(changedSetupFields(incompleteCredentials, new Set(['appSecret']))).toEqual([
      incompleteCredentials.fields[1],
    ]);
  });

  it('keeps Save and connect enabled regardless of configured fields', () => {
    expect(canSaveSetup(false)).toBe(true);
    expect(canSaveSetup(true)).toBe(false);
  });
});
