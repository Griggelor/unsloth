# SPDX-License-Identifier: AGPL-3.0-only
"""Opt-in bounded exact prefix probe for very long, archived GGUF chat histories.

IMPORTANT: Exact token counts for an isolated prefix are *evidence* of overflow,
not an unconditional mathematical lower bound for every possible chat template.
This feature is intentionally disabled unless UNSLOTH_CONTEXT_EARLY_PROBE=1.
Only a large margin and complete turn prefixes can activate the shortcut.
No original records are mutated or deleted.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any, Optional

_MEDIA_PARTS = frozenset((
    "image_url", "input_image", "input_audio", "audio", "video_url", "input_video",
))
_ROLES = frozenset(("system", "developer", "user", "assistant", "tool"))


def _cheap_text_size(message: dict) -> int:
    """No JSON formatting/base64 encoding for the preliminary size screening."""
    content = message.get("content", "")
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(
            len(part.get("text", "")) if isinstance(part, dict) and isinstance(part.get("text"), str)
            else 0 for part in content
        )
    return 0


def _safe_roles_and_media(messages: list[dict]) -> bool:
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in _ROLES:
            return False
        parts = message.get("content")
        if isinstance(parts, list):
            if any(isinstance(p, dict) and p.get("type") in _MEDIA_PARTS for p in parts):
                return False
    return True


def bounded_exact_prefix_probe(
    messages: list[dict],
    *,
    context_length: int,
    prompt_target: int,
    count_tokens: Callable[[list[dict]], int],
    max_fraction: float = 0.25,
) -> Optional[tuple[int, int]]:
    """Return (exact_prefix_count, prefix_message_count) only for gross overflow.

    The probe stops only *between complete user turns*: an assistant tool call
    and its tool results remain together. A lone continuation without another
    user delimiter is deliberately not probed. A callback refusal is a normal
    inconclusive result and the caller must use the unchanged full count.

    Unlike the standard fit, this is a performance fast path and may change
    *when* compaction starts for an exotic non-monotonic template. Keep it opt-in,
    and compare with full-context fits and model runs before enabling broadly.
    """
    if context_length <= 1 or prompt_target <= 0 or len(messages) < 32:
        return None
    if not _safe_roles_and_media(messages):
        return None
    text_chars = sum(_cheap_text_size(m) for m in messages)
    # Need several times the full window in raw characters even to attempt.
    if text_chars < context_length * 12:
        return None

    # The first prefix must contain the fixed system/developer messages, then
    # one or more WHOLE turns, ending before the next user message.
    first_user = next((i for i, m in enumerate(messages) if m["role"] == "user"), None)
    if first_user is None:
        return None
    maximum_messages = max(first_user + 2, int(len(messages) * max_fraction))
    if maximum_messages >= len(messages) - 1:
        return None

    size = 0
    candidate_end = None
    # The new user at the cut is excluded; leave enough extra raw-text room
    # that a prefix of several completed turns can independently exceed the
    # conservative exact-count margin, even when each turn is large.
    target_chars = prompt_target * 10
    max_chars = context_length * 16
    for i, message in enumerate(messages):
        size += _cheap_text_size(message)
        if size > max_chars or i + 1 >= maximum_messages:
            break
        # A user starts a new complete turn; don't send an unfinished tool
        # batch or a half user/assistant exchange to the real tokenizer.
        if i > first_user and message["role"] == "user" and size >= target_chars:
            candidate_end = i  # the new user is NOT part of the prefix
            break
    if candidate_end is None or candidate_end <= first_user:
        return None

    prefix = messages[:candidate_end]
    # Reject orphaned tool results and incomplete tool batches at the cut.
    pending: set[str] = set()
    for m in prefix:
        if m["role"] == "assistant" and m.get("tool_calls"):
            for call in m["tool_calls"]:
                if not isinstance(call, dict) or not isinstance(call.get("id"), str):
                    return None
                pending.add(call["id"])
        elif m["role"] == "tool":
            ident = m.get("tool_call_id")
            if ident not in pending:
                return None
            pending.remove(ident)
    if pending:
        return None
    try:
        count = count_tokens(prefix)
    except Exception:
        return None
    if type(count) is not int:
        return None
    # Large exact gap to tolerate prompt wrapper/assistant state differences.
    if count < max(prompt_target + 1024, (prompt_target * 3) // 2):
        return None
    return count, candidate_end
