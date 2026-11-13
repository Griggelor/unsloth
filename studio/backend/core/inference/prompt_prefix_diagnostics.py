# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Opt-in content-free diagnostics for GGUF prompt prefix instability.

Only SHA-256 digests of fixed-size chunks are retained. No user messages,
tool descriptions, URLs or retrieved passages are written to logs.
A character boundary is not a llama.cpp token position.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import OrderedDict

_LOG = logging.getLogger(__name__)
_CHUNK = 1024
_MAX_CHARS = 131072
_MAX_THREADS = 24
_LOCK = threading.Lock()
_PREVIOUS: "OrderedDict[str, tuple[tuple[bytes, ...], int, str]]" = OrderedDict()


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":"))


def record_prefix(thread_id: str | None, messages: list[dict], tools: object = None, *, phase: str = "agent") -> None:
    """Approximate the unchanged prefix between consecutive requests for this thread."""
    if not thread_id:
        return
    thread_tag = hashlib.sha256(thread_id.encode("utf-8", "replace")).hexdigest()[:12]
    serialized = _json(messages)
    sample = serialized[:_MAX_CHARS]
    digests = tuple(hashlib.sha256(sample[i:i + _CHUNK].encode("utf-8", "surrogatepass")).digest()
                    for i in range(0, len(sample), _CHUNK))
    tool_tag = hashlib.sha256(_json(tools).encode("utf-8", "surrogatepass")).hexdigest()[:12]
    with _LOCK:
        previous = _PREVIOUS.get(thread_tag)
        _PREVIOUS[thread_tag] = (digests, len(serialized), tool_tag)
        _PREVIOUS.move_to_end(thread_tag)
        while len(_PREVIOUS) > _MAX_THREADS:
            _PREVIOUS.popitem(last=False)
    if previous is None:
        _LOG.info("prompt_prefix_diag thread=%s phase=%s first_sample=1 chars=%d tool_hash=%s",
                  thread_tag, phase, len(serialized), tool_tag)
        return
    prev_chunks, prev_len, prev_tool_tag = previous
    matched = 0
    for old, new in zip(prev_chunks, digests):
        if old != new:
            break
        matched += 1
    stable_floor = min(matched * _CHUNK, prev_len, len(serialized))
    _LOG.info(
        "prompt_prefix_diag thread=%s phase=%s stable_prefix_chars_floor=%d "
        "old_chars=%d new_chars=%d tools_changed=%s capped_sample=%s",
        thread_tag, phase, stable_floor, prev_len, len(serialized),
        prev_tool_tag != tool_tag, int(len(serialized) > _MAX_CHARS),
    )
