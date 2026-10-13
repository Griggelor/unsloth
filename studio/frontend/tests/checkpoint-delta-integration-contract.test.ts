// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { readSrc } from "./helpers/kit.ts";

const runtime = readSrc("features/chat/runtime-provider.tsx");
const delta = readSrc("features/chat/utils/checkpoint-delta-plan.ts");
const storage = readSrc("features/chat/utils/chat-history-storage.ts");

test("delta is opt-in: default published Studio still uses atomic full sync", () => {
  assert.match(runtime, /import\.meta\.env\.VITE_UNSLOTH_EXPERIMENTAL_CHECKPOINT_DELTA === "1"/);
  assert.match(runtime, /\} else \{\s*await ensureStoredChatThread\(remoteId\);\s*await syncExportedRepositoryToBackend\(remoteId, exported\);\s*\}/);
});

test("snapshot is written only after successful transport", () => {
  const block = runtime.slice(runtime.indexOf("const plan = planCheckpointDelta("), runtime.indexOf("if (isChatThreadDeleted(remoteId)) {", runtime.indexOf("const plan = planCheckpointDelta(")));
  assert.ok(block.indexOf("await saveChatMessage(plan.message") < block.indexOf("checkpointDeltaRef.current.set(remoteId, plan.next)"));
  assert.ok(block.indexOf("await syncExportedRepositoryToBackend(remoteId, exported)") < block.indexOf("checkpointDeltaRef.current.set(remoteId, plan.next)"));
  assert.match(block, /catch \(error\) \{\s*checkpointDeltaRef\.current\.delete\(remoteId\)/);
});

test("protected updates fall back to the old full reconciliation", () => {
  assert.match(runtime, /error instanceof ChatMessageProtectedError/);
  assert.match(runtime, /await syncExportedRepositoryToBackend\(remoteId, exported\);/);
  // The general stream method swallows protected 409; this path instead
  // calls the strict API and must handle that signal explicitly.
  assert.match(storage, /export async function saveStoredChatMessage/);
  assert.match(runtime, /await saveChatMessage\(plan.message, \{ coalesce: true \}\)/);
});

test("delta planner rejects untrusted or partial histories", () => {
  assert.match(delta, /reason: "no-trusted-baseline"/);
  assert.match(delta, /reason: "snapshot-memory-budget"/);
  assert.match(delta, /reason: "message-set-changed"/);
  assert.match(delta, /reason: "multi-message-change"/);
  assert.match(delta, /reason: "server-managed-message"/);
  assert.match(delta, /reason: "previously-server-managed"/);
  assert.match(delta, /reason: "reparented-message"/);
});
