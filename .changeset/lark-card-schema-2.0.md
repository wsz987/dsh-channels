---
'@wsz987/channel-lark': patch
---

**Lark: switch interactive-card streaming to JSON 2.0 schema (`markdown` element).**

The legacy card payload (`elements: [{ tag: 'div', text: { tag: 'lark_md', ... } }]`) renders only a SUBSET of Markdown — bold, italic, links and inline code. Headings, ordered/unordered lists, code blocks, blockquotes, tables and strikethrough fall through as raw Markdown text. Switches `cardContent()` to the supported Interactive Card 2.0 schema (`schema: '2.0'`, `body.elements: [{ tag: 'markdown', ... }]`) so streaming replies render the full Lark-flavoured Markdown.

Streaming semantics unchanged: the same `im.v1.message.create` → `im.v1.message.patch` flow is used; only the `content` field shape changes. No SDK upgrade (still `@larksuiteoapi/node-sdk@1.73.0`).

Verified by `pnpm typecheck` (27 packages pass) and `pnpm vitest run` in `packages/channel-lark` (14 files / 164 tests pass), plus a live verification on a real Feishu app: a single `im.v1.message.create` followed by several `im.v1.message.patch` calls renders headings/lists/code/blockquote/tables/strikethrough correctly.

