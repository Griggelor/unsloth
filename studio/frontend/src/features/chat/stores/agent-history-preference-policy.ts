// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  AGENT_DEFAULT_ROWS,
  isAgentWindowSize,
  type AgentWindowSize,
} from "../../../components/assistant-ui/agent-history-scroll-window.ts";

import type { AgentDomLevel } from "../../../components/assistant-ui/agent-history-dom-budget";

export type AgentHistoryPreferenceSnapshot = {
  globalDomLevel?: AgentDomLevel;
  domLevelByThreadId?: Record<string, AgentDomLevel>;
  globalEnabled: boolean;
  globalWindowRows: AgentWindowSize;
  enabledThreads: Record<string, true>;
  disabledThreads: Record<string, true>;
  windowRowsByThreadId: Record<string, AgentWindowSize>;
};

export function agentHistoryEnabledFor(
  state: AgentHistoryPreferenceSnapshot,
  threadId: string | null | undefined,
): boolean {
  if (!threadId || state.disabledThreads[threadId] === true) return false;
  return state.globalEnabled || state.enabledThreads[threadId] === true;
}

export function agentHistoryWindowFor(
  state: AgentHistoryPreferenceSnapshot,
  threadId: string | null | undefined,
): AgentWindowSize {
  const specific = threadId ? state.windowRowsByThreadId[threadId] : undefined;
  if (isAgentWindowSize(specific)) return specific;
  return isAgentWindowSize(state.globalWindowRows)
    ? state.globalWindowRows
    : AGENT_DEFAULT_ROWS;
}

/** Explicit per-chat settings win. Legacy v1 preferences remain readable. */
export function agentHistoryLevelFor(
  state: AgentHistoryPreferenceSnapshot,
  threadId: string | null | undefined,
): AgentDomLevel | "legacy" {
  const specific = threadId ? state.domLevelByThreadId?.[threadId] : undefined;
  if (specific === "off" || specific === "low" || specific === "high") return specific;
  // A pre-existing explicit per-chat opt-out/in is a local exception too.
  // Do not overwrite it when adopting the new global policy.
  if (threadId && state.disabledThreads[threadId] === true) return "off";
  if (threadId && state.enabledThreads[threadId] === true) {
    return state.globalDomLevel === "low" || state.globalDomLevel === "high"
      ? state.globalDomLevel : "legacy";
  }
  if (state.globalDomLevel === "off" || state.globalDomLevel === "low" ||
      state.globalDomLevel === "high") return state.globalDomLevel;
  return agentHistoryEnabledFor(state, threadId) ? "legacy" : "off";
}
