# Setup Field Value Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show configured non-secret channel identifiers such as QQ/Lark `appId` and DingTalk `clientId` in the setup dialog.

**Architecture:** Channel Definitions return non-secret values through `ConfiguredState.fields`. `ChannelControlService.getSetup()` forwards those values while excluding secret fields, and the existing React form initializes text inputs from `field.value`.

**Tech Stack:** TypeScript, Vitest, React, Cordis.

---

### Task 1: Return the Lark SDK App ID

**Files:**
- Modify: `packages/channel-lark/src/definition.ts`
- Test: `packages/channel-lark/test/definition.test.ts`

**Step 1:** Assert the SDK configured state exposes `appId.value`.

**Step 2:** Return `state.upstream.appId` as the non-secret field value.

**Step 3:** Run `pnpm --filter @wsz987/channel-lark test`.

### Task 2: Protect Existing Values

**Files:**
- Test: `packages/channel-dingtalk/test/definition.test.ts`
- Test: `packages/channel-control/test/service.test.ts`

**Step 1:** Assert configured DingTalk `clientId` exposes its existing value.

**Step 2:** Assert `getSetup()` forwards a non-secret value and omits any secret value.

**Step 3:** Run affected tests, `pnpm typecheck`, and `pnpm test`.
