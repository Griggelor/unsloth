// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  indicesInRenderPlan,
  planMessageRenderWindow,
} from "../src/components/assistant-ui/experimental-render-window.ts";

const indices = (request: Parameters<typeof planMessageRenderWindow>[0]) =>
  [...indicesInRenderPlan(planMessageRenderWindow(request))];

test("empty history mounts nothing; storage is unaffected", () => {
  assert.deepEqual(planMessageRenderWindow({ messageCount: 0 }), {
    ranges: [], mountedMessageCount: 0,
  });
});

test("small histories render their entire tail without phantom rows", () => {
  assert.deepEqual(indices({ messageCount: 3 }), [0, 1, 2]);
});

test("long histories mount only a bounded reader-centred span", () => {
  const plan = planMessageRenderWindow({ messageCount: 100_000, focusIndex: 4000 });
  assert.deepEqual(plan.ranges, [{ start: 3992, end: 4013 }]);
  assert.equal(plan.mountedMessageCount, 21);
  assert.equal([...indicesInRenderPlan(plan)].length, 21);
});

test("a separately pinned live tail survives a reader scrolling far upward", () => {
  const plan = planMessageRenderWindow({
    messageCount: 10_000, focusIndex: 300, before: 2, after: 2,
    protectedTailStart: 9998,
  });
  assert.deepEqual(plan.ranges, [
    { start: 298, end: 303 },
    { start: 9998, end: 10_000 },
  ]);
  assert.deepEqual([...indicesInRenderPlan(plan)], [298, 299, 300, 301, 302, 9998, 9999]);
});

test("overlapping and adjacent spans merge with no duplicate indices", () => {
  for (const protectedTailStart of [89, 90, 91, 92, 93]) {
    const rendered = indices({
      messageCount: 100, focusIndex: 89, before: 4, after: 3,
      protectedTailStart,
    });
    assert.equal(new Set(rendered).size, rendered.length);
    assert.deepEqual(rendered, Array.from({ length: 100 - 85 }, (_, i) => i + 85));
  }
});

test("a growing live response retains stable original indices", () => {
  const request = { focusIndex: 20, before: 2, after: 2, protectedTailStart: 98 };
  const earlier = indices({ ...request, messageCount: 100 });
  const later = indices({ ...request, messageCount: 101 });
  assert.deepEqual(earlier, [18, 19, 20, 21, 22, 98, 99]);
  assert.deepEqual(later, [...earlier, 100]);
});

test("deleting messages clamps stale focus safely to the new end", () => {
  assert.deepEqual(indices({ messageCount: 5, focusIndex: 50, before: 2, after: 2 }), [2, 3, 4]);
  assert.deepEqual(indices({ messageCount: 5, focusIndex: -20, before: 2, after: 2 }), [0, 1, 2]);
});

test("a protected tail beginning at count is empty, not an extra row", () => {
  assert.deepEqual(indices({ messageCount: 10, focusIndex: 0, before: 0, after: 0, protectedTailStart: 10 }), [0]);
});

test("invalid spans and non-integer indices reject rather than silently hide history", () => {
  assert.throws(() => planMessageRenderWindow({ messageCount: -1 }), RangeError);
  assert.throws(() => planMessageRenderWindow({ messageCount: 10, before: -1 }), RangeError);
  assert.throws(() => planMessageRenderWindow({ messageCount: 10, after: 300 }), RangeError);
  assert.throws(() => planMessageRenderWindow({ messageCount: 10, protectedTailStart: 11 }), RangeError);
  assert.throws(() => planMessageRenderWindow({ messageCount: 10, focusIndex: Number.NaN }), RangeError);
});

test("exhaustive small-message plans produce ordered unique in-bounds indices", () => {
  for (let count = 0; count <= 25; count += 1) {
    for (let focus = -2; focus <= count + 2; focus += 1) {
      for (let pinned = 0; pinned <= count; pinned += 1) {
        const plan = planMessageRenderWindow({
          messageCount: count, focusIndex: focus, before: 3, after: 4,
          protectedTailStart: pinned,
        });
        const all = [...indicesInRenderPlan(plan)];
        assert.equal(all.length, plan.mountedMessageCount);
        assert.equal(new Set(all).size, all.length);
        assert.ok(all.every((i) => i >= 0 && i < count));
        assert.ok(all.every((i, pos) => pos === 0 || i > all[pos - 1]));
        if (count > 0 && pinned < count) {
          assert.ok(all.includes(count - 1));
        }
      }
    }
  }
});
