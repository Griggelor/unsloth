// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkingPhase } from "../src/features/chat/utils/working-progress-format.ts";

test("phase and real counts appear during long work", () => {
  const text = formatWorkingPhase({
    phase: "match_evicted_turn", current: 500, total: 12000,
    unit: "turns", status: "running", elapsed_ms: 18_000,
  });
  assert.match(text, /Working 6/);
  assert.match(text, /500\/12\.000 Turns/);
  assert.match(text, /0:18/);
});
test("no fake fraction or percentage for blocking token count", () => {
  const text = formatWorkingPhase({
    phase: "checkpoint.original_exact_count", current: 0, total: 3842,
    unit: "messages", status: "running", elapsed_ms: 90_000,
  });
  assert.match(text, /3\.842 Nachrichten/);
  assert.doesNotMatch(text, /0\/3\.842|%/);
});
test("unknown phase cannot surface arbitrary strings", () => {
  const text = formatWorkingPhase({
    phase: "sensitive_private_phase", current: 3, total: null,
    unit: "calls", status: "running", elapsed_ms: 0,
  });
  assert.match(text, /Kontext vorbereiten/);
  assert.doesNotMatch(text, /sensitive_private_phase/);
});
