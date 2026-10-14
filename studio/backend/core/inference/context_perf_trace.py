# SPDX-License-Identifier: AGPL-3.0-only
"""Opt-in content-free timing for long-chat context and archive stages."""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict
from collections.abc import Callable
from typing import Any

LOG = logging.getLogger("studio.context_perf")
FLAG = "UNSLOTH_CONTEXT_PERF_TRACE"
# QA-only default. Never merge this on-by-default flag into production.
from core.inference import context_live_progress as _live


def enabled() -> bool:
    return os.environ.get(FLAG, "1") == "1"


def trace_call(phase: str, fn: Callable, *args: Any, messages: int = 0, **kwargs: Any):
    """Do not record arguments, results, private paths or exception text."""
    if not enabled():
        return fn(*args, **kwargs)
    _live.begin(phase, items = messages)
    LOG.info(
        "context_perf phase=%s status=begin messages=%d",
        phase,
        max(0, int(messages)),
    )
    started = time.perf_counter()
    cpu = time.process_time()
    status = "error"
    try:
        value = fn(*args, **kwargs)
        status = "ok"
        return value
    finally:
        _live.end(phase)
        LOG.info(
            "context_perf phase=%s status=%s messages=%d wall_ms=%.3f cpu_ms=%.3f",
            phase,
            status,
            max(0, int(messages)),
            (time.perf_counter() - started) * 1000,
            (time.process_time() - cpu) * 1000,
        )


class StageBook:
    """Aggregate repeated turn operations, with no chat identifiers in logs."""

    def __init__(self, label: str, *, evicted_messages: int = 0, evicted_turns: int = 0) -> None:
        self.label = label
        self.active = enabled()
        self.evicted_messages = max(0, int(evicted_messages))
        self.evicted_turns = max(0, int(evicted_turns))
        self.started = time.perf_counter() if self.active else 0.0
        self.cpu = time.process_time() if self.active else 0.0
        self.stats: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
        if self.active:
            _live.begin(self.label, items = self.evicted_messages)
            LOG.info("context_perf phase=%s status=begin evicted_messages=%d", self.label, self.evicted_messages)

    def call(self, phase: str, fn: Callable, *args: Any, **kwargs: Any):
        if not self.active:
            return fn(*args, **kwargs)
        wall = time.perf_counter()
        cpu = time.process_time()
        row = self.stats[phase]
        row[0] += 1
        _live.begin(phase, items = self.evicted_messages, total = self.evicted_turns)
        _live.advance(phase, processed = int(row[0]), total = self.evicted_turns)
        if phase == "embedding_encode":
            LOG.info(
                "context_perf phase=embedding_encode status=begin evicted_messages=%d",
                self.evicted_messages,
            )
        try:
            return fn(*args, **kwargs)
        finally:
            row[1] += (time.perf_counter() - wall) * 1000
            row[2] += (time.process_time() - cpu) * 1000
            if phase == "match_evicted_turn" and int(row[0]) % 250 == 0:
                LOG.info(
                    "context_perf phase=match_evicted_turn status=progress calls=%d wall_ms=%.3f cpu_ms=%.3f",
                    int(row[0]), row[1], row[2],
                )

    def report(self, *, archived_messages: int = 0, evicted_turns: int = 0) -> None:
        if not self.active:
            return
        _live.begin("context.ready", items = self.evicted_messages)
        LOG.info(
            "context_perf phase=%s status=end evicted_messages=%d evicted_turns=%d archived_messages=%d wall_ms=%.3f cpu_ms=%.3f",
            self.label,
            self.evicted_messages,
            max(0, int(evicted_turns)),
            max(0, int(archived_messages)),
            (time.perf_counter() - self.started) * 1000,
            (time.process_time() - self.cpu) * 1000,
        )
        for phase, (calls, wall_ms, cpu_ms) in sorted(self.stats.items()):
            LOG.info(
                "context_perf phase=%s calls=%d wall_ms=%.3f cpu_ms=%.3f",
                phase,
                int(calls),
                wall_ms,
                cpu_ms,
            )
