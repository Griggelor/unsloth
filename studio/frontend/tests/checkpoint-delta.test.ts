// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  persistCheckpointMessages,
  planCheckpointDelta,
  type CheckpointSnapshot,
} from "../src/features/chat/utils/checkpoint-delta.ts";
import type { MessageRecord } from "../src/features/chat/types";

function row(id: string, parentId: string | null = null, text = id): MessageRecord {
  return {
    id, threadId: "thread-1", parentId,
    role: id.startsWith("a") ? "assistant" : "user",
    content: [{ type: "text", text }],
    createdAt: 1_700_000_000_000,
  };
}
async function baseline(messages: MessageRecord[]): Promise<CheckpointSnapshot> {
  const plan = await planCheckpointDelta(messages, null);
  assert.equal(plan.mode, "full");
  assert.ok(plan.nextSnapshot);
  return plan.nextSnapshot;
}

test("first checkpoint uses the old complete sync and stores only hashes", async () => {
  const messages = [row("u0"), row("a0", "u0")];
  const calls: string[] = [];
  const snapshot = await persistCheckpointMessages(messages, null, {
    full: async () => { calls.push("full"); },
    message: async (m) => { calls.push(m.id); },
  });
  assert.deepEqual(calls, ["full"]);
  assert.equal(snapshot?.size, 2);
  assert.equal(snapshot?.get("u0")?.length, 64);
  assert.ok(!snapshot?.get("u0")?.includes("u0"), "cache must not contain raw messages");
});

test("unchanged 2,000-message history causes no write at all", async () => {
  const messages = Array.from({length: 2000}, (_, i) =>
    row(`u${i}`, i ? `u${i-1}` : null, "long history " + "x".repeat(1000)));
  const prior = await baseline(messages);
  let full = 0;
  let delta = 0;
  const next = await persistCheckpointMessages(messages, prior, {
    full: async () => { full++; },
    message: async () => { delta++; },
  });
  assert.equal(full, 0);
  assert.equal(delta, 0);
  assert.equal(next?.size, 2000);
});

test("one amended assistant message saves exactly one message", async () => {
  const old = [row("u0"), row("a0", "u0", "thinking"), row("u1", "a0")];
  const snap = await baseline(old);
  const changed = [...old];
  changed[1] = row("a0", "u0", "thinking plus a streamed chunk");
  const called: string[] = [];
  const next = await persistCheckpointMessages(changed, snap, {
    full: async () => { called.push("full"); },
    message: async (record) => { called.push(record.id); },
  });
  assert.deepEqual(called, ["a0"]);
  assert.ok(next?.get("a0") !== snap.get("a0"));
});

test("old messages and their metadata edits cannot be silently ignored", async () => {
  const old = [row("u0"), row("a0", "u0"), row("u1", "a0")];
  const snap = await baseline(old);
  const changed = old.map(m => ({...m}));
  changed[0].metadata = { updatedFromEdit: "yes" };
  const plan = await planCheckpointDelta(changed, snap);
  assert.equal(plan.mode, "delta");
  if (plan.mode === "delta") assert.deepEqual(plan.changed.map(x => x.id), ["u0"]);
});

test("new children are written parent-first even if assistant-ui export is unsorted", async () => {
  const old = [row("u0")];
  const snap = await baseline(old);
  const messages = [row("a1", "u1"), row("u1", "u0"), ...old];
  const plan = await planCheckpointDelta(messages, snap);
  assert.equal(plan.mode, "delta");
  if (plan.mode === "delta") assert.deepEqual(plan.changed.map(x => x.id), ["u1", "a1"]);
});

test("missing parent forces the proven full-sync path", async () => {
  const prior = await baseline([row("u0")]);
  const plan = await planCheckpointDelta([row("u0"), row("a1", "missing")], prior);
  assert.equal(plan.mode, "full");
});

test("a removed message never triggers silent prune or delta overwrite", async () => {
  const snap = await baseline([row("u0"), row("a0", "u0")]);
  const plan = await planCheckpointDelta([row("u0")], snap);
  assert.equal(plan.mode, "full");
  assert.equal(plan.nextSnapshot, null);
});

