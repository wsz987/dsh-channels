# @wsz987/app-fake-channel

Private end-to-end proof app for the dsh-channels monorepo.

Wires a fake channel adapter into a Cordis runtime and exercises the full loop
(`ChannelEvent` → SessionBinding → AgentRouter → reply pipeline) without a real
messaging platform or Harness runtime.

## Run

```bash
pnpm --filter @wsz987/app-fake-channel build
pnpm --filter @wsz987/app-fake-channel typecheck
pnpm --filter @wsz987/app-fake-channel test
```

## Related

- [Repository root](../../README.md)

## License

[MIT](../LICENSE)
