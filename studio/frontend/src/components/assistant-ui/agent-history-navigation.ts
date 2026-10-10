// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** A single navigation intent owns passive scroll sampling during a search reveal.
 * Epochs make a superseded DOM/layout callback incapable of ending a newer intent.
 */
export type AgentHistoryNavigation =
  | Readonly<{ kind: "reader"; epoch: number }>
  | Readonly<{ kind: "search"; epoch: number; row: number; positioned: boolean }>;

export function initialAgentHistoryNavigation(): AgentHistoryNavigation {
  return { kind: "reader", epoch: 0 };
}

export function requestAgentHistoryReveal(
  current: AgentHistoryNavigation,
  row: number,
  count: number,
): AgentHistoryNavigation {
  if (!Number.isSafeInteger(row) || row < 0 || row >= count) return current;
  return { kind: "search", epoch: current.epoch + 1, row, positioned: false };
}

export function markAgentHistoryRevealPositioned(
  current: AgentHistoryNavigation,
  epoch: number,
): AgentHistoryNavigation {
  if (current.kind !== "search" || current.epoch !== epoch) return current;
  return { ...current, positioned: true };
}

export function completeAgentHistoryReveal(
  current: AgentHistoryNavigation,
  epoch: number,
  visible: boolean,
): AgentHistoryNavigation {
  if (current.kind !== "search" || current.epoch !== epoch || !current.positioned || !visible) return current;
  return { kind: "reader", epoch };
}

export function interruptAgentHistoryReveal(current: AgentHistoryNavigation): AgentHistoryNavigation {
  return current.kind === "search" ? { kind: "reader", epoch: current.epoch + 1 } : current;
}

export function allowsPassiveAgentScroll(current: AgentHistoryNavigation): boolean {
  return current.kind === "reader";
}
