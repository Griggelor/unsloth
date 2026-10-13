// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import test from "node:test";
import {
  planCheckpointDelta,
  type CheckpointSnapshot,
} from "../src/features/chat/utils/checkpoint-delta-plan.ts";

type ChatRecord = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  parentId: string | null;
  content: Array<{ type: string; text: string }>;
  metadata?: Record<string, unknown>;
  createdAt: number;
};

const record = (id: string, parentId: string | null = null, text = "text"): ChatRecord => ({
  id,
  threadId: "t1",
  parentId,
  role: "assistant",
  content: [{ type: "text", text }],
  createdAt: 1,
});

function baseline(rows: readonly ChatRecord[]): CheckpointSnapshot {
  const result = planCheckpointDelta("t1", rows, null);
  assert.equal(result.kind, "full");
  assert.ok(result.next);
  return result.next;
}

test("first snapshot is always a full atomic write", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const result = planCheckpointDelta("t1", rows, null);
  assert.equal(result.kind, "full");
  assert.equal(result.reason, "no-trusted-baseline");
  assert.ok(result.next);
});

test("unchanged checkpoint performs no storage request", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const result = planCheckpointDelta("t1", rows, baseline(rows));
  assert.equal(result.kind, "skip");
});

test("one existing assistant update is a single-record write", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const next = [rows[0], record("a1", "u1", "stream chunk 1")];
  const result = planCheckpointDelta("t1", next, baseline(rows));
  assert.equal(result.kind, "single");
  assert.equal(result.message.id, "a1");
  const following = planCheckpointDelta("t1", next, result.next);
  assert.equal(following.kind, "skip");
});

test("caller must not commit the next snapshot after a failed write", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const old = baseline(rows);
  const next = [rows[0], record("a1", "u1", "new")];
  const tentative = planCheckpointDelta("t1", next, old);
  assert.equal(tentative.kind, "single");
  // Simulate a rejected PUT: retaining the old successfully committed
  // snapshot forces the same retry, never a mistaken 'skip'.
  assert.equal(planCheckpointDelta("t1", next, old).kind, "single");
  // After an uncertain timeout we invalidate completely.
  assert.equal(planCheckpointDelta("t1", next, null).kind, "full");
});

test("added message forces full sync and preserves all branches", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const grown = [...rows, record("branch-a", "u1", "other answer")];
  assert.equal(planCheckpointDelta("t1", grown, baseline(rows)).kind, "full");
});

test("deleted message forces full sync even if caller later applies deletion separately", () => {
  const rows = [record("u1"), record("a1", "u1")];
  assert.equal(planCheckpointDelta("t1", [rows[0]], baseline(rows)).kind, "full");
});

test("multiple changed messages preserve full atomic transaction semantics", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const newRows = [record("u1", null, "edit"), record("a1", "u1", "edit")];
  assert.equal(planCheckpointDelta("t1", newRows, baseline(rows)).kind, "full");
});

test("reparenting falls back to full even for one message", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const moved = [rows[0], record("a1", null)];
  assert.equal(planCheckpointDelta("t1", moved, baseline(rows)).kind, "full");
});

test("server-managed generated content always falls back to full", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const generated = [
    rows[0],
    { ...record("a1", "u1", "change"), metadata: { generationRunId: "run-1" } },
  ];
  assert.equal(planCheckpointDelta("t1", generated, baseline(rows)).kind, "full");
});

test("research content always falls back to full", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const modified = [
    rows[0],
    { ...record("a1", "u1", "research update"), metadata: { researchRunId: "r1" } },
  ];
  assert.equal(planCheckpointDelta("t1", modified, baseline(rows)).kind, "full");
});

test("cross-thread snapshots never prove another thread was saved", () => {
  const rows = [record("u1"), record("a1", "u1")];
  assert.equal(planCheckpointDelta("t2", rows, baseline(rows)).kind, "full");
});

test("duplicate IDs or mismatched thread IDs cannot become a delta", () => {
  const rows = [record("u1"), record("a1", "u1")];
  const base = baseline(rows);
  assert.equal(planCheckpointDelta("t1", [rows[0], rows[0]], base).kind, "full");
  assert.equal(
    planCheckpointDelta("t1", [{ ...rows[0], threadId: "t2" }], base).kind,
    "full",
  );
});

test("memory budget never allows an incomplete snapshot to count as saved", () => {
  const rows = [record("u1", null, "x".repeat(1000))];
  const r = planCheckpointDelta("t1", rows, null, { maxSnapshotBytes: 64 });
  assert.equal(r.kind, "full");
  assert.equal(r.next, null);
  assert.equal(planCheckpointDelta("t1", rows, r.next).kind, "full");
});

test("10-million historic estimated tokens and one changed small assistant update", () => {
  const old = [
    record("history", null, "x".repeat(10_000_000 * 4)),
    record("latest", "history", "Working"),
  ];
  const previous = baseline(old);
  const now = [old[0], record("latest", "history", "Working, part 2")];
  const plan = planCheckpointDelta("t1", now, previous);
  assert.equal(plan.kind, "single");
  assert.equal(plan.message.id, "latest");
  assert.ok(JSON.stringify(plan.message).length < 500);
  assert.ok(plan.next.estimatedRetainedBytes < 128 * 1024 * 1024);
});
