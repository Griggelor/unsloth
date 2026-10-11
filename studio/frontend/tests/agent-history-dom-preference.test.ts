// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { agentHistoryLevelFor } from "../src/features/chat/stores/agent-history-preference-policy.ts";
import type { AgentHistoryPreferenceSnapshot } from "../src/features/chat/stores/agent-history-preference-policy.ts";

const legacy: AgentHistoryPreferenceSnapshot = {
  globalEnabled: false, globalWindowRows: 5,
  enabledThreads: { olderChat: true }, disabledThreads: {},
  windowRowsByThreadId: {},
};
test("v1 legacy settings remain enabled without migration", () => {
  assert.equal(agentHistoryLevelFor(legacy, "olderChat"), "legacy");
  assert.equal(agentHistoryLevelFor(legacy, "new"), "off");
});
test("explicit chat levels override global levels in both directions", () => {
  const prefs = { ...legacy, globalDomLevel: "low" as const,
    domLevelByThreadId: { custom: "high" as const, disabled: "off" as const } };
  assert.equal(agentHistoryLevelFor(prefs, "custom"), "high");
  assert.equal(agentHistoryLevelFor(prefs, "disabled"), "off");
  assert.equal(agentHistoryLevelFor(prefs, "new"), "low");
  assert.equal(agentHistoryLevelFor({ ...prefs, globalDomLevel: "off" }, "custom"), "high");
});

test("existing explicit v1 exceptions retain precedence when the global mode changes", () => {
  const prefs = { ...legacy, globalDomLevel: "off" as const,
    disabledThreads: { blocked: true as const } };
  assert.equal(agentHistoryLevelFor(prefs, "olderChat"), "legacy");
  assert.equal(agentHistoryLevelFor(prefs, "blocked"), "off");
  assert.equal(agentHistoryLevelFor(prefs, "new"), "off");
  const enabled = { ...prefs, globalDomLevel: "high" as const };
  assert.equal(agentHistoryLevelFor(enabled, "olderChat"), "high");
  assert.equal(agentHistoryLevelFor(enabled, "blocked"), "off");
  assert.equal(agentHistoryLevelFor({ ...enabled,
    domLevelByThreadId: { blocked: "low" as const } }, "blocked"), "low");
});
