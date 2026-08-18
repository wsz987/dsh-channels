# ADR 0003 — Image Compatibility as a Logged Surface Replace at `agent/pre-step`

> Supersedes the *implementation location* of ADR 0002 (the product policy —
> `degrade` / `reject` as an explicit Channel choice — is retained unchanged).
> Target implementation lives in `packages/channel-harness`; this record pins
> the seam and the invariants for the landed migration away from the old
> `llm/stream` provider-boundary rewrite.

## Status

Accepted — implemented.

## Context

ADR 0002 chose to apply the Channel image-compatibility policy at the provider
boundary: a `llm/stream` waterfall listener rewrites the request's messages,
replacing each `ImageBlock` with `[图片：当前模型不支持查看]`, and re-streams a
copied `GenerateOptions` (or refuses the request in `reject` mode).

A re-audit against `@deepseek-ai/dsh-agent-loop` 0.1.0-rc.7 found this violates
the official **Model-visible ⇔ durably referenced** invariant, not just host
parity. The relevant official facts:

1. **Requests are derived from the Session log.** `dsh-agent-loop`'s
   `buildRequest` uses `this.session.deriveMessages()` as the request messages
   (`lib/index.js` `step()` → `buildRequest`). What the model sees IS the
   durable log derivation — by construction, at the loop level.
2. **The reconstruction invariant guards it at `llm/stream`.**
   `@deepseek-ai/dsh-agent-loop/invariant` registers a `prepend: true,
   global: true` `llm/stream` listener: loop-built requests (identity-marked
   via `markAgentLoopRequest`) must be frozen and must satisfy
   `JSON.stringify(options.messages) === JSON.stringify(session.deriveMessages())`
   — otherwise `fail("… log-reconstruction desync")`. The degraded copy the
   channel currently streams is a NEW object, so `isAgentLoopRequest` (a
   WeakSet identity check) returns `false` and the invariant is *bypassed*,
   not satisfied: the placeholder text reaches the provider while the durable
   log still holds the real `ImageBlock`. A request can no longer be rebuilt
   from the log, and the invariant's coverage is silently escaped by an
   unmarked, non-frozen copy.