test("research/server-managed messages stay in reconciliation-aware full sync", async () => {
  const rec = {...row("a0"), metadata: {serverManaged: true, researchRunId: "r1"}};
  const plan = await planCheckpointDelta([rec], await baseline([row("a0")]));
  assert.equal(plan.mode, "full");
  assert.equal(plan.nextSnapshot, null);
});

test("duplicate IDs and cyclic parents cannot use a delta", async () => {
  const snap = await baseline([row("u0")]);
  assert.equal((await planCheckpointDelta([row("u0"), row("u0")], snap)).mode, "full");
  assert.equal((await planCheckpointDelta([row("u0"), row("a0", "a1"), row("a1", "a0")], snap)).mode, "full");
});

test("large rewrites fall back to one atomic bulk write", async () => {
  const old = Array.from({length: 40}, (_, i) => row(`u${i}`));
  const snap = await baseline(old);
  const changed: MessageRecord[] = old.map(m => ({...m, content: [{type:"text" as const, text:"revised"}]}));
  assert.equal((await planCheckpointDelta(changed, snap)).mode, "full");
});

test("a rejected delta does not commit a false successful snapshot", async () => {
  const original = [row("u0")];
  const snap = await baseline(original);
  const next = [...original, row("a0", "u0")];
  await assert.rejects(
    () => persistCheckpointMessages(next, snap, {
      full: async () => { throw new Error("not expected"); },
      message: async () => { throw new Error("network down"); },
    }),
    /network down/,
  );
  const repairCalls: string[] = [];
  // A caller invalidates its snapshot on rejection. The next attempt must
  // restore the complete history, NOT assume the rejected delta was durable.
  await persistCheckpointMessages(next, null, {
    full: async () => { repairCalls.push("full"); },
    message: async () => { repairCalls.push("delta"); },
  });
  assert.deepEqual(repairCalls, ["full"]);
});

test("new assistant content with ~1m historical tokens sends only its new payload", async () => {
  const old = Array.from({length: 128}, (_, i) =>
    row(`u${i}`, i ? `u${i-1}` : null, "z".repeat(32000)));
  const saved = await baseline(old);
  const append = row("a128", "u127", "final " + "K".repeat(160));
  const plan = await planCheckpointDelta([...old, append], saved);
  assert.equal(plan.mode, "delta");
  if (plan.mode !== "delta") return;
  assert.deepEqual(plan.changed.map(v => v.id), ["a128"]);
  const bytes = JSON.stringify(plan.changed).length;
  assert.ok(bytes < 1000, `delta ${bytes} bytes not small`);
});

test("changes in content, attachments, links and role all invalidate fingerprints", async () => {
  const old = [row("u0")];
  const snap = await baseline(old);
  const candidates = [
    {...old[0], role: "assistant"},
    {...old[0], content: [{type:"text", text:"different"}]},
    {...old[0], attachments: [{id:"file-1"}]},
    {...old[0], createdAt: 1_700_000_000_001},
  ] as MessageRecord[];
  for (const change of candidates) {
    const plan = await planCheckpointDelta([change], snap);
    assert.equal(plan.mode, "delta");
  }
});

test("checkpoint wiring treats protected messages as an error, not a successful delta", async () => {
  const runtime = readFileSync(
    new URL("../src/features/chat/runtime-provider.tsx", import.meta.url), "utf8",
  );
  const storage = readFileSync(
    new URL("../src/features/chat/utils/chat-history-storage.ts", import.meta.url), "utf8",
  );
  assert.match(runtime, /saveStoredChatMessage\(record, \{ strictProtected: true \}\)/);
  assert.match(storage, /if \(options\.strictProtected\) throw error/);
  const baselineSnapshot = await baseline([row("u0")]);
  await assert.rejects(
    persistCheckpointMessages([row("u0"), row("a0", "u0")], baselineSnapshot, {
      full: async () => { throw new Error("unexpected full"); },
      message: async () => { throw new Error("server-managed message conflict 409"); },
    }),
    /409/,
  );
});
