# @wsz987/channel-files

Optional generic-file extension for DeepSeek Harness Channels.

Adds a private channel asset store and document extraction on top of the
Harness-native image path. Inbound PDF / DOCX / XLSX / text files are stored,
extracted, and exposed to the model through the `read_channel_attachment`
tool — without routing raw platform payloads through the prompt.

## Install

```bash
pnpm add @wsz987/channel-files
```

It is included in the `@wsz987/dsh-channels` bundle by default. To disable the
extension, remove the `channels-files` plugin from the bundle patch; Harness
native images and plain text messages keep working.

## Features

| Area | Detail |
| --- | --- |
| Storage | Private file-backed asset store under the channel data directory |
| Extraction | PDF (`unpdf`), DOCX (`mammoth`), XLSX (`xlsx`), plain text |
| Tool | `read_channel_attachment` installs on the agent so models can read stored files |
| Limits | 100 MiB inbound per file · 32 MiB parser input · 5 MiB extracted text output |

## How it works

`ChannelFileService` implements the `ChannelFileProvider` port from
`@wsz987/channel-harness`:

```ts
ctx.channelFiles.store(channelFileContext, binaryPart); // store + extract
ctx.channelFiles.resolveAttachment(attachmentId, sessionId);
await ctx.channelFiles.installTools(agentContext);     // add the read tool
```

## Development

```bash
pnpm --filter @wsz987/channel-files build
pnpm --filter @wsz987/channel-files typecheck
pnpm --filter @wsz987/channel-files test
```

## Related

- [Repository root](../../README.md)
- [Architecture design](../../docs/deepseek-harness-channels-architecture.md)

## License

[MIT](../../LICENSE)