3. **`agent/pre-step` is the official message channel.** The loop dispatches
   `agent/pre-step` (waterfall, agent-scoped) with the claimed messages; the
   returned `decision.messages` are then appended as `user/message` durable
   events (`lib/index.js` `turn()`: `for (const message of decision.messages)
   this.session.append("user/message", message, …)`), and `step()` derives the
   request from the log afterwards. `agent/request`, by contrast, is
   explicitly documented as unable to mutate messages ("Model-visible content
   must use logged channels; this waterfall cannot mutate messages").

So: *whether* to degrade is a Channel policy, but *how* it is implemented must
stay on a seam that keeps the model-visible content reconstructable from the
durable log. The provider-boundary semantic rewrite does not.

## Decision

Keep the ADR 0002 product policy (`degrade` default / `reject` opt-in —
explicitly not host parity) and move the implementation to
**`agent/pre-step`**, the open-step reconstruction boundary: a listener
installed on the Agent's scoped context by the channel's existing
`commandSetup` (so only channel-bound agents carry it — no global
`bindingFor` scan) that, per step:

1. runs `next()` to obtain the proposed `{ kind: 'enter', messages }` decision;
2. determines the effective selection for THIS step:
   - the logged `request/header` → `agent.options` →
     `agentDefaultModel.currentSelection()` chain that Harness uses when it
     creates/resumes the Session;
3. probes `llm.resolveModelInfo(provider, model)`; when `inputModalities`
   explicitly omits `image` and any entered message contains an image block:
   - `degrade` — replace each image block in the entered messages with
     `[图片：当前模型不支持查看]` and return the rewritten decision. The
     placeholder is what gets appended as `user/message` AND what the model
     sees via `deriveMessages()` — the invariant holds by construction;
   - `reject` — refuse the step (throw `ChannelImageUnsupportedError` from the
     listener for v1 migration parity with today's observable turn failure;
     returning `{ kind: 'reject' }` plus an explicit channel notice is a
     documented follow-up);
4. fails open when capability metadata is missing or the lookup fails (absent
   declaration is not proof of rejection — unchanged from ADR 0002);
5. leaves image-capable selections untouched.

### Consequences

- **Model-visible ⇔ durably referenced holds.** The degraded text is a
  durable `user/message`; every later request re-derives it from the log; a
  process restart or log replay reproduces exactly what the model saw. The
  `llm/stream` reconstruction invariant stays satisfied (and the identity
  bypass disappears).
- **The durable log no longer keeps the real `ImageBlock` for degraded
  turns.** This is the honest trade-off the invariant demands: the log records
  what the model saw. The original image remains in the channel platform's own
  message history and in the inbound `ChannelEvent` (Harness never durably
  logged it). Switching a degraded session to an image-capable model later
  cannot resurrect the image from the log — document this user-visible change
  in the release notes. (Rejected alternative: keep the real image in the log
  and rewrite only the provider request — that is the current invariant
  violation, by definition.)
- **Capability timing follows the current Session model.** The probe reads the
  same current selection that `/status` and `/model` expose. `/model` updates
  the live Session through Harness's official API/hook, so there is no second
  channel owner or cached Host selection to reconcile.
- **Scoping tightens.** Agent-scoped installation removes the global
  listener's `bindingFor` session-scan and the per-request `active` WeakSet
  recursion guard (no recursive dispatch exists anymore).
- **Cost.** One `resolveModelInfo` lookup per step with images. Model selection
  itself uses only the official current-session/default surfaces.

### Known limitations / follow-ups (implementation notes)

- `reject` user-visible notice: a thrown error keeps today's observable
  behavior; a `{ kind: 'reject' }` decision + explicit notice needs a
  `turn/end`-reason mapping and is out of scope for the initial migration.
- `degrade` + later image-capable switch: the placeholder is durable (see
  above); consider surfacing the placeholder text in `/status` or the
  channel notice when a degraded turn occurs (log line already exists).
- The legacy `llm/stream` listener was removed when the pre-step listener
  landed; it must not be reintroduced in parallel because two seams would
  double-rewrite or disagree.

### Migration stages

1. **This ADR** — seam and invariants pinned.
2. **Completed:** implement the agent-scoped `agent/pre-step` listener
   (`installImageCompatibility(agentCtx, deps)` invoked from
   `ChannelHarnessBridge.commandSetup`; deps = bridge root
   `llm.resolveModelInfo` seam plus the read-only current-session model view),
   with the `imageCompatibility.mode` config unchanged.
3. **Completed:** regression tests: degraded step's `user/message` durable events contain
   the placeholder; `deriveMessages()` equals the model-visible request;
   the official reconstruction invariant passes for a degraded request;
   reject mode; fail-open on missing metadata; non-channel agents untouched;
   mixed text→image→text order preserved.
4. **Completed:** delete the `llm/stream` listener + its recursion guard; update
   `image-model-fallback.ts` (keep `ChannelImageUnsupportedError` and the
   placeholder constant; move the rewrite helper), ADR 0002's status, and
   `config.ts` docs.

## Why not the alternatives

- **Keep rewriting at `llm/stream`** — the current state: bypasses the
  reconstruction invariant via the identity check, streams a non-frozen
  unmarked copy, and the provider sees text the log cannot explain. Rejected.
- **`agent/request`** — officially documented as unable to mutate messages.
  Rejected.
- **A custom `SessionEvent` / attachment rewrite** — no official logged
  channel exists for rewriting a user message after the fact; pre-step is the
  official one. Rejected.
- **Provider-native serialization (image → `image_url`)** — an encoding
  conversion, not a semantic change; does not solve text-only models.
  Out of scope for this ADR (it is already the `saveImage` path's job).
