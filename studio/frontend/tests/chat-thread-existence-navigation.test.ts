// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { readSrc } from "./helpers/kit.ts";

// A temporary backend outage must never be interpreted as a deleted chat.
// Keep this source contract alongside the routing effect: it ensures the
// actual failure callback cannot silently grow a reset or redirect again.
test("thread lookup failure preserves the selected chat", () => {
  const source = readSrc("features/chat/chat-page.tsx");
  const start = source.indexOf("    // Only a confirmed missing record should abandon the open chat.");
  const end = source.indexOf("  const [modelSelectorOpen", start);
  assert.ok(start !== -1 && end > start, "thread-existence effect not found");
  const effect = source.slice(start, end);
  assert.match(effect, /getStoredChatThreadReadResult\(threadId, \{/);
  assert.match(effect, /bounded: true/);
  assert.match(effect, /signal: controller\.signal/);
  assert.match(effect, /if \(canceled \|\| thread\) return/);
  assert.match(effect, /selected !== null && selected !== threadId/);
  assert.match(effect, /controller\.abort\(\)/);
  const failure = effect.match(/\.catch\(\(error\) => \{([\s\S]*?)\n      \}\);/);
  assert.ok(failure, "missing explicit failure handler");
  assert.doesNotMatch(failure[1], /setActiveThreadId|navigate\(/);
  assert.match(failure[1], /controller\.signal\.aborted/);
});
