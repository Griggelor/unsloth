# Stage 2 — Conversation-archive pre-inference latency investigation

Status: isolated **QA research**; not shipped, not approved for production; public issue #14519 intentionally not updated.

## Established evidence

- Real Windows Studio profiling (Oct 21, 2026): generation waits in
  `_archive_and_recall -> archive_turns -> encode_with_identity -> SentenceTransformer.encode`.
  CPU remains active after Chat Stop on the affected release.
- Original archiving OFF removes the observed pre-inference stall in the affected chat.
- Synthetic 40-turn Windows QA baseline for PR #14546: 80 archive docs / 320 embedding
  chunks, with **96 chunk_pages calls** and **26,256 token-counter calls** across
  initial work plus follow-up, because the 256-chunk cap is applied *after* all
  outstanding groups are chunked again. Stage 1 batching permits cooperative
  Stop only between embedding batches.
- The test uses a randomly initialized small BERT, not the user's installed
  embedding model or 823-MB studio.db. It does *not* reproduce the 9–16-minute
  wall time or end-to-end HTTP/llama.cpp prefill delay.

## Source-level bottlenecks

1. `conversation_archive.archive_turns` in PR #14546 creates chunks for **all** missing
   groups before the cap, so deferral causes avoidable future re-tokenization.
2. `chunking._split` recursively calls a text token counter for many separators
   and pieces. The ST counter repeatedly acquires the compute mutex, fetches the
   model tokenizer, and toggles `TOKENIZERS_PARALLELISM` per call. This is
   measured in the synthetic benchmark as 21,880+ calls even at 40 turns.
3. `_archive_and_recall` invokes archive synchronously on the generation path,
   so limiting work per request does **not** make prefill independent of embedding.
4. `_transcript_positions` loads the persisted transcript and `_occurrences`
   searches its positions per group. Synthetic BERT QA explicitly bypasses the
   persisted transcript mapping. Its long-thread complexity remains unmeasured.
5. Cancellation is cooperative: a single `SentenceTransformer.encode` batch
   or a single `chunk_pages` call can still occupy CPU until it returns.

## Implemented in this isolated QA branch

- Enforce the chunk budget incrementally **during** preparation, instead of
  first tokenizing all outstanding groups.
- Poll Chat Stop between the preparation of individual groups.
- Preserve deduplication and **restamping of later already-archived groups**
  after the chunking budget is exhausted, without tokenizing deferred new groups.
- Keep group writes atomic, idempotent, and deferred rather than discarding work.
- Regression tests cover early cap, stop during preparation, preservation
  of later archived entries, PR cancellation and capped continuation.
- CI runs the complete conversation archive suite and a 4-thread Windows CPU-BERT
  benchmark. Refer to the workflow run for **actual** status; never infer success
  merely from a committed test.

## Required follow-on experiments

1. On the same Windows runner, compare stage-1 against stage-2: initial
   `chunk_pages` calls, token-counter calls, preparation CPU/wall time, and
   time to first embed. Analyze runner variance separately from work reduction.
2. Vary `RAG_ARCHIVE_EMBED_MAX_CHUNKS`: 16 / 32 / 64 / 128 / 256. Record initial
   prefill delay, number of deferred requests, total archive time, and recall
   coverage. A lower cap trades immediate retrievability for responsiveness.
3. Measure typical and worst-case text uniqueness to evaluate a bounded
   tokenizer-count cache. Avoid cross-embedder stale cache values.
4. On a separate Windows QA deployment, generate fully synthetic 100 / 500 /
   1000-turn agent chats using the *actual* installed embedding model; measure
   duration from prompt submission to llama prefill, Stop-to-idle latency, and
   pending archive completion. Never read/copy the user's production databases.
5. Test thread deletion, branch rewind, concurrent requests, embedder changes,
   and crash/restart during deferred work.

## Genuine nonblocking architecture — NOT YET IMPLEMENTED

For guaranteed short time-to-prefill, a **durable pending-archive queue** is likely
needed. It must atomically capture evicted turns before they leave the context,
with thread/scope IDs, branch revision, content digest, and embedding identity.
A lower-priority worker could embed in short batches, yield to inference, and
commit complete groups idempotently. Stop should pause active work without losing
durable pending history; thread deletion must tombstone/cancel the queue and
prevent deleted data from being resurrected.

The model must not silently lose recalled history while pending embeddings are
unfinished: the product needs an explicit consistency policy (bounded synchronous
fallback, pending-text retrieval, or delayed availability surfaced to callers).
Unbounded fire-and-forget tasks are not a safe substitute.

**No prod release or Windows installation is justified until this semantic
contract and real-device measurements are verified.**
