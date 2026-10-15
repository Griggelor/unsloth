# Fork CI cleanup audit — 2026-10-15

Repository: `Griggelor/unsloth` (fork of `unslothai/unsloth`).
Baseline: read-only inspection of GitHub repository metadata, workflow files on `main`, all 5,830 listed workflow runs (100 per page), 79 branches and 24 open pull requests. Latest observed run: 2026-10-14 21:11:18 UTC. Counts are a snapshot; subsequent commits and runs change them.

## Decision

**Do not delete workflows, PRs, branches, artifacts, or run history on the strength of age or count alone.** The evidence points to a PR-event fanout under stacked experimental branches, not to 62 intrinsically redundant workflows. Start with a targeted fork-only CI policy and PR/branch dependency audit. Retain core security gates and production validation until coverage-equivalent replacements exist.

This audit PR changes documentation only. It performs no cleanup mutations, does not disable Actions and does not modify production code.

## Verified baseline

| Measure | Value |
| --- | ---: |
| Workflows in fork `main/.github/workflows` | 62 |
| Workflows in upstream `main/.github/workflows` | 63 |
| Fork workflow files identical by Git blob SHA | 22 |
| Fork workflow files different by blob SHA | 40 |
| Upstream-only workflow | `cancel-closed-pr-runs.yml` |
| Current branches | 79 |
| Open PRs | 24 (all Draft) |
| Workflow runs inspected | 5,830 |
| `pull_request` runs | 5,363 |
| `push` runs | 436 |
| `schedule` runs | 29 |
| `workflow_dispatch` runs | 2 |
| Runs cancelled | 3,297 |
| Runs successful | 2,071 |
| Runs failed | 348 |
| Runs skipped | 114 |

Run window: 2026-10-09 11:03:16 UTC through 2026-10-14 21:11:18 UTC. Approximately 92.0% of the runs were triggered by PR events, and approximately 56.6% were cancelled. **Cancelled is not equivalent to billed runner minutes**: individual run/job timing and billed usage were not audited.

### Where runs accumulated

| Head branch | Runs in this snapshot |
| --- | ---: |
| `qa/agent-history-main-sync-20261012` | 1,084 |
| `perf/chat-history-viewport-experiment` | 680 |
| `experiment/working-phase-ui-20261014` | 558 |
| `qa/agent-history-adaptive-dom-20261011` | 491 |
| `main` | 454 |
| `qa/agent-history-dom-budget-engine-20261012` | 443 |
| `qa/agent-history-four-buffer-modes-20261012` | 395 |

The seven branches above account for 4,105 of 5,830 observed runs. These are counts by `head_branch`, not necessarily counts of distinct commits or PRs. PR #34's head branch alone accounts for 558 runs in the full snapshot.

### Trigger audit of 62 fork workflows on main

- 46 have a `pull_request` trigger.
- 43 of those 46 have a `paths` or `paths-ignore` filter.
- Three have no PR path filter: `codeql.yml`, `lint-ci.yml`, `workflow-trigger-lint.yml`.
- Existing workflows frequently already have workflow-level `concurrency` controls; wholesale introduction of `cancel-in-progress` is **not** an evidenced fix.
- In particular, `workflow-trigger-lint.yml` explicitly documents why it must run on *every* PR without path filters. Its security coverage must not be diluted.
- `codeql.yml` intentionally scans on main and chooses changed languages on PRs, with fail-closed fallback.
- Many workflow paths trigger on `studio/frontend/**`, backend, shared test directories or workflow/config changes. Large mixed frontend/backend changes can therefore legitimately match many filtered workflows.

### PR dependency and preservation notes

- PR #30: main-based Agent History integration; 69 changed files.
- PR #33: main-based combined Agent History / context performance integration; 92 changed files.
- PR #34: based on `experiment/context-archive-indexed-match-20261013`, not on main; 17 changed files. Must not lose the base branch.
- PR #31: separate QA fast-gates experiment; 8 changed files.
- The other 20 open draft PRs include *stacked bases on other QA or experimental branches*, not just independent PRs into main. Closing/deleting their heads requires a reachability, branch-base and artifact/evidence check.
- All 24 PRs are Draft, which makes "gate everything on every intermediate push" especially expensive, but is not permission to bypass security or integration testing.
- Current branch listing includes historical `archive/` and `backup/` refs. Retain these until a separate retention decision with SHA inventory and proof that no active PR relies on them.
- Workflow files existing on experimental branches can differ from the 62 on main. The main-only inventory is **not** a complete historical workflow inventory.

