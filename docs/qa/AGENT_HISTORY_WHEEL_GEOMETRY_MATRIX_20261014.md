# Agent History physical-wheel geometry matrix (QA-only, 2026-10-14)

**Scope:** diagnostic experiment on `qa/agent-history-wheel-geometry-matrix-20261014`, fork only. This is not a shipping virtualizer fix, an upstream submission, or Windows/WebView2 acceptance.

## Code-under-test and controlled conditions

- Base: `qa/upstream-agent-history-frame-trace-20261014@281297384da33e10b594c3234045803e348423c6`, the clean upstream-based virtualizer plus QA-only staging instrumentation.
- Runtime virtualizer intentionally unchanged in this experiment. The existing `qa/upstream-agent-history-candidate-20261014@4de45a27376075b13ae6dfb0173ee914c583fe38` stays untouched.
- Synthetic fixture: 400 alternating short user/assistant messages. Chromium viewport: 1440×960.
- Independently initialize page/context for each of four native wheel deltas: **240, 720, 1680, 2400 px**. In each context test Dynamic and Fixed separately (fresh context), both wheel directions, 3 × 7 wheel events, 35 ms between events and 1200 ms idle after each burst.
- No test-side `scrollTop` writes and no synthesized `scroll` events during the wheel test.
- Frame instrumentation records native scroll position, interior viewport message-height coverage, DOM window bounds, staging state, first/last row positions, mounted row count and continuous sub-55%-coverage intervals.
- Additional per-snapshot measured row-height min/median/max distinguish virtual **720 px** default estimates from real short-message dimensions.
- **Do not treat the 160 ms exploratory underfill gate as an acceptable shipping visual limit.** It is a diagnostic comparison threshold only. Even `133 ms` is perceptible (~8 frames at 60 Hz).
- Both limits are maintained: `32` mounted rows maximum for adaptive Fixed and `8,000` estimated/measured descendant admission target. A single mandatory tool row can exceed the target, hence no absolute RAM guarantee.

## Questions to answer from recorded evidence

1. Does the 720 px unknown-row height estimate materially disagree with the actual short-row median?
2. Does the underfill correlate with wheel deltas, scroll direction, staged window lag or height-ledger remeasurement?
3. Does a gap persist until the staged window commits, or are there post-staging layout/scroll-position corrections?
4. Which visual gap duration (worst and distribution) is observed **while** wheel events arrive, not only after 1.2 seconds of idle?

## Acceptance and next steps

- Save the exact workflow SHA, successes/failures and JSON artifact from GitHub Actions; all experimental failures are included in the JSON before the job fails.
- Do not tune test assertions downward or claim that settling after 1.2 seconds eliminates transient gaps.
- Only after reading the multi-delta observations, propose an isolated A/B fix with the same fixed fixture, timings and CI machinery. A potential architecture uses lightweight estimated placeholders during conservative staging, while never hiding the actual measured real-message underfill in the QA data.
- Require additional heavy-tool and variable-height fixtures, browser navigation/search/copy, 50k/200k/400k DOM, GC and user-controlled Windows WebView2 validation before finalizing an upstream-facing patch.
- Do not merge the virtualizer into `main` and do not send an official upstream PR without explicit user approval.

## Updated upstream status

The official `unslothai/unsloth` main is still `525f3ceae3c3347e1deb1e39b6313de9aaae8e72`, 34 commits after the clean port's original base `aad900ec04d4e1a27d608295e27feee2f4c1acbc` (verified 2026-10-14). File-path overlap currently covers startup bundle check and locale files; the clean port must still be reconciled three-way, and all final-SHA gates must be rerun.

**Results:** Pending the geometry-matrix CI run `38620229311`; do not substitute prior single-delta runs for the matrix.
