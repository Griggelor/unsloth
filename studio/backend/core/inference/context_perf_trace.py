# SPDX-License-Identifier: AGPL-3.0-only
"""Opt-in content-free timing for long-chat context and archive stages."""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict
from collections.abc import Callable
from typing import Any
from core.inference import working_progress

LOG = logging.getLogger("studio.context_perf")
FLAG = "UNSLOTH_CONTEXT_PERF_TRACE"


def enabled() -> bool:
    return os.environ.get(FLAG) == "1"


def trace_call(phase: str, fn: Callable, *args: Any, messages: int = 0, **kwargs: Any):
    """Do not record arguments, results, private paths or exception text."""
    logging_on = enabled()
    if not logging_on and working_progress.current() is None:
        return fn(*args, **kwargs)
    working_progress.publish(phase, current = 0, total = messages, unit = "messages")
    if logging_on:
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
        working_progress.publish(phase, current = messages, total = messages, unit = "messages")
        if logging_on:
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

    def __init__(self, label: str, *, evicted_messages: int = 0) -> None:
        self.label = label
        self.logging_on = enabled()
        self.active = self.logging_on or working_progress.current() is not None
        self.totals: dict[str, int] = {}
        self.evicted_messages = max(0, int(evicted_messages))
        self.started = time.perf_counter() if self.active else 0.0
        self.cpu = time.process_time() if self.active else 0.0
        self.stats: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
        if self.active:
            working_progress.publish(self.label, total = self.evicted_messages, unit = "messages")
        if self.logging_on:
            LOG.info("context_perf phase=%s status=begin evicted_messages=%d", self.label, self.evicted_messages)

    def set_total(self, phase: str, count: int) -> None:
        self.totals[phase] = max(0, int(count))

    def call(self, phase: str, fn: Callable, *args: Any, **kwargs: Any):
        if not self.active:
            return fn(*args, **kwargs)
        wall = time.perf_counter()
        cpu = time.process_time()
        row = self.stats[phase]
        if phase != "match_live_turn":
            working_progress.publish(phase, current = int(row[0]), total = self.totals.get(phase), unit = "turns")
        row[0] += 1
        if self.logging_on and phase == "embedding_encode":
            LOG.info(
                "context_perf phase=embedding_encode status=begin evicted_messages=%d",
                self.evicted_messages,
            )
        try:
            return fn(*args, **kwargs)
        finally:
            row[1] += (time.perf_counter() - wall) * 1000
            row[2] += (time.process_time() - cpu) * 1000
            if phase != "match_live_turn":
                working_progress.publish(phase, current = int(row[0]), total = self.totals.get(phase), unit = "turns")
            if self.logging_on and phase == "match_evicted_turn" and int(row[0]) % 250 == 0:
                LOG.info(
                    "context_perf phase=match_evicted_turn status=progress calls=%d wall_ms=%.3f cpu_ms=%.3f",
                    int(row[0]), row[1], row[2],
                )

    def report(self, *, archived_messages: int = 0, evicted_turns: int = 0) -> None:
        if not self.active:
            return
        working_progress.publish(self.label, current = evicted_turns, total = evicted_turns, unit = "turns")
        if not self.logging_on:
            return
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
