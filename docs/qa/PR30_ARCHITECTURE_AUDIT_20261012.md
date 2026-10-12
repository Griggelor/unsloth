# PR #30: Independent architecture/QA audit (working evidence)

This document records code-reviewed invariants and exact-CI observations for draft QA PR #30. It is **not** a release approval.

## Review basis and restrictions

- Fork `Griggelor/unsloth`, branch `qa/agent-history-main-sync-20261012`, started at `b403fcef7165dc3b3862e3b996de4c67b3422288`.
- Evidence: `agent-history-mode-store.ts`, `agent-history-preference-policy.ts`, `agent-history-scroll-messages.tsx`, `agent-history-scroll-window.ts`, `agent-history-navigation.ts`, `use-intent-aware-autoscroll.tsx`, `thread.tsx`, and actual CI job logs.
- No changes to upstream, main, releases, security baselines or Windows hardware testing.

## Decision ownership

| Decision / invariant | Canonical owner | Downstream consumers |
| --- | --- | --- |
| Persisted per-chat/global choices | `agent-history-mode-store.ts` (Zustand persistent state) | preference policy |
| Effective mode / active vs off | `agentHistoryLevelFor` in `agent-history-preference-policy.ts` | `agentHistoryEnabledFor`, `thread.tsx`, menu |
| 5/32 row limit | `agentHistoryWindowFor` / buffer policy | virtual renderer |
| Mounted [start,end), candidate target and staged expansion | `agent-history-scroll-messages.tsx` | DOM rows / spacers |
| Height ledger and index mapping | `AgentHeightIndex` in `agent-history-scroll-window.ts` | virtual renderer |
| Dynamic per-row descendant estimates | `AgentDomCostIndex` / `agentBudgetWindow` | dynamic policies |
| Authorized reader epoch / search reveal | `agent-history-navigation.ts` | virtual renderer |
| Physical `scrollTop` writes and bottom-follow policy | `use-intent-aware-autoscroll.tsx` | renderer navigates via shared context |

## Finding A: duplicate enable decision (reproduced by source truth table)

**Severity: Medium (latent inconsistent API).** Before remediation, `agentHistoryEnabledFor` checked only legacy maps/global enabled while `agentHistoryLevelFor` also read explicit per-chat modes. `{globalEnabled:false, domLevelByThreadId:{x:"dynamic-high"}}` produced `enabledFor(x)=false` but `levelFor(x)="dynamic-high"`. Renderer currently uses `levelFor`; no directly reproduced wrong rendered result from this mismatch. The policy helper now derives enabled from the resolved mode. The legacy fallback in `levelFor` does not recurse through the public helper; the old v1 semantics are preserved. Table-driven unit tests cover explicit modes, global state, legacy opt-in, off and precedence collisions. Pending behavioral CI on the new SHA.

## Finding B: focused browser test coupled to Radix menu (reproduced)

**Severity: Medium (coverage obstruction).** On SHA `2ec153b...`, focused menu job 115016456336 timed out in `Locator.focus` after the submenu element detached. On SHA `cb1539d...`, new blocker job 115021231668 timed out waiting for the submenu before `fixed-low`; its diagnostic reported parent expanded=false, zero menus and 32 legacy rows. Neither failure proved the scrollbar post-drag invariant. The focused `--critical-scrollbar-only` path now seeds real persisted settings per chat then runs the same heavy-DOM and native-mouse tests in both dynamic modes. The original comprehensive menu E2E is retained and must still pass before release. CI pending.

## Finding C: scroll gesture vs layout owner (production-path risk)

**Severity: High until E2E proven.** A native Chromium scrollbar drag emits physical scroll changes but not necessarily DOM pointermove events during thumb capture. The prior one-epoch gating could leave mounted rows around the old index after scrollTop moved. Commit `2ec153b...` reconciles on physical pointer release using the existing navigation owner, without direct `scrollTop` healing. The separate browser model reproduced blank-before/visible-after; this is **not yet production E2E evidence**. Mandatory: physical thumb moves; a row intersects viewport without wheel; stable row top within 5 px after 650 ms; all four modes and search retain their separate gates.

## Finding D: startup budget (measured, open)

**Severity: High as required gate.** Exact SHA `cb1539d...` blocker job 115021231391: `npm run typecheck` and `npm run build` succeeded. `bundle:check` failed: eager raw 6533.5 KB vs 6531.1 KB, compressed transfer 1963.6 KB vs 1960.1 KB. The budget has not been increased. Evaluate eager dependency graph before any lazy split; do not claim pass.

## Finding E: Windows stale page (open; separate failure class)

**Severity: High as release gate.** Historical Windows UI job 114999334041 reached `[ui] closing the stale page` following successful authentication rotation and was stopped by the 540s watchdog. `tests/studio/playwright_chat_ui.py` matches fork-main blob at that historical HEAD, so this failure must not be attributed automatically to Agent History. The standalone Windows auth lane must run on final SHA; no evidence yet of a Windows OS-level hard freeze.

## Persistent architectural questions

1. Legacy `enabledThreads/disabledThreads` may coexist with `domLevelByThreadId`; the documented precedence is explicit per-chat mode first. The boolean selector must never implement a competing precedence. Evaluate UX of legacy on/off toggles for per-chat explicit modes before changing store mutations.
2. Separate menu E2E, pure policy contracts, native-scrollbar E2E, performance and Windows auth into distinct failure domains; avoid masking one via a successful test in another.
3. Preserve single `scrollTop` writer, bounded range, persistent transcript, native drag behavior, and the baseline startup budgets.
4. Review the complete security audit and Windows WebView2 behavior separately. Neither a green Linux browser run nor a built EXE constitutes release approval.

**Verdict: NOT READY — CI and manual gates outstanding.**
