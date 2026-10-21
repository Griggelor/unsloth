# Synthetic conversation-archive CPU benchmark: frozen mainline vs legacy QA

Date: 2026-10-21. Related issue: https://github.com/unslothai/unsloth/issues/14519

## Exact source versions

- **Legacy:** `Griggelor/unsloth` QA commit `822631c340e54f50c2028110da3d253b4b48a978`, older backend approximately v0.1.909 phase.
- **Mainline:** exact official upstream main ancestor `36497673f7d55053e7f343834da195a5faa6466e`. On isolated fork branch `experiment/rag-mainline-embedding-hotpath-20261021` with synthetic QA-only commits.
- **Benchmark:** identical source bytes in `studio/backend/tests/context_perf/test_archive_embedding_hotpath_ci.py` for both versions, verified via SHA256 in CI.
- **CI:** https://github.com/Griggelor/unsloth/actions/runs/39644694290 (successful paired A–B–B–A benchmark).
- **Initial individual Windows CI:** legacy https://github.com/Griggelor/unsloth/actions/runs/39624113575 ; mainline https://github.com/Griggelor/unsloth/actions/runs/39643502338 .

## What was executed

Windows GitHub Actions runner; Python 3.13, CPU-only PyTorch, synthetic SentenceTransformer using a locally-generated small randomly initialized BERT, 4 Torch CPU threads. Simulated 8/40 agent turns with structured tool calls and long generated outputs. Real archive-turn chunking, `encode_with_identity`, `_st_encode`, `SentenceTransformer.encode`, and RAG-store write functions exercised. The benchmark bypasses persisted-transcript branch mapping (`_transcript_positions`) and does not execute a real GGUF model, HTTP requests or cancellation. No private data or model download.

Each run creates a fresh process, model and isolated databases. Four sequential pytest runs share one Windows runner and Python packages in order: **Legacy 1, Mainline 1, Mainline 2, Legacy 2**. Both parametric cases passed on each run.

## Paired observations (wall-clock milliseconds)

| Phase | Legacy 1 | Mainline 1 | Mainline 2 | Legacy 2 |
| --- | ---: | ---: | ---: | ---: |
| 8 turns: archive total | 698.960 | 726.333 | 716.675 | 692.532 |
| 8 turns: chunking | 434.762 | 451.218 | 449.446 | 432.788 |
| 8 turns: SentenceTransformer.encode | 120.977 | 118.796 | 120.574 | 122.149 |
| 40 turns: archive total | 3292.074 | 4981.275 | 3236.232 | 3260.503 |
| 40 turns: chunking | 2184.288 | 2723.643 | 2153.398 | 2176.893 |
| 40 turns: SentenceTransformer.encode | 483.947 | 539.553 | 482.741 | 482.912 |
| 40 turns: repeat archive, no embedding | 4.700 | 5.103 | 4.535 | 4.639 |

Each 8-turn execution had **32 messages, 16 archive documents, 64 embedding chunks, 4376 token counter invocations**. Each 40-turn execution had **160 messages, 80 documents, 320 chunks, 21880 token counter invocations**. The repeat archive generated no embeddings; `RAG_CONVERSATION_ARCHIVE=0` returned almost immediately.

The two legacy 8-turn runs averaged **695.746 ms**; mainline averaged **721.504 ms** (**3.70% slower**). The two legacy 40-turn runs averaged **3276.289 ms**. Mainline 40-turn #2 took **3236.232 ms**, just **1.22% faster** than the legacy average; mainline #1 took **4981.275 ms** and is an isolated large wall-time outlier. Counting that outlier, mainline 40-turn mean was **4108.754 ms**, **25.41% slower**.

## Interpretation

**There is no demonstrated reproducible performance improvement of the CPU archive-hotpath in the newer mainline under equivalent worker conditions.** In the separate single-run comparison, mainline appeared ~14% faster, but paired same-runner results do not reproduce that advantage. The 40-turn mainline #1 outlier is not yet root-caused; do not call it a product regression without more samples.

The original severe Windows repro (~17–18 busy logical CPUs and >9-minute prefill stall) is **not** recreated by the tiny synthetic BERT benchmark. This benchmark does establish the actual archive->chunker->embedding call chain and the scaling of work, but it does not reproduce the original wall-time severity or prove cancellation behavior. The PR #14098 archive matcher improvement is not measured because the persisted transcript position mapping was deliberately bypassed.

The mainline still performs synchronous `encode_with_identity` inside `archive_turns`; no direct cancellation signal exists at that call. Further dedicated regression tests should measure real batch size, generation cancellation after starting an embed, and full persisted-thread branch matching.

**No production installation or user data was modified.**
