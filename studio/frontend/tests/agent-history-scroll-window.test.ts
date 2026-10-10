// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { AgentHeightIndex, agentIndexAtScrollPosition, latestAgentWindow, agentWindowAtIndex, agentWindowOnAppend, AGENT_MAX_ROWS } from "../src/components/assistant-ui/agent-history-scroll-window.ts";

test("first and last 32 messages are reachable without paging buttons", () => {
  assert.deepEqual(latestAgentWindow(1000), { start: 968, end: 1000 });
  assert.deepEqual(agentWindowAtIndex(1000, 0), { start: 0, end: 32 });
  assert.deepEqual(agentWindowAtIndex(1000, 999), { start: 968, end: 1000 });
});

test("scrolling across every window never loses or duplicates indices", () => {
  for (let count = 1; count < 300; count++) {
    let window = latestAgentWindow(count);
    for (let index = count - 1; index >= 0; index--) {
      window = agentWindowAtIndex(count, index, window);
      assert.ok(index >= window.start && index < window.end);
      assert.ok(window.end - window.start <= AGENT_MAX_ROWS);
    }
    for (let index = 0; index < count; index++) {
      window = agentWindowAtIndex(count, index, window);
      assert.ok(index >= window.start && index < window.end);
    }
  }
});

test("append preserves the mounted window on its first update", () => {
  let window = latestAgentWindow(100);
  assert.deepEqual(agentWindowOnAppend(window, 100, 101, true), { start: 68, end: 101 });
  let count = 100;
  for (let i = 0; i < 250; i++) {
    window = agentWindowOnAppend(window, count, count + 1, true);
    count++;
    assert.equal(window.end, count);
    assert.ok(window.end - window.start <= AGENT_MAX_ROWS);
  }
  assert.deepEqual(agentWindowOnAppend({ start: 30, end: 62 }, 100, 101, false), { start: 30, end: 62 });
});

test("variable-height rows contribute their measured height to all offsets", () => {
  const sizes = [32, 4000, 21000, 0, 240, 100, 9300, 10, 2300, 5];
  const heights = new AgentHeightIndex(sizes.length, 500);
  sizes.forEach((size, index) => heights.measure(index, size));
  for (let k = 0; k <= sizes.length; k++) {
    assert.equal(heights.offset(k), sizes.slice(0, k).reduce((a, b) => a + b, 0));
  }
  assert.equal(heights.indexAt(heights.total), sizes.length - 1);
});

test("growing and shrinking the transcript preserves earlier measurement", () => {
  const heights = new AgentHeightIndex(10_000, 500);
  heights.measure(9980, 20_000);
  const original = heights.total;
  heights.resize(20_000);
  assert.equal(heights.offset(10_000), original);
  heights.measure(12_345, 1800);
  assert.equal(heights.indexAt(heights.offset(12_345) + 1), 12_345);
  heights.resize(9000);
  assert.equal(heights.total, 9000 * 500);
});

test("invalid indices are rejected rather than crashing the chat", () => {
  assert.throws(() => new AgentHeightIndex(-1), RangeError);
  const heights = new AgentHeightIndex(0);
  assert.equal(heights.indexAt(100), 0);
  heights.resize(1);
  assert.equal(heights.measure(10, 50), false);
});


test("scroll position uses the top spacer as document origin even at a distant window", () => {
  const heights = new AgentHeightIndex(1_000, 720);
  const viewHeight = 600;
  const viewTop = 80;
  for (const index of [0, 31, 100, 500, 967, 998]) {
    const scrollTop = index * 720;
    // The spacer starts at the document origin, even when the mounted rows
    // begin at index 968 and its height is 968 * 720.
    const spacerTop = viewTop - scrollTop;
    assert.equal(agentIndexAtScrollPosition(heights, spacerTop, viewTop, scrollTop, viewHeight), index);
  }
  // A measured 20k-px tool message moves every later row's offset.
  heights.measure(400, 20_000);
  const scrollTop = heights.offset(500);
  assert.equal(agentIndexAtScrollPosition(heights, viewTop - scrollTop, viewTop, scrollTop, viewHeight), 500);
});
