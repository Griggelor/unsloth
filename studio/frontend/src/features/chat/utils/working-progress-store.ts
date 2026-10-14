// SPDX-License-Identifier: AGPL-3.0-only
/** Ephemeral QA status store; no chat content, persistence, or full-thread redraws. */
import { useSyncExternalStore } from "react";
import { authFetch } from "@/features/auth";
import type { WorkingPhaseSnapshot } from "./working-progress-format";
type Run = { id: string; stop: () => void };
const snapshots = new Map<string, WorkingPhaseSnapshot>();
const active = new Map<string, Run>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function useWorkingPhase(threadId: string | null | undefined): WorkingPhaseSnapshot | null {
  return useSyncExternalStore(
    subscribe, () => (threadId ? snapshots.get(threadId) : null) ?? null, () => null,
  );
}
export function startWorkingPhase(
  threadId: string | null | undefined, signal: AbortSignal,
): Run | null {
  if (import.meta.env.VITE_CONTEXT_PROGRESS_QA !== "1" ||
      !threadId || !globalThis.crypto?.randomUUID || signal.aborted) return null;
  active.get(threadId)?.stop();
  const id = globalThis.crypto.randomUUID().replace(/-/g, "");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  snapshots.set(threadId, {
    phase: "client_prepare", current: 0, total: null,
    unit: "messages", status: "running", elapsed_ms: 0,
  });
  notify();
  const stop = () => {
    if (active.get(threadId)?.id !== id) return;
    active.delete(threadId);
    controller.abort();
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    snapshots.delete(threadId);
    notify();
  };
  active.set(threadId, { id, stop });
  signal.addEventListener("abort", stop, { once: true });
  const poll = async () => {
    try {
      const response = await authFetch(
        "/api/inference/working-progress/" + id, { signal: controller.signal },
      );
      if (response.ok) {
        const data = (await response.json()) as WorkingPhaseSnapshot;
        if (active.get(threadId)?.id !== id) return;
        if (typeof data?.phase === "string" &&
            typeof data.elapsed_ms === "number" &&
            typeof data.current === "number" &&
            (data.total === null || typeof data.total === "number") &&
            ["running", "done", "failed"].includes(data.status)) {
          snapshots.set(threadId, data);
          notify();
        }
      }
    } catch {
      // Unregistered request, transient backend outage, or old backend: harmless.
    } finally {
      if (active.get(threadId)?.id === id && !signal.aborted) {
        timer = setTimeout(() => { void poll(); }, 750);
      }
    }
  };
  timer = setTimeout(() => { void poll(); }, 250);
  return { id, stop };
}
