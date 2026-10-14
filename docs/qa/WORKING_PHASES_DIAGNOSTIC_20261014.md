# Working-phase QA diagnostic — 2026-10-14

Experimental, unsigned test build, not a release. Based on main-synced PR33 and separate indexed-archive experiment. The existing PR33 branch and main are untouched.

## UI
In a local GGUF **agentic tool loop**, the assistant's previous generic `Working...` is replaced with backend phase, message count and time since the last stage change:

- Working 1/5 · Agentenrunde · N Nachrichten
- Working 2/5 · Verlauf / Checkpoint-Zustand · N Nachrichten
- Working 3/5 · Kontext & exakte Tokenzählung · N Nachrichten
- Working 4/5 · Archivierung / Embedding · N Nachrichten
- Working 5/5 · Modellanfrage / Prefill · N Nachrichten

Round > 1 includes an additional round indicator. The count is the *source-message objects*, not tokens or processed archive chunks. Step 4 counts source messages removed by compaction, not live per-item completion. No fabricated progress percentages. A stage can remain displayed with a running elapsed clock while Python is blocked in a synchronous function.

Enabled by default **on this QA branch only**. Set `UNSLOTH_WORKING_PHASES=0` on the backend to disable. Separate opt-in `UNSLOTH_CONTEXT_PERF_TRACE=1` logs content-free wall-time and CPU-time of exact token count and archive subphases. Browser/normal no-tool GGUF requests are not yet given detailed stream phases; this is an explicit limitation.

The response must use an *agentic GGUF tool-loop* and `X-Unsloth-Events: 1`; no special frames are sent to external OpenAI API clients. UI metadata is diagnostic, not assistant text.

## Caveats
This Tauri debug EXE is unsigned, built without an installer and may need an independently working local backend; it is not proof of a standalone Python runtime. Test against an isolated Windows test profile, synthetic agent histories and a known backend source version. Do not replace or open your private production thread database just to diagnose the problem.

Pass criteria: exact-commit Windows workflow, clean Python syntax/unit checks, frontend build, artifact manifest and EXE SHA256; afterwards controlled Windows long-history replay must establish whether the time accumulates in exact count, archive matching, chunking/embeddings, queue admission or another phase. No 22-minute causality is claimed until that measurement.
