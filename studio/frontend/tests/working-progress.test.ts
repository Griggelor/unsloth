// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("an existing non-QA backend is diagnosed instead of silently showing Working", () => {
  const line = formatWorkingPhase({
    phase: "qa_backend_missing", current: 0, total: null,
    unit: "calls", status: "running", elapsed_ms: 24_000,
  });
  assert.match(line, /QA-Backend nicht installiert/);
});

test("legacy streaming and durable chat both forward the same progress key", () => {
  const base = new URL("../src/features/chat/", import.meta.url);
  const adapter = readFileSync(new URL("api/chat-adapter.ts", base), "utf8");
  const runApi = readFileSync(new URL("api/chat-generation-api.ts", base), "utf8");
  const streamApi = readFileSync(new URL("api/chat-api.ts", base), "utf8");
  assert.match(adapter, /createChatGenerationRunUntilAbort[\s\S]*?workingProgressId,/);
  assert.match(adapter, /streamChatCompletions\([\s\S]*?workingProgressId,/);
  assert.match(runApi, /X-Unsloth-Context-Progress/);
  assert.match(streamApi, /X-Unsloth-Context-Progress/);
});
