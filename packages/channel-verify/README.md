# @wsz987/channel-verify

Offline verification CLI for third-party DeepSeek Harness channel adapters
(`dsh channels verify`).

`verifyAdapter` runs a battery of checks against an adapter package directory
and produces a structured report. Everything runs locally — no network, no real
platform credentials — so the CLI is CI-friendly and offline.

## Install

```bash
pnpm add -D @wsz987/channel-verify
```

The package ships a CLI binary with hand-rolled argument parsing:

```bash
dsh-channels-verify [dir] [--test] [--allow-unsupported]
```

Or from the repository root:

```bash
pnpm verify packages/channel-<name> --test
```

## Options

| Flag | Effect |
| --- | --- |
| `dir` | Adapter package directory (default `.`) |
| `--test` | Run the adapter's own test suite (`pnpm test`) as the contract check |
| `--allow-unsupported` | Treat an `unsupported` compatibility state as a warning instead of a failure |

Exit code is `0` when the report has no `fail` items, `1` otherwise; warnings do
not fail the run.

## Checks

| Check id | What it verifies |
| --- | --- |
| `package` | `package.json` exists and has `name`, `version`, `main`, `types`, `exports` |
| `adapter-surface` | The package entry can be imported and exposes an adapter |
| `manifest` | The adapter exposes a structurally valid compatibility manifest |
| `capabilities` | `capabilities` is a valid `ChannelCapabilities` object |
| `fixtures` | `fixtures/<channel>/*.json` cases are present and valid |
| `credentials` | No real credentials / secret values are committed in config or fixtures |
| `contract` | The adapter passes the `@wsz987/channel-testkit` contract suite (or its own tests with `--test`) |

## Development

```bash
pnpm --filter @wsz987/channel-verify build
pnpm --filter @wsz987/channel-verify typecheck
pnpm --filter @wsz987/channel-verify test
```

## Related

- [Repository root](../../README.md)
- [Adapter authoring guide](../../docs/adapter-authoring.md)

## License

[MIT](../../LICENSE)
