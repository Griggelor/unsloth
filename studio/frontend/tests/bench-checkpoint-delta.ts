// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** CPU-only measurement of full-snapshot serialization versus delta planning.
 * This does not make network calls and MUST NOT be represented as an end-to-end
 * latency improvement. All messages are synthetic and contain no user data.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { planCheckpointDelta } from "../src/features/chat/utils/checkpoint-delta.ts";
import type { MessageRecord } from "../src/features/chat/types";

function sample(estimatedTokens: number): MessageRecord[] {
  const count = Math.min(2048, Math.max(32, Math.ceil(estimatedTokens / 512)));
  const perMessage = Math.ceil(estimatedTokens * 4 / count);
  const payload = "Synthetic history " + "x".repeat(Math.max(0, perMessage - 18));
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`, threadId: "benchmark-thread",
    parentId: i ? `msg-${i - 1}` : null,
    role: i % 2 ? "assistant" : "user",
    content: [{ type: "text", text: payload }],
    createdAt: 1_700_000_000_000 + i,
  }));
}

async function run(tokens: number) {
  const msgs = sample(tokens);
  const startedFull = performance.now();
  const fullPayload = JSON.stringify({ messages: msgs, pruneMissing: false });
  const fullSerializationMs = performance.now() - startedFull;
  const fullBytes = Buffer.byteLength(fullPayload);

  const startedBaseline = performance.now();
  const baseline = await planCheckpointDelta(msgs, null);
  const baselineMs = performance.now() - startedBaseline;
  if (baseline.mode !== "full" || !baseline.nextSnapshot) {
    throw new Error("missing secure baseline");
  }
  const startedUnchanged = performance.now();
  const unchanged = await planCheckpointDelta(msgs, baseline.nextSnapshot);
  const unchangedMs = performance.now() - startedUnchanged;
  if (unchanged.mode !== "unchanged") {
    throw new Error("unchanged history wrongly triggers network writes");
  }
  const changed = msgs.slice();
  const last = msgs[msgs.length - 1];
  changed[changed.length - 1] = {
    ...last,
    content: [{ type: "text", text: "Synthetic newly streamed text".repeat(24) }],
  };
  const startedChanged = performance.now();
  const delta = await planCheckpointDelta(changed, unchanged.nextSnapshot);
  const deltaMs = performance.now() - startedChanged;
  if (delta.mode !== "delta" || delta.changed.length !== 1) {
    throw new Error("changed assistant generated unexpected full snapshot");
  }
  const deltaBytes = Buffer.byteLength(JSON.stringify(delta.changed[0]));
  return {
    target_estimated_tokens: tokens,
    message_count: msgs.length,
    synthetic_full_payload_bytes: fullBytes,
    synthetic_delta_payload_bytes: deltaBytes,
    transfer_bytes_reduction_ratio: Math.round(fullBytes / deltaBytes),
    full_json_serialization_ms: Math.round(fullSerializationMs * 1000) / 1000,
    initial_crypto_plan_ms: Math.round(baselineMs * 1000) / 1000,
    repeat_noop_crypto_plan_ms: Math.round(unchangedMs * 1000) / 1000,
    one_changed_crypto_plan_ms: Math.round(deltaMs * 1000) / 1000,
    comparisons: {
      full_sync_would_transmit_bytes: fullBytes,
      unchanged_checkpoint_transmits_bytes: 0,
      changed_checkpoint_transmits_bytes: deltaBytes,
    },
  };
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex < 0 || !args[outIndex + 1]) {
  throw new Error("Usage: node --experimental-strip-types bench-checkpoint-delta.ts --out file.json");
}
const cases = [];
for (const estimated of [200_000, 1_000_000, 10_000_000]) {
  const data = await run(estimated);
  cases.push(data);
  console.log(
    `delta-frontend ${estimated} tokens: full=${(data.synthetic_full_payload_bytes / 1e6).toFixed(2)}MB, ` +
    `delta=${data.synthetic_delta_payload_bytes}B, noop-plan=${data.repeat_noop_crypto_plan_ms}ms, ` +
    `changed-plan=${data.one_changed_crypto_plan_ms}ms`
  );
}
const output = {
  schema_version: 1,
  commit_sha: process.env.GITHUB_SHA ?? "local",
  kind: "synthetic_frontend_cpu_and_payload_size_not_network_or_windows",
  limitations: [
    "The delta plan still hashes the entire exported history; a smaller network payload is not a zero-cost browser operation.",
    "Payload size is representative but not a measurement of actual transport, response parse or WebView freeze.",
    "Estimated tokens are synthetic text bytes divided by four, not model-tokenizer counts.",
    "Do not establish hard wall-time thresholds from shared CI runners.",
  ],
  cases,
};
mkdirSync(dirname(args[outIndex + 1]), {recursive: true});
writeFileSync(args[outIndex + 1], JSON.stringify(output, null, 2));
