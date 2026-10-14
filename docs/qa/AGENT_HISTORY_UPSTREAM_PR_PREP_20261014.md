# Agent History — upstream PR preparation and wheel-scroll regression

**Status: PREPARATION ONLY (2026-10-14). No upstream PR, merge, or release without user approval.**

## Windows exploratory user report

- Dynamic and Fixed Agent History modes: low RAM usage, fluid UI, chat switching and settings.
- Repeated physical mouse-wheel scrolling over several screens sometimes exposes partially empty screens; additional scrolling reveals rows.
- Dynamic: more often when navigating back through older history. Fixed: more often when moving toward newer history.
- The separate context-progress QA build displays 'Working 1 · Anfrage senden · 0:00' without subsequent stages. That issue is **out of scope** for this virtualizer PR.
- No exact empty-screen screenshot, WebView2 reproduction timing distribution or memory benchmark was supplied. Do not claim this particular scroll issue fixed.

## Code-review observations (PR30 at 4fefa530)

1. 'AgentHistoryScrollMessages.seek' initially mounts ONE target row during disjoint non-snap seeks. 'nextProgressiveAgentWindow' adds up to two rows per animation frame. New scroll intents during staging are deferred.
2. Fixed-low means a STRICT five-row cap. If five short messages do not fill the viewport, a fully populated fixed window still cannot guarantee content throughout the visible height.
3. Dynamic uses an 8,000-descendant target and normally at most 16 rows. Unknown rows are charged conservatively and admitted progressively; budget rebalancing can expand after measurements.
4. The height index estimates unseen rows. Variable-height tool messages can amplify virtual-scroll coordinate disagreement.
5. The present 'playwright_agent_history_scroll.py::scroll_to' combines real wheel, programmatic scrollTop and synthetic scroll events. This proves position reachability but does NOT cover repeated wheel-only use without synthetic recovery.

**These mechanisms are hypotheses; no root cause has been reproduced/isolated yet.**

## Test-first acceptance

- Run an isolated disposable Studio and a wheel-only Playwright loop (NO programmatic scrollTop writes or repair events after initialization).
- Exercise forward and backward multi-page wheel streams in BOTH Dynamic and Fixed.
- Measure whether at least one virtual row intersects the actual viewport after scrolling settles; sample visual row intersection during scrolling and report maximum blank duration. Record mounted range, scrollTop, spacer and measured row heights, mode, direction.
- Repeat with one-line turns, variable-height tools and heavy synthetic descendants; test after thread switching and with native scrollbar.
- Keep bounded DOM/descendant budgets, preserved persisted history, search reveal, reader-intent, streaming tail and no extra scrollTop owner.
- Reproduce before changing production renderer. Prefer a bounded viewport-aware prefetch/overscan only after a failing test. Do not globally raise row caps without measuring RAM and DOM churn.
- Explicit product tradeoff: strict fixed five-row ceiling cannot guarantee a full viewport with very short messages. Ask user before changing fixed semantics.
- Require TypeScript, unit, browser, heavy DOM and Windows WebView2 exact-HEAD passes before release.

## Upstream submission scope

- The fork Griggelor/unsloth is writable; parent unslothai/unsloth is readable. Opening a cross-fork upstream PR is technically possible, but explicitly NOT authorized yet.
- Existing PR #30 is a fork-local DRAFT with 69 files, including installer scripts, CI/Core unrelated fixes and 36 commits; this is not a clean upstream PR. Comparison against fork main showed 4 commits behind.
- Existing PR #33 bundles context work; PR #34 is context diagnostic. **Do not send either upstream as the virtualization patch.**
- Build a NEW submission branch from the latest upstream main. Port ONLY the necessary Agent History UI, preference and menu, find/search and scroll coordination, required translations, feature tests and concise docs. Exclude installer, context/archive/inference and unrelated CI baselines.
- Preserve full transcript state; do not promise offscreen Ctrl+A selection parity. Keep performance claims anchored to exact machine, fixture, browser and commit measurements.

## Draft official PR (NOT SUBMITTED)

**Title:** Studio: virtualize long chat history with bounded message DOM and configurable modes

**Summary:** Introduce opt-in Dynamic and Fixed chat-history windowing, preserving full persisted messages while bounding rendered DOM. Support search, keyboard navigation, streaming follow, thread switches and native scrolling. Add repeatable large-history and real wheel regressions.

**Validation checklist:**
- [ ] Wheel-only rapid scrolling has no persistent blank viewport in both supported UI modes; document the strict fixed-row limitation if retained.
- [ ] All focused TypeScript/unit/Chromium and full startup bundle gates pass on the final isolated HEAD.
- [ ] 50k/200k/400k synthetic heavy-DOM, native thumb, search, clipboard, tail, and Windows WebView2 manual runs pass.
- [ ] Changes are rebased/ported cleanly to CURRENT upstream main and exclude unrelated files.
- [ ] Performance evidence and limitations are documented for maintainers.

**Decision:** Not ready to publish. First reproduce and fix observed empty-page scroll regression, then trim scope and review final PR text together.
