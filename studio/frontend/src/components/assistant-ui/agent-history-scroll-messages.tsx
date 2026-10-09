// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
import { AuiProvider, MessageByIndexProvider, useAui, useAuiState } from "@assistant-ui/react";
import { type FC, type ReactElement, type RefObject, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRowNotificationGate } from "./row-notification-gate";
import { AgentHeightIndex, agentIndexAtScrollPosition, agentWindowAtIndex, agentWindowOnAppend, latestAgentWindow, type AgentScrollWindow } from "./agent-history-scroll-window";
import { useAdjustForContentInsertedAbove, useScrollThreadToBottom } from "./use-intent-aware-autoscroll";

/**
 * Experimental opt-in renderer. All messages remain in the assistant-ui store
 * and persisted transcript; only the mounted DOM is bounded.
 * Search / select-all parity MUST be addressed before release.
 */
export const AgentHistoryScrollMessages: FC<{
  renderMessage: () => ReactElement;
  resetKey: string | undefined;
  viewportRef: RefObject<HTMLElement | null>;
}> = memo(function AgentHistoryScrollMessages({ renderMessage, resetKey, viewportRef }) {
  const count = useAuiState(({ thread }) => thread.messages.length);
  const aui = useAui();
  const gate = useMemo(() => createRowNotificationGate(aui), [aui]);
  const heights = useMemo(() => new AgentHeightIndex(count), [resetKey]);
  heights.resize(count);
  const jumpBottom = useScrollThreadToBottom();
  const correctAnchor = useAdjustForContentInsertedAbove();
  const following = useRef(true);
  const countRef = useRef(count);
  countRef.current = count;
  const animation = useRef<number | null>(null);
  const topSpacer = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ index: number; top: number } | null>(null);
  const jump = useRef<"top" | "bottom" | null>(null);
  const [state, setState] = useState(() => ({ key: resetKey, count, range: latestAgentWindow(count) }));
  const [heightRevision, setHeightRevision] = useState(0);
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
  const range = state.key !== resetKey ? latestAgentWindow(count)
    : state.count !== count
      ? agentWindowOnAppend(state.range, state.count, count, following.current)
      : state.range;
  if (state.key !== resetKey || state.count !== count) {
    setState({ key: resetKey, count, range });
  }
  const rangeRef = useRef<AgentScrollWindow>(range);
  rangeRef.current = range;

  const seek = useCallback((index: number, snap?: "top" | "bottom") => {
    const viewport = viewportRef.current;
    const next = agentWindowAtIndex(countRef.current, index, rangeRef.current);
    if (next.start === rangeRef.current.start && next.end === rangeRef.current.end) {
      if (snap === "bottom") jumpBottom("auto");
      if (snap === "top" && viewport) viewport.scrollTop = 0;
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
  }, [jumpBottom, viewportRef]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const action = jump.current;
    jump.current = null;
    const oldAnchor = anchor.current;
    anchor.current = null;
    if (action === "top") viewport.scrollTop = 0;
    else if (action === "bottom") jumpBottom("auto");
    else if (oldAnchor) {
      const row = viewport.querySelector<HTMLElement>('[data-agent-history-row="' + oldAnchor.index + '"]');
      if (row) correctAnchor(row.getBoundingClientRect().top - oldAnchor.top);
    }
  }, [range.start, range.end, viewportRef, jumpBottom, correctAnchor]);

  // Passive, one sample per frame. No React work per pixel or token.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      if (animation.current !== null) return;
      animation.current = requestAnimationFrame(() => {
        animation.current = null;
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
        seek(index);
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
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
      result.push(<div key={index} data-agent-history-row={index} role="listitem" aria-posinset={index + 1} aria-setsize={count} className="min-w-0">
        <AuiProvider value={gate.row(index)}><MessageByIndexProvider index={index}>{element}</MessageByIndexProvider></AuiProvider>
      </div>);
    }
    return result;
  }, [range.start, range.end, renderMessage, gate, count]);
  // Reclaim row clients from previously visited windows after React has
  // finished unmounting their subscriptions. Keep the mounted window stable.
  useEffect(() => {
    gate.pruneOutside(range.start, range.end);
  }, [gate, range.start, range.end]);
  const backToLatest = () => { following.current = true; seek(countRef.current - 1, "bottom"); };
  return <div data-agent-history-scroll-list="true" role="list" className="flex min-w-0 flex-col">
    {range.end < count && <button type="button" className="sticky top-2 z-20 mx-auto rounded-full border bg-background px-3 py-1 text-xs shadow" onClick={backToLatest}>Zur neuesten Ausgabe</button>}
    <div ref={topSpacer} data-agent-history-spacer="top" aria-hidden="true" style={{ height: heights.offset(range.start), flexShrink: 0 }} />
    {rows}
    <div data-agent-history-spacer="bottom" aria-hidden="true" style={{ height: Math.max(0, heights.total - heights.offset(range.end)), flexShrink: 0 }} />
  </div>;
});
