# Context latency experiment — skeptical review, 16 October 2026

Isolated diagnostic branch based on upstream commit 983226fa739a3d00836d4d77b94390bebe144781. Do not merge into the R6V3 virtual-history PR #14001 or fork main. This branch makes no inference, compaction or persistence behavior changes.

## What was actually observed

The previous Windows run showed roughly 16 minutes 29 seconds (11:16:56–11:33:25) before the first large llama.cpp request, within about 22 minutes of Working. Around 32 full-history message writes and 32 message-count requests were seen, some with 8–14 second server waits. There was then a prompt of approximately 144,801 tokens and 187 seconds of llama.cpp work. These are one-run external observations, not an attributed backend profile. Model-load requests do not carry the full chat history.

## Why the earlier candidate fixes require skepticism

- The old checkpoint-delta planner reduces HTTP payload bytes, but hashes, UTF-8 encodes and serializes EVERY old message during EVERY checkpoint. CPU and transient frontend allocations are still proportional to complete history. The advertised ~848 byte delta against ~40 MB is network measurement, not elapsed latency. It has no durable server revision, needs cross-tab and crash/restart reconciliation, and can send up to 32 sequential per-message writes.
- The early exact-prefix probe remains disabled by default. Exact token counts are not generally prefix-monotonic across exotic chat templates and tool schemas. Substituting a prefix token count for a full prompt count can change the compaction boundary and diagnostics. Do not enable without parity with the real model tokenizer.
- Archive indexed matching improves exact anchors but all-tool-call turns fall back to full position scans, and repeated or fuzzy tool-call arguments can be expensive. Existing parity tests do not establish worst-case scalability.
- CPU synthetic token counters and Linux SQLite surrogate/production helper benchmarks do not reproduce Windows WebView CPU, Pydantic validation, llama-server apply-template/tokenize, embedding and SQLite contention. Green CI is not Windows runtime proof.
- The old opt-in phase trace has good checkpoint/archive spans but lacked end-to-end HTTP upload/validation/response envelopes on current upstream. Old combined QA branch is hundreds of upstream commits behind.

## Diagnostic instrumentation on current upstream

Set UNSLOTH_CONTEXT_LATENCY_TRACE=1 in the Studio Python backend environment before launch and restart. Default OFF. A transparent ASGI middleware times selected model-load, chat-sync, chat-count, chat-read and generation request classes from Python receipt through request body completion, response headers, first response-body frame and end. It logs only random per-request ID, constant endpoint class, HTTP status, byte totals and elapsed milliseconds. First SSE frame is NOT necessarily first model token.

Additional synchronous timers measure SQLite sync, message upsert, list and branch counts; checkpoint original/replay/reset/no-carry exact token counts; rolling exact counts; and whole conversation archive. Nested timer durations overlap; do not sum them. Logs omit prompts, contents, headers, URLs, thread IDs, model names, user paths, private identifiers and exception messages. Request bodies are neither read ahead nor replayed.

## Windows reproduction plan

1. Capture client-side Send and model-load timestamps, request dispatch, backend receive, upload complete, HTTP headers, and first actual llama prompt/prefill/token. Compare a short fresh conversation to the long agent branch with the same model/context/tools.
2. If delay is before backend begin, investigate frontend hashing/serialization, WebView main-thread stalls and previous in-flight saves. If between backend begin and upload completion, investigate transport/body framing. If upload finishes but headers lag, examine DB spans vs Pydantic/queue time.
3. If SQLite count spans are short despite slow chat_counts HTTP, do not rewrite SQL. If checkpoint initial exact count dominates, evaluate bounded active-window with mandatory final exact full-template count. If archive dominates, profile embedding, matching and DB writes.
4. Repeat several times on the same Windows setup; turn the flag off after diagnosis.

Limits: No frontend instrumentation or real Windows E2E replay in this commit. No proof that 16:29 is solved. No early-prefix optimization or delta persistence has been enabled.