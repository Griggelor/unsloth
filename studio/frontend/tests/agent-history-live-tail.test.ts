// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import assert from "node:assert/strict";
import test from "node:test";
import { readSrc } from "./helpers/kit.ts";
import { shouldRepairAgentLiveTail } from "../src/components/assistant-ui/agent-history-live-tail.ts";

const steady = {
  isRunning: true, following: true, readerNavigation: false,
  recentGesture: false, atPhysicalBottom: true, mountedRows: 1,
  visibleRows: true, tailMounted: true,
};

test("active stream repairs an invisible or stale bottom window", () => {
  assert.equal(shouldRepairAgentLiveTail(steady), false);
  assert.equal(shouldRepairAgentLiveTail({ ...steady, visibleRows: false }), true);
  assert.equal(shouldRepairAgentLiveTail({ ...steady, tailMounted: false }), true);
});

test("neither detached reading nor search navigation may auto-repair", () => {
  for (const change of [
    { isRunning: false }, { following: false }, { readerNavigation: true },
    { recentGesture: true }, { atPhysicalBottom: false }, { mountedRows: 0 },
  ]) {
    assert.equal(shouldRepairAgentLiveTail({ ...steady, visibleRows: false, ...change }), false,
      JSON.stringify(change));
  }
});

test("live-tail recovery is wired to streaming mutations and uses the shared scroll owner", () => {
  const source = readSrc("components/assistant-ui/agent-history-scroll-messages.tsx");
  assert.match(source, /shouldRepairAgentLiveTail\(/);
  assert.match(source, /scheduleLiveTailCheck\(\)/);
  assert.match(source, /characterData: true/);
  assert.match(source, /jumpBottom\("auto"\)/);
  assert.doesNotMatch(source, /viewport\.scrollTop\s*=/);
});
