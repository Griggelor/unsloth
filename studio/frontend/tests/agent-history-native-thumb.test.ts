// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { AgentHeightIndex } from "../src/components/assistant-ui/agent-history-scroll-window.ts";
import {
  beginAgentNativeThumbDrag,
  finishAgentNativeThumbDrag,
} from "../src/components/assistant-ui/agent-history-native-thumb.ts";

const count = 400;
const viewportHeight = 960;
const heights = new AgentHeightIndex(count);
const maxScroll = heights.total - viewportHeight;
const thumbHeight = Math.max(18, viewportHeight * viewportHeight / heights.total);

function startAtBottom(pointerY = viewportHeight - thumbHeight / 2) {
  const gesture = beginAgentNativeThumbDrag({
    pointerId: 1, pointerY, viewportTop: 0, viewportHeight,
    scrollTop: maxScroll, scrollHeight: heights.total,
  });
  assert.ok(gesture, "actual scrollbar thumb must be recognized");
  return gesture;
}

test("one native thumb drag from bottom to track origin resolves to the FIRST message", () => {
  const gesture = startAtBottom();
  // Replacing 16 estimated rows by short measured rows during the drag must
  // not redefine the gesture's logical endpoint.
  const changingHeights = new AgentHeightIndex(count);
  for (let i = 380; i < 400; i++) changingHeights.measure(i, 92);
  const result = finishAgentNativeThumbDrag(gesture, {
    pointerId: 1, pointerY: 1, scrollTop: maxScroll * .3,
    viewportHeight, heights: changingHeights,
  });
  assert.deepEqual(result, { kind: "top", index: 0, topPx: 0 });
});

test("a full native thumb drag to bottom resolves to the LAST message", () => {
  const gesture = beginAgentNativeThumbDrag({
    pointerId: 4, pointerY: thumbHeight / 2,
    viewportTop: 0, viewportHeight, scrollTop: 0, scrollHeight: heights.total,
  });
  assert.ok(gesture);
  const result = finishAgentNativeThumbDrag(gesture, {
    pointerId: 4, pointerY: viewportHeight + 100, scrollTop: maxScroll * .5,
    viewportHeight, heights,
  });
  assert.deepEqual(result, { kind: "bottom", index: count - 1, topPx: maxScroll });
});

test("interior native thumb drag maps to a logical history position, not measured physical scrollTop", () => {
  const gesture = startAtBottom();
  const changed = new AgentHeightIndex(count);
  changed.measure(33, 19000);
  const targetY = viewportHeight / 2 + gesture.grabOffsetPx;
  const result = finishAgentNativeThumbDrag(gesture, {
    pointerId: 1, pointerY: targetY, scrollTop: 0,
    viewportHeight, heights: changed,
  });
  assert.equal(result?.kind, "position");
  assert.ok(result && result.index > 100 && result.index < 300, String(result?.index));
  assert.ok(result && result.topPx > changed.total * .4 && result.topPx < changed.total * .6);
});

test("scrollbar track clicks, inert thumb clicks and unrelated pointer releases are not navigation", () => {
  const bottom = startAtBottom();
  assert.equal(beginAgentNativeThumbDrag({
    pointerId: 1, pointerY: 80, viewportTop: 0, viewportHeight,
    scrollTop: maxScroll, scrollHeight: heights.total,
  }), null);
  assert.equal(finishAgentNativeThumbDrag(bottom, {
    pointerId: 2, pointerY: 0, scrollTop: 0, viewportHeight, heights,
  }), null);
  assert.equal(finishAgentNativeThumbDrag(bottom, {
    pointerId: 1, pointerY: bottom.startY,
    scrollTop: bottom.startScrollTop, viewportHeight, heights,
  }), null);
});

test("zero-range documents cannot open a native-thumb navigation transaction", () => {
  assert.equal(beginAgentNativeThumbDrag({
    pointerId: 1, pointerY: 1, viewportTop: 0, viewportHeight,
    scrollTop: 0, scrollHeight: viewportHeight,
  }), null);
});
