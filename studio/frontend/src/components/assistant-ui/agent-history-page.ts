// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * Opt-in Agenten-Chatverlauf: fixed pages with a stable latest-page start.
 *
 * A newly appended message never repositions every existing tail row. Unlike
 * traditional virtual scrolling, navigating to another page is explicit, so
 * there is no need to guess variable message heights or preserve scroll space.
 */
export const AGENT_HISTORY_PAGE_SIZE = 32;
export const AGENT_HISTORY_MAX_LIVE_ROWS = 64;
export const AGENT_HISTORY_MAX_RUNNING_ROWS = 96;

export type AgentHistoryPage =
  | Readonly<{ kind: "latest"; start: number }>
  | Readonly<{ kind: "older"; end: number }>;

export type AgentHistorySlice = Readonly<{
  start: number;
  end: number;
  older: boolean;
  newer: boolean;
  latest: boolean;
}>;

export function initialAgentHistoryPage(count: number): AgentHistoryPage {
  return { kind: "latest", start: Math.max(0, count - AGENT_HISTORY_PAGE_SIZE) };
}

/**
 * Reconcile after history fetch, append, delete, and a run finishing.
 * Keep current rows mounted on ordinary appends; prune in chunks only when
 * idle; a higher hard ceiling applies to one long-running generation so
 * multi-hour tool agents cannot grow the live DOM without limit.
 */
export function reconcileAgentHistoryPage(
  page: AgentHistoryPage,
  oldCount: number,
  count: number,
  isRunning: boolean,
): AgentHistoryPage {
  if (count === 0) return initialAgentHistoryPage(0);
  if (oldCount === 0 && count > 0) return initialAgentHistoryPage(count);
  if (count < oldCount) return initialAgentHistoryPage(count);
  if (page.kind === "older") return page;
  if (
    count - page.start > (isRunning ? AGENT_HISTORY_MAX_RUNNING_ROWS : AGENT_HISTORY_MAX_LIVE_ROWS)
  ) {
    return initialAgentHistoryPage(count);
  }
  return page;
}

export function agentHistorySlice(
  page: AgentHistoryPage,
  count: number,
): AgentHistorySlice {
  const end = page.kind === "latest"
    ? count
    : Math.max(0, Math.min(count, page.end));
  const start = page.kind === "latest"
    ? Math.min(page.start, end)
    : Math.max(0, end - AGENT_HISTORY_PAGE_SIZE);
  return {
    start,
    end,
    older: start > 0,
    newer: end < count,
    latest: page.kind === "latest",
  };
}

export function olderAgentHistoryPage(slice: AgentHistorySlice): AgentHistoryPage {
  return { kind: "older", end: slice.start };
}

/** Show the most recent user instruction with its original index, without scanning in render. */
export function agentHistoryPageForMessage(
  messageIndex: number,
  count: number,
): AgentHistoryPage {
  if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 || messageIndex >= count) {
    return initialAgentHistoryPage(count);
  }
  return messageIndex >= count - AGENT_HISTORY_PAGE_SIZE
    ? initialAgentHistoryPage(count)
    : { kind: "older", end: messageIndex + 1 };
}

export function newerAgentHistoryPage(
  slice: AgentHistorySlice,
  count: number,
): AgentHistoryPage {
  const end = Math.min(count, slice.end + AGENT_HISTORY_PAGE_SIZE);
  return end === count ? initialAgentHistoryPage(count) : { kind: "older", end };
}
