# 22-minute context preflight: testable diagnosis

**Scope:** isolated diagnostic branch `experiment/context-preflight-22min-trace-20261013`, based on main-sync candidate. Main, PR30, context-perf source and PR33 integration **unchanged**.

## Verified code-path risks

1. `checkpoint.fit_checkpoint_context` performs an unconditional exact token count over `list(messages)` when `UNSLOTH_CONTEXT_EARLY_PROBE` is disabled (default). This occurs **before** dropping the old messages, even with many archived turns. `LlamaCppBackend.count_chat_tokens` renders the full chat through `/apply-template`, then posts the rendered text to `/tokenize`. Its synchronous HTTP, template encoding, token-array JSON response and Python processing can be expensive on enormous agent histories even when model decoding is idle. The impact on the reported 22 minutes is **not measured**.
2. `_archive_and_recall` synchronously calls `conversation_archive.archive_turns` after the fit. The archive loops over evicted turns, calling `_occurrences(positions, group)` and `_write_budget` with another occurrence search, and `chunk_pages`. `_occurrences` scans all saved transcript positions for each group: **potential O(number_of_evicted_turns × number_of_saved_turns)** before accounting for tool-call fuzzy matching. A first reset also runs embedding and repeated DB writes. These are plausible major sources of pre-inference CPU time.
3. Prior CI synthetic 10M-token checkpoint fit is <1s using **injected synthetic counts**, not actual GGUF tokenizer, archive/embedding, or Windows environment. Production SQLite synthetic 10M-token full sync <1s on Linux but not evidence against Windows contention. Do not equate UI Working… with exact server stage.
4. The benchmark's data are from `43f0d3abfdd9132b47910e987bc9058f6df16d9f`; they are not measurements of the local 22-minute run.

## Opt-in trace for controlled replay

Set **`UNSLOTH_CONTEXT_PERF_TRACE=1` on the Studio backend process before starting**; restart its backend. The flag defaults to **off**. Logs from the new code report only phase names, operation count, number of messages, wall and CPU milliseconds. No content, thread IDs, tool arguments, paths, model names, URLs or exception messages are added.

Expected phase labels:
- `checkpoint.original_exact_count` (the full-history count, including GGUF counting/HTTP)
- `checkpoint.replay_exact_count`, `checkpoint.reset_exact_count`, `checkpoint.no_carry_exact_count`
- `conversation_archive.archive_turns` total
- `load_branch_positions`, `match_evicted_turn`, `match_live_turn`, `chunk_turn`, `embedding_encode` (aggregate substage wall and CPU)

Measure alongside the **client-side timestamp for Working… → first token**, CPU process attribution, network calls to Studio and llama-server, and context-policy settings. The original processing duration can be attributed only after these segments have been correlated. Recording the total run and the delta between measured backend phases will surface time in request validation/queue admission/storage or other uninstrumented phases.

Do **not** enable early-prefix probe in the first diagnostic: it changes selection conditions. Test `UNSLOTH_CONTEXT_EARLY_PROBE=1` only later as an isolated semantic A/B after proving exact-message parity with the model's chat template and history branches.

All code changes are diagnostic only. No speedup, correctness of full archiving or Windows release is claimed until isolated tests and actual repro data are available.
