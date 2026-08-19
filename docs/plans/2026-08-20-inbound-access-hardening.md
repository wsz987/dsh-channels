# Inbound Access Hardening Implementation Plan

> **For maintainers:** Execute each task with focused tests before the full repository gate.

**Goal:** Close the remaining fail-closed gaps in channel inbound access control and fix the Owner Claim JSON request failure.

**Architecture:** Keep platform identity mapping in adapters, the shared policy contract in `channel-core`, policy persistence in `channel-control`, and privileged admission in `channel-harness`. Preserve the Web host's strict JSON media-type policy by making bodyless Owner Claim mutations send an explicit empty JSON object.

**Tech Stack:** TypeScript, Zod 4, Cordis, React, Vitest, pnpm/Turbo.

---

### Task 1: Owner Claim JSON Requests

**Files:**
- Modify: `packages/channel-web/src/client/api.ts`
- Test: `packages/channel-web/test/routes-v2.test.ts`

1. Add a failing handler test proving Owner Claim POST accepts `{}` with `application/json`.
2. Make begin/confirm client requests send JSON headers and `body: '{}'`.
3. Run the channel-web tests.

### Task 2: Policy Storage Boundaries

**Files:**
- Modify: `packages/channel-core/src/access.ts`
- Modify: `packages/channel-control/src/access/policy-store.ts`
- Test: `packages/channel-core/test/access.test.ts`
- Test: `packages/channel-control/test/access/policy-store.test.ts`

1. Add collision coverage for channel/account IDs containing the key delimiter.
2. Encode each storage-key component independently.
3. Add malformed JSON coverage and return `undefined` without throwing.
4. Run channel-core and channel-control access tests.

### Task 3: Mandatory Gate and Canonical Identity

**Files:**
- Modify: `packages/channel-harness/src/bridge.ts`
- Modify: direct bridge test fixtures under `packages/channel-harness/test/` and `packages/channel-lark/test/`
- Test: `packages/channel-harness/test/access-gate.test.ts`

1. Make `accessResolver` mandatory for every bridge construction.
2. Normalize sender and conversation IDs once before the Access Gate and reuse the normalized event for command/session routing.
3. Add regression tests for whitespace-only/trimmed identities.
4. Run channel-harness tests and typecheck to catch every direct constructor.

### Task 4: Documentation and Repository Verification

**Files:**
- Modify: `docs/security/inbound-access-control.md`
- Modify: `docs/security/channel-identity-map.md`
- Modify: `docs/dsh-channels-final-design-execution-plan.md`

1. Document encoded storage-key components and the mandatory resolver invariant.
2. Run focused tests, `pnpm typecheck`, then `pnpm ci:check`.
3. Report any live-platform verification that remains unavailable separately from offline code verification.
