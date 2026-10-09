// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AgentHistoryModeState = {
  enabledThreads: Record<string, true>;
  setEnabled: (threadId: string, enabled: boolean) => void;
};

/** Local, per-thread display preference. Never modifies the persisted chat transcript. */
export const useAgentHistoryModeStore = create<AgentHistoryModeState>()(
  persist(
    (set) => ({
      enabledThreads: {},
      setEnabled: (threadId, enabled) => {
        if (!threadId) return;
        set((state) => {
          const enabledThreads = { ...state.enabledThreads };
          if (enabled) enabledThreads[threadId] = true;
          else delete enabledThreads[threadId];
          return { enabledThreads };
        });
      },
    }),
    {
      name: "unsloth_agent_chat_history_v1",
      partialize: (state) => ({ enabledThreads: state.enabledThreads }),
      merge: (persisted, current) => {
        const saved = (persisted as { enabledThreads?: unknown } | null)?.enabledThreads;
        const entries = saved && typeof saved === "object" && !Array.isArray(saved)
          ? Object.entries(saved).filter(([id, enabled]) => id.length > 0 && enabled === true)
          : [];
        return { ...current, enabledThreads: Object.fromEntries(entries) };
      },
    },
  ),
);
