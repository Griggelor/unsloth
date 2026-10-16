# SPDX-License-Identifier: AGPL-3.0-only
"""Opt-in content-free timing for Studio long-context diagnosis.

Never log paths, chat identifiers, headers, messages, tool arguments,
model identifiers, filenames, or exception text. Disabled unless explicitly set.
"""
from __future__ import annotations

import contextvars
from functools import wraps
import logging
import os
import secrets
import time
from collections.abc import Callable
from typing import Any

_LOG = logging.getLogger("studio.context_latency")
_REQUEST = contextvars.ContextVar("context_latency_request", default = "-")
_FLAG = "UNSLOTH_CONTEXT_LATENCY_TRACE"


def enabled() -> bool:
    return os.environ.get(_FLAG) == "1"


def _kind(path: str, method: str) -> str | None:
    parts = path.strip("/").split("/")
    if len(parts) >= 3 and parts[:2] == ["api", "chat"]:
        tail = parts[2:]
        if tail == ["messages:counts"] and method == "POST":
            return "chat_counts"
        if tail == ["messages:batch"] and method == "POST":
            return "chat_batch"
        if len(tail) == 3 and tail[0] == "threads" and tail[2] == "messages":
            return {"PUT": "chat_sync", "GET": "chat_read"}.get(method)
        if len(tail) == 4 and tail[0] == "threads" and tail[2] == "messages":
            return {"PUT": "chat_message_write", "GET": "chat_message_read"}.get(method)
    if method == "POST" and (
        path in ("/v1/chat/completions", "/api/inference/chat/completions")
        or (path.startswith("/api/inference/") and path.endswith("/chat/completions"))
    ):
        return "generation"
    if method == "POST" and path in ("/api/models/load", "/api/inference/load"):
        return "model_load"
    return None


def trace_call(phase: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """The caller supplies a constant stage name; no argument or result is logged."""
    if not enabled():
        return fn(*args, **kwargs)
    wall = time.perf_counter()
    cpu_timer = getattr(time, "thread_time", time.process_time)
    cpu = cpu_timer()
    status = "error"
    try:
        result = fn(*args, **kwargs)
        status = "ok"
        return result
    finally:
        _LOG.info(
            "context_latency stage=%s rid=%s status=%s wall_ms=%.3f cpu_ms=%.3f",
            phase, _REQUEST.get(), status,
            (time.perf_counter() - wall) * 1000,
            (cpu_timer() - cpu) * 1000,
        )


def trace_phase(phase: str):
    """Decorate a synchronous function without changing its signature or result."""
    def decorate(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            return trace_call(phase, fn, *args, **kwargs)
        return wrapped
    return decorate


class ContextLatencyMiddleware:
    """Transparent ASGI tap across upload, validation, DB, and response encoding.

    First response-body frame may be a SSE keepalive, NOT the first model token.
    """
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not enabled():
            return await self.app(scope, receive, send)
        kind = _kind(scope.get("path", ""), scope.get("method", ""))
        if kind is None:
            return await self.app(scope, receive, send)
        rid = secrets.token_hex(6)
        token = _REQUEST.set(rid)
        start = time.perf_counter()
        recv_bytes = 0
        sent_bytes = 0
        upload_ms = None
        headers_ms = None
        first_body_ms = None
        status_code = 0
        outcome = "error"
        _LOG.info("context_latency http=%s rid=%s event=begin", kind, rid)

        async def tapped_receive():
            nonlocal recv_bytes, upload_ms
            frame = await receive()
            if frame.get("type") == "http.request":
                recv_bytes += len(frame.get("body", b""))
                if not frame.get("more_body", False) and upload_ms is None:
                    upload_ms = (time.perf_counter() - start) * 1000
            return frame

        async def tapped_send(frame):
            nonlocal sent_bytes, headers_ms, first_body_ms, status_code
            typ = frame.get("type")
            if typ == "http.response.start":
                status_code = int(frame.get("status", 0))
                headers_ms = (time.perf_counter() - start) * 1000
                _LOG.info(
                    "context_latency http=%s rid=%s event=headers status=%d wall_ms=%.3f",
                    kind, rid, status_code, headers_ms,
                )
            elif typ == "http.response.body":
                sent_bytes += len(frame.get("body", b""))
                if first_body_ms is None:
                    first_body_ms = (time.perf_counter() - start) * 1000
                    _LOG.info(
                        "context_latency http=%s rid=%s event=first_body wall_ms=%.3f",
                        kind, rid, first_body_ms,
                    )
            await send(frame)

        try:
            await self.app(scope, tapped_receive, tapped_send)
            outcome = "ok"
        finally:
            _LOG.info(
                "context_latency http=%s rid=%s event=end status=%s code=%d "
                "wall_ms=%.3f upload_ms=%.3f headers_ms=%.3f first_body_ms=%.3f "
                "request_bytes=%d response_bytes=%d",
                kind, rid, outcome, status_code,
                (time.perf_counter() - start) * 1000,
                -1 if upload_ms is None else upload_ms,
                -1 if headers_ms is None else headers_ms,
                -1 if first_body_ms is None else first_body_ms,
                recv_bytes, sent_bytes,
            )
            _REQUEST.reset(token)
