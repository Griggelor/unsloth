# GGUF Prefill / Conversation Recall Fastpath (QA, 2026-11-13)

## Symptom and evidence
The Rulith Qwen3.8 Flash-Next 262144-token run showed seven forced full prompt
reprocessings after new user turns. The old/new tokenized prompts shared only
2061–7089 tokens while the earliest available checkpoint was at position 8191
(8192 tokens). The active 6144 MiB cache kept only one large checkpointed prompt.
This is **not resolved by increasing --cache-ram**.

Each such transition also followed a synchronous `Conversation recall: 4 earlier
passage(s)` event. This is correlation, not proof that retrieval itself caused
the first differing token. Rolling/checkpoint replay, changing tool catalogues
and synthetic recall can each change the prefix.

## Proposed isolated mitigation
Set the Windows user-level environment variable
`RAG_CONVERSATION_AUTO_RECALL=0`. Then restart Unsloth Studio completely.

* Skip **automatic** archival retrieval/synthetic `search_conversation` exchanges.
* Preserve existing archived turns, indexing of newly evicted turns, and the
  explicit `search_conversation` tool when the model needs an older fact.
* Stop emitting the corresponding `Recalling earlier conversation` status.
* Remove the automatic recall-token reserve from the fit budget.
* **Does not stop synchronous archiving** on eviction. `archive_turns` may still
  calculate embeddings and delay a model request. Other `working`/compaction
  status messages may therefore remain.
* Does **not** disable document RAG, manual search, or background archiving.

The default is still `1`, preserving upstream behavior for every other user.
These environment variables have no effect on an **unpatched** Unsloth backend.
The frontend-only R6V3/browser EXE cannot deploy this Python/backend change.
Verify `contextPolicy` in saved Studio chat settings: an explicit `rolling`
setting overrides the Windows `UNSLOTH_CONTEXT_POLICY=checkpoint` variable.
To compare against baseline, set the variable to `1` and restart.

PowerShell (run once; applies to **new** processes):
```powershell
[Environment]::SetEnvironmentVariable('RAG_CONVERSATION_AUTO_RECALL','0','User')
[Environment]::SetEnvironmentVariable('UNSLOTH_PROMPT_PREFIX_DIAG','1','User')
```

## Private-data-safe prompt diagnosis
When `UNSLOTH_PROMPT_PREFIX_DIAG=1`, the backend emits
`prompt_prefix_diag` lines for each GGUF model request, including:
- Hashed thread identity and request phase (`plain`, `agent`, `final`)
- Lower-bound common **JSON character** prefix in 1024-character blocks,
  compared only against the *same phase* of the previous call
- Sample length and sample-capped flags (not total prompt length)
- Boolean change of the tool catalogue

The same optional diagnostic logs `context_policy_diag` (requested/candidate
Checkpoint/Rolling; the actual fit may fall back), `context_fit_diag`
(compaction state and before/after token counts), and
`conversation_archive_diag` with separate `evicted_archive` and `auto_recall`
wall-clock durations and counts, without message content. The archive duration
includes scheduling and synchronous embedding, not just database writes.

The first 131072 JSON characters are hashed for comparison, not stored as text;
the diagnostic keeps at most 72 prior thread/phase samples in RAM. Streaming
JSON serialization stops once this sample cap is met (an unusually large single
string may still be temporarily encoded by Python). A character boundary is
**not** a GGUF token position and does not include all template-side changes.
Tool definitions are hashed separately. Compare with Rulith's measured `lcp`
and checkpoint traces before attributing a full-prefill to a specific cause.
Disable the flag after testing. No raw messages, retrieved passages, tool
arguments, or page contents are written to logs by this diagnostic.

## Additional engine-side A/B test (not applied automatically)
Rulith created its first checkpoint after an 8192-token prefill batch. In a
**separate** run, test `--ubatch-size 2048` and
`--checkpoint-min-step 2048`, keeping `--ctx-checkpoints 8`, and confirm
the engine actually saves a checkpoint before each 2061–7089-token divergence.
A smaller microbatch may reduce prefill throughput and may not affect every
checkpoint policy. **Crucial:** a checkpoint at 2048 can at best reuse the
initial 2k–7k matching tokens; it does NOT avoid re-evaluating the remaining
120k–180k changed suffix. The primary fix still requires stabilizing the
rendered prefix through context replay / tool-catalogue transitions.

## Acceptance checks
1. Run full chat with same tool catalogue for 10+ user turns.
2. No synchronous forced conversation-recall status with auto recall disabled.
3. `search_conversation` can still retrieve a *newly* evicted message.
4. Verify `conversation_archive_diag` reports archive duration while no
   `auto_recall` phase occurs when disabled. Check whether the UI's generic
   `working` status still comes from compaction or archiving.
5. Compare `prompt_prefix_diag` **same-phase** samples with Rulith `lcp`.
6. Run the 10+ turn long-chat Rulith test (262k context) and document forced
   full-prefill counts and token cost. Only then claim any performance fix.

This patch is **QA-only** and independent of the virtualization/browser EXE
branch. Do not overwrite a working deployment before test results exist.
