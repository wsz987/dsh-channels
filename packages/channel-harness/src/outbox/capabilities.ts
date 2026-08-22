/**
 * Outbox capability resolution (plan §71 / §69).
 *
 * Proactive (outbound, unsolicited) sends are a distinct capability from the
 * transport flags in `ChannelAdapter.capabilities`. An adapter declares its
 * proactive support via an optional `outboxCapabilities` getter/field (e.g.
 * DingTalk will add it in M7C once its official proactive API is wired). When
 * the adapter exposes none, capability DERIVES from the transport flags.
 *
 * Fail-closed rule (plan §69: cannot pretend support): `proactiveText` is
 * true for adapters exposing the field; otherwise the conservative default
 * assumes text is available but media is only available when the adapter
 * transports image, file, audio, or video. A capability of `false` means the
 * outbox must refuse the send (fail closed), never fabricate support.
 */

/**
 * Outbox (proactive-send) capability set (plan §71).
 *
 * - `proactiveText` — the adapter can proactively send plain text to an
 *   arbitrary target (not just a reply).
 * - `proactiveMedia` — the adapter can proactively send an image, file,
 *   audio, or video part to an arbitrary target.
 */
export interface OutboxCapabilities {
  proactiveText: boolean;
  proactiveMedia: boolean;
}

/**
 * Optional adapter-declared outbox capabilities. Adapters that complete their
 * proactive path attach this field; when absent the caller derives a default.
 */
export interface OutboxCapabilitySource {
  readonly outboxCapabilities?: OutboxCapabilities;
  readonly capabilities?: {
    image?: boolean;
    file?: boolean;
    audio?: boolean;
    video?: boolean;
  };
}

/**
 * Resolve an adapter's proactive outbox capabilities (plan §71). Uses an
 * explicitly declared `outboxCapabilities` when present; otherwise derives
 * `proactiveText = true` and `proactiveMedia` from the transport
 * image/file/audio/video flags. Capability `false` always means fail closed.
 */
export function resolveOutboxCapabilities(adapter: OutboxCapabilitySource): OutboxCapabilities {
  if (adapter.outboxCapabilities) {
    return {
      proactiveText: adapter.outboxCapabilities.proactiveText,
      proactiveMedia: adapter.outboxCapabilities.proactiveMedia,
    };
  }
  const caps = adapter.capabilities;
  return {
    proactiveText: true,
    proactiveMedia: Boolean(caps?.image || caps?.file || caps?.audio || caps?.video),
  };
}
