// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import test from "node:test";
import { readSrc } from "./helpers/kit.ts";
import {
  allowsAgentReaderScrollIntent,
  consumeAgentReaderScrollIntent,
  initialAgentReaderScrollIntent,
  requestAgentReaderScrollIntent,
} from "../src/components/assistant-ui/agent-history-navigation.ts";

test("a layout/anchor scroll without fresh reader input cannot start a window seek", () => {
  const initial = initialAgentReaderScrollIntent();
  assert.equal(allowsAgentReaderScrollIntent(initial, initial.epoch), false);
  const gesture = requestAgentReaderScrollIntent(initial);
  assert.equal(allowsAgentReaderScrollIntent(gesture, gesture.epoch), true);
  const settled = consumeAgentReaderScrollIntent(gesture, gesture.epoch);
  assert.equal(allowsAgentReaderScrollIntent(settled, gesture.epoch), false);
  // 200 redundant native/synthetic scroll events from two oscillating DOM windows
  // must never become 200 new reader-navigation transactions.
  for (let i = 0; i < 200; i++) {
    assert.equal(allowsAgentReaderScrollIntent(settled, gesture.epoch), false);
    assert.deepEqual(consumeAgentReaderScrollIntent(settled, gesture.epoch), settled);
  }
  const second = requestAgentReaderScrollIntent(settled);
  assert.equal(allowsAgentReaderScrollIntent(second, second.epoch), true);
});

test("superseded rAF scroll callbacks cannot consume a newer gesture", () => {
  const first = requestAgentReaderScrollIntent(initialAgentReaderScrollIntent());
  const next = requestAgentReaderScrollIntent(first);
  assert.equal(allowsAgentReaderScrollIntent(next, first.epoch), false);
  assert.deepEqual(consumeAgentReaderScrollIntent(next, first.epoch), next);
  assert.equal(allowsAgentReaderScrollIntent(next, next.epoch), true);
  const consumed = consumeAgentReaderScrollIntent(next, next.epoch);
  assert.equal(consumed.sampledEpoch, next.epoch);
});

test("the production scroll handler gates passive seeks by gesture epoch", () => {
  const source = readSrc("components/assistant-ui/agent-history-scroll-messages.tsx");
  assert.match(source, /allowsAgentReaderScrollIntent\(/);
  assert.match(source, /consumeAgentReaderScrollIntent\(/);
  assert.match(source, /requestAgentReaderScrollIntent\(/);
});
