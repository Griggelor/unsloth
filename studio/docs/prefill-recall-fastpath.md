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
* Does **not** disable document RAG, manual search, or background archiving.

The default is still `1`, preserving upstream behavior for every other user.
To compare against baseline, set the variable to `1` and restart.

PowerShell (run once; applies to **new** processes):
```powershell
[Environment]::SetEnvironmentVariable('RAG_CONVERSATION_AUTO_RECALL','0','User')
[Environment]::SetEnvironmentVariable('UNSLOTH_PROMPT_PREFIX_DIAG','1','User')
```

## Private-data-safe prompt diagnosis
When `UNSLOTH_PROMPT_PREFIX_DIAG=1`, the backend emits
`prompt_prefix_diag` lines for each GGUF model request, including:
- Hashed thread identity, phase, and total serialized message length
- Lower-bound common **character** prefix in 1024-character blocks
- Boolean change of the tool catalogue

The first 131072 characters are hashed for comparison, not stored as text;
the diagnostic keeps a maximum of 24 prior-thread digests in RAM. A character
boundary is **not** an engine token offset; compare with Rulith's `lcp` and
checkpoint traces. Disable the flag after testing. No raw messages, retrieved
passages, tool arguments, or page contents are logged by this diagnostic.

## Additional engine-side A/B test (not applied automatically)
Rulith created its first checkpoint after an 8192-token prefill batch. In a
**separate** run, test `--ubatch-size 2048` and
`--checkpoint-min-step 2048`, keeping `--ctx-checkpoints 8`, and confirm
the engine actually saves a checkpoint before each 2061–7089-token divergence.
A smaller microbatch may reduce prefill throughput and may not affect every
checkpoint policy. This is an experimental tradeoff, not a guaranteed fix.

## Acceptance checks
1. Run full chat with same tool catalogue for 10+ user turns.
2. No synchronous forced conversation-recall status with auto recall disabled.
3. `search_conversation` can still retrieve an evicted message.
4. Compare `prompt_prefix_diag` and Rulith `lcp` across new user turns.
5. Document the count and token cost of forced full-prefills before claiming
   the original performance regression is fixed.

This patch is **QA-only** and independent of the virtualization/browser EXE
branch. Do not overwrite a working deployment before test results exist.
