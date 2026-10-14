# SPDX-License-Identifier: AGPL-3.0-only
"""Bounded, authenticated, content-free QA progress snapshots for a single chat request.

The caller owns a random run key. Ownership is *always* checked against the
authenticated subject; no thread ID, prompt or exception is stored or returned.
"""
from __future__ import annotations

import asyncio
import contextvars
import re
import threading
import time
from collections import OrderedDict
from typing import Any

_KEY = re.compile(r"^[0-9a-f]{32}$")
_MAX_RECORDS = 128
_ACTIVE_TTL = 30 * 60
_DONE_TTL = 10 * 60
_lock = threading.RLock()
_records: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
_active: contextvars.ContextVar[tuple[str, str] | None] = contextvars.ContextVar(
    "unsloth_working_progress", default = None,
)


def _count(value: Any) -> int:
    try:
        return max(0, min(int(value), 1_000_000_000))
    except (TypeError, ValueError, OverflowError):
        return 0


def begin(subject: str, run_id: str | None) -> tuple[str, str] | None:
    if not isinstance(subject, str) or not subject or not isinstance(run_id, str) or not _KEY.fullmatch(run_id):
        return None
    key = (subject, run_id)
    now = time.monotonic()
    with _lock:
        _sweep(now)
        # A second caller may not hijack or reset an in-flight run key.
        if key in _records:
            return None
        _records[key] = {
            "phase": "request_received", "current": 0, "total": None,
            "unit": "messages", "status": "running", "started": now, "updated": now,
        }
        _records.move_to_end(key)
        while len(_records) > _MAX_RECORDS:
            _records.popitem(last = False)
    return key


def attach(subject: str, run_id: str | None) -> tuple[str, str] | None:
    """Worker may attach only to a run explicitly opted in by its authenticated creator."""
    if not isinstance(subject, str) or not isinstance(run_id, str) or not _KEY.fullmatch(run_id):
        return None
    key = (subject, run_id)
    with _lock:
        _sweep(time.monotonic())
        row = _records.get(key)
        return key if row is not None and row["status"] == "running" else None


def _sweep(now: float) -> None:
    for key, row in list(_records.items()):
        ttl = _DONE_TTL if row["status"] != "running" else _ACTIVE_TTL
        if now - row["updated"] > ttl:
            _records.pop(key, None)


def activate(key: tuple[str, str] | None):
    return _active.set(key)


def reset(token: contextvars.Token) -> None:
    _active.reset(token)


def current() -> tuple[str, str] | None:
    return _active.get()


def publish(phase: str, *, current: int = 0, total: int | None = None, unit: str = "calls") -> None:
    key = _active.get()
    if key is None:
        return
    now = time.monotonic()
    with _lock:
        row = _records.get(key)
        if row is None or row["status"] != "running":
            return
        # Internal callers only. Keep a constrained public surface, even if a
        # future caller accidentally interpolates user content into a label.
        if not isinstance(phase, str) or not re.fullmatch(r"[a-z_][a-z_0-9.]{0,79}", phase):
            return
        # Avoid lock churn and frontend redraws on thousands of archive matches.
        changed = phase != row["phase"]
        if not changed and now - row["updated"] < 0.25 and current != 0:
            return
        row.update(phase = phase, current = _count(current),
                   total = _count(total) if total is not None else None,
                   unit = unit if unit in ("messages", "turns", "calls", "chunks", "tokens") else "calls",
                   updated = now)


def finish(key: tuple[str, str] | None, *, failed: bool = False) -> None:
    if key is None:
        return
    with _lock:
        row = _records.get(key)
        if row is not None:
            row["status"] = "failed" if failed else "done"
            row["updated"] = time.monotonic()


def snapshot(subject: str, run_id: str) -> dict[str, Any] | None:
    if not isinstance(subject, str) or not isinstance(run_id, str) or not _KEY.fullmatch(run_id):
        return None
    now = time.monotonic()
    with _lock:
        _sweep(now)
        row = _records.get((subject, run_id))
        if row is None:
            return None
        return {
            "phase": row["phase"], "current": row["current"], "total": row["total"],
            "unit": row["unit"], "status": row["status"],
            "elapsed_ms": _count((now - row["started"]) * 1000),
        }


async def bind_response_stream(iterator, key: tuple[str, str]):
    """Bind context across the pre-header/ASGI response split and release on EOF."""
    token = activate(key)
    failed = True
    try:
        async for chunk in iterator:
            yield chunk
        failed = False
    finally:
        # _SameTaskStreamingResponse throws CancelledError into its body iterator
        # on disconnect. Forward it into the ORIGINAL backend generator as well:
        # otherwise its admission lease / tool tracker can remain suspended.
        if failed:
            athrow = getattr(iterator, "athrow", None)
            if callable(athrow):
                try:
                    await athrow(asyncio.CancelledError())
                except (asyncio.CancelledError, StopAsyncIteration, RuntimeError, Exception):
                    pass
            aclose = getattr(iterator, "aclose", None)
            if callable(aclose):
                try:
                    await aclose()
                except (asyncio.CancelledError, RuntimeError, Exception):
                    pass
        finish(key, failed = failed)
        reset(token)
