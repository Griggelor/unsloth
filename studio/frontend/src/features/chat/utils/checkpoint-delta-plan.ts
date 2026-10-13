// SPDX-License-Identifier: AGPL-3.0-only
// Experimental long-chat checkpoint delta planner; no production call sites yet.
//
// This module is intentionally pure: the caller must commit `next` ONLY after
// the selected write has completed successfully. An interruption or failed
// request invalidates the snapshot and requires a full transaction on retry.
//
// Exact JSON representations avoid probabilistic hash collisions. The memory
// budget caps the extra retention cost for extremely long threads; overflow
// FAILS OPEN to the existing full-snapshot persistence, never skips a write.

export type CheckpointSnapshot = Readonly<{
  threadId: string;
  serializedById: ReadonlyMap<string, string>;
  estimatedRetainedBytes: number;
}>;

type MinimalMessage = {
  id: string;
  threadId: string;
  parentId?: string | null;
  role?: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
};

export type CheckpointPlan<T extends MinimalMessage> =
  | {
      kind: "full";
      reason: string;
      next: CheckpointSnapshot | null;
    }
  | {
      kind: "skip";
      reason: "unchanged";
      next: CheckpointSnapshot;
    }
  | {
      kind: "single";
      reason: "one-existing-message-changed";
      message: T;
      next: CheckpointSnapshot;
    };

const DEFAULT_MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

function serverManaged(message: MinimalMessage): boolean {
  const meta = message.metadata;
  return (
    meta?.serverManaged === true ||
    typeof meta?.researchRunId === "string" ||
    typeof meta?.generationRunId === "string" ||
    typeof meta?.researchId === "string" ||
    typeof meta?.researchTurnId === "string" ||
    typeof meta?.serverRevision === "number"
  );
}

/**
 * Select a safe subset of the old checkpoint write. The only incremental case
 * is one changed *existing*, non-server-managed record. Every ambiguous edit,
 * multi-message change, deleted/reordered branch, or oversized snapshot falls
 * back to the prior atomic full-sync method. A full-sync of a short thread also
 * establishes the first trusted baseline; no on-disk state is inferred.
 *
 * Reading every message is O(history JSON size), but network transfer/SQLite
 * upsert/readback becomes O(delta) on the fast path.
 */
export function planCheckpointDelta<T extends MinimalMessage>(
  threadId: string,
  messages: readonly T[],
  prior: CheckpointSnapshot | null,
  options: { maxSnapshotBytes?: number } = {},
): CheckpointPlan<T> {
  const max = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  if (!Number.isFinite(max) || max <= 0) {
    return { kind: "full", reason: "invalid-memory-budget", next: null };
  }

  const serializedById = new Map<string, string>();
  let estimatedRetainedBytes = 0;
  for (const message of messages) {
    if (
      !message.id ||
      message.threadId !== threadId ||
      serializedById.has(message.id)
    ) {
      return { kind: "full", reason: "invalid-message-identity", next: null };
    }
    const json = JSON.stringify(message);
    if (typeof json !== "string") {
      return { kind: "full", reason: "unserializable-record", next: null };
    }
    // Upper-bound the added UTF-16 storage rather than assuming ASCII.
    estimatedRetainedBytes += json.length * 2 + 64;
    if (estimatedRetainedBytes > max) {
      return { kind: "full", reason: "snapshot-memory-budget", next: null };
    }
    serializedById.set(message.id, json);
  }
  const next: CheckpointSnapshot = {
    threadId,
    serializedById,
    estimatedRetainedBytes,
  };

  if (!prior || prior.threadId !== threadId) {
    return { kind: "full", reason: "no-trusted-baseline", next };
  }

  // Any new or missing message can change the parent/branch graph.
  // The existing full-sync transaction handles these cases atomically.
  if (
    prior.serializedById.size !== serializedById.size ||
    [...serializedById.keys()].some((id) => !prior.serializedById.has(id))
  ) {
    return { kind: "full", reason: "message-set-changed", next };
  }

  const changed = messages.filter(
    (message) =>
      prior.serializedById.get(message.id) !== serializedById.get(message.id),
  );
  if (changed.length === 0) {
    return { kind: "skip", reason: "unchanged", next };
  }
  if (changed.length !== 1) {
    return { kind: "full", reason: "multi-message-change", next };
  }

  const message = changed[0];
  if (serverManaged(message)) {
    return { kind: "full", reason: "server-managed-message", next };
  }
  // Reparenting may be an intended branch edit; do it via the existing
  // atomic full-sync path, not one isolated message upsert.
  const oldJson = prior.serializedById.get(message.id);
  if (oldJson === undefined) {
    return { kind: "full", reason: "unknown-message", next };
  }
  const previous = JSON.parse(oldJson) as MinimalMessage;
  if (serverManaged(previous)) {
    return { kind: "full", reason: "previously-server-managed", next };
  }
  if (previous.role !== message.role || previous.createdAt !== message.createdAt) {
    return { kind: "full", reason: "identity-fields-changed", next };
  }
  if ((previous.parentId ?? null) !== (message.parentId ?? null)) {
    return { kind: "full", reason: "reparented-message", next };
  }
  return {
    kind: "single",
    reason: "one-existing-message-changed",
    message,
    next,
  };
}
