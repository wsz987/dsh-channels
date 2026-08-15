# Optional Generic File Extension

## Decision

Generic channel file storage and document parsing live in the optional
`@wsz987/channel-files` package. The four channel adapters continue to emit only
the shared `FilePart` contract (`localData` or `resourceRef`). They do not know
about PDF, DOCX, XLSX, extraction tools, or private storage.

`@wsz987/channel-harness` keeps a small optional `ChannelFileProvider` port. It
uses the provider to persist inbound binary parts, install provider-owned tools,
and resolve an attachment id for outbound delivery. When no provider is active,
files remain text placeholders and image handling continues through Harness's
official `ctx.attachments` service.

## Ownership

| Package | Owns |
| --- | --- |
| `channel-core` | Cross-channel message contracts only |
| Channel adapters | Platform download/upload and `FilePart` mapping |
| `channel-harness` | Session routing and optional provider calls |
| `channel-files` | Private store, extraction policy, extractors, read tool |
| DeepSeek Harness | Native image validation/storage and model image blocks |

The bundle activates `channel-files` before `channel-harness` for today's
default experience, but the extension line can be removed from a profile. This
is activation-time composition, not a hard dependency of the bridge package.

## PDF

PDF text extraction uses `unpdf`, backed by PDF.js. No PDF byte-stream parser is
maintained in this repository. DOCX and XLSX continue to use `mammoth` and
`xlsx`, respectively; all three dependencies belong only to `channel-files`.

## Replacement Path

When Harness adds a generic `FileAttachment`/`FileBlock` provider, replace or
remove the `channel-files` bundle entry and bind a provider implementation to
the same bridge port. No adapter, channel-core contract, or routing logic needs
to change.

## Upstream Evidence

- [Harness attachment subsystem source](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/attachment.md)
- [Harness filesystem subsystem source](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/filesystem.md)
- [Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)

At the reviewed `0.1.0-rc.6` surface, `ctx.attachments` exposes image methods
only and the LLM content contract has no generic file block. The extension is
therefore a temporary compatibility layer, not a parallel image pipeline.
