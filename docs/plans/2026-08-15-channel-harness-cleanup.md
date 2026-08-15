# Channel Harness Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove troubleshooting leftovers, make session creation transactional, and keep channel persistence paths consistent before release.

**Architecture:** Put the shared channel data-directory policy in `channel-core`, move the fresh-session transaction into an internal harness factory, and keep verbose session diagnostics behind the existing debug switch. Preserve the current public channel behavior and soft Workspace-attach semantics.

**Tech Stack:** TypeScript, Cordis, DeepSeek Harness APIs, Vitest, pnpm/Turbo.

---

### Task 1: Unify channel data paths

**Files:**
- Create: `packages/channel-core/src/paths.ts`
- Modify: `packages/channel-core/src/plugin.ts`
- Modify: `packages/channel-core/src/index.ts`
- Modify: `packages/channel-harness/src/dsh-home.ts`
- Test: `packages/channel-core/test/plugin-paths.test.ts`
- Test: `packages/channel-harness/test/dsh-home.test.ts`

Move the directory name and resolution policy into a public core path helper. Verify both packages honor `DSH_CHANNELS_DATA_DIR`, `$DSH_HOME`, home expansion, and cwd-relative overrides consistently.

### Task 2: Extract and harden fresh-session creation

**Files:**
- Create: `packages/channel-harness/src/channel-session-factory.ts`
- Modify: `packages/channel-harness/src/bridge.ts`
- Test: `packages/channel-harness/test/workspace-bridge.test.ts`

Move Workspace resolution, Agent creation, publication verification, Workspace attachment, Binding persistence, and rollback into one internal factory. Add a regression test proving publication-verification failure disposes the newly created Session.

### Task 3: Reduce production diagnostics

**Files:**
- Modify: `packages/channel-harness/src/bridge.ts`
- Modify: `packages/channel-harness/src/debug-logger.ts`
- Modify: `packages/channel-harness/src/lifecycle.ts`
- Modify: `packages/channel-harness/test/debug-logger.test.ts`
- Modify: `packages/channel-harness/test/channel-harness.test.ts`

Remove per-message event-tail sampling from the normal message path. Keep one structured info record for successful Session creation and expose detailed lifecycle records only through debug logging.

### Task 4: Make Windows debug logging UTF-8 safe

**Files:**
- Create: `scripts/dev-web-debug.mjs`
- Modify: `package.json`

Launch `dsh web` directly with Node, mirror raw stdout/stderr bytes to the terminal and `dsh-web.log`, and set `DSH_CHANNELS_DEBUG=1` without routing output through `cmd.exe` or PowerShell text decoding.

### Task 5: Verify

Run focused package tests, then `pnpm build`, `pnpm typecheck`, `pnpm test`, and `git diff --check`. All commands must pass without modifying files outside `D:\workspace\dsh-channels`.
