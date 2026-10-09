# Agenten-Chatverlauf – experimental opt-in

## Variant A: bounded history pages (integrated, not release-ready)

This fork adds an opt-in **Agenten-Chatverlauf** for long-running autonomous agent chats. Ordinary chats keep the existing ProgressiveMessages renderer, unchanged.

The header menu toggles the mode on saved single chats; switching is disabled while generation runs. The local per-thread preference is stored in browser storage. It is not mirrored into studio.db or synchronized across devices/accounts. The chat transcript, model context, compaction and backend remain untouched.

The latest page initially mounts the last 32 messages. Explicit Older / Newer / Latest navigation changes whole pages; it is not continuous virtual scrolling. The live page is pruned after 64 idle messages or 96 during a running agent generation, preserving the currently generating tail and avoiding huge predicted-height spacer calculations.

### Blockers before any upstream PR

- Search in the existing find-in-page indexes mounted DOM; currently it does **not** search hidden pages. Add a full-history search or explicit complete-history mode before release.
- Browser selection and Ctrl+A cover the visible page only; explicit Copy Chat / Export are storage-backed but browser parity is still unverified.
- Accessibility range labelling exists but virtualized list semantics and keyboard/focus/page-transition behavior need review.
- Local preference needs account switching, privacy and multi-device persistence policy review.
- Browser integration for active tool calls, edits, removal, fork, thread switch, image growth and active streaming needs E2E coverage.
- The current source commits have NOT been compiled or browser-benchmarked; no performance claim is warranted.
- Existing stream-pacing gate remains in place. Do not add another proxy without proving a separate remaining cost.

### Prior regressions we must beat

Unsloth documented a rejected virtualizer in tests/studio/studiobench/CONTRIBUTING-perf.md: send_turn declined from 61.1 FPS to 37.3 FPS and p95 increased from 34 ms to 375 ms, mostly because of first-append style recalculation and row repositioning. This experiment uses fixed pages, not continuous shifting absolute-positioned rows.

Upstream PR #13059 already significantly reduces selector fan-out, including for very large agent chats, so all A/B measurement must be against current upstream rather than older releases.

### Test/measurement gate

From studio/frontend, run the new tests/agent-history-page.test.ts and existing tests, then npm test, npm run typecheck and npm run build. Run Playwright for find, copy, edit, stream, tool actions, resize, thread switches, and WebView2 real agent traces. Run Studiobench with in-band null controls and its liveness/floor_table/visible+behaviour parity gates. Any uncovered action is NOT RUN, not PASS.

## Follow-up variants

- B: opt-in true pixel-aware viewport virtualization, if an A/B test shows benefit beyond A.
- C: decouple the in-memory assistant-ui message repository from complete persisted archive, with store-backed global history search.

The earlier experimental-render-window.ts is an unrelated research planner; Variant A uses agent-history-page.ts instead.

## Variant B prototype: natural-scroll viewport (2026-10-09)

The user rejected explicit 32-row navigation buttons: the intended experience is **continuous scrolling**, automatic load/unload, first messages at scroll top, last messages at scroll bottom, and one optional "Zur neuesten Ausgabe" jump.

This experimental branch now contains `agent-history-scroll-window.ts` (height index and bounded range planner), `agent-history-scroll-messages.tsx` (React wiring to the existing Thread viewport) and `tests/agent-history-scroll-window.test.ts`. The former page implementation remains in the branch as unreferenced history; **the active opt-in renderer is the scroll prototype**, while ordinary chat continues to use `ProgressiveMessages`.

Only pure algorithm tests have been locally executed (six passing) and a TypeScript AST syntax parse of the local prototype completed. GitHub code changes are committed, but **the actual React app has not been typechecked, bundled, or exercised in a browser**. Do not claim the scrolling feature is proven or advise running it on a production agent conversation yet.

Review blockers for Variant B:
- Prove scroll anchoring with a real browser and tall dynamically changing messages; handle selected text, inline tool cards and reasoning.
- Inspect CSS for the `contents` wrapper and spacer metrics; verify bottom autoscroll and jumping to start across large histories.
- ResizeObserver measurements currently update the height ledger, not React spacer styles immediately; validate correction/repaint scheduling and adjust to avoid scroll jump.
- Ensure massive estimated scroll height does not exceed engine scroll dimension caps; prefer anchored chunked navigation if it does.
- Provide full-history search and clipboard support independently of mounted DOM; screen reader range semantics require browser-level verification.
- Benchmark long-thread `send_turn` against upstream main and concurrent null. Reject this design if it repeats the previously documented first-append style recalculation regression.
- Verify account switch/privacy, transient chats and thread reopen, and the existing native autocomplete/auto-scroll interactions.
- Consolidate clean commits only after tests and performance A/B; the existing branch is a research worktree, not PR-ready.
