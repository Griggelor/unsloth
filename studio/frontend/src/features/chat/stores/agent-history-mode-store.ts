// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  AGENT_DEFAULT_ROWS,
  isAgentWindowSize,
  type AgentWindowSize,
} from "../../../components/assistant-ui/agent-history-scroll-window";
import { type AgentHistoryPreferenceSnapshot } from "./agent-history-preference-policy";

export type AgentHistoryModeState = AgentHistoryPreferenceSnapshot & {
  setGlobalEnabled: (enabled: boolean) => void;
  setGlobalWindowRows: (rows: AgentWindowSize) => void;
  setEnabled: (threadId: string, enabled: boolean) => void;
  setWindowRows: (threadId: string, rows: AgentWindowSize) => void;
};

/** Kept local to each browser/profile. Does not change message persistence. */
export const useAgentHistoryModeStore = create<AgentHistoryModeState>()(
  persist(
    (set) => ({
      globalEnabled: false,
      globalWindowRows: AGENT_DEFAULT_ROWS,
      enabledThreads: {},
      disabledThreads: {},
      windowRowsByThreadId: {},
      setGlobalEnabled: (enabled) => set({ globalEnabled: enabled }),
      setGlobalWindowRows: (rows) => {
        if (!isAgentWindowSize(rows)) return;
        set({ globalWindowRows: rows });
      },
      setWindowRows: (threadId, rows) => {
        if (!threadId || !isAgentWindowSize(rows)) return;
        set((state) => {
          const windowRowsByThreadId = { ...state.windowRowsByThreadId };
          if (rows === state.globalWindowRows) delete windowRowsByThreadId[threadId];
          else windowRowsByThreadId[threadId] = rows;
          return { windowRowsByThreadId };
        });
      },
      setEnabled: (threadId, enabled) => {
        if (!threadId) return;
        set((state) => {
          const enabledThreads = { ...state.enabledThreads };
          const disabledThreads = { ...state.disabledThreads };
          if (enabled) {
            enabledThreads[threadId] = true;
            delete disabledThreads[threadId];
          } else {
            delete enabledThreads[threadId];
            if (state.globalEnabled) disabledThreads[threadId] = true;
            else delete disabledThreads[threadId];
          }
          return { enabledThreads, disabledThreads };
        });
      },
    }),
    {
      name: "unsloth_agent_chat_history_v1",
      partialize: (state) => ({
        globalEnabled: state.globalEnabled,
        globalWindowRows: state.globalWindowRows,
        enabledThreads: state.enabledThreads,
        disabledThreads: state.disabledThreads,
        windowRowsByThreadId: state.windowRowsByThreadId,
      }),
      merge: (persisted, current) => {
        const saved: Record<string, unknown> = persisted && typeof persisted === "object"
          ? (persisted as Record<string, unknown>) : {};
        const trueMap = (raw: unknown): Record<string, true> => {
          const entries = raw && typeof raw === "object" && !Array.isArray(raw)
            ? Object.entries(raw).filter(([id, flag]) => id.length > 0 && flag === true)
            : [];
          return Object.fromEntries(entries) as Record<string, true>;
        };
        const globalWindowRows = isAgentWindowSize(saved.globalWindowRows)
          ? saved.globalWindowRows : AGENT_DEFAULT_ROWS;
        const rowEntries = saved.windowRowsByThreadId &&
          typeof saved.windowRowsByThreadId === "object" &&
          !Array.isArray(saved.windowRowsByThreadId)
          ? Object.entries(saved.windowRowsByThreadId).filter(([id, rows]) =>
              id.length > 0 && isAgentWindowSize(rows) && rows !== globalWindowRows)
          : [];
        return {
          ...current,
          globalEnabled: saved.globalEnabled === true,
          globalWindowRows,
          enabledThreads: trueMap(saved.enabledThreads),
          disabledThreads: trueMap(saved.disabledThreads),
          windowRowsByThreadId: Object.fromEntries(rowEntries) as Record<string, AgentWindowSize>,
        };
      },
    },
  ),
);
