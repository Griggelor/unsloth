# SPDX-License-Identifier: AGPL-3.0-only
"""Trace opt-in and privacy contracts; no model or archive dependency needed."""

from __future__ import annotations

import logging
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))

from core.inference.context_perf_trace import StageBook, trace_call  # noqa: E402


class ContextPerfTraceTests(unittest.TestCase):
    def test_disabled_has_no_logs_or_semantic_change(self):
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_PERF_TRACE": "0"}):
            with self.assertNoLogs("studio.context_perf"):
                self.assertEqual(trace_call("count", lambda n: n + 1, 4), 5)
                book = StageBook("archive", evicted_messages = 3)
                self.assertEqual(book.call("matched", lambda: 5), 5)
                book.report(archived_messages = 2, evicted_turns = 3)

    def test_enabled_emits_only_duration_and_counts(self):
        secret = "PRIVATE_AGENT_MESSAGE_NEVER_LOG"
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_PERF_TRACE": "1"}):
            with self.assertLogs("studio.context_perf", level = logging.INFO) as capture:
                self.assertEqual(trace_call("count", len, secret, messages = 1), len(secret))
                book = StageBook("archive", evicted_messages = 3)
                self.assertEqual(book.call("matched", len, secret), len(secret))
                book.report(archived_messages = 2, evicted_turns = 3)
        output = "\n".join(capture.output)
        self.assertNotIn(secret, output)
        self.assertIn("phase=count", output)
        self.assertIn("status=begin", output)
        self.assertIn("phase=archive status=begin", output)
        self.assertIn("phase=matched calls=1", output)

    def test_exception_propagates_without_logging_exception_message(self):
        secret = "SENSITIVE_UNEXPECTED_FAILURE"

        def failed():
            raise ValueError(secret)

        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_PERF_TRACE": "1"}):
            with self.assertLogs("studio.context_perf", level = logging.INFO) as capture:
                with self.assertRaises(ValueError):
                    trace_call("count", failed)
        self.assertNotIn(secret, "\n".join(capture.output))
        self.assertIn("status=error", "\n".join(capture.output))


if __name__ == "__main__":
    unittest.main()
