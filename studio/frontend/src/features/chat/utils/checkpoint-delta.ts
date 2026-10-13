// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Conservative, opt-in-by-call checkpoint delta planner.
 *
 * The caller commits nextSnapshot ONLY after every write succeeded. A failure
 * invalidates its snapshot, so the next checkpoint repairs with full sync.
 * This never handles deletion: only explicit prune/delete workflows may delete
 * stored messages. SHA-256 ensures old-message edits are not silently skipped,
 * without retaining a second multi-megabyte copy of the transcript in memory.
 */
import type { MessageRecord } from "../types";
// Mirrors RESEARCH_METADATA_KEYS from research-message-sync.ts. This file is
// deliberately import-free at runtime so the CPU-only node:test harness can
// exercise the same code without bundler dependency stubs.
const RESEARCH_METADATA_KEYS = [
  "researchRunId", "researchRun", "researchStatus", "researchPlanRevision", "serverManaged",
] as const;
function hasResearchMetadata(value: unknown): boolean {
  return !!value && typeof value === "object" &&
    RESEARCH_METADATA_KEYS.some((key) => key in value);
}

export type CheckpointSnapshot = ReadonlyMap<string, string>;
export type CheckpointPlan =
  | { mode: "full"; nextSnapshot: CheckpointSnapshot | null; reason: string }
  | { mode: "delta"; nextSnapshot: CheckpointSnapshot; changed: MessageRecord[] }
  | { mode: "unchanged"; nextSnapshot: CheckpointSnapshot };

const MAX_DELTA_WRITES = 32;

function normalizedSignatureInput(record: MessageRecord): string {
  // A fixed tuple ignores JS object property insertion order on the record,
  // but includes metadata, links, attachments and the complete content.
  // Nested object key changes may trigger a harmless additional write.
  return JSON.stringify([
    record.id,
    record.threadId,
    record.parentId ?? null,
    record.role,
    record.content,
    record.attachments ?? null,
    record.metadata ?? null,
    record.createdAt,
  ]);
}

function hexadecimal(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function planCheckpointDelta(
  messages: readonly MessageRecord[],
  previous: CheckpointSnapshot | null,
): Promise<CheckpointPlan> {
  // Every auto-save containing research metadata needs the existing server
  // reconciliation before writing. Never attempt individual writes there.
  if (messages.some((record) => hasResearchMetadata(record.metadata))) {
    return { mode: "full", nextSnapshot: null, reason: "server-owned research" };
  }
  const sha = globalThis.crypto?.subtle;
  if (!sha) {
    return { mode: "full", nextSnapshot: null, reason: "secure digest unavailable" };
  }
  const ids = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.id) || !message.id) {
      return { mode: "full", nextSnapshot: null, reason: "duplicate or missing message id" };
    }
    ids.add(message.id);
  }
  // A removed message can be a branch/delete/rewind operation. Never guess
  // about storage's prune semantics or return an incomplete delta.
  if (previous && [...previous.keys()].some((id) => !ids.has(id))) {
    return { mode: "full", nextSnapshot: null, reason: "message disappeared" };
  }
  const next = new Map<string, string>();
  const changed: MessageRecord[] = [];
  try {
    for (const record of messages) {
      const json = normalizedSignatureInput(record);
      const digest = hexadecimal(await sha.digest("SHA-256", new TextEncoder().encode(json)));
      next.set(record.id, digest);
      if (previous && previous.get(record.id) !== digest) {
        changed.push(record);
      }
    }
  } catch {
    return { mode: "full", nextSnapshot: null, reason: "message fingerprint unavailable" };
  }
  if (!previous) {
    return { mode: "full", nextSnapshot: next, reason: "first checkpoint" };
  }
  if (changed.length === 0) {
    return { mode: "unchanged", nextSnapshot: next };
  }
  if (changed.length > MAX_DELTA_WRITES) {
    return { mode: "full", nextSnapshot: next, reason: "large batch of edits" };
  }
  // The per-message route inserts single rows. Newly inserted children must
  // not precede their newly inserted parent even when export() is unsorted.
  const pendingById = new Map(changed.map((record) => [record.id, record]));
  const ordered: MessageRecord[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (record: MessageRecord): boolean => {
    if (visiting.has(record.id)) return false;
    if (visited.has(record.id)) return true;
    visiting.add(record.id);
    const parent = record.parentId;
    if (parent) {
      // Do not materialize a dangling parent when the history is partial.
      if (!ids.has(parent)) return false;
      const pendingParent = pendingById.get(parent);
      if (pendingParent && !visit(pendingParent)) return false;
    }
    visiting.delete(record.id);
    visited.add(record.id);
    ordered.push(record);
    return true;
  };
  for (const record of changed) {
    if (!visit(record)) {
      return { mode: "full", nextSnapshot: next, reason: "missing or cyclic parent" };
    }
  }
  return { mode: "delta", nextSnapshot: next, changed: ordered };
}

/** The returned snapshot is valid only when ALL writes have acknowledged. */
export async function persistCheckpointMessages(
  messages: readonly MessageRecord[],
  previous: CheckpointSnapshot | null,
  writers: {
    full: () => Promise<unknown>;
    message: (record: MessageRecord) => Promise<unknown>;
  },
): Promise<CheckpointSnapshot | null> {
  const plan = await planCheckpointDelta(messages, previous);
  if (plan.mode === "full") {
    await writers.full();
  } else if (plan.mode === "delta") {
    for (const record of plan.changed) {
      await writers.message(record);
    }
  }
  return plan.nextSnapshot;
}
