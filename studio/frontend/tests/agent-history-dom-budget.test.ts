// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { AgentDomCostIndex, agentBudgetWindow, AGENT_DOM_TARGETS } from "../src/components/assistant-ui/agent-history-dom-budget.ts";

test("low and high adapt to measured row complexity", () => {
  const costs = new AgentDomCostIndex(40);
  // The first render must never mount multiple unmeasured, potentially
  // huge tool results. Each later render may admit only one unknown neighbor.
  assert.deepEqual(agentBudgetWindow(40, 39, costs, AGENT_DOM_TARGETS.low), { start: 39, end: 40 });
  assert.deepEqual(agentBudgetWindow(40, 39, costs, AGENT_DOM_TARGETS.high), { start: 39, end: 40 });
  costs.measure(39, 4_800);
  assert.deepEqual(agentBudgetWindow(40, 39, costs, AGENT_DOM_TARGETS.low), { start: 39, end: 40 });
  assert.deepEqual(agentBudgetWindow(40, 39, costs, AGENT_DOM_TARGETS.high), { start: 38, end: 40 });
  costs.measure(38, 100);
  assert.deepEqual(agentBudgetWindow(40, 39, costs, AGENT_DOM_TARGETS.high), { start: 37, end: 40 });
  costs.measure(39, 100);
  assert.deepEqual(agentBudgetWindow(40, 39, costs, AGENT_DOM_TARGETS.low), { start: 37, end: 40 });
});

test("oversized target stays mounted and no window skips its target", () => {
  const costs = new AgentDomCostIndex(100);
  costs.measure(50, 100_000);
  for (const at of [0, 1, 15, 50, 98, 99]) {
    for (const budget of Object.values(AGENT_DOM_TARGETS)) {
      const window = agentBudgetWindow(100, at, costs, budget);
      assert.ok(window.start <= at && at < window.end);
      assert.ok(window.end - window.start <= 32);
    }
  }
  assert.deepEqual(agentBudgetWindow(100, 50, costs, AGENT_DOM_TARGETS.low), { start: 50, end: 51 });
  assert.deepEqual(agentBudgetWindow(0, 0, costs, AGENT_DOM_TARGETS.low), { start: 0, end: 0 });
});

test("invalid measurements cannot poison the budget policy", () => {
  const costs = new AgentDomCostIndex(3);
  assert.equal(costs.measure(10, 1), false);
  assert.equal(costs.measure(0, Infinity), false);
  assert.equal(costs.measure(0, 3_300), true);
  costs.resize(0);
  assert.equal(costs.cost(0), 1_000);
});

test("a five-row run of unknown giant outputs never mounts together", () => {
  const costs = new AgentDomCostIndex(1000);
  for (const level of Object.values(AGENT_DOM_TARGETS)) {
    assert.deepEqual(agentBudgetWindow(1000, 999, costs, level),
      { start: 999, end: 1000 });
  }
  costs.measure(999, 80_000);
  for (const level of Object.values(AGENT_DOM_TARGETS)) {
    assert.deepEqual(agentBudgetWindow(1000, 999, costs, level),
      { start: 999, end: 1000 });
  }
});
