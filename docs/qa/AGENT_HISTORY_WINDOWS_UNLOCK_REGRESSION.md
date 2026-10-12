# Windows lock/unlock → completed chat scroll: stability regression

**Status:** fork-only QA, diagnostic. This is not proof of a driver bug, a
Windows-specific fix, or authorization to run unattended stress on target hardware.

## Why lock/unlock matters

Windows Desktop Window Manager (DWM) uses GPU composition; a hidden or
occluded WebView2 can have different timer/caching/visibility behavior from a
foreground WebView. A Windows session lock is **not** the same as app minimize
and does **not** guarantee a WebView2 visibility change, a suspended webview
or any fixed 10-second recovery window.

Win32 session transitions are distinguishable using
WM_WTSSESSION_CHANGE WTS_SESSION_LOCK (0x7) and WTS_SESSION_UNLOCK (0x8).

## Track A: CI, headless Chromium (NOT an actual Windows lock)

`tests/studio/playwright_agent_history_foreground_burst.py`

- Create 1,000 **synthetic** persisted messages; global K=5.
- Materialize ~50,000 synthetic descendants in five visible message rows.
- Switch to another browser tab for 3 seconds.
- Compare (A) return to foreground with **no scroll** against (B) return
  followed by an immediate transcript scroll. Observe first 10 seconds.
- Collect Long Tasks, TaskDuration, ScriptDuration, LayoutDuration,
  RecalcStyleDuration, final DOM and browser errors; assert persisted
  transcript is unchanged and mounted rows remain bounded.
- Important: this cannot establish an AMD Windows power-state or WebView2
  driver defect. It only tests the browser visibility/resume dimension.

## Track B: REAL Windows lock/unlock, local measurements only

`tests/studio/windows_agent_history_unlock_probe.ps1`

Run from a local checkout on the target Windows machine, **without elevated
permissions**:

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\tests\studio\windows_agent_history_unlock_probe.ps1 -Minutes 15 -Scenario NoScroll
```

1. **Back up the private chat data.** Do not upload private chat, model
   trace, ETW sessions, screenshots or unredacted logs to any repository.
2. Leave the model idle; ideally test with a newly created **synthetic**
   finished chat first. Keep AMD driver and BIOS settings fixed across cases.
3. Start the probe, verify a local file in `%LOCALAPPDATA%\UnslothQA`.
4. Lock manually with **Win+L** for ~1–2 minutes. Unlock manually. For the
   first trial, **do not interact with Unsloth for the next 30 seconds**.
5. Inspect the `LOCK`, `UNLOCK`, `UNLOCK_0_10`, and `UNLOCK_10_30`
   rows. The probe uses actual Windows session notification messages.
6. Only after the no-scroll trial is stable, repeat a separate supervised run:
```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\tests\studio\windows_agent_history_unlock_probe.ps1 -Minutes 15 -Scenario ScrollAfter30s
```
7. In the second run, wait 30 seconds after unlock, then scroll gently for
   5–10 seconds. Do **not** run the previous 200k/400k extreme stress test
   on the user machine at this stage.

**Privacy:** numeric-only local CSV, auto-flushed after each sample;
process executable **names** are used only for filtering, not written.
No passwords, chat text, URLs, command lines, screenshots, HTML, PID list
or dumps. The 1s samples can be slowed by OS pressure; `ProbeCostMs`
indicates sampling overhead. A hard lock may prevent writing its cause,
but the last flushed measurements can remain useful.

## Questions addressed

1. Is there a DWM/WebView2/system commit spike during the **first ten
   seconds without user scroll**?
2. Does the spike appear only after scrolling a completed transcript?
3. Are events captured without any sleep/wake transition, or was a
   sleep/resume state actually involved? These are separate phenomena.
4. Does a 30-second wait before scrolling eliminate the measured spike?
   Record a control without locking to separate unlock from scroll.

## What this does NOT capture

- GPU VRAM residency, SMU/TDR kernel state, per-renderer DOM internals or
  true detached DOM nodes.
- Exact GPU driver causes. A frozen kernel can prevent all logging.
- A genuine 4–5h model-loaded run; those remain unsafe until release gates
  and a staged supervised comparison have passed.

No merge, no public upstream comment, no release without explicit owner approval.
