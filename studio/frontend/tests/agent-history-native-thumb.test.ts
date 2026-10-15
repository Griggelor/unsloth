// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { AgentHeightIndex } from "../src/components/assistant-ui/agent-history-scroll-window.ts";
import {
  agentNativeThumbBottomSpacerPx,
  beginAgentNativeThumbDrag,
  agentNativeThumbLiveTarget,
  canAdoptAgentNativeThumbPosition,
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


test("drag-scoped virtual-height projection keeps native track extent fixed across row measurements", () => {
  const ledger = new AgentHeightIndex(400);
  const virtualHeight = ledger.total;
  for (const [start, end, rowHeight] of [
    [384, 400, 100], [250, 266, 110], [60, 76, 2100], [4, 20, 96],
  ]) {
    for (let i = start; i < end; i++) ledger.measure(i, rowHeight);
    // Prefix + mounted measured rows + projected unmounted suffix should
    // represent the same logical scrollbar range throughout the drag.
    const top = ledger.offset(start);
    const mounted = ledger.offset(end) - top;
    const suffix = agentNativeThumbBottomSpacerPx(virtualHeight, ledger.offset(end));
    assert.equal(top + mounted + suffix, virtualHeight);
  }
  assert.ok(ledger.total !== virtualHeight, "measurement workload must change actual height");
});

test("drag-scoped suffix is bounded if a huge row consumes all projected space", () => {
  assert.equal(agentNativeThumbBottomSpacerPx(100, 125), 0);
  assert.equal(agentNativeThumbBottomSpacerPx(100, 20), 80);
  assert.equal(agentNativeThumbBottomSpacerPx(Number.NaN, 20), 0);
});

test("R4 adopts a painted native interior position rather than scrolling twice", () => {
  const desired = { kind: "position", index: 180, topPx: 125000 } as const;
  const state = {
    scrollTop: 125000, scrollHeight: 280000, viewportHeight: 960,
    logicalTotal: 280000, frozenTotal: 280000,
    targetVisible: true, windowSettled: true,
  };
  assert.equal(canAdoptAgentNativeThumbPosition(desired, state), true);
  // Minor height remeasurement is tolerated in the same logical track.
  assert.equal(canAdoptAgentNativeThumbPosition(desired, {
    ...state, logicalTotal: 279990, frozenTotal: 280000,
  }), true);
});

test("R4 preserves the R3 recovery path for a lagging native thumb or missing target", () => {
  const desired = { kind: "position", index: 180, topPx: 125000 } as const;
  const state = {
    scrollTop: 95000, scrollHeight: 280000, viewportHeight: 960,
    logicalTotal: 280000, frozenTotal: 280000,
    targetVisible: true, windowSettled: true,
  };
  assert.equal(canAdoptAgentNativeThumbPosition(desired, state), false);
  assert.equal(canAdoptAgentNativeThumbPosition(desired, {
    ...state, scrollTop: 125000, targetVisible: false,
  }), false);
  assert.equal(canAdoptAgentNativeThumbPosition(desired, {
    ...state, scrollTop: 125000, windowSettled: false,
  }), false);
  assert.equal(canAdoptAgentNativeThumbPosition(desired, {
    ...state, scrollTop: 125000, frozenTotal: null,
  }), false);
  assert.equal(canAdoptAgentNativeThumbPosition(desired, {
    ...state, scrollTop: 125000, logicalTotal: 275000,
  }), false);
});

test("R4 never adopts the endpoints: top and bottom retain mandatory R3 snaps", () => {
  const state = {
    scrollTop: 0, scrollHeight: 280000, viewportHeight: 960,
    logicalTotal: 280000, frozenTotal: 280000,
    targetVisible: true, windowSettled: true,
  };
  assert.equal(canAdoptAgentNativeThumbPosition({ kind: "top", index: 0, topPx: 0 }, state), false);
  assert.equal(canAdoptAgentNativeThumbPosition({
    kind: "bottom", index: 399, topPx: 279040,
  }, { ...state, scrollTop: 279040 }), false);
});

test("R4 compares native and desired positions in track pixels, not document pixels", () => {
  const state = {
    scrollTop: 125000 + 2500, scrollHeight: 280000, viewportHeight: 960,
    logicalTotal: 280000, frozenTotal: 280000,
    targetVisible: true, windowSettled: true,
  };
  const desired = { kind: "position", index: 180, topPx: 125000 } as const;
  // 2500 document pixels over a long transcript represent only 8.6px
  // on a 960px scrollbar track. No second scroll should be necessary.
  assert.equal(canAdoptAgentNativeThumbPosition(desired, state), true);
  assert.equal(canAdoptAgentNativeThumbPosition(desired, {
    ...state, scrollTop: 125000 + 6000,
  }), false);
});

test("active thumb follows multiple distant ranges within the SAME held gesture", () => {
  const current = { start: 380, end: 400 };
  assert.equal(agentNativeThumbLiveTarget(current, null, 190, 400), 190);
  const staging = { start: 180, end: 196 };
  assert.equal(agentNativeThumbLiveTarget({ start: 190, end: 191 }, staging, 192, 400), null);
  assert.equal(agentNativeThumbLiveTarget({ start: 190, end: 191 }, staging, 40, 400), 40);
  assert.equal(agentNativeThumbLiveTarget({ start: 40, end: 41 }, { start: 32, end: 48 }, 44, 400), null);
  assert.equal(agentNativeThumbLiveTarget({ start: 32, end: 48 }, null, 390, 400), 390);
});

test("active native thumb never seeks for already covered rows or invalid targets", () => {
  const mounted = { start: 140, end: 156 };
  assert.equal(agentNativeThumbLiveTarget(mounted, null, 148, 400), null);
  assert.equal(agentNativeThumbLiveTarget(mounted, null, -1, 400), null);
  assert.equal(agentNativeThumbLiveTarget(mounted, null, 400, 400), null);
  assert.equal(agentNativeThumbLiveTarget(mounted, null, Number.NaN, 400), null);
  assert.equal(agentNativeThumbLiveTarget(mounted, null, 5, 0), null);
});
