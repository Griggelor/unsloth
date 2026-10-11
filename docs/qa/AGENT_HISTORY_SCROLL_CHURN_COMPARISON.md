# Synthetic agent-history DOM-churn A/B measurements (fork QA)

Status: EXPERIMENTAL, NOT RELEASE-READY. All inputs and readings are synthetic or
numeric. No private transcript, machine dump or raw user log is used.

## Methodology and measurement limitations

- 1,000 synthetic persisted messages, virtual window K=5, headless Chromium,
  no loaded model or Windows WebView2.
- Mounted synthetic tool-like descendants: approximately 200,000 or 400,000
  DOM elements in heavy windows.
- Each recorded `scroll()` operation is **a mouse-wheel event plus three
  programmatic scroll-position updates**. Treat as a multi-event navigation,
  never a single physical mouse-wheel tick.
- Performance API counters and timestamps are wall-clock observations, not a
  profiler attribution of a Windows driver hang.
- Control: PR #20 global K=5 renderer. Experiment A: PR #21 initial
  progressive renderer (one row admitted per requestAnimationFrame).
- Experiment B: PR #21 updated to two admissions per frame; CI comparison
  not yet assessed at the time this note was authored.
- Test completion must wait for a full destination window (five rows) and
  filled synthetic fixtures. Intermediate one-row staging is expected.

## Measured comparison: K=5 vs one-row-per-frame

| Metric | 200k Control | 200k Experiment A | 400k Control | 400k Experiment A |
|---|---:|---:|---:|---:|
| Max recorded navigation duration (s) | 13.95 | 8.80 | 27.55 | 16.94 |
| Total of nine navigation durations (s) | 45.81 | 48.58 | 77.29 | 89.21 |
| Max recorded task-time delta (s) | 13.87 | 8.71 | 27.50 | 16.86 |
| Sum of task-time deltas (s) | 44.84 | 48.07 | 76.87 | 88.68 |
| Total layout-time deltas (s) | 7.29 | 5.78 | 12.94 | 10.93 |
| Total style-recalculation deltas (s) | 24.83 | 28.28 | 42.74 | 53.49 |
| Max message mount delta per navigation | 21 | 10 | 21 | 10 |
| Cumulative DOM nodes newly created | 2.10m | 2.10m | 3.78m | 4.06m |
| Renderer crash events | 0 | 0 | 0 | 0 |

Interpretation: Experiment A reduced the worst navigation by around 37–39%,
while total navigation time grew around 6% at 200k and 15% at 400k.
This is not a net performance victory yet. Extra style passes from staging
appear consistent with the higher total time, but causal attribution requires
profiling; do not conflate correlation with proof.

## Release gates

1. Rerun identical synthetic control and experiments, excluding runner startup.
2. No weakening of search, scrolling, clipboard, message identity or persistence tests.
3. No lost, stale or indefinitely partially mounted content during interleaved gestures.
4. Measurable reduction in worst *single* main-thread task as well as acceptable
   total work and reader responsiveness.
5. Windows WebView2 on target hardware after firmware update, with local numeric
   telemetry only; model idle, focused on completed-history scrolling.
6. Explicit owner approval before any merge or release.
