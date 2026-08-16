# @wsz987/channel-compat

Upstream compatibility manifests, version policy and `channels doctor` for
DeepSeek Harness Channels.

This package is the governance layer for adapter/upstream compatibility. It
reads adapter manifests as data — it never imports adapter packages and never
special-cases a platform.

## Install

```bash
pnpm add @wsz987/channel-compat
```

## What's inside

| Export | Purpose |
| --- | --- |
| `AdapterManifest` / `getAdapterManifest` / `validateManifest` | Structural manifest schema and reader |
| `UpstreamManifest` helpers | Read the repository upstream manifest set |
| `versionState` / `satisfiesVersion` / `compareVersions` | Five-state version policy (`tested`, `compatible`, `untested`, `experimental`, `unsupported`) |
| `diagnose` / `formatDoctor` | `channels doctor` diagnostics for adapters + health |
| `checkAdapterCompatibility` | Single-entry compatibility check used by CI gates and manifest sync checks |

## Usage

```ts
import { getAdapterManifest, versionState } from '@wsz987/channel-compat';

const manifest = getAdapterManifest(adapter);
if (manifest) {
  const { state, reason } = versionState(manifest);
  console.log(state, reason); // e.g. tested
}
```

The repository-level `doctor` script:

```bash
pnpm doctor                 # channel diagnostics + release gate
pnpm check:fixtures         # fixture sweep
pnpm check:manifests        # manifest governance
```

## Development

```bash
pnpm --filter @wsz987/channel-compat build
pnpm --filter @wsz987/channel-compat typecheck
pnpm --filter @wsz987/channel-compat test
```

## Related

- [Repository root](../../README.md)
- [Architecture design](../../docs/deepseek-harness-channels-architecture.md)

## License

[MIT](../../LICENSE)
