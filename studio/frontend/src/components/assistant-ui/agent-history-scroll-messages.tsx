// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { AuiProvider, useAui, useAuiState } from "@assistant-ui/react";
import { MessageByIndexProvider } from "./stale-safe-scopes";
import { type FC, type ReactElement, type RefObject, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRowNotificationGate } from "./row-notification-gate";
import { findAgentTextMatches, type AgentFindMatch } from "./agent-history-search";
import { notifyFindTargets, registerFindTarget, type FindTargetResult } from "@/features/find-in-page/lib/find-targets";
import { AGENT_DOM_TARGETS, AGENT_FIXED_VIEWPORT_DOM_TARGET, AGENT_FIXED_VIEWPORT_MAX_ROWS, AgentDomCostIndex, agentBudgetWindow, needsAgentBudgetRebalance } from "./agent-history-dom-budget";
import { AGENT_DEFAULT_ROWS, AgentHeightIndex, agentIndexAtScrollPosition, agentViewportCoverageRecoveryTarget, agentWindowAtIndex, agentWindowOnAppend, latestAgentWindow, nextProgressiveAgentWindow, type AgentScrollWindow } from "./agent-history-scroll-window";
import { useAdjustForContentInsertedAbove, useGetThreadBottomFollowIntent, useNavigateThreadViewport, useScrollThreadToBottom } from "./use-intent-aware-autoscroll";
import {
  allowsAgentReaderScrollIntent,
  allowsRecentAgentBoundaryReconcile,
  allowsPassiveAgentScroll,
  completeAgentHistoryReveal,
  consumeAgentReaderScrollIntent,
  initialAgentHistoryNavigation,
  initialAgentReaderScrollIntent,
  interruptAgentHistoryReveal,
  markAgentHistoryRevealPositioned,
  requestAgentHistoryReveal,
  requestAgentReaderScrollIntent,
} from "./agent-history-navigation";
import type { AgentHistoryNavigation } from "./agent-history-navigation";

/**
 * Experimental opt-in renderer. All messages remain in the assistant-ui store
 * and persisted transcript; only the mounted DOM is bounded.
 * Search / select-all parity MUST be addressed before release.
 */
