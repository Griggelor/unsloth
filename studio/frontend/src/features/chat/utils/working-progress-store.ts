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
  threadId: string | null | undefined, signal: AbortSignal, runId?: string,
): Run | null {
  // The durable worker and legacy stream need the SAME client-generated run key.
  // Reject all other values, instead of accidentally polling a different request.
  const id = typeof runId === "string" ? runId.replace(/-/g, "") : "";
  if (import.meta.env.VITE_CONTEXT_PROGRESS_QA !== "1" ||
      !threadId || !/^[0-9a-f]{32}$/.test(id) || signal.aborted) return null;
  active.get(threadId)?.stop();
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

// The transport invokes this synchronously without importing the React store.
// This keeps chat-api / chat-adapter compatible with isolated module-stub tests.
if (typeof window !== "undefined") {
  window.addEventListener("unsloth-qa-working-start", (event: Event) => {
    const detail = (event as CustomEvent<{
      threadId?: string; runId?: string; signal?: AbortSignal;
    }>).detail;
    if (!detail?.threadId || !detail.runId || !detail.signal) return;
    startWorkingPhase(detail.threadId, detail.signal, detail.runId);
  });
}
