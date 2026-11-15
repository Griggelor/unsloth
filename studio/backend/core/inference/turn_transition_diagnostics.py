# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Opt-in, privacy-bounded cross-phase GGUF request and tool surface diagnostics.

Unlike the per-phase prefix probe, this compares the last engine request of one
turn (final) to the first request of the next human turn (agent/plain). This is a
JSON-prefix proxy, NOT the llama-server rendered prompt/token LCP.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import OrderedDict

from core.inference.prompt_prefix_diagnostics import _CHUNK, _MAX_CHARS, _hash_json, _sample_json

_LOG = logging.getLogger(__name__)
_LOCK = threading.Lock()
_MAX_THREADS = 72
_MAX_HEAD_MESSAGES = 32
_MAX_MESSAGE_CHARS = 8192
_PREVIOUS_REQUEST: "OrderedDict[str, dict]" = OrderedDict()
_ENCODER = json.JSONEncoder(ensure_ascii = False, sort_keys = True, default = str, separators = (",", ":"))
_SAFE_ROLES = frozenset({"system", "developer", "user", "assistant", "tool"})


def _head_hash(message: object) -> bytes:
    """Never retain message contents; hash only the first bounded JSON characters."""
    digest = hashlib.sha256()
    size = 0
    for part in _ENCODER.iterencode(message):
        room = _MAX_MESSAGE_CHARS - size
        if room <= 0:
            break
        digest.update(part[:room].encode("utf-8", "surrogatepass"))
        size += min(len(part), room)
    return digest.digest()


def _message_heads(messages: list[dict]) -> tuple[tuple[str, bytes], ...]:
    heads = []
    for message in messages[:_MAX_HEAD_MESSAGES]:
        raw_role = message.get("role") if isinstance(message, dict) else None
        role = raw_role if raw_role in _SAFE_ROLES else "other"
        heads.append((role, _head_hash(message)))
    return tuple(heads)


def _tool_stats(tools: object) -> tuple[int, int]:
    if not isinstance(tools, (list, tuple)):
        return (0, 0)
    count = len(tools)
    browsers = 0
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function")
        name = (fn.get("name") if isinstance(fn, dict) else tool.get("name"))
        if isinstance(name, str) and name.startswith("browser_"):
            browsers += 1
    return (count, browsers)


def _choice(value: object) -> str:
    if isinstance(value, str) and value in {"auto", "none", "required"}:
        return value
    return "forced" if isinstance(value, dict) else "unset"


def record_request_surface(
    thread_id: str | None,
    messages: list[dict],
    *,
    phase: str,
    tools: object = None,
    source_tools: object = None,
    template_kwargs: object = None,
    tool_choice: object = None,
) -> None:
    """Hash request surfaces only. Diagnostics must not alter inference on error."""
    if not thread_id:
        return
    try:
        tag = hashlib.sha256(thread_id.encode("utf-8", "replace")).hexdigest()[:12]
        sample, capped = _sample_json(messages)
        chunks = tuple(
            hashlib.sha256(sample[i : i + _CHUNK].encode("utf-8", "surrogatepass")).digest()
            for i in range(0, len(sample), _CHUNK)
        )
        heads = _message_heads(messages)
        system = tuple((role, digest) for role, digest in heads if role in {"system", "developer"})
        extra = template_kwargs if isinstance(template_kwargs, dict) else {}
        template_tools = extra.get("tools")
        template_other = {k: v for k, v in extra.items() if k != "tools"}
        wire_count, wire_browser = _tool_stats(tools)
        source_count, source_browser = _tool_stats(source_tools)
        template_count, template_browser = _tool_stats(template_tools)
        current = {
            "phase": phase,
            "chunks": chunks,
            "size": len(sample),
            "capped": capped,
            "heads": heads,
            "system": system,
            "wire_hash": _hash_json(tools),
            "source_hash": _hash_json(source_tools),
            "template_tools_hash": _hash_json(template_tools),
            "template_other_hash": _hash_json(template_other),
            "choice": _choice(tool_choice),
            "wire_browser": wire_browser,
            "source_browser": source_browser,
            "template_browser": template_browser,
        }
        with _LOCK:
            previous = _PREVIOUS_REQUEST.get(tag)
            current["seq"] = 1 if previous is None else previous["seq"] + 1
            _PREVIOUS_REQUEST[tag] = current
            _PREVIOUS_REQUEST.move_to_end(tag)
            while len(_PREVIOUS_REQUEST) > _MAX_THREADS:
                _PREVIOUS_REQUEST.popitem(last = False)
        _LOG.info(
            "prompt_surface_diag thread=%s seq=%d phase=%s message_count=%d "
            "wire_tools=%d source_tools=%d template_tools=%d "
            "wire_browser=%d source_browser=%d template_browser=%d tool_choice=%s",
            tag, current["seq"], phase, len(messages), wire_count, source_count,
            template_count, wire_browser, source_browser, template_browser,
            current["choice"],
        )
        if previous is None or previous["phase"] != "final" or phase not in {"agent", "plain"}:
            return
        matched = 0
        for old, new in zip(previous["chunks"], chunks):
            if old != new:
                break
            matched += 1
        floor = min(matched * _CHUNK, previous["size"], len(sample))
        first_diff = -1
        for i, pair in enumerate(zip(previous["heads"], heads)):
            if pair[0] != pair[1]:
                first_diff = i
                break
        if first_diff < 0 and len(previous["heads"]) != len(heads):
            first_diff = min(len(previous["heads"]), len(heads))
        role = heads[first_diff][0] if 0 <= first_diff < len(heads) else "none"
        _LOG.info(
            "turn_boundary_diag thread=%s old_seq=%d new_seq=%d from_phase=final to_phase=%s "
            "json_prefix_floor=%d old_sample_chars=%d new_sample_chars=%d "
            "old_capped=%d new_capped=%d first_changed_head_message=%d first_changed_role=%s "
            "system_changed=%s source_tools_changed=%s wire_tools_changed=%s "
            "template_tools_changed=%s template_other_changed=%s tool_choice_changed=%s "
            "old_source_browser=%d new_source_browser=%d old_wire_browser=%d new_wire_browser=%d "
            "old_template_browser=%d new_template_browser=%d",
            tag, previous["seq"], current["seq"], phase, floor,
            previous["size"], len(sample), int(previous["capped"]), int(capped),
            first_diff, role, previous["system"] != system,
            previous["source_hash"] != current["source_hash"],
            previous["wire_hash"] != current["wire_hash"],
            previous["template_tools_hash"] != current["template_tools_hash"],
            previous["template_other_hash"] != current["template_other_hash"],
            previous["choice"] != current["choice"],
            previous["source_browser"], source_browser,
            previous["wire_browser"], wire_browser,
            previous["template_browser"], template_browser,
        )
    except Exception:
        _LOG.warning("turn_boundary_diag unavailable phase=%s", phase)
