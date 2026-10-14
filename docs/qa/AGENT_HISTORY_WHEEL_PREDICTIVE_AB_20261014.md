# Predictive physical-wheel prefetch — controlled A/B evidence (2026-10-14)

**QA ONLY; no official upstream PR, merge, release or user Windows-profile mutation.**

## Revision and code changes

- Experimental source branch: `qa/agent-history-wheel-predictive-prefetch-20261014`.
- **Exact tested source commit:** `300b1fd74d0abeef76ef8339564d33a07e5abea1`.
- Comparison source: `qa/agent-history-idle-neighbor-window-ab-20261014@6d7ddab001ab31582dfa26dd0cf7748d036e8c73`.
- Only small native wheel steps toward older history (up to 720px) trigger physical-viewport-aware prefetch of an immediately adjacent row. The callback uses `agentWheelPrefetchTarget` and `agentPhysicalNeighborWindow`. A maximum of one follow-up neighbor is attempted after the first actual DOM cost is measured; other large wheel deltas keep conservative progressive staging.
- No new `scrollTop` owner, no synthetic scroll repairs, no bump of 16-row Dynamic / 32-row adaptive Fixed caps, and no change to the 8,000-descendant admission target. Oversized single mandatory tool rows remain a separate known limitation.
- Added pure guard unit test for small/large deltas, invalid coordinates and boundary.
- All work is on disposable fork QA branches.

## Like-for-like measured evidence

Headless Chromium 1440×960, 400 purely synthetic short chat messages, both Dynamic and Fixed modes, physical Playwright wheel deltas 240/720/1680/2400px, both directions, three seven-event bursts per mode/delta/direction, 35ms spacing, 1200ms idle; **48 scenarios**. A scenario fails if settled interior coverage is below 55%, it has no visible mounted rows, or contiguous interior underfill below 55% exceeds 160ms. Neither test logic nor thresholds were relaxed in this experiment.

| Metric | Neighbor baseline | Predictive A/B first run | Predictive A/B repeat |
|---|---:|---:|---:|
| Scenarios with any failure | 10 / 48 | 4 / 48 | 4 / 48 |
| Failures at 240px | 6 | 0 | 0 |
| Mean contiguous underfill maximum per scenario | 84.4ms | 48.2ms | 46.5ms |
| P90 contiguous underfill | 217ms | 133ms | 133ms |
| Worst contiguous underfill | 350ms | 350ms | 350ms |
| Total sampled underfilled animation frames | 478 | 273 | 264 |
| Any settled coverage below 55% (regardless of physical-edge exemption) | 2 | 0 | 0 |

All four remaining failures in both candidate runs are **2,400px toward older**: Dynamic bursts 1+2 (333/350ms) and Fixed bursts 1+2 (333/350ms). The 160ms gate remains red intentionally; a CI job failing this visual quality gate is **not** proof that every property is release-ready.

### Reproducible CI evidence

- Baseline: [wheel neighbor run 38623839203](https://github.com/Griggelor/unsloth/actions/runs/38623839203), archive available in runner artifacts.
- Experiment: [run 38627530579, attempt 1](https://github.com/Griggelor/unsloth/actions/runs/38627530579), artifact `11924751856`.
- Exact-SHA wheel rerun: [run 38627530579, attempt 2](https://github.com/Griggelor/unsloth/actions/runs/38627530579), artifact `11924957288`.
- Both same-SHA unit suites SUCCESS; wheel jobs intentionally FAIL on 4 real extreme cases (not skipped).
- Source-equivalent compile validation branch `qa/agent-history-predictive-compile-validation-20261014@a40ff3d32c28956187390703ae5b64dba6772c66`, code differs from tested `300b1fd...` **only** by a QA workflow file. [Build run 38628247182](https://github.com/Griggelor/unsloth/actions/runs/38628247182): SUCCESS on TypeScript, focused unit, Vite production build and bundle-budget checks.

## Review conclusion

**Positive bounded A/B improvement; retain for staging.** The 240px regression is eliminated in both runs, while residual 2,400px gaps do not worsen. Do not claim zero transient blank frames, final release approval, or a true absolute RAM upper bound.

**Before porting to an upstream-facing PR:**
1. Run full exact-source-equivalent 50k/200k/400k DOM churn, GC, search, menu, native thumb, thread switching and clipboard; add variable-height and huge-tool fixtures to test this early-prefetch path.
2. Real Windows WebView2 smoke test using a safe, disposable profile; no non-synthetic chat data in CI.
3. Port only needed runtime/tests to an updated official-upstream-based branch; reconcile latest upstream edits, delete temporary QA workflows, redo exact-final-source gates.
4. Review full English PR diff and limitations with user. **Do NOT open an official upstream PR without explicit approval.**
