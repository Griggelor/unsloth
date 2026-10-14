// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { AgentDomCostIndex, agentBudgetWindow, AGENT_DOM_TARGETS } from "../src/components/assistant-ui/agent-history-dom-budget.ts";
import { isSimpleTextHistoryRow, MAX_UNMEASURED_LIGHT_ROWS } from "../src/components/assistant-ui/agent-history-lightweight.ts";

const plain = (role: "user" | "assistant", text: string) => ({
  role, content: [{ type: "text", text }], attachments: null, metadata: null,
});
test("only short plain text content qualifies: media, tools and complex markdown never qualify", () => {
  assert.equal(isSimpleTextHistoryRow(plain("user", "gut!")), true);
  assert.equal(isSimpleTextHistoryRow(plain("assistant", "Dann bis zum 10er-Bohrer.")), true);
  for (const content of [
    { role: "assistant", content: [{ type: "tool-call", text: "x" }] },
    { role: "assistant", content: [{ type: "text", text: "safe" }, { type: "image", url: "file" }] },
    { role: "assistant", content: [{ type: "text", text: "x".repeat(161) }] },
    { role: "user", content: [{ type: "text", text: "# markdown" }] },
    { role: "user", content: [{ type: "text", text: "<img src=x>" }] },
    { role: "user", content: [{ type: "text", text: "normal" }], attachments: ["image"] },
    { role: "assistant", content: [{ type: "text", text: "hi" }], metadata: { tools: true } },
  ]) assert.equal(isSimpleTextHistoryRow(content), false);
});

test("short turns admit a maximum four unseen rows, never unmeasured complex rows with them", () => {
  const count = 500;
  const costs = new AgentDomCostIndex(count);
  const small = (row: number) => row >= 100 && row < 105;
  const window = agentBudgetWindow(count, 102, costs, AGENT_DOM_TARGETS.medium, 16, small);
  assert.ok(window.start <= 102 && 102 < window.end);
  assert.ok(window.end - window.start <= MAX_UNMEASURED_LIGHT_ROWS);
  for(let at = window.start; at < window.end; at++) assert.ok(small(at));
  const dangerous = agentBudgetWindow(count, 50, costs, AGENT_DOM_TARGETS.medium, 16, small);
  assert.deepEqual(dangerous, {start:50,end:51});
  const costsHeavy = new AgentDomCostIndex(count);
  costsHeavy.measure(101, 90000);
  const isolated = agentBudgetWindow(count,101,costsHeavy,AGENT_DOM_TARGETS.medium,16,small);
  assert.deepEqual(isolated,{start:101,end:102});
});

test("without fast classifier the existing strict unknown-row policy is unchanged", () => {
  const costs = new AgentDomCostIndex(200);
  for (let i = 0; i < 200; i += 23) {
    const oldWindow = agentBudgetWindow(200, i, costs, AGENT_DOM_TARGETS.medium, 16);
    assert.deepEqual(oldWindow,{start:i,end:i+1});
  }
});
