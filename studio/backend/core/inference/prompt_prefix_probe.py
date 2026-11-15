# SPDX-License-Identifier: AGPL-3.0-only
"""Opt-in, local-only token prefix probe for llama-server chat requests.

NEVER records rendered prompts, token IDs, message contents, or their hashes.
The previous token stream is held only in process memory for LCP comparison.
This is a diagnostic, not a cache hit predictor: Rulith decides cache reuse.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)
_LOCK = threading.Lock()
_LAST: dict[str, dict] = {}


def common_prefix_tokens(left: list[int], right: list[int]) -> int:
    """Length of the identical leading sequence of real tokenizer IDs."""
    return next((i for i, (a, b) in enumerate(zip(left, right)) if a != b), min(len(left), len(right)))


def _fingerprint(value: object) -> bytes:
    # Only compared in RAM; never emitted in an event or persisted.
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode()).digest()


def _template_body(payload: dict) -> dict:
    """Match the supported /apply-template fields of count_chat_tokens."""
    body = {"messages": payload["messages"]}
    for key in (
        "tools", "tool_choice", "parallel_tool_calls", "response_format",
        "chat_template_kwargs", "continue_final_message", "add_generation_prompt",
    ):
        if key in payload:
            body[key] = payload[key]
    return body


def _local_endpoint(base_url: str) -> bool:
    try:
        parts = urlsplit(base_url)
        return parts.scheme in ("http", "https") and parts.hostname in ("localhost", "127.0.0.1", "::1")
    except ValueError:
        return False


def observe_chat_payload(payload: dict, *, base_url: str, headers: dict, verify: object) -> None:
    """Probe the actual outbound payload before streaming, only if explicitly enabled.

    Adds two localhost-only HTTP requests (/apply-template and /tokenize). Both
    can delay generation; record probe duration and DISABLE after diagnosis.
    All failures are nonfatal. Do not invoke for non-chat or remote backends.
    """
    if os.environ.get("UNSLOTH_PROMPT_PREFIX_PROBE") != "1":
        return
    if not isinstance(payload.get("messages"), list) or not _local_endpoint(base_url):
        return
    request_id = uuid.uuid4().hex
    started = time.monotonic()
    event = {"event": "prompt_prefix_probe", "request_id": request_id, "schema": 1}
    try:
        body = _template_body(payload)
        # An independent client prevents the probe from changing stream lifetime.
        with httpx.Client(
            timeout=httpx.Timeout(connect=5, read=30, write=30, pool=5),
            headers=headers,
            trust_env=False,
            verify=verify,
        ) as client:
            rendered = client.post(f"{base_url}/apply-template", json=body)
            rendered.raise_for_status()
            prompt = rendered.json().get("prompt")
            if not isinstance(prompt, str):
                raise ValueError("missing rendered prompt")
            after_render = time.monotonic()
            tokenized = client.post(
                f"{base_url}/tokenize",
                json={"content": prompt, "add_special": True},
            )
            tokenized.raise_for_status()
            token_ids = tokenized.json().get("tokens")
            if not isinstance(token_ids, list) or any(type(x) is not int for x in token_ids):
                raise ValueError("invalid tokenizer response")
        after_tokens = time.monotonic()
        signatures = tuple(_fingerprint(m) for m in body["messages"])
        tools_signature = _fingerprint((body.get("tools"), body.get("chat_template_kwargs")))
        endpoint_key = base_url  # never emitted: may contain private port/path
        with _LOCK:
            previous = _LAST.get(endpoint_key)
            if previous is None:
                event.update(previous_tokens=None, lcp=None, first_different_token=None,
                             first_changed_message=None, tool_manifest_changed=None)
            else:
                lcp = common_prefix_tokens(previous["tokens"], token_ids)
                a, b = previous["signatures"], signatures
                changed = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
                event.update(
                    previous_tokens=len(previous["tokens"]),
                    lcp=lcp,
                    first_different_token=lcp if lcp < max(len(previous["tokens"]), len(token_ids)) else None,
                    first_changed_message=changed if a != b else None,
                    tool_manifest_changed=previous["tools_signature"] != tools_signature,
                )
            _LAST[endpoint_key] = {
                "tokens": token_ids, "signatures": signatures, "tools_signature": tools_signature
            }
        event.update(status="ok", prompt_tokens=len(token_ids), messages=len(signatures),
                     render_ms=round(1000 * (after_render - started)),
                     tokenize_ms=round(1000 * (after_tokens - after_render)))
    except Exception as exc:  # noqa: BLE001 -- diagnostics must never break inference
        # Log only the exception CLASS. Exception messages can contain server/PII text.
        event.update(status="unavailable", error_type=type(exc).__name__)
    event["probe_ms"] = round(1000 * (time.monotonic() - started))
    logger.info("prompt_prefix_probe %s", json.dumps(event, sort_keys=True))
