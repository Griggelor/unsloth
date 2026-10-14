# Working-Phases Windows Testbuild (2026-10-14)

QA-only and unsigned. No changes to main, PR #33 or source branches.

Numbered elapsed phases shown while assistant-ui message is running and empty:

1. Working 1 – messages and tools prepared, count = current outbound messages.
2. Working 2 – first local history autosave awaited, count = outbound request messages.
3. Working 3 – server/Python admission, context prep or queue awaited, count = outbound request messages.
4. Working 4 – context fit boundary reported, archive followup may still be pending.

These are actual client phase boundaries, NOT claimed to be detailed internal Python progress. Message counts are not token counts. The backend tracing added on the diagnostic experiment branch can time exact whole-history tokens, archived turn scans, chunking and embedding if the backend process has UNSLOTH_CONTEXT_PERF_TRACE=1.

Only the special Windows workflow enables VITE_CONTEXT_PHASE_DEBUG=1. The default app has its ordinary Working... indicator. UI debug fields contain no private message content.

Artifact: an unsigned debug Tauri exe with a commit and SHA256 manifest, not a production installer. Reproduce with a separate test profile, correlate visible time and backend log time. No Windows timing claims until the actual test.