# Agent History physical-viewport recovery: immediate vs wheel-idle A/B (2026-10-14)

**Disposition: experimental fork-only QA. Not releasable; do not port yet or open upstream PR.**
Official-upstream-based clean virtualization candidate `4de45a27376075b13ae6dfb0173ee914c583fe38` is unchanged.

## Exact-SHA reproducible source

- Baseline: `qa/agent-history-wheel-geometry-matrix-20261014@6c107a4bb128d79e9240c3632e4332ca7b515668` — [CI 38620229311](https://github.com/Griggelor/unsloth/actions/runs/38620229311) — [artifact 11921452213](https://github.com/Griggelor/unsloth/actions/runs/38620229311/artifacts/11921452213)
- Immediate physical-coverage A/B: `qa/agent-history-viewport-coverage-ab-20261014@7066b8c58d24baac00ab600d07d5c08f0e082612` — [CI 38621666707](https://github.com/Griggelor/unsloth/actions/runs/38621666707) — artifact 11921593781
- Wheel-idle-only physical-coverage A/B: `qa/agent-history-wheel-idle-reconcile-ab-20261014@cf860a5c0f8e574d49e2a7d453ad9c323ca02efe` — [CI 38622623889](https://github.com/Griggelor/unsloth/actions/runs/38622623889) — [artifact 11921839732](https://github.com/Griggelor/unsloth/actions/runs/38622623889/artifacts/11921839732)

All three ran the same scripted 48-scenario matrix with real wheel input (240, 720, 1680, 2400px; both modes and directions; 3 bursts per direction). Each scenario sends 7 events spaced 35ms, measures rAF physical viewport coverage and 1200ms settled state, with 400 synthetic short messages and Chromium 1440×960. Both A/Bs passed focused unit and Python parser CI. **The browser gate intentionally fails** for any continuous interior coverage <55% lasting >160ms or settled underfill.

## Evidence table

| Wheel size | Baseline failed/12 | Immediate failed/12 | 100ms idle failed/12 | Baseline worst underfill | 100ms idle worst |
|---|---:|---:|---:|---:|---:|
| 240 px | 6 | 1 | 6 | 1367ms | 217ms |
| 720 px | 4 | 3 | 0 | 1217ms | 150ms |
| 1680 px | 0 | 8 | 0 | 133ms | 133ms |
| 2400 px | 5 | 6 | 4 | 1100ms | 350ms |
| **Total** | **15/48** | **18/48** | **10/48** | — | — |

100ms idle settle coverage min at 240px was 79.4% (Dynamic) / 80.6% (Fixed), versus baseline 14.8% /31.1%. Thus it prevents persistent idle underfilled viewport for this fixture but not perceptible transient gaps.

**Root cause:** The old DOM budget rebalance infers visibility from *summed mounted row heights*. It can be satisfied by 16 rows entirely or mostly below the physical viewport, due to a 720px height estimate vs ~126px actual short-row median. At actual wheel top, the logical target row can be just outside mounted range; native reader-intent gating correctly ignores layout echoes, so nobody reopens the missing earlier row. Rebuilding the entire target window after every wheel causes additional mid-gesture gaps; waiting for genuine wheel quiet prevents this specific regression.

**Open visual failures:** At 240px, 6/12 scenarios still had 183–217ms transient underfill; at 2400px, four had 333–350ms even after idle retarget. At 1680px, regressions from the immediate A/B disappeared. **Zero-gap and Windows WebView2 parity are not demonstrated.**

## Next experiment and release guards

- Compare 60ms post-wheel debounce on a new isolated fork-only branch `qa/agent-history-wheel-idle-60ms-ab-20261014`. Keep test assertions, viewport, synthetic fixture and strict budgets unchanged; do not assume a shorter timer automatically wins.
- If remaining 2400px gaps persist, investigate a one-row-at-a-time viewport-aware *incremental shift retaining mounted rows* (or bounded placeholder for unknown heavy tools). The current fully disjoint `seek()` may itself cause temporary blanks when the target is unknown and `agentBudgetWindow()` admits only one unknown row.
- No additional native scrollTop owner, no unconstrained global DOM growth, no search/keyboard/copy regressions, no loss of persisted history. Maintain 32-row adaptive Fixed cap and 8k estimated/measured descendant target (not absolute RAM cap for one giant tool output).
- Before upstream submission: 50k/200k/400k churn, GC, menu/search/selection/scrollbar, typecheck/build/bundle, heavy/variable-height messages, exact-head reruns, controlled Windows WebView2 check and reconciliation with current official upstream; remove temporary QA workflows and ask user approval.

**Important:** This note is QA evidence, not permission to merge or publish.
