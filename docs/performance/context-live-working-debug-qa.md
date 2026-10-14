# QA live phase display for long "Working..." requests

**Branch:** `qa/context-live-phases-windows-20261014`. Diagnostic-only; not a release or default production behavior.

The existing `Working...` placeholder is replaced (when the QA backend is running) by a periodically refreshed, human-readable status such as:

`Working 3 · Chat-Template und Tokenizer · 500 Elemente · 34 s`
`Working 7 · Archiv-Turns zuordnen · 260/500 Turns · 85 s`

Only short phase codes and numeric counters are exposed. Authentication is required; non-owner accounts receive 404. Progress is partitioned by authenticated account and is available in memory only, never persisted. Concurrent requests by the same owner are not individually distinguished; for accurate diagnostics run one chat at a time. The frontend periodically polls an independent lightweight endpoint, so it can repaint even while a worker thread is occupied, PROVIDED the FastAPI event loop and network remain responsive.

This QA branch turns the tracer on by default. `UNSLOTH_CONTEXT_PERF_TRACE=0` disables it and restores the original `Working...` UI. Do not merge this debug-default into production. Do not use untrusted/private production profiles for first runs. Browser and backend must run the **same QA source revision**, otherwise the backend probe will be unavailable or return no progress.

Interpretation:
- Phase 2: first whole-history exact checkpoint count.
- Phase 3: actual llama-server /apply-template + /tokenize HTTP cycle (llama generation can be idle).
- Phases 4-5: replay and final short-context counting.
- Phases 6-9: transcript scan/index, archived turn matching, chunking and embeddings.
- The message count is the size of the stage's input; processed/total are only shown for stages that support it.
- No phase response does NOT imply Python is idle. The startup, persistence and queue segments preceding exact counting still need client/backend correlation.
- Absence of a progress response must never block generation, or replace a genuine error.

This is a QA _measurement_ feature, not proof of a speedup or cure for the 22-minute symptom. Full Windows UI/browser and backend release gates are still required.
