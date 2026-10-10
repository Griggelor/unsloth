// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { AuiProvider, MessageByIndexProvider, useAui, useAuiState } from "@assistant-ui/react";
import { type FC, type ReactElement, type RefObject, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRowNotificationGate } from "./row-notification-gate";
import { findAgentTextMatches, type AgentFindMatch } from "./agent-history-search";
import { notifyFindTargets, registerFindTarget, type FindTargetResult } from "@/features/find-in-page/lib/find-targets";
import { AGENT_DEFAULT_ROWS, AgentHeightIndex, agentIndexAtScrollPosition, agentWindowAtIndex, agentWindowOnAppend, latestAgentWindow, type AgentScrollWindow } from "./agent-history-scroll-window";
import { useAdjustForContentInsertedAbove, useNavigateThreadViewport, useScrollThreadToBottom } from "./use-intent-aware-autoscroll";
import {
  allowsPassiveAgentScroll,
  completeAgentHistoryReveal,
  initialAgentHistoryNavigation,
  interruptAgentHistoryReveal,
  markAgentHistoryRevealPositioned,
  requestAgentHistoryReveal,
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
}> = memo(function AgentHistoryScrollMessages({
  renderMessage, resetKey, viewportRef, windowRows = AGENT_DEFAULT_ROWS,
}) {
  const count = useAuiState(({ thread }) => thread.messages.length);
  const aui = useAui();
  const gate = useMemo(() => createRowNotificationGate(aui), [aui]);
  const heights = useMemo(() => new AgentHeightIndex(count), [resetKey]);
  heights.resize(count);
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
  const [state, setState] = useState(() => ({
    key: resetKey, count, windowRows, range: latestAgentWindow(count, windowRows),
  }));
  const visibleIndex = useRef(Math.max(0, count - 1));
  const lastWindowRows = useRef(windowRows);
  const [heightRevision, setHeightRevision] = useState(0);
  const [searchHit, setSearchHit] = useState(-1);
  const [revealRevision, setRevealRevision] = useState(0);
  const searchHitRef = useRef(-1);
  const navigation = useRef<AgentHistoryNavigation>(initialAgentHistoryNavigation());
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

  // Async history arrival must not mount the entire conversation in one commit.
  const range = state.key !== resetKey ? latestAgentWindow(count, windowRows)
    : state.windowRows !== windowRows
      ? following.current
        ? latestAgentWindow(count, windowRows)
        : agentWindowAtIndex(
            count, Math.min(visibleIndex.current, Math.max(0, count - 1)), undefined, windowRows,
          )
      : state.count !== count
        ? agentWindowOnAppend(state.range, state.count, count, following.current, windowRows)
        : state.range;
  if (state.key !== resetKey || state.count !== count || state.windowRows !== windowRows) {
    setState({ key: resetKey, count, windowRows, range });
  }
  const rangeRef = useRef<AgentScrollWindow>(range);
  rangeRef.current = range;

  const seek = useCallback((index: number, snap?: "top" | "bottom") => {
    const viewport = viewportRef.current;
    const next = agentWindowAtIndex(countRef.current, index, rangeRef.current, windowRows);
    if (next.start === rangeRef.current.start && next.end === rangeRef.current.end) {
      if (snap === "bottom") jumpBottom("auto");
      if (snap === "top" && viewport) navigateViewport(0);
      return;
    }
    anchor.current = null;
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
    rangeRef.current = next;
    setState(old => ({ ...old, range: next }));
  }, [jumpBottom, navigateViewport, viewportRef, windowRows]);

  const revealSearchRow = useCallback((index: number) => {
    const nextIntent = requestAgentHistoryReveal(navigation.current, index, countRef.current);
    if (nextIntent === navigation.current) return;
    navigation.current = nextIntent;
    // A search command is reader navigation, never permission to continue
    // following a streaming tail. The viewport owner also detaches BEFORE
    // writing scrollTop once the destination row has mounted.
    following.current = false;
    anchor.current = null;
    jump.current = null;
    searchHitRef.current = index;
    setSearchHit(index);
    // A repeated hit may already be mounted, and setSearchHit(sameIndex)
    // does not produce a render. Force a fresh layout navigation transaction.
    setRevealRevision(v => v + 1);
    const next = agentWindowAtIndex(countRef.current, index, rangeRef.current, windowRows);
    if (next.start !== rangeRef.current.start || next.end !== rangeRef.current.end) {
      rangeRef.current = next;
      setState(old => ({ ...old, range: next }));
    }
  }, [windowRows]);

  // Changing the preference should not strand the reader at a stale scroll offset.
  // Keep height measurements; only the mounted window changes.
  useLayoutEffect(() => {
    if (lastWindowRows.current === windowRows) return;
    lastWindowRows.current = windowRows;
    if (following.current) jumpBottom("auto");
    else navigateViewport(heights.offset(visibleIndex.current));
  }, [windowRows, range.start, range.end, heights, jumpBottom, navigateViewport]);

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
  }, [range.start, range.end, searchHit, revealRevision, viewportRef, jumpBottom, correctAnchor, navigateViewport]);

  // Passive, one sample per frame. No React work per pixel or token.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      if (animation.current !== null) return;
      animation.current = requestAnimationFrame(() => {
        animation.current = null;
        if (!allowsPassiveAgentScroll(navigation.current)) return;
        const total = countRef.current;
        if (!total) return;
        const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24;
        following.current = atBottom;
        if (atBottom) { seek(total - 1); return; }
        if (viewport.scrollTop < 1) { seek(0, "top"); return; }
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
        seek(index);
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    // Actual reader gestures supersede a pending search. Synthetic scroll
    // events from explicit navigation and from layout measurement do not.
    const interrupt = () => {
      navigation.current = interruptAgentHistoryReveal(navigation.current);
      if (revealFrame.current !== null) {
        cancelAnimationFrame(revealFrame.current);
        revealFrame.current = null;
      }
    };
    viewport.addEventListener("wheel", interrupt, { passive: true });
    viewport.addEventListener("touchmove", interrupt, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", interrupt);
      viewport.removeEventListener("touchmove", interrupt);
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
    };
  }, [viewportRef, heights, seek]);

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
        if (Number.isSafeInteger(index)) changed = heights.measure(index, row.getBoundingClientRect().height) || changed;
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
  }, [range.start, range.end, count, viewportRef, heights, requestHeightRevision]);

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
    following.current = true;
    seek(countRef.current - 1, "bottom");
  };
  return <div data-agent-history-scroll-list="true" role="list" className="flex min-w-0 flex-col">
    {range.end < count && <button type="button" className="sticky top-2 z-20 mx-auto rounded-full border bg-background px-3 py-1 text-xs shadow" onClick={backToLatest}>Zur neuesten Ausgabe</button>}
    <div ref={topSpacer} data-agent-history-spacer="top" aria-hidden="true" style={{ height: heights.offset(range.start), flexShrink: 0 }} />
    {rows}
    <div data-agent-history-spacer="bottom" aria-hidden="true" style={{ height: Math.max(0, heights.total - heights.offset(range.end)), flexShrink: 0 }} />
  </div>;
});
