// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/** Normal-flow virtualization: only window boundaries change; rows are never absolutely positioned. */
export const AGENT_INITIAL_ROWS = 32;
export const AGENT_MAX_ROWS = 96;
/** Per-chat runtime window sizes. Defaults remain compatible with 32/96. */
export const AGENT_WINDOW_SIZES = [2, 5, 8, 16, 32] as const;
export type AgentWindowSize = (typeof AGENT_WINDOW_SIZES)[number];
export function isAgentWindowSize(value: unknown): value is AgentWindowSize {
  return typeof value === "number" && (AGENT_WINDOW_SIZES as readonly number[]).includes(value);
}
export const AGENT_ROW_ESTIMATE_PX = 720;
export type AgentScrollWindow = Readonly<{ start: number; end: number }>;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function latestAgentWindow(
  count: number,
  windowRows: number = AGENT_INITIAL_ROWS,
): AgentScrollWindow {
  return { start: Math.max(0, count - windowRows), end: count };
}

/** Reuse existing mounted rows until the reader nears an edge; never shift on each token. */
export function agentWindowAtIndex(
  count: number,
  index: number,
  current?: AgentScrollWindow,
  windowRows: number = AGENT_INITIAL_ROWS,
): AgentScrollWindow {
  if (count <= windowRows) return { start: 0, end: count };
  const target = clamp(Math.floor(index), 0, count - 1);
  const maxRows = windowRows === AGENT_INITIAL_ROWS ? AGENT_MAX_ROWS : windowRows;
  if (current && current.start >= 0 && current.end <= count &&
      current.end > current.start && current.end - current.start <= maxRows &&
      target >= current.start + Math.min(8, Math.floor((current.end-current.start)/4)) &&
      target < current.end - Math.min(8, Math.floor((current.end-current.start)/4))) {
    return current;
  }
  if (target === 0) return { start: 0, end: windowRows };
  if (target === count - 1) return latestAgentWindow(count, windowRows);
  const lead = windowRows === AGENT_INITIAL_ROWS ? 12 : Math.floor((windowRows - 1) / 2);
  const start = clamp(target - lead, 0, count - windowRows);
  return { start, end: start + windowRows };
}

/** Appending at the tail never shifts the mounted rows on the first append. */
export function agentWindowOnAppend(
  previous: AgentScrollWindow,
  oldCount: number,
  count: number,
  following: boolean,
  windowRows: number = AGENT_INITIAL_ROWS,
): AgentScrollWindow {
  if (count < oldCount) return latestAgentWindow(count, windowRows);
  if (oldCount === 0) return latestAgentWindow(count, windowRows);
  if (!following || previous.end !== oldCount) return previous;
  // Only the legacy default may grow to 96 rows. Small windows are strict bounds.
  const maxRows = windowRows === AGENT_INITIAL_ROWS ? AGENT_MAX_ROWS : windowRows;
  if (count - previous.start > maxRows) return latestAgentWindow(count, windowRows);
  return { start: previous.start, end: count };
}

/**
 * Resolve a scroll position into the index of a logical transcript row.
 * The top spacer is the PREFIX of the virtual document: its top is the
 * document origin, not the position of the first mounted row. Subtracting
 * offset(window.start) here double-counts the prefix and pins large histories
 * to the last messages even while the reader scrolls upwards.
 */
export function agentIndexAtScrollPosition(
  heights: AgentHeightIndex,
  topSpacerViewportTop: number,
  viewportTop: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const documentOrigin = topSpacerViewportTop - viewportTop + scrollTop;
  return heights.indexAt(scrollTop - documentOrigin + viewportHeight / 3);
}

/**
 * Height index: initial estimates + sparse corrections for measured rows.
 * It gives O(log N) offset lookup, and does not re-position mounted rows on append.
 * A growing capacity doubles rather than rebuilding on each agent message.
 */
export class AgentHeightIndex {
  private lengthValue: number;
  private capacity: number;
  private tree: Float64Array;
  private readonly heights = new Map<number, number>();
  readonly estimate: number;

  constructor(count: number, estimate = AGENT_ROW_ESTIMATE_PX) {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isFinite(estimate) || estimate <= 0) {
      throw new RangeError("Invalid agent history height index");
    }
    this.lengthValue = count;
    this.estimate = estimate;
    this.capacity = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    this.tree = new Float64Array(this.capacity + 1);
  }

  get length(): number { return this.lengthValue; }

  resize(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid count");
    if (count < this.lengthValue) {
      for (const key of this.heights.keys()) if (key >= count) this.heights.delete(key);
      this.rebuild(Math.max(this.capacity, count));
    } else if (count > this.capacity) {
      this.rebuild(Math.max(count, this.capacity * 2));
    }
    this.lengthValue = count;
  }

  /** Returns true only when a measurable height actually changed. */
  measure(index: number, px: number): boolean {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.lengthValue ||
        !Number.isFinite(px) || px < 0) return false;
    const height = Math.max(0, Math.round(px * 10) / 10);
    const old = this.heights.get(index) ?? this.estimate;
    if (Math.abs(old - height) < 0.5) return false;
    this.heights.set(index, height);
    this.add(index, height - old);
    return true;
  }

  height(index: number): number { return this.heights.get(index) ?? this.estimate; }

  offset(index: number): number {
    const end = clamp(Math.floor(index), 0, this.lengthValue);
    let delta = 0;
    for (let i = end; i > 0; i -= i & -i) delta += this.tree[i];
    return end * this.estimate + delta;
  }

  get total(): number { return this.offset(this.lengthValue); }

  /** The original index covering the given estimated document coordinate. */
  indexAt(offsetPx: number): number {
    if (this.lengthValue === 0) return 0;
    const target = Math.max(0, Number.isFinite(offsetPx) ? offsetPx : 0);
    let low = 0;
    let high = this.lengthValue;
    while (low < high) {
      const mid = low + Math.floor((high - low + 1) / 2);
      if (this.offset(mid) <= target) low = mid;
      else high = mid - 1;
    }
    return clamp(low, 0, this.lengthValue - 1);
  }

  private add(index: number, delta: number): void {
    for (let i = index + 1; i <= this.capacity; i += i & -i) this.tree[i] += delta;
  }

  private rebuild(capacity: number): void {
    this.capacity = capacity;
    this.tree = new Float64Array(capacity + 1);
    for (const [index, height] of this.heights) {
      if (index < this.lengthValue) this.add(index, height - this.estimate);
    }
  }
}
