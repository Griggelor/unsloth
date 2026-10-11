// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  AGENT_DEFAULT_ROWS,
  isAgentWindowSize,
  type AgentWindowSize,
} from "../../../components/assistant-ui/agent-history-scroll-window.ts";

export type AgentHistoryPreferenceSnapshot = {
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
