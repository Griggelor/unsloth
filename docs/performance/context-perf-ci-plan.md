# Context performance experiment — independent of PR30

Status: **Phase 1: reproduce and measure**, no product code changes.

## Scope and immutable baseline

- Experimental branch: `experiment/context-perf-ci-20261013`, fork `Griggelor/unsloth`.
- Branched from upstream `fa168bbf4de9abf5d75b4837d5fc44ea0454ec77`, not from PR30.
- Do not merge, push, or retarget PR30 or fork main from this work.
- User observation (Windows): repeated 20.5 MB PUT messages; one request 5.81 s upload,
  13.54 s server waiting, and 0.095 s download (total 20.28 s).
  Tiny POST `/api/chat/messages:counts`: 11.47 s server wait. These are user-observed
  **client timings**; they do not establish an individual server bottleneck.
- Estimate of ~10M history tokens is the user's order-of-magnitude estimate, not
  a measurement of exact model tokens.

## CI matrix — evidence labels matter

`context-perf-experiment.yml` runs independently on experiment-branch pushes.

1. Python 3.11 + 3.13: deterministic tests calling *actual* production
   `core.inference.context_window.fit_rolling_context` and
   `core.inference.checkpoint.fit_checkpoint_context`. Guards cover: short
   contexts, overflow, repeated counting, preserving latest user/system,
   nonmutation, deterministic output, oversized-message refusal, counter
   errors, protected message set, replay and window growth.
2. CPU-only scale matrix: synthetic histories at 1k, 32k, 200k, 1M and 10M
   **estimated** tokens, using approximately four UTF-8 bytes per synthetic token.
   Measures call counts, number of content bytes visited by injected counter,
   fit wall/CPU time and resulting history size.
3. A separately labeled Python JSON/SQLite *surrogate* for full-snapshot
   serialization/upsert/readback. It is not the production FastAPI endpoint.
4. Source-pattern observations on the current checkout: full chat write/readback,
   frontend snapshot PUT, synchronous SQLite batch, exact prompt count,
   checkpoint count, llama-server counting endpoints and admission thread.

The test job's PASS means correctness on exercised production context-fit
functions; the scale job's PASS only means the measurements completed. It is
**not** a claim that latency is acceptable, a true model tokenizer was profiled,
or the Windows issue was reproduced end-to-end.

CI writes `context-perf-baseline.json` as an Actions artifact. Track each result
with its immutable commit SHA. Do not establish hard time budgets from a single
shared runner measurement or dismiss timeout as a passing assertion.

## Follow-on reproducibility work (separate commits)

**P1 — instrument production, opt-in and zero user content in logs**:

- Frontend: send click, outbound message serialization start/end, request dispatch.
- Backend: FastAPI request receive; Pydantic validation; queue admission wait;
  context-fit start/end; each `count_chat_tokens` / `apply-template` / `tokenize` /
  `input_tokens` call; archive/retrieval; POST to llama-server; first byte and
  first model token.
- Persistence: sync entry, SQLite BEGIN IMMEDIATE wait, serialization,
  executemany, inventory updates, commit, full readback, response encoding;
  count endpoint start/end.
- Correlate request IDs end-to-end. Store only counts, bytes and timing;
  no prompt, tool-output, attachment or private path values.

**P2 — architecture fix after a confirmed bottleneck**:

- Separate complete durable transcript from active generation window. Preserve
  system/developer instructions, newest user turn, atomic tool exchanges,
  branch/fork semantics, checkpoint carry-forward and historical recall.
- Bound active window *before* any exact per-turn admission count.
  Tokens, not message count; use conservative budgeting plus mandatory final
  exact template/tokenizer verification. Respect physical `n_ctx`, output
  reserve, tool schemas and multimodal token allowances.
- Avoid context shifts every turn: stable checkpoint boundary with headroom;
  validate llama.cpp KV-prefix reuse.
- Persistence: replace blanket full-snapshot autosaves with per-message/delta
  writes where semantics allow; keep explicit full-sync for migration/fork/delete,
  with a small acknowledgement (version/hash/count) and idempotence.
- Safeguard cross-tab concurrent editing, research/generation ownership,
  parent links, pruning, attachment inventories and rollback integrity.
- Invalidate caches upon edits, branch switches, tokenizer/template/tool catalog
  changes, model reload, and changing context sizes.

**P3 — independent regression / metamorphic suite before release**:

- Same last turn, 10M vs 200k archived history: bounded request-body size and
  bounded exact-count work; unchanged correct active context.
- Ordering, edits, re-generations, forks, tool call/result pairing and failure
  during archive/index writes; no lost transcripts or silent changes in answers
  from the available context.
- Same prompt twice: stable prompt prefix and expected KV hits on a real
  local llama-server (self-hosted GPU/Windows test; not claimed by CPU CI).
- Production HTTP + SQLite integration (not surrogate), concurrent clients,
  migration and read-after-write behavior. Test both new and legacy paths.
- Fixed-schema evidence matrix: requirement → test → real production path →
  measured result → limitation. Gate on correctness; performance thresholds
  only after multiple fixed-runner baseline runs.

## Commands

```bash
python -m unittest discover -s studio/backend/tests/context_perf -p 'test_*.py' -v
python studio/backend/tests/context_perf/bench_context_perf.py --out context-perf-baseline.json
# Optional faster local preliminary run:
python studio/backend/tests/context_perf/bench_context_perf.py --quick --out quick.json
```
