// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  AGENT_INITIAL_ROWS,
  isAgentWindowSize,
  type AgentWindowSize,
} from "../../../components/assistant-ui/agent-history-scroll-window";

export type AgentHistoryModeState = {
  enabledThreads: Record<string, true>;
  windowRowsByThreadId: Record<string, AgentWindowSize>;
  setEnabled: (threadId: string, enabled: boolean) => void;
  setWindowRows: (threadId: string, rows: AgentWindowSize) => void;
};

/** Local, per-thread display preference. Never modifies the persisted chat transcript. */
export const useAgentHistoryModeStore = create<AgentHistoryModeState>()(
  persist(
    (set) => ({
      enabledThreads: {},
      windowRowsByThreadId: {},
      setWindowRows: (threadId, rows) => {
        if (!threadId || !isAgentWindowSize(rows)) return;
        set((state) => {
          const windowRowsByThreadId = { ...state.windowRowsByThreadId };
          if (rows === AGENT_INITIAL_ROWS) delete windowRowsByThreadId[threadId];
          else windowRowsByThreadId[threadId] = rows;
          return { windowRowsByThreadId };
        });
      },
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
      partialize: (state) => ({
        enabledThreads: state.enabledThreads,
        windowRowsByThreadId: state.windowRowsByThreadId,
      }),
      merge: (persisted, current) => {
        const saved = (persisted as { enabledThreads?: unknown } | null)?.enabledThreads;
        const entries = saved && typeof saved === "object" && !Array.isArray(saved)
          ? Object.entries(saved).filter(([id, enabled]) => id.length > 0 && enabled === true)
          : [];
        const savedRows = (persisted as { windowRowsByThreadId?: unknown } | null)?.windowRowsByThreadId;
        const rowEntries = savedRows && typeof savedRows === "object" && !Array.isArray(savedRows)
          ? Object.entries(savedRows).filter(([id, rows]) => id.length > 0 && isAgentWindowSize(rows) && rows !== AGENT_INITIAL_ROWS)
          : [];
        return {
          ...current,
          enabledThreads: Object.fromEntries(entries),
          windowRowsByThreadId: Object.fromEntries(rowEntries) as Record<string, AgentWindowSize>,
        };
      },
    },
  ),
);
