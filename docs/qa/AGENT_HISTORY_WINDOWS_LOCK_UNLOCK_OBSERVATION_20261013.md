# Windows lock/unlock observation — 2026-10-13

## Observation (manual, user-reported)

During a long-running local agent session in Unsloth Studio, Windows was locked and
subsequently unlocked. The existing Unsloth window was reopened while the agent
had been running. **No freeze, stuck window, or visible interruption was observed.**

This is a positive exploratory observation, not a CI test or proof of repeatable
behavior. The precise executable SHA, lock duration, Windows build, run length,
and memory trace were not supplied; therefore no measured performance claim or
release conclusion is drawn from this observation.

## Acceptance coverage still needed

- Repeat lock/unlock during live streaming on the candidate Windows WebView2 EXE.
- Verify the reply is still visible and the tail follows automatically after unlock.
- Verify typing, scrolling, chat switching, and cancellation remain responsive.
- Record EXE commit, environment, elapsed time, and WebView2 process memory.

The observation is independent of the CI frontend startup-budget gate.