### Upstream delta worth reviewing

Upstream includes `cancel-closed-pr-runs.yml`; the fork does not. Its upstream implementation reacts to PR closure, enumerates queued/in-progress `pull_request` runs and attempts ordinary cancellation (not force-cancellation); it requests scoped `actions: write` permission. Reintroducing it may help **after** PRs close, but it cannot reduce the large repeated fanout while experimental PRs remain open. Review before import rather than copying unexamined.

## Proposed fork-only execution model (requires a separate code PR)

| Lane | Trigger expectation | Purpose | Guardrails |
| --- | --- | --- | --- |
| Fast PR checks | all PR changes where relevant | workflow safety / static sanity / fast source tests | Keep security coverage; avoid broad bypasses |
| Focused QA | targeted branch pushes and/or manual dispatch | one experiment's browser/backend regressions | bounded matrix, timeouts, one workflow per experiment family rather than one-off workflow proliferation |
| Integration gate | candidate PR, ready-for-review transition, and/or explicit dispatch | full cross-platform, production-equivalent gates | mandatory before merge; preserve failure visibility |
| Release | explicit manual dispatch / tag as applicable | artifact build, validation and publication | separate release policy; keep provenance, integrity and signature checks |
| Upstream maintenance | reviewed schedules / selective branches | supply chain and maintenance workflows | fork opt-out only where clearly not useful |

**Prefer a pilot:** select 2-3 expensive QA-correlated workflows based on measured job minutes, not count alone. Move only their draft-PR heavy jobs behind reviewed conditions with a validated explicit dispatch path. Preserve the ability to run identical gates on candidate commits; do not treat `skipped` as a pass. This design is a proposal, not an applied change.

## Implementation stages and acceptance conditions

1. **Inventory and classification (this PR).** Account for 62 main workflow files, the 63 upstream comparison, all 79 refs, the open PR head/base graph, and complete run outcome totals. Complete at the workflow level before touching code.
2. **Usage and cost audit.** Collect billed minutes, job-duration distribution, matrix fanout, highest-cost runners and artifact storage from GitHub usage data. Run count alone is insufficient for a cost-saving claim.
3. **Small CI policy pilot.** Preserve all security checks and candidate-stage validation; route heavy tests to explicit/manual or ready candidate stage on selected workflows; maintain a documented dispatch mechanism for QA on Draft PRs.
4. **Validate.** Demonstrate CI run/job count difference for representative backend+frontend changes; green production-equivalent candidate run; negative tests for skipped/failed/in-progress behavior, workflow trigger paths and permissions. Confirm that no required branch-protection check becomes permanently absent.
5. **PR and branch cleanup, separately approved.** For each PR: record head SHA, base SHA, merge-base, unique commits, useful artifacts and successor PR. Close/archive only when superseded and evidenced. For each branch: preserve branches referenced by any open PR head or base, release, tag, or recovery checkpoint.
6. **Historical run/artifact retention, separately approved.** Define retention windows by QA vs release/audit and obtain retention/usage impact before deletion. Never delete the only evidence for a current test verdict.

## Preliminary disposition

**Keep unchanged in this PR:** all 62 production/main workflows, all 24 open PRs, all 79 branches, all run/artifact history; particularly security gates `workflow-trigger-lint.yml` and `codeql.yml`, and current work around PR #30, #31, #33, #34.

**Review for consolidation (not yet deletion):** one-off `qa/*` workflow variants on experimental branches, overlapping Windows/browser/compilation jobs, duplicate work across a rapid Draft PR stack, schedules irrelevant to a fork, upstream `cancel-closed-pr-runs.yml` import.

**Unknown until further evidence:** exact wasted compute minutes, whether failed runs are distinct regressions, which QA drafts are fully superseded by later candidates, which archived branches hold unique work, and whether any workflow is required by branch protection.

## Safety / sign-off rules

- No branch or PR deletion, bulk cancellation, disablement, merge, or release from this audit.
- Do not weaken security scans, authorization/permissions, artifact provenance or workflow-trigger controls.
- Do not declare a successful cleanup based solely on fewer green/red checks; compare semantic test coverage.
- Explicit owner approval required before closing PRs, deleting refs/runs/artifacts or applying any policy that suppresses a currently automatic validation.
