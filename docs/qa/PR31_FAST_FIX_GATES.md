# Independent PR #31 — focused QA runs for PR #30

The test-only workflow `.github/workflows/qa-pr31-fix-gates.yml` lives on the separate fork branch `qa/agent-history-pr31-fast-gates` based on main. It has no application code changes and cannot modify PR30, main or upstream.

Each independent job resolves the current DRAFT PR30 head SHA at **job start** using read-only GitHub API, verifies its fork and branch identity, checks out that SHA, and logs it. After fixing PR30, select an individual job in GitHub Actions and **Re-run jobs**. This retrieves the new PR30 HEAD without a new PR30 commit or its many CI triggers. Results from different SHAs must not be treated as an all-green release gate.

Dedicated parallel lanes: policy/scroll intent/DOM/lazy-import source contracts; real Chromium native thumb high/low + heavy DOM/anchor stability; TypeScript build and **unchanged** startup bundle budgets; Windows chat auth, password rotation, stale-page teardown. Full four-mode Radix menu/search E2E remains a separate known block in PR30's focused suite until its own dedicated lane is added; none of these lanes claim its pass. The Windows job is slower, but not a dependency of the fast jobs.

This workflow triggers on a `push` changing only this workflow file on its own branch; not on PR events. Opening PR31 can still cause existing globally enabled `pull_request` workflows to run **once**; this new file cannot disable other workflows. Workflow-dispatch cannot start a workflow that exists only on a non-default branch, hence the push trigger and per-job rerun.

PR30 `494a8a1bfd91a9d0b23b3126b18e49957bf9592b` native physical-thumb E2E passed job 115027936485; frontend budget failed job 115027936542: 6533.4 KB raw / 1966.8 KB transfer (limits: 6531.1 KB / 1960.1 KB). The baseline limits stay unchanged.

Both PR30 and PR31 remain DRAFT. No merge, release, or automated Windows hardware lock tests without explicit consent.
