# P0 – Local GGUF prompt-prefix probe (diagnostic only)

Status: instrumentation and synthetic tests. No validated Windows/Rulith run and no final root-cause fix.

## Data handling

Probe insertion: LlamaCppBackend._open_stream after prepare_image_turn_boundaries,
immediately before the actual /v1/chat/completions request. It is disabled
unless the process environment contains UNSLOTH_PROMPT_PREFIX_PROBE=1.

Each captured request triggers two extra localhost HTTP calls:
1. /apply-template with the outgoing message, tool and template data.
2. /tokenize of the rendered prompt, with add_special=true.

The resulting token IDs and message fingerprints are held only in RAM for
comparison with the previous request. The log includes no message text,
tokens, URLs, credentials, or digest values. Non-loopback addresses are
refused even if the probe is enabled. The extra local requests may be slow,
so do not use diagnostic-on timings for performance baselines.

The probe measures the tokenizer-ID longest common prefix, not the actual
Rulith checkpoint restoration. Correlate with Rulith logs. Be aware the
auxiliary template and tokenizer endpoints can differ from the generation
endpoint in special-token handling.

## Isolated Windows test

Enable the variable for the specific Studio backend process. For example,
in a PowerShell session that launches the backend:

    $env:UNSLOTH_PROMPT_PREFIX_PROBE = '1'
    # Launch the usual local Studio backend from this same window.

A desktop launcher may require a persistent User variable plus full
restart. Do not change production settings casually.

Use synthetic long-chat history and one active chat. After a first
baseline request, run multiple new user turns and stable tool loops.
Search backend logs for lines beginning with prompt_prefix_probe. The
embedded JSON reports request_id, prompt_tokens, previous_tokens, lcp,
first_different_token, first_changed_message, tool_manifest_changed,
render_ms, tokenize_ms, probe_ms and status.

LCP 5,000 for a 120,000-token prompt shows an early tokenizer prefix
change. It does not alone prove why Rulith invalidated its hybrid cache.
The first_changed_message index is the earliest structurally different
message; tool_manifest_changed compares supplied tools and template kwargs.
The first request reports lcp=null. Two interleaved chats on one engine
share a comparison slot and can produce misleading LCP values: test one
isolated chat at a time.

Disable and restart backend after the diagnosis:

    Remove-Item Env:\UNSLOTH_PROMPT_PREFIX_PROBE -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable('UNSLOTH_PROMPT_PREFIX_PROBE', $null, 'User')

## Local tests

    python -m pytest studio/backend/tests/test_prompt_prefix_probe.py -q

These tests mock the localhost endpoints and cover token-ID LCP, disabled
probe, nonlocal endpoint protection and absence of private texts in logs.
They do not establish integration or fix effectiveness on Windows/Rulith.

## Required follow-up

1. On actual Windows/Rulith, verify auxiliary token counts and log privacy,
   then align diagnostic lines with engine warnings by timestamp/sequence.
   The probe request_id is not the engine's task_id.
2. Instrument pre-inference phase times separately for the 63–86 second
   backend delay; this probe does not measure that gap.
3. Run controlled synthetic A/B: recall on/off, checkpoint-block placement,
   tools stable/changed. Modify only one factor at a time.
4. Determine the first divergent token and the owner of that mutation.
   Only then create a structural fix and full production-path replay.
5. Leave the original private logs and handover archive outside GitHub.

Baseline observations and constraints are in the private
UNSLOTH_VOLLSTAENDIGE_UEBERGABE_2026-11-15.zip.
