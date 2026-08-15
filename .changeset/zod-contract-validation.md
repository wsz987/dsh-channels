---
'@wsz987/channel-core': minor
'@wsz987/channel-compat': patch
'@wsz987/channel-harness': patch
'@wsz987/channel-testkit': patch
'@wsz987/channel-verify': patch
'@wsz987/channel-web': patch
---

Contract validation via zod (replaces hand-rolled structural guards):

- `channel-core`: new `schema.ts` with `capabilitiesSchema`, `channelAdapterShapeSchema`,
  `defineChannelAdapterInputSchema` and `channelEventEnvelopeSchema`;
  `defineChannelAdapter` / `isChannelAdapter` / `isChannelEvent` now validate
  through them (dev-time error messages unchanged).
- `channel-compat`: `AdapterManifest` schema backs `getAdapterManifest`;
  `validateManifest` checks fields through the same zod schema pieces with
  unchanged messages and the R6 `tested` release-gate.
- `channel-harness`: `isV1Binding` uses a zod schema for the v1 → v2 binding migration.
- `channel-testkit`: `validateFixture` uses a fixture zod schema.
- `channel-verify`: capabilities + adapter-shape checks reuse `channel-core`
  schemas (removes duplicated flag/enum constants); package.json surface check
  is schema-driven with unchanged report codes.
- `channel-web`: v2 body validators (config patch / credentials / setup /
  auth begin / auth input) are zod schemas; v1 auth input reuses the shared
  `authInputSchema`.
