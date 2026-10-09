// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

import {
  AuiProvider,
  MessageByIndexProvider,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  type FC,
  type ReactElement,
  memo,
  useMemo,
  useState,
} from "react";

import { createRowNotificationGate } from "./row-notification-gate";
import {
  agentHistorySlice,
  agentHistoryPageForMessage,
  initialAgentHistoryPage,
  newerAgentHistoryPage,
  olderAgentHistoryPage,
  reconcileAgentHistoryPage,
  type AgentHistoryPage,
} from "./agent-history-page";

/**
 * Explicit page navigation rather than scroll virtualization. No spacer or
 * estimated heights. Normal chats continue to use ProgressiveMessages.
 *
 * Important: this component is mounted only while the thread is idle at the
 * mode boundary; a generating thread retains the same subtree throughout.
 * Full-history search and DOM capture must not silently consume a bounded page.
 */
export const AgentHistoryMessages: FC<{
  renderMessage: () => ReactElement;
  resetKey: string | undefined;
}> = memo(function AgentHistoryMessages({ renderMessage, resetKey }) {
  const count = useAuiState(({ thread }) => thread.messages.length);
  const isRunning = useAuiState(({ thread }) => thread.isRunning);
  const aui = useAui();
  const gate = useMemo(() => createRowNotificationGate(aui), [aui]);
  // Scan only when the message count changes, not on each composer keystroke
  // or each delta. The upstream long-chat regression was selector fan-out.
  const lastUserIndex = useMemo(() => {
    const messages = aui.thread().getState().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  }, [aui, count]);
  const [page, setPage] = useState<AgentHistoryPage>(() => initialAgentHistoryPage(count));
  const [seen, setSeen] = useState({ count, key: resetKey, running: isRunning });

  if (seen.key !== resetKey) {
    setSeen({ count, key: resetKey, running: isRunning });
    setPage(initialAgentHistoryPage(count));
  } else if (seen.count !== count || seen.running !== isRunning) {
    setSeen({ count, key: resetKey });
    setPage(reconcileAgentHistoryPage(page, seen.count, count, isRunning));
  }

  const slice = agentHistorySlice(page, count);

  // When browsing old pages, keep this page fixed while the agent continues
  // to work. Show a 'Latest' action, never jump the reader unexpectedly.
  const rows = useMemo(() => {
    if (slice.end <= slice.start) return null;
    const message = renderMessage();
    const items: ReactElement[] = [];
    for (let index = slice.start; index < slice.end; index += 1) {
      items.push(
        <AuiProvider key={index} value={gate.row(index)}>
          <MessageByIndexProvider index={index}>{message}</MessageByIndexProvider>
        </AuiProvider>,
      );
    }
    return items;
  }, [slice.start, slice.end, renderMessage, gate]);

  return (
    <>
      {count > 0 && (slice.older || slice.newer || lastUserIndex >= 0) && (
        <nav
          aria-label="Agenten-Chatverlauf"
          data-agent-history-navigation="true"
          className="mx-auto mb-4 flex w-full max-w-(--thread-content-max-width) flex-wrap items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
        >
          <span aria-live="polite">
            Nachrichten {slice.start + 1}–{slice.end} von {count}
          </span>
          {lastUserIndex >= 0 && (lastUserIndex < slice.start || lastUserIndex >= slice.end) && (
            <button type="button" className="rounded-md border px-2 py-1 hover:bg-muted" onClick={() => setPage(agentHistoryPageForMessage(lastUserIndex, count))}>
              Letzte Eingabe
            </button>
          )}
          {slice.older && (
            <button
              type="button"
              className="rounded-md border px-2 py-1 hover:bg-muted"
              onClick={() => setPage(olderAgentHistoryPage(slice))}
            >
              Ältere Nachrichten
            </button>
          )}
          {slice.newer && (
            <button
              type="button"
              className="rounded-md border px-2 py-1 hover:bg-muted"
              onClick={() => setPage(newerAgentHistoryPage(slice, count))}
            >
              Neuere Nachrichten
            </button>
          )}
          {!slice.latest && (
            <button
              type="button"
              className="rounded-md border px-2 py-1 hover:bg-muted"
              onClick={() => setPage(initialAgentHistoryPage(count))}
            >
              Letzte Ausgabe
            </button>
          )}
        </nav>
      )}
      {rows}
    </>
  );
});