export const AgentHistoryScrollMessages: FC<{
  renderMessage: () => ReactElement;
  resetKey: string | undefined;
  viewportRef: RefObject<HTMLElement | null>;
  windowRows?: number;
  domLevel?: "low" | "medium" | "high";
  fixedRowsStrict?: boolean;
  /** Fixed adapts short-turn viewport coverage but caps rows and estimated DOM. */
  fixedViewportAdaptive?: boolean;
}> = memo(function AgentHistoryScrollMessages({
  renderMessage, resetKey, viewportRef, windowRows = AGENT_DEFAULT_ROWS, domLevel, fixedRowsStrict = false, fixedViewportAdaptive = false,
}) {
  const count = useAuiState(({ thread }) => thread.messages.length);
  const aui = useAui();
  const gate = useMemo(() => createRowNotificationGate(aui), [aui]);
  const heights = useMemo(() => new AgentHeightIndex(count), [resetKey]);
  heights.resize(count);
  const costs = useMemo(() => new AgentDomCostIndex(count), [resetKey]);
  costs.resize(count);
  // Fixed-low no longer means a permanent five-message viewport. It can grow
  // until the viewport is filled, but never exceed 32 mounted messages or the
  // same conservative 8k-descendant budget as Dynamic.
  const budget = domLevel ? AGENT_DOM_TARGETS[domLevel]
    : fixedViewportAdaptive ? AGENT_FIXED_VIEWPORT_DOM_TARGET : null;
  const budgetRows = fixedViewportAdaptive ? AGENT_FIXED_VIEWPORT_MAX_ROWS
    : domLevel === "low" ? 5 : domLevel === "medium" ? 16 : 32;
  const jumpBottom = useScrollThreadToBottom();
  const getIsFollowingBottom = useGetThreadBottomFollowIntent();
  const correctAnchor = useAdjustForContentInsertedAbove();
  const navigateViewport = useNavigateThreadViewport();
  const following = useRef(true);
  const countRef = useRef(count);
  countRef.current = count;
  const animation = useRef<number | null>(null);
  const topSpacer = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ index: number; top: number } | null>(null);
  const jump = useRef<"top" | "bottom" | null>(null);
  const staged = useRef<{ destination: AgentScrollWindow; target: number } | null>(null);
  const pendingPassiveReveal = useRef<number | null>(null);
  // A real scroll received during staging must be sampled after the last
  // window commit, never allowed to abort staging with only one row mounted.
  const deferredScroll = useRef(false);
  const lastBlankRecoveryEpoch = useRef(-1);
  // A physical-wheel epoch may require limited further reconciliation after
  // height-ledger corrections. Never run an unbounded layout-recovery loop.
  const coverageRecovery = useRef({ epoch: -1, attempts: 0 });
  const wheelCoverageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelIdleReady = useRef(false);
  const [state, setState] = useState(() => ({
    key: resetKey, count, windowRows, domLevel, fixedRowsStrict, fixedViewportAdaptive,
    range: budget !== null ? agentBudgetWindow(count, count - 1, costs, budget, budgetRows)
      : latestAgentWindow(count, windowRows),
  }));
  const visibleIndex = useRef(Math.max(0, count - 1));
  const lastWindowRows = useRef(windowRows);
  const lastDomLevel = useRef(domLevel);
  const lastFixedRowsStrict = useRef(fixedRowsStrict);
  const lastFixedAdaptive = useRef(fixedViewportAdaptive);
  const [heightRevision, setHeightRevision] = useState(0);
  const [searchHit, setSearchHit] = useState(-1);
  const [revealRevision, setRevealRevision] = useState(0);
  const searchHitRef = useRef(-1);
  const navigation = useRef<AgentHistoryNavigation>(initialAgentHistoryNavigation());
  const readerIntent = useRef(initialAgentReaderScrollIntent());
  const pendingScrollEpoch = useRef<number | null>(null);
  const lastReaderGestureAt = useRef(Number.NEGATIVE_INFINITY);
  // Old reader gestures must not carry over when the user changes threads.
  useLayoutEffect(() => {
    // A previous chat's detached window must not survive a thread switch.
    following.current = true;
    visibleIndex.current = Math.max(0, countRef.current - 1);
    readerIntent.current = initialAgentReaderScrollIntent();
    lastReaderGestureAt.current = Number.NEGATIVE_INFINITY;
    pendingScrollEpoch.current = null;
    navigation.current = initialAgentHistoryNavigation();
    staged.current = null;
    pendingPassiveReveal.current = null;
    deferredScroll.current = false;
    lastBlankRecoveryEpoch.current = -1;
    coverageRecovery.current = { epoch: -1, attempts: 0 };
    if (wheelCoverageTimer.current !== null) clearTimeout(wheelCoverageTimer.current);
    wheelCoverageTimer.current = null;
    wheelIdleReady.current = false;
  }, [resetKey]);
  const revealFrame = useRef<number | null>(null);
  useEffect(() => () => {
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
  }, []);
  const heightFrame = useRef<number | null>(null);
  const requestHeightRevision = useCallback(() => {
    if (heightFrame.current !== null) return;
    heightFrame.current = requestAnimationFrame(() => {
      heightFrame.current = null;
      setHeightRevision(v => v + 1);
    });
  }, []);
  useEffect(() => () => {
    if (heightFrame.current !== null) cancelAnimationFrame(heightFrame.current);
  }, []);

  // Preserve progressive staging and reader-intent ownership; only the
  // selected window policy changes under an explicit Low/High preference.
  const budgetWindow = (index: number) =>
    budget === null ? null : agentBudgetWindow(count, index, costs, budget, budgetRows);
  const latestWindow = () => budgetWindow(count - 1) ?? latestAgentWindow(count, windowRows);
  const visibleWindow = () => budgetWindow(visibleIndex.current) ?? agentWindowAtIndex(
    count, Math.min(visibleIndex.current, Math.max(0, count - 1)), undefined, windowRows, fixedRowsStrict,
  );
  // The shared viewport owner, not our gesture cache, decides whether a new
  // streamed message belongs in the visible tail window.
  const followingOnAppend = getIsFollowingBottom();
  const range = state.key !== resetKey ? latestWindow()
    : state.domLevel !== domLevel || state.windowRows !== windowRows ||
      state.fixedRowsStrict !== fixedRowsStrict || state.fixedViewportAdaptive !== fixedViewportAdaptive
      ? followingOnAppend ? latestWindow() : visibleWindow()
      : state.count !== count
        ? budget !== null
          ? followingOnAppend ? latestWindow() : state.range
          : agentWindowOnAppend(state.range, state.count, count, followingOnAppend, windowRows, fixedRowsStrict)
        : state.range;
  if (state.key !== resetKey || state.count !== count ||
      state.windowRows !== windowRows || state.domLevel !== domLevel ||
      state.fixedRowsStrict !== fixedRowsStrict || state.fixedViewportAdaptive !== fixedViewportAdaptive) {
    setState({ key: resetKey, count, windowRows, domLevel, fixedRowsStrict, fixedViewportAdaptive, range });
  }
  const previousCountRef = useRef(count);
  useLayoutEffect(() => {
    if (previousCountRef.current === count) return;
    previousCountRef.current = count;
    if (getIsFollowingBottom()) {
      following.current = true;
      visibleIndex.current = Math.max(0, count - 1);
    }
  }, [count, getIsFollowingBottom]);
  const rangeRef = useRef<AgentScrollWindow>(range);
  rangeRef.current = range;

  const seek = useCallback((index: number, snap?: "top" | "bottom") => {
    const viewport = viewportRef.current;
    const next = budget !== null
      ? agentBudgetWindow(countRef.current, index, costs, budget, budgetRows)
      : agentWindowAtIndex(countRef.current, index, rangeRef.current, windowRows, fixedRowsStrict);
    if (next.start === rangeRef.current.start && next.end === rangeRef.current.end) {
      if (snap === "bottom") jumpBottom("auto");
      if (snap === "top" && viewport) navigateViewport(0);
      return false;
    }
    anchor.current = null;
    const disjoint = next.end <= rangeRef.current.start ||
      next.start >= rangeRef.current.end;
    const progressive = !snap && !following.current && disjoint &&
      next.end - next.start > 1;
    const target = Math.min(Math.max(index, next.start), next.end - 1);
    const candidate = progressive ? { start: target, end: target + 1 } : next;
    staged.current = progressive ? { destination: next, target } : null;
    pendingPassiveReveal.current = disjoint && !snap ? target : null;
    if (viewport && !snap) {
      const fold = viewport.getBoundingClientRect().top;
      for (const el of viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")) {
        if (el.getBoundingClientRect().bottom > fold) {
          const at = Number(el.dataset.agentHistoryRow);
          if (at >= next.start && at < next.end) anchor.current = { index: at, top: el.getBoundingClientRect().top };
          break;
        }
      }
    }
    jump.current = snap ?? null;
    rangeRef.current = candidate;
    setState(old => ({ ...old, range: candidate }));
    return true;
  }, [jumpBottom, navigateViewport, viewportRef, windowRows, costs, budget, budgetRows, fixedRowsStrict]);

  useEffect(() => {
    const task = staged.current;
    if (!task) return;
    const frame = requestAnimationFrame(() => {
      if (staged.current !== task) return;
      const current = rangeRef.current;
      const next = nextProgressiveAgentWindow(current, task.destination);
      if (next.start === current.start && next.end === current.end) {
        staged.current = null;
        return;
      }
      if (next.start < current.start) {
        const row = viewportRef.current?.querySelector<HTMLElement>(
          '[data-agent-history-row="' + task.target + '"]',
        );
        if (row) anchor.current = { index: task.target, top: row.getBoundingClientRect().top };
      }
      rangeRef.current = next;
      setState(old => ({ ...old, range: next }));
      if (next.start === task.destination.start && next.end === task.destination.end) {
        staged.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [range.start, range.end, viewportRef]);

  useLayoutEffect(() => {
    if (staged.current !== null || !deferredScroll.current) return;
    deferredScroll.current = false;
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Read the final layout instead of using a stale coordinate from the
    // temporarily one-row document. React has now committed the full window.
    const frame = requestAnimationFrame(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });
    return () => cancelAnimationFrame(frame);
  }, [range.start, range.end, viewportRef]);

  const revealSearchRow = useCallback((index: number) => {
    const nextIntent = requestAgentHistoryReveal(navigation.current, index, countRef.current);
    if (nextIntent === navigation.current) return;
    navigation.current = nextIntent;
    readerIntent.current = consumeAgentReaderScrollIntent(readerIntent.current, readerIntent.current.epoch);
    pendingScrollEpoch.current = null;
    staged.current = null;
    deferredScroll.current = false;
    // A search command is reader navigation, never permission to continue
    // following a streaming tail. The viewport owner also detaches BEFORE
    // writing scrollTop once the destination row has mounted.
    following.current = false;
    visibleIndex.current = index;
    anchor.current = null;
    jump.current = null;
    searchHitRef.current = index;
    setSearchHit(index);
    // A repeated hit may already be mounted, and setSearchHit(sameIndex)
    // does not produce a render. Force a fresh layout navigation transaction.
    setRevealRevision(v => v + 1);
    const next = budget !== null
      ? agentBudgetWindow(countRef.current, index, costs, budget, budgetRows)
      : agentWindowAtIndex(countRef.current, index, rangeRef.current, windowRows, fixedRowsStrict);
    if (next.start !== rangeRef.current.start || next.end !== rangeRef.current.end) {
      rangeRef.current = next;
      setState(old => ({ ...old, range: next }));
    }
  }, [windowRows, costs, budget, budgetRows, fixedRowsStrict]);

  // Changing the preference should not strand the reader at a stale scroll offset.
  // Keep height measurements; only the mounted window changes.
  useLayoutEffect(() => {
    if (lastWindowRows.current === windowRows && lastDomLevel.current === domLevel &&
        lastFixedRowsStrict.current === fixedRowsStrict &&
        lastFixedAdaptive.current === fixedViewportAdaptive) return;
    lastWindowRows.current = windowRows;
    lastDomLevel.current = domLevel;
    lastFixedRowsStrict.current = fixedRowsStrict;
    lastFixedAdaptive.current = fixedViewportAdaptive;
    // A pending progressive destination belongs to the PREVIOUS mode. Do
    // not let its next frame reintroduce rows outside the new DOM budget.
    staged.current = null;
    deferredScroll.current = false;
    readerIntent.current = consumeAgentReaderScrollIntent(readerIntent.current, readerIntent.current.epoch);
    pendingScrollEpoch.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    if (getIsFollowingBottom()) jumpBottom("auto");
    else navigateViewport(heights.offset(visibleIndex.current));
  }, [windowRows, domLevel, fixedRowsStrict, fixedViewportAdaptive, range.start, range.end, heights, jumpBottom, navigateViewport, getIsFollowingBottom]);

  // Register a search target only for the opt-in virtualized thread. The normal
  // find engine can keep its existing DOM semantics without mounting the history.
  useEffect(() => {
    let query = "";
    let matches: AgentFindMatch[] = [];
    let active = -1;
    let result: FindTargetResult = { count: 0, active: -1 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const recalculate = (fresh: boolean) => {
      const state = aui.thread().getState();
      const found = findAgentTextMatches(state.messages, query);
      const former = !fresh && active >= 0 ? matches[active] : null;
      matches = found.matches;
      active = former ? matches.findIndex(hit =>
        hit.row === former.row && hit.offset === former.offset) : -1;
      if (active < 0 && matches.length > 0) {
        const firstVisible = matches.findIndex(hit => hit.row >= rangeRef.current.start);
        active = firstVisible >= 0 ? firstVisible : 0;
      }
      result = { count: matches.length, active, capped: found.capped };
      if (active >= 0 && fresh) revealSearchRow(matches[active].row);
      else if (active < 0) { searchHitRef.current = -1; setSearchHit(-1); }
      notifyFindTargets();
    };
    const target = {
      id: "agent-chat-history:" + (resetKey ?? "current"),
      kind: "chat" as const,
      available: () => viewportRef.current !== null,
      contains: (node: Node) => viewportRef.current?.contains(node) ?? false,
      search: (value: string) => {
        if (query === value) return;
        query = value;
        recalculate(true);
      },
      step: (delta: -1 | 1) => {
        if (!matches.length) return;
        active = (active + delta + matches.length) % matches.length;
        result = { ...result, active };
        revealSearchRow(matches[active].row);
        notifyFindTargets();
      },
      result: () => result,
    };
    const unregister = registerFindTarget(target);
    const unsubscribe = aui.subscribe(() => {
      if (!query || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        recalculate(false);
      }, 300);
    });
    return () => {
      unregister();
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [aui, resetKey, viewportRef, revealSearchRow]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const intent = navigation.current;
    if (intent.kind === "search") {
      const row = viewport.querySelector<HTMLElement>('[data-agent-history-row="' + intent.row + '"]');
      if (row) {
        if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
        // `instant` is required: the viewport has scroll-smooth styling.
        // The common intent-aware owner detaches follow and commits scrollTop.
        const desired = viewport.scrollTop +
          row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 72;
        navigateViewport(desired);
        navigation.current = markAgentHistoryRevealPositioned(navigation.current, intent.epoch);
        revealFrame.current = requestAnimationFrame(() => {
          revealFrame.current = null;
          const active = navigation.current;
          if (active.kind !== "search" || active.epoch !== intent.epoch) return;
          const rendered = viewport.querySelector<HTMLElement>('[data-agent-history-row="' + intent.row + '"]');
          const bounds = rendered?.getBoundingClientRect();
          const viewportBounds = viewport.getBoundingClientRect();
          const visible = !!bounds && bounds.bottom > viewportBounds.top &&
            bounds.top < viewportBounds.bottom;
          navigation.current = completeAgentHistoryReveal(active, intent.epoch, visible);
        });
      }
    }
    const action = jump.current;
    jump.current = null;
    const oldAnchor = anchor.current;
    anchor.current = null;
    if (action === "top") navigateViewport(0);
    else if (action === "bottom") jumpBottom("auto");
    else if (oldAnchor) {
      const row = viewport.querySelector<HTMLElement>('[data-agent-history-row="' + oldAnchor.index + '"]');
      if (row) correctAnchor(row.getBoundingClientRect().top - oldAnchor.top);
    }
    // A scrollbar thumb can jump millions of estimated pixels in one event.
    // Do not require a SECOND wheel gesture merely to reveal its destination:
    // after the staged window is fully committed, reconcile the mounted target
    // with the real viewport geometry once, before the browser paints.
    const pending = pendingPassiveReveal.current;
    if (pending !== null && staged.current === null) {
      const row = viewport.querySelector<HTMLElement>(
        '[data-agent-history-row="' + pending + '"]',
      );
      if (row) {
        pendingPassiveReveal.current = null;
        const viewportBox = viewport.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        if (rowBox.bottom <= viewportBox.top + 8 ||
            rowBox.top >= viewportBox.bottom - 8) {
          navigateViewport(
            viewport.scrollTop + rowBox.top - viewportBox.top -
            Math.min(72, viewport.clientHeight / 4),
          );
        }
      }
    }
    // Unseen rows have estimated heights. A measurement/scroll-anchor update
    // after a physical wheel can put ALL mounted rows outside the viewport,
    // and the reader epoch intentionally blocks layout-origin scroll echoes.
    // Recover once per real wheel epoch, only if not a single row intersects
    // the viewport; ordinary partial-height windows are budgeted separately.
    const epoch = readerIntent.current.epoch;
    const recentWheel = epoch > 0 &&
      performance.now() - lastReaderGestureAt.current <= 1500;
    // The total mounted content height is NOT the same as physical viewport
    // coverage. After rows shrink from the 720px estimate to their measured
    // heights, the physical top may lie in the virtual spacer immediately
    // above our 16/32-row window. In that state 16 mounted short messages can
    // coexist with a 600px blank area that never gets filled on idle.
    //
    // Re-target the existing budgeted window to the actual physical endpoint,
    // never write scrollTop here and never bypass search or staging ownership.
    // Retarget only AFTER a short period without a physical wheel event:
    // applying correction mid-burst creates additional 1680px blank frames.
    if (recentWheel && wheelIdleReady.current && budget !== null &&
        staged.current === null && pendingPassiveReveal.current === null &&
        navigation.current.kind === "reader" && !getIsFollowingBottom()) {
      const bounds = viewport.getBoundingClientRect();
      const viewportHeight = viewport.clientHeight;
      const remaining = viewport.scrollHeight - viewport.scrollTop - viewportHeight;
      const interior = viewport.scrollTop >= viewportHeight && remaining >= viewportHeight;
      if (interior && viewportHeight > 0) {
        const wrappers = [...viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")];
        const first = wrappers[0], last = wrappers[wrappers.length - 1];
        if (first && last) {
          const spacer = topSpacer.current;
          if (spacer) {
            const originTop = spacer.getBoundingClientRect().top;
            const physicalTopIndex = agentIndexAtScrollPosition(
              heights, originTop, bounds.top, viewport.scrollTop, 0,
            );
            const physicalBottomIndex = agentIndexAtScrollPosition(
              heights, originTop, bounds.top, viewport.scrollTop, viewportHeight * 3,
            );
            const candidate = agentViewportCoverageRecoveryTarget(
              rangeRef.current, physicalTopIndex, physicalBottomIndex,
              Math.max(0, first.getBoundingClientRect().top - bounds.top),
              Math.max(0, bounds.bottom - last.getBoundingClientRect().bottom),
              viewportHeight,
            );
            const previous = coverageRecovery.current;
            const attempts = previous.epoch === epoch ? previous.attempts : 0;
            if (candidate !== null && attempts < 3) {
              coverageRecovery.current = { epoch, attempts: attempts + 1 };
              visibleIndex.current = candidate;
              if (seek(candidate)) return;
            }
          }
        }
      }
    }
    if (pendingPassiveReveal.current === null && staged.current === null &&
        recentWheel && !getIsFollowingBottom() &&
        navigation.current.kind === "reader" &&
        lastBlankRecoveryEpoch.current !== epoch) {
      const bounds = viewport.getBoundingClientRect();
      const rows = [...viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")];
      const hasVisible = rows.some(row => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top + 1 && rect.top < bounds.bottom - 1;
      });
      if (!hasVisible && rows.length > 0) {
        const index = Math.min(Math.max(visibleIndex.current, range.start), range.end - 1);
        const row = rows.find(item => Number(item.dataset.agentHistoryRow) === index) ?? rows[0];
        lastBlankRecoveryEpoch.current = epoch;
        navigateViewport(viewport.scrollTop +
          row.getBoundingClientRect().top - bounds.top -
          Math.min(72, viewport.clientHeight / 4));
      }
    }
  }, [range.start, range.end, heightRevision, searchHit, revealRevision, viewportRef, jumpBottom, correctAnchor, navigateViewport, getIsFollowingBottom, budget, heights, seek]);

  // A scroll event is not itself evidence of user navigation. Internal
  // anchor corrections, CSS/native scroll anchoring and remeasuring huge tool
  // rows all emit scroll events. Authorize ONE window change per fresh reader
  // gesture epoch, then ignore geometry-driven echoes until the next gesture.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const physicalEdgeReconcile = () => {
      const atTop = viewport.scrollTop < 1;
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
      return allowsRecentAgentBoundaryReconcile(
        readerIntent.current, lastReaderGestureAt.current, performance.now(),
        rangeRef.current.start, rangeRef.current.end, countRef.current, atTop, atBottom,
      );
    };
    const onScroll = () => {
      const epoch = readerIntent.current.epoch;
      if (!allowsAgentReaderScrollIntent(readerIntent.current, epoch) &&
          !physicalEdgeReconcile()) return;
      pendingScrollEpoch.current = epoch;
      if (animation.current !== null) return;
      animation.current = requestAnimationFrame(() => {
        animation.current = null;
        const pendingEpoch = pendingScrollEpoch.current;
        pendingScrollEpoch.current = null;
        const freshGesture = pendingEpoch !== null &&
          allowsAgentReaderScrollIntent(readerIntent.current, pendingEpoch);
        const recentPhysicalEdge = !freshGesture && physicalEdgeReconcile();
        if (pendingEpoch === null || (!freshGesture && !recentPhysicalEdge) ||
            !allowsPassiveAgentScroll(navigation.current)) return;
        if (staged.current !== null) {
          // A second REAL wheel gesture may move by many screens before the
          // old one-row staging transaction completes. Retarget immediately
          // rather than waiting for the previous destination to fill first.
          // Each replacement still begins with ONE row, so heavy tool outputs
          // cannot all mount in a single event-loop turn.
          const spacer = topSpacer.current;
          if (freshGesture && spacer && countRef.current > 0) {
            const index = agentIndexAtScrollPosition(
              heights, spacer.getBoundingClientRect().top,
              viewport.getBoundingClientRect().top,
              viewport.scrollTop, viewport.clientHeight,
            );
            const destination = staged.current.destination;
            if (index < destination.start || index >= destination.end) {
              visibleIndex.current = index;
              if (seek(index)) {
                readerIntent.current = consumeAgentReaderScrollIntent(
                  readerIntent.current, pendingEpoch,
                );
              }
              deferredScroll.current = false;
              return;
            }
          }
          // If still within the staged window, let it complete, then sample
          // the last actual wheel position once (not every layout echo).
          deferredScroll.current = true;
          return;
        }
        const total = countRef.current;
        if (!total) return;
        // Automatic follow pins can fire scroll events after a click has armed
        // a gesture epoch. An echo is not an instruction to leave the tail.
        if (getIsFollowingBottom()) {
          following.current = true;
          visibleIndex.current = total - 1;
          if (rangeRef.current.end !== total) seek(total - 1, "bottom");
          return;
        }
        const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
        following.current = atBottom;
        let changed = false;
        if (atBottom) changed = seek(total - 1, recentPhysicalEdge ? "bottom" : undefined);
        else if (viewport.scrollTop < 1) changed = seek(0, "top");
        else {
          const spacer = topSpacer.current;
          if (!spacer) return;
          const index = agentIndexAtScrollPosition(
            heights,
            spacer.getBoundingClientRect().top,
            viewport.getBoundingClientRect().top,
            viewport.scrollTop,
            viewport.clientHeight,
          );
          visibleIndex.current = index;
          changed = seek(index);
        }
        if (changed && freshGesture) {
          // Consume BEFORE React commits rows and correction writes scrollTop.
          // Those native scroll events cannot reverse this chosen window.
          readerIntent.current = consumeAgentReaderScrollIntent(readerIntent.current, pendingEpoch);
        }
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    // Each physical gesture supersedes a pending search and authorizes a fresh
    // reader transaction. A pointer drag needs repeated epochs because scroll
    // bars can move continuously while the button remains depressed.
    const interrupt = () => {
      if (wheelCoverageTimer.current !== null) {
        clearTimeout(wheelCoverageTimer.current);
        wheelCoverageTimer.current = null;
      }
      wheelIdleReady.current = false;
      lastReaderGestureAt.current = performance.now();
      readerIntent.current = requestAgentReaderScrollIntent(readerIntent.current);
      navigation.current = interruptAgentHistoryReveal(navigation.current);
      if (revealFrame.current !== null) {
        cancelAnimationFrame(revealFrame.current);
        revealFrame.current = null;
      }
    };
    // Chromium's native scrollbar captures pointer movement outside the DOM
    // event stream. We see pointerdown/up and scroll events, but not pointermove
    // while the thumb is dragged. After the first window change consumes an
    // intent epoch, the later scroll events would otherwise leave old rows
    // mounted at the new physical scrollTop (a blank viewport until wheel).
    let nativeThumbDrag: { pointerId: number; scrollTop: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      const gutterWidth = viewport.offsetWidth - viewport.clientWidth;
      const rect = viewport.getBoundingClientRect();
      const inGutter = gutterWidth >= 6 && (
        (event.clientX >= rect.right - gutterWidth && event.clientX <= rect.right) ||
        (event.clientX >= rect.left && event.clientX <= rect.left + gutterWidth)
      );
      // A click on a tool or message is not a scrolling gesture.
      if (inGutter) interrupt();
      nativeThumbDrag = event.pointerType === "mouse" && event.button === 0 && inGutter
        ? { pointerId: event.pointerId, scrollTop: viewport.scrollTop } : null;
    };
    const onPointerRelease = (event: PointerEvent) => {
      const drag = nativeThumbDrag;
      if (!drag || drag.pointerId !== event.pointerId) return;
      nativeThumbDrag = null;
      if (Math.abs(viewport.scrollTop - drag.scrollTop) < 1) return;
      // Reconcile the final *physical* position through the existing scroll
      // owner. Do not write scrollTop or synthesize a wheel/scroll event.
      interrupt();
      onScroll();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.buttons !== 0) interrupt();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.metaKey) return;
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
        if (!viewport.contains(target) && target !== document.body && target !== document.documentElement) return;
      }
      interrupt();
    };
    const onWheel = () => {
      interrupt();
      // This is a genuine trailing-wheel reconciliation, NOT a synthetic
      // scroll event or another scrollTop owner. The layout effect samples
      // the real physical viewport only after the reader stops spinning.
      wheelCoverageTimer.current = setTimeout(() => {
        wheelCoverageTimer.current = null;
        wheelIdleReady.current = true;
        requestHeightRevision();
      }, 60);
    };
    viewport.addEventListener("wheel", onWheel, { passive: true });
    viewport.addEventListener("touchmove", interrupt, { passive: true });
    viewport.addEventListener("pointerdown", onPointerDown, { passive: true });
    viewport.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerRelease, { passive: true });
    window.addEventListener("pointercancel", onPointerRelease, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", onWheel);
      if (wheelCoverageTimer.current !== null) clearTimeout(wheelCoverageTimer.current);
      wheelCoverageTimer.current = null;
      wheelIdleReady.current = false;
      viewport.removeEventListener("touchmove", interrupt);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerRelease);
      window.removeEventListener("pointercancel", onPointerRelease);
      window.removeEventListener("keydown", onKeyDown);
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
      pendingScrollEpoch.current = null;
    };
  }, [viewportRef, heights, seek, getIsFollowingBottom, requestHeightRevision]);
  // Measure the committed window and settle towards the known DOM budget.
  // Never supersede an in-progress staged seek or an active search epoch.
  const budgetFrame = useRef<number | null>(null);
  const lastBudgetProbe = useRef(0);
  const budgetProbeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleBudgetRebalance = useCallback(() => {
    if (budget === null || budgetFrame.current !== null) return;
    budgetFrame.current = requestAnimationFrame(() => {
      budgetFrame.current = null;
      if (staged.current !== null) return;
      const intent = navigation.current;
      const followingTail = getIsFollowingBottom();
      const target = intent.kind === "search" ? intent.row
        : followingTail ? countRef.current - 1 : visibleIndex.current;
      const next = agentBudgetWindow(countRef.current, target, costs, budget, budgetRows);
      const viewport = viewportRef.current;
      if (!viewport) return;
      // The old policy greedily added one newly measured neighbor on every
      // animation frame, moving anchored text over and over in Low/High mode.
      // Never grow a window that already fills the reader's viewport.
      const visibleHeight = [...viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")]
        .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
      if (!needsAgentBudgetRebalance(
        rangeRef.current, next, target, visibleHeight, viewport.clientHeight,
      )) return;
      const row = viewport.querySelector<HTMLElement>(
        '[data-agent-history-row="' + target + '"]',
      );
      anchor.current = row ? { index: target, top: row.getBoundingClientRect().top } : null;
      if (followingTail) jump.current = "bottom";
      rangeRef.current = next;
      setState(old => ({ ...old, range: next }));
    });
  }, [budget, budgetRows, costs, viewportRef, getIsFollowingBottom]);
  // Throttle costly descendant counting but ALWAYS keep one trailing probe:
  // a final resize during the throttle window must not leave an oversized
  // streaming tool result at its old, underestimated cost indefinitely.
  const scheduleBudgetProbe = useCallback(() => {
    if (budget === null || budgetProbeTimer.current !== null) return;
    const delay = Math.max(0, 1_000 - (performance.now() - lastBudgetProbe.current));
    budgetProbeTimer.current = setTimeout(() => {
      budgetProbeTimer.current = null;
      lastBudgetProbe.current = performance.now();
      if (staged.current !== null) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      let changed = false;
      for (const wrapper of viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")) {
        const index = Number(wrapper.dataset.agentHistoryRow);
        if (Number.isSafeInteger(index)) {
          changed = costs.measure(index, wrapper.querySelectorAll("*").length + 1) || changed;
        }
      }
      if (changed) scheduleBudgetRebalance();
    }, delay);
  }, [budget, costs, viewportRef, scheduleBudgetRebalance]);
  useEffect(() => () => {
    if (budgetFrame.current !== null) cancelAnimationFrame(budgetFrame.current);
    if (budgetProbeTimer.current !== null) clearTimeout(budgetProbeTimer.current);
    budgetFrame.current = null;
    budgetProbeTimer.current = null;
  }, [resetKey, budget]);
  // Content changes do not necessarily resize a row: clipped tool output can
  // add thousands of descendants without changing the observed box. Counting
  // only in ResizeObserver would leave the DOM budget stale indefinitely.
  // Observe mounted message content, not the entire page, and use the existing
  // trailing throttled probe rather than counting on each mutation.
  useEffect(() => {
    if (budget === null || typeof MutationObserver === "undefined") return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new MutationObserver(() => scheduleBudgetProbe());
    for (const wrapper of viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")) {
      const content = wrapper.querySelector<HTMLElement>("[data-role]");
      if (content) observer.observe(content, { childList: true, subtree: true });
    }
    return () => observer.disconnect();
  }, [budget, range.start, range.end, viewportRef, scheduleBudgetProbe]);

  useLayoutEffect(() => {
    if (budget === null || staged.current !== null) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let changed = false;
    for (const el of viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")) {
      const index = Number(el.dataset.agentHistoryRow);
      if (Number.isSafeInteger(index)) {
        changed = costs.measure(index, el.querySelectorAll("*").length + 1) || changed;
      }
    }
    if (changed) {
      lastBudgetProbe.current = performance.now();
      scheduleBudgetRebalance();
    }
  }, [budget, costs, range.start, range.end, viewportRef, scheduleBudgetRebalance]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        const raw = row.closest<HTMLElement>("[data-agent-history-row]")?.dataset.agentHistoryRow;
        if (raw === undefined) continue;
        const index = Number(raw);
        if (Number.isSafeInteger(index)) {
          changed = heights.measure(index, row.getBoundingClientRect().height) || changed;
          if (budget !== null) scheduleBudgetProbe();
        }
      }
      if (changed) requestHeightRevision();
    });
    for (const wrapper of viewport.querySelectorAll<HTMLElement>("[data-agent-history-row]")) {
      const row = wrapper.querySelector<HTMLElement>("[data-role]");
      if (!row) continue;
      const index = Number(wrapper.dataset.agentHistoryRow);
      row.setAttribute("aria-setsize", String(count));
      row.setAttribute("aria-posinset", String(index + 1));
      if (heights.measure(index, row.getBoundingClientRect().height)) requestHeightRevision();
      observer.observe(row);
    }
    return () => observer.disconnect();
  }, [range.start, range.end, count, viewportRef, heights, requestHeightRevision, budget, scheduleBudgetProbe]);

  // A ResizeObserver measurement must update both spacers, not merely the ledger.
  void heightRevision;
  const rows = useMemo(() => {
    const element = renderMessage();
    const result: ReactElement[] = [];
    for (let index = range.start; index < range.end; index++) {
      result.push(<div key={index} data-agent-history-row={index} data-agent-history-find-active={searchHit === index ? "true" : undefined} role="listitem" aria-current={searchHit === index ? "location" : undefined} aria-posinset={index + 1} aria-setsize={count} className={searchHit === index ? "min-w-0 rounded ring-2 ring-primary/70" : "min-w-0"}>
        <AuiProvider value={gate.row(index)}><MessageByIndexProvider index={index}>{element}</MessageByIndexProvider></AuiProvider>
      </div>);
    }
    return result;
  }, [range.start, range.end, renderMessage, gate, count, searchHit]);
  // Reclaim row clients from previously visited windows after React has
  // finished unmounting their subscriptions. Keep the mounted window stable.
  useEffect(() => {
    gate.pruneOutside(range.start, range.end);
  }, [gate, range.start, range.end]);
  const backToLatest = () => {
    navigation.current = interruptAgentHistoryReveal(navigation.current);
    staged.current = null;
    deferredScroll.current = false;
    following.current = true;
    seek(countRef.current - 1, "bottom");
  };
  return <div data-agent-history-scroll-list="true" data-agent-history-dom-level={domLevel ?? "legacy"} data-agent-history-qa-stage={staged.current !== null ? "true" : "false"} data-agent-history-qa-stage-target={staged.current?.target ?? ""} data-agent-history-qa-visible-index={visibleIndex.current} data-agent-history-qa-window-start={range.start} data-agent-history-qa-window-end={range.end} role="list" className="flex min-w-0 flex-col">
    {range.end < count && <button type="button" className="sticky top-2 z-20 mx-auto rounded-full border bg-background px-3 py-1 text-xs shadow" onClick={backToLatest}>Zur neuesten Ausgabe</button>}
    <div ref={topSpacer} data-agent-history-spacer="top" aria-hidden="true" style={{ height: heights.offset(range.start), flexShrink: 0 }} />
    {rows}
    <div data-agent-history-spacer="bottom" aria-hidden="true" style={{ height: Math.max(0, heights.total - heights.offset(range.end)), flexShrink: 0 }} />
  </div>;
});
