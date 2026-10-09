// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

/**
 * Pure, opt-in planning primitive for a bounded chat-rendering experiment.
 *
 * This does NOT alter chat storage, the assistant-ui message repository, the
 * model context, or the shipped progressive mount. All indices address the
 * original message array. A future renderer must retain those indices in
 * MessageByIndexProvider and must handle search, copy, export and accessibility
 * from the complete message source, never solely from the mounted DOM.
 *
 * In particular, a generation's tail can be kept mounted independently of the
 * reader's window. Capture protectedTailStart once at run start rather than
 * recomputing it from messageCount on every append: doing the latter would
 * unmount a row while it is being streamed or inspected.
 */
export type MessageRenderRange = Readonly<{
  start: number;
  end: number; // exclusive
}>;

export type MessageRenderWindowRequest = Readonly<{
  messageCount: number;
  /** Original message index nearest the reader's viewport; defaults to the tail. */
  focusIndex?: number;
  before?: number;
  after?: number;
  /** Original index at which the pinned, live generation tail begins. */
  protectedTailStart?: number;
}>;

export type MessageRenderWindowPlan = Readonly<{
  ranges: readonly MessageRenderRange[];
  mountedMessageCount: number;
}>;

const DEFAULT_BEFORE = 8;
const DEFAULT_AFTER = 12;
const MAX_OVERSCAN = 256;

function integerInRange(value: number, name: string, low: number, high: number): number {
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new RangeError(`${name} must be an integer in [${low}, ${high}]`);
  }
  return value;
}

/**
 * Build one or two ascending, disjoint ranges. The second range, when present,
 * pins live messages but does not drag the whole unseen middle into the DOM.
 * Adjacent ranges merge, avoiding duplicate MessageByIndexProvider instances.
 */
export function planMessageRenderWindow(
  request: MessageRenderWindowRequest,
): MessageRenderWindowPlan {
  const count = integerInRange(request.messageCount, "messageCount", 0, Number.MAX_SAFE_INTEGER);
  const before = integerInRange(request.before ?? DEFAULT_BEFORE, "before", 0, MAX_OVERSCAN);
  const after = integerInRange(request.after ?? DEFAULT_AFTER, "after", 0, MAX_OVERSCAN);
  const pinned = request.protectedTailStart;
  if (pinned !== undefined) {
    integerInRange(pinned, "protectedTailStart", 0, count);
  }
  if (request.focusIndex !== undefined && !Number.isSafeInteger(request.focusIndex)) {
    throw new RangeError("focusIndex must be a safe integer");
  }
  if (count === 0) return { ranges: [], mountedMessageCount: 0 };

  // Clamp a stale reader index after deletions/thread changes before touching a row.
  const focus = Math.max(0, Math.min(count - 1, request.focusIndex ?? count - 1));
  const visible: MessageRenderRange = {
    start: Math.max(0, focus - before),
    end: Math.min(count, focus + after + 1),
  };
  if (pinned === undefined || pinned === count) {
    return { ranges: [visible], mountedMessageCount: visible.end - visible.start };
  }

  const tail: MessageRenderRange = { start: pinned, end: count };
  const ordered = [visible, tail].sort((a, b) => a.start - b.start);
  const first = ordered[0];
  const second = ordered[1];
  if (second.start <= first.end) {
    const merged: MessageRenderRange = {
      start: first.start,
      end: Math.max(first.end, second.end),
    };
    return { ranges: [merged], mountedMessageCount: merged.end - merged.start };
  }
  return {
    ranges: ordered,
    mountedMessageCount:
      first.end - first.start + second.end - second.start,
  };
}

/** Enumeration is deliberately isolated from rendering: callers can preserve original indices. */
export function* indicesInRenderPlan(plan: MessageRenderWindowPlan): Generator<number> {
  for (const { start, end } of plan.ranges) {
    for (let index = start; index < end; index += 1) yield index;
  }
}
