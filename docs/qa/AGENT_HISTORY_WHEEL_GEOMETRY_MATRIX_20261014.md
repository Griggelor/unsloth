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

## Observed baseline result (completed; no product fix)

**Code SHA:** `6c107a4bb128d79e9240c3632e4332ca7b515668`  
**Workflow:** [38620229311](https://github.com/Griggelor/unsloth/actions/runs/38620229311)  
**Artifact:** [11921452213](https://github.com/Griggelor/unsloth/actions/runs/38620229311/artifacts/11921452213)  
**Unit + Python parser:** PASS. **Wheel matrix:** FAIL, **15/48** physical-wheel scenarios did not meet the exploratory gate.

| Wheel delta | Failed/12 | Max contiguous underfilled interval |
| --- | ---: | ---: |
| 240 px | 6/12 | 1367 ms |
| 720 px | 4/12 | 1217 ms |
| 1680 px | 0/12 | 133 ms |
| 2400 px | 5/12 | 1100 ms |

For the synthetic short messages, the measured mounted-row median was typically **126 px**, versus the static **720 px** initial unknown-row estimate (a factor of ~5.7). This alone does not establish the optimal replacement height for large real agent/tool messages.

**Concrete persistent gap:** Dynamic / 240 px / oldest / burst 0 settled with `range=[384,400)`, 16 mounted rows, `firstTop=661px` below viewport top and only **299/960 px (31.1%)** visible message coverage after 1.2 s idle. Stage flag was `false`: this is not merely a temporary staged-render gap. The same 240-px scenario reproduces in adaptive Fixed. The virtual physical top lies in an earlier, unmounted row.

**Code-level mechanism:** `needsAgentBudgetRebalance` uses the sum of mounted message heights, not actual intersection of the mounted range with the physical viewport. It may therefore consider a window "tall enough" while its first element begins hundreds of pixels below the viewport. The reader intent epoch also suppresses subsequent layout-origin scroll echoes. No geometry-aware partial-gap reconciliation was present.

**Follow-up experiment:** `qa/agent-history-viewport-coverage-ab-20261014` @ `7066b8c58d24baac00ab600d07d5c08f0e082612` adds a bounded top/bottom physical-window retarget only, preserving existing budget, reader/search ownership and native scrollTop. It must demonstrate a reduction versus these failures before any port.

**Evidence:** The JSON in the workflow artifact contains all 48 outcomes, full per-frame traces for long gaps, height samples and synthetic failure screenshots. No private end-user chat data was used.


