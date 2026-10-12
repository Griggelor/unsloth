// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { AuiProvider, useAui, useAuiState } from "@assistant-ui/react";
import { MessageByIndexProvider } from "./stale-safe-scopes";
import { type FC, type ReactElement, type RefObject, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRowNotificationGate } from "./row-notification-gate";
import { findAgentTextMatches, type AgentFindMatch } from "./agent-history-search";
import { notifyFindTargets, registerFindTarget, type FindTargetResult } from "@/features/find-in-page/lib/find-targets";
import { AGENT_DOM_TARGETS, AgentDomCostIndex, agentBudgetWindow, type AgentDomLevel, needsAgentBudgetRebalance } from "./agent-history-dom-budget";
import { AGENT_DEFAULT_ROWS, AgentHeightIndex, agentIndexAtScrollPosition, agentWindowAtIndex, agentWindowOnAppend, latestAgentWindow, nextProgressiveAgentWindow, type AgentScrollWindow } from "./agent-history-scroll-window";
import { useAdjustForContentInsertedAbove, useNavigateThreadViewport, useScrollThreadToBottom } from "./use-intent-aware-autoscroll";
import {
  allowsAgentReaderScrollIntent,
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
  domLevel?: Exclude<AgentDomLevel, "off">;
}> = memo(function AgentHistoryScrollMessages({
  renderMessage, resetKey, viewportRef, windowRows = AGENT_DEFAULT_ROWS, domLevel,
}) {
  const count = useAuiState(({ thread }) => thread.messages.length);
  const aui = useAui();
  const gate = useMemo(() => createRowNotificationGate(aui), [aui]);
  const heights = useMemo(() => new AgentHeightIndex(count), [resetKey]);
  heights.resize(count);
  const costs = useMemo(() => new AgentDomCostIndex(count), [resetKey]);
  costs.resize(count);
  const budget = domLevel ? AGENT_DOM_TARGETS[domLevel] : null;
  const jumpBottom = useScrollThreadToBottom();
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
  const [state, setState] = useState(() => ({
    key: resetKey, count, windowRows, domLevel,
    range: budget ? agentBudgetWindow(count, count - 1, costs, budget)
      : latestAgentWindow(count, windowRows),
  }));
  const visibleIndex = useRef(Math.max(0, count - 1));
  const lastWindowRows = useRef(windowRows);
  const lastDomLevel = useRef(domLevel);
  const [heightRevision, setHeightRevision] = useState(0);
  const [searchHit, setSearchHit] = useState(-1);
  const [revealRevision, setRevealRevision] = useState(0);
  const searchHitRef = useRef(-1);
  const navigation = useRef<AgentHistoryNavigation>(initialAgentHistoryNavigation());
  const readerIntent = useRef(initialAgentReaderScrollIntent());
  const pendingScrollEpoch = useRef<number | null>(null);
  // Old reader gestures must not carry over when the user changes threads.
  useLayoutEffect(() => {
    readerIntent.current = initialAgentReaderScrollIntent();
    pendingScrollEpoch.current = null;
    navigation.current = initialAgentHistoryNavigation();
    staged.current = null;
    pendingPassiveReveal.current = null;
    deferredScroll.current = false;
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
    budget === null ? null : agentBudgetWindow(count, index, costs, budget);
  const latestWindow = () => budgetWindow(count - 1) ?? latestAgentWindow(count, windowRows);
  const visibleWindow = () => budgetWindow(visibleIndex.current) ?? agentWindowAtIndex(
    count, Math.min(visibleIndex.current, Math.max(0, count - 1)), undefined, windowRows,
  );
  const range = state.key !== resetKey ? latestWindow()
    : state.domLevel !== domLevel || state.windowRows !== windowRows
      ? following.current ? latestWindow() : visibleWindow()
      : state.count !== count
        ? budget !== null
          ? following.current ? latestWindow() : state.range
          : agentWindowOnAppend(state.range, state.count, count, following.current, windowRows)
        : state.range;
  if (state.key !== resetKey || state.count !== count ||
      state.windowRows !== windowRows || state.domLevel !== domLevel) {
    setState({ key: resetKey, count, windowRows, domLevel, range });
  }
  const rangeRef = useRef<AgentScrollWindow>(range);
  rangeRef.current = range;

  const seek = useCallback((index: number, snap?: "top" | "bottom") => {
    const viewport = viewportRef.current;
    const next = budget !== null
      ? agentBudgetWindow(countRef.current, index, costs, budget)
      : agentWindowAtIndex(countRef.current, index, rangeRef.current, windowRows);
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
  }, [jumpBottom, navigateViewport, viewportRef, windowRows, costs, budget]);

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
      ? agentBudgetWindow(countRef.current, index, costs, budget)
      : agentWindowAtIndex(countRef.current, index, rangeRef.current, windowRows);
    if (next.start !== rangeRef.current.start || next.end !== rangeRef.current.end) {
      rangeRef.current = next;
      setState(old => ({ ...old, range: next }));
    }
  }, [windowRows, costs, budget]);

  // Changing the preference should not strand the reader at a stale scroll offset.
  // Keep height measurements; only the mounted window changes.
  useLayoutEffect(() => {
    if (lastWindowRows.current === windowRows && lastDomLevel.current === domLevel) return;
    lastWindowRows.current = windowRows;
    lastDomLevel.current = domLevel;
    // A pending progressive destination belongs to the PREVIOUS mode. Do
    // not let its next frame reintroduce rows outside the new DOM budget.
    staged.current = null;
    deferredScroll.current = false;
    readerIntent.current = consumeAgentReaderScrollIntent(readerIntent.current, readerIntent.current.epoch);
    pendingScrollEpoch.current = null;
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    if (following.current) jumpBottom("auto");
    else navigateViewport(heights.offset(visibleIndex.current));
  }, [windowRows, domLevel, range.start, range.end, heights, jumpBottom, navigateViewport]);

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
  }, [range.start, range.end, searchHit, revealRevision, viewportRef, jumpBottom, correctAnchor, navigateViewport]);

  // A scroll event is not itself evidence of user navigation. Internal
  // anchor corrections, CSS/native scroll anchoring and remeasuring huge tool
  // rows all emit scroll events. Authorize ONE window change per fresh reader
  // gesture epoch, then ignore geometry-driven echoes until the next gesture.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const epoch = readerIntent.current.epoch;
      if (!allowsAgentReaderScrollIntent(readerIntent.current, epoch)) return;
      pendingScrollEpoch.current = epoch;
      if (animation.current !== null) return;
      animation.current = requestAnimationFrame(() => {
        animation.current = null;
        const pendingEpoch = pendingScrollEpoch.current;
        pendingScrollEpoch.current = null;
        if (pendingEpoch === null ||
            !allowsAgentReaderScrollIntent(readerIntent.current, pendingEpoch) ||
            !allowsPassiveAgentScroll(navigation.current)) return;
        if (staged.current !== null) {
          // A gesture during staging is replayed only after the final commit.
          deferredScroll.current = true;
          return;
        }
        const total = countRef.current;
        if (!total) return;
        const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
        following.current = atBottom;
        let changed = false;
        if (atBottom) changed = seek(total - 1);
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
        if (changed) {
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
      readerIntent.current = requestAgentReaderScrollIntent(readerIntent.current);
      navigation.current = interruptAgentHistoryReveal(navigation.current);
      if (revealFrame.current !== null) {
        cancelAnimationFrame(revealFrame.current);
        revealFrame.current = null;
      }
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
    viewport.addEventListener("wheel", interrupt, { passive: true });
    viewport.addEventListener("touchmove", interrupt, { passive: true });
    viewport.addEventListener("pointerdown", interrupt, { passive: true });
    viewport.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", interrupt);
      viewport.removeEventListener("touchmove", interrupt);
      viewport.removeEventListener("pointerdown", interrupt);
      viewport.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
      pendingScrollEpoch.current = null;
    };
  }, [viewportRef, heights, seek]);
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
      const target = intent.kind === "search" ? intent.row
        : following.current ? countRef.current - 1 : visibleIndex.current;
      const next = agentBudgetWindow(countRef.current, target, costs, budget);
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
      if (following.current) jump.current = "bottom";
      rangeRef.current = next;
      setState(old => ({ ...old, range: next }));
    });
  }, [budget, costs, viewportRef]);
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
  return <div data-agent-history-scroll-list="true" data-agent-history-dom-level={domLevel ?? "legacy"} role="list" className="flex min-w-0 flex-col">
    {range.end < count && <button type="button" className="sticky top-2 z-20 mx-auto rounded-full border bg-background px-3 py-1 text-xs shadow" onClick={backToLatest}>Zur neuesten Ausgabe</button>}
    <div ref={topSpacer} data-agent-history-spacer="top" aria-hidden="true" style={{ height: heights.offset(range.start), flexShrink: 0 }} />
    {rows}
    <div data-agent-history-spacer="bottom" aria-hidden="true" style={{ height: Math.max(0, heights.total - heights.offset(range.end)), flexShrink: 0 }} />
  </div>;
});
