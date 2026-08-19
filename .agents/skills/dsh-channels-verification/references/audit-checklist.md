# Audit Checklist

Use this as a deterministic verification checklist.

## A. Repository snapshot

- [ ] Confirm repo URL.
- [ ] Confirm default/target branch.
- [ ] Record current HEAD SHA.
- [ ] Record commit date.
- [ ] Compare HEAD with Skill snapshot.
- [ ] Read latest architecture docs.

## B. ChannelDefinition

For each target channel:

- [ ] Read `definition.ts`.
- [ ] Enumerate setup fields.
- [ ] Mark text vs secret.
- [ ] Record authMethods.
- [ ] Record setupUrl.
- [ ] Record autoStart.
- [ ] Confirm secret refs never cross browser boundary.
- [ ] Confirm configured state never returns secret values.

## C. Config

- [ ] Read `config.ts`.
- [ ] Enumerate every user-facing field.
- [ ] Record defaults.
- [ ] Record hidden/deprecated plaintext migration fields.
- [ ] Record credential ref defaults.
- [ ] Confirm saveConfig cannot write real secret values.

## D. Adapter capability

- [ ] Read `adapter.ts`.
- [ ] Record text/image/file/audio/video.
- [ ] Record markdown/cards/reactions/threads.
- [ ] Record streaming mode.
- [ ] Check target-dependent capability overrides.
- [ ] Ensure protocol capability is not mistaken for DSH implemented capability.

## E. Actual platform interface

- [ ] Trace inbound API.
- [ ] Trace outbound text API.
- [ ] Trace media upload/download.
- [ ] Trace card/edit/streaming.
- [ ] Trace typing/reaction.
- [ ] Trace proactive send.
- [ ] Trace auth/token acquisition.

## F. Platform permission

- [ ] Open current official docs.
- [ ] Identify exact scope/intent/admin right for every used API.
- [ ] Identify event subscriptions separately from API permissions.
- [ ] Identify bot/app capabilities separately from scopes.
- [ ] Mark sensitive permissions.
- [ ] Mark permissions that require app publish/review.
- [ ] Mark runtime-only/live checks.

## G. Web UI

- [ ] Compare `channelRegistry.ts`.
- [ ] Compare ChannelDefinition setup fields.
- [ ] Validate docsUrl.
- [ ] Validate field labels.
- [ ] Validate auth prerequisites.
- [ ] Ensure static requirement UI is not displayed as a live “granted” result.
- [ ] Unknown channel must still use generic fallback.

## H. Manifest/upstream

- [ ] Read `manifest.ts`.
- [ ] Compare upstream reference.
- [ ] Compare SDK package.
- [ ] Compare testedVersion.
- [ ] Compare versionRange.
- [ ] Compare current official package/protocol version.
- [ ] Review changelog/source before bump.
- [ ] Do not auto-upgrade latest.
- [ ] Update fixtures.
- [ ] Run offline tests.
- [ ] Run live gate.
- [ ] Update status only after evidence exists.

## I. Mandatory known checks (snapshot 2026-08-19)

- [ ] QQ: verify DSH does not accidentally rely on SDK `FULL_INTENTS`.
- [ ] QQ: `markdownSupport=true` only when platform permission exists.
- [ ] Telegram: review drift from manifest 7.10 to official Bot API 10.2.
- [ ] Telegram: verify webhook disabled before long polling.
- [ ] Weixin: keep file outbound unsupported until concrete upstream supports it.
- [ ] Weixin: replace pending live version/commit after real gate.
- [ ] Weixin: do not treat `channels.weixin.qq.com` as iLink protocol documentation.
- [ ] Lark: verify three core scopes + `im.message.receive_v1`.
- [ ] Lark: verify media/reaction permissions when those features are enabled.
- [ ] DingTalk: verify each proactive/media/card OpenAPI permission, not only Stream receive.
- [ ] All: secrets must remain in credential/secrets seam.
