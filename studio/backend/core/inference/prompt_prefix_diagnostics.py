# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Opt-in bounded diagnostics for GGUF prompt prefix instability.

Compares only the same request phase; JSON-character offsets are not llama.cpp
prompt tokens. Only SHA-256 digests, lengths and flags are retained or logged.
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
_MAX_SAMPLES = 72
_LOCK = threading.Lock()
_ENCODER = json.JSONEncoder(ensure_ascii = False, sort_keys = True, default = str, separators = (",", ":"))
_PREVIOUS: "OrderedDict[tuple[str, str], tuple[tuple[bytes, ...], int, bool, str]]" = OrderedDict()


def _sample_json(value: object) -> tuple[str, bool]:
    """Stop serializing after the comparison window; do not copy a whole long transcript."""
    parts = []
    size = 0
    for part in _ENCODER.iterencode(value):
        room = _MAX_CHARS - size
        if room <= 0:
            return "".join(parts), True
        parts.append(part[:room])
        size += min(len(part), room)
        if len(part) > room:
            return "".join(parts), True
    return "".join(parts), False


def _hash_json(value: object) -> str:
    digest = hashlib.sha256()
    for part in _ENCODER.iterencode(value):
        digest.update(part.encode("utf-8", "surrogatepass"))
    return digest.hexdigest()[:12]


def record_prefix(thread_id: str | None, messages: list[dict], tools: object = None, *, phase: str = "agent") -> None:
    """Report a lower-bound common prefix for successive requests in one phase."""
    if not thread_id:
        return
    try:
        tag = hashlib.sha256(thread_id.encode("utf-8", "replace")).hexdigest()[:12]
        sample, capped = _sample_json(messages)
        digests = tuple(
            hashlib.sha256(sample[i : i + _CHUNK].encode("utf-8", "surrogatepass")).digest()
            for i in range(0, len(sample), _CHUNK)
        )
        tool_tag = _hash_json(tools)
        key = (tag, phase)
        with _LOCK:
            previous = _PREVIOUS.get(key)
            _PREVIOUS[key] = (digests, len(sample), capped, tool_tag)
            _PREVIOUS.move_to_end(key)
            while len(_PREVIOUS) > _MAX_SAMPLES:
                _PREVIOUS.popitem(last = False)
        if previous is None:
            _LOG.info(
                "prompt_prefix_diag thread=%s phase=%s first_sample=1 sample_chars=%d "
                "sample_capped=%s tool_hash=%s",
                tag, phase, len(sample), int(capped), tool_tag,
            )
            return
        prev_chunks, prev_size, prev_capped, prev_tool_tag = previous
        matched = 0
        for old, new in zip(prev_chunks, digests):
            if old != new:
                break
            matched += 1
        stable_floor = min(matched * _CHUNK, prev_size, len(sample))
        _LOG.info(
            "prompt_prefix_diag thread=%s phase=%s stable_prefix_chars_floor=%d "
            "old_sample_chars=%d new_sample_chars=%d tools_changed=%s "
            "old_capped=%s new_capped=%s",
            tag, phase, stable_floor, prev_size, len(sample),
            prev_tool_tag != tool_tag, int(prev_capped), int(capped),
        )
    except Exception:
        # Diagnostics must never interrupt inference or log sensitive serializer exceptions.
        _LOG.warning("prompt_prefix_diag unavailable phase=%s", phase)
