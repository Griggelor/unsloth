// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Budget targets apply to message descendants, not the entire application DOM. */
export type AgentDomLevel = "off" | "low" | "high";
export const AGENT_DOM_TARGETS = { low: 5_000, high: 12_000 } as const;
/** Unknown rows are charged conservatively until observed, so long chats start small. */
export const AGENT_UNKNOWN_ROW_COST = 1_000;
export const AGENT_DOM_MAX_ROWS = 32;

export class AgentDomCostIndex {
  private costs = new Map<number, number>();
  constructor(private size: number) {}
  resize(size: number) {
    this.size = size;
    for (const key of this.costs.keys()) if (key >= size) this.costs.delete(key);
  }
  measure(row: number, descendants: number): boolean {
    if (!Number.isSafeInteger(row) || row < 0 || row >= this.size ||
      !Number.isFinite(descendants) || descendants < 0) return false;
    const cost = Math.max(1, Math.round(descendants));
    if (this.costs.get(row) === cost) return false;
    this.costs.set(row, cost);
    return true;
  }
  cost(row: number): number { return this.costs.get(row) ?? AGENT_UNKNOWN_ROW_COST; }
}

/**
 * Always include the target. A single giant message can exceed the target;
 * excluding it would break navigation. Expand contiguously up to the budget,
 * preferring rows following the target so the reader can continue downwards.
 */
export function agentBudgetWindow(
  count: number,
  target: number,
  costs: AgentDomCostIndex,
  budget: number,
  maxRows = AGENT_DOM_MAX_ROWS,
): Readonly<{ start: number; end: number }> {
  if (count <= 0) return { start: 0, end: 0 };
  const at = Math.max(0, Math.min(count - 1, Math.floor(target)));
  let start = at, end = at + 1, used = costs.cost(at);
  while (end - start < maxRows) {
    const previous = start > 0 ? costs.cost(start - 1) : Infinity;
    const next = end < count ? costs.cost(end) : Infinity;
    if (previous === Infinity && next === Infinity) break;
    // Favor earlier rows at the tail, forward progress elsewhere.
    const preferPrevious = end === count || (start > 0 && previous < next);
    if (preferPrevious && used + previous <= budget) {
      start--; used += previous;
    } else if (used + next <= budget) {
      end++; used += next;
    } else if (used + previous <= budget) {
      start--; used += previous;
    } else break;
  }
  return { start, end };
}
