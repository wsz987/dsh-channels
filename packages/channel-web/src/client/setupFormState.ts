import type { ChannelSetupDescriptor } from './api.js';

/** Fields intentionally changed by the operator, including secret fields. */
export function changedSetupFields(descriptor: ChannelSetupDescriptor, edited: Set<string>) {
  return descriptor.fields.filter((field) => edited.has(field.name));
}

/** Setup status and field completeness must not gate a user-initiated save. */
export function canSaveSetup(saving: boolean): boolean {
  return !saving;
}
