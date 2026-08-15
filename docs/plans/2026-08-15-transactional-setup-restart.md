# Transactional Setup Restart Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve a running channel and its prior setup when a replacement Adapter cannot start.

**Architecture:** `applySetup()` snapshots mutable non-secret config and old credential values before applying new input. `ChannelRuntimeManager.restart()` builds a candidate first, and on a start failure runs the rollback callback before remounting the prior Adapter.

**Tech Stack:** TypeScript, Cordis, Vitest.

---

### Task 1: Add Reversible Definition State

**Files:**
- Modify: `packages/channel-control/src/types.ts`
- Modify: `packages/channel-qq/src/definition.ts`
- Modify: `packages/channel-dingtalk/src/definition.ts`
- Modify: `packages/channel-lark/src/definition.ts`

**Steps:** Add optional snapshot/restore hooks to the generic definition contract. Implement them against each built-in mutable config snapshot and keep setup metadata synchronized after restoration.

### Task 2: Recover Runtime Mounts

**Files:**
- Modify: `packages/channel-control/src/runtime/manager.ts`
- Test: `packages/channel-control/test/runtime/manager.test.ts`

**Steps:** Build the candidate before disposing the current mount. On candidate startup failure, execute rollback, then remount the prior adapter and rethrow the original failure.

### Task 3: Make Setup Updates Transactional

**Files:**
- Modify: `packages/channel-control/src/service.ts`
- Test: `packages/channel-control/test/service.test.ts`

**Steps:** Snapshot config and affected credential values, restore them before runtime recovery, and verify failed updates leave the old adapter, identifier, and secret active.
