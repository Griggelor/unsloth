# SPDX-License-Identifier: AGPL-3.0-only
"""Isolated QA phase timeline: counters only, with no chat/text disclosures."""
from __future__ import annotations

import logging
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))

from core.inference import context_live_progress as state  # noqa: E402
from core.inference.context_perf_trace import StageBook, trace_call  # noqa: E402
from utils.account_context import AccountContext, bind_account, reset_account  # noqa: E402


class LiveWorkingProgress(unittest.TestCase):
    def setUp(self):
        state.clear_for_test()

    def tearDown(self):
        state.clear_for_test()

    def test_count_phase_updates_and_protects_message_data(self):
        payload = "secret transcript that must not appear anywhere in status"
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_PERF_TRACE": "1"}):
            self.assertEqual(trace_call("checkpoint.original_exact_count", len, payload, messages = 500), len(payload))
            view = state.snapshot()
        self.assertEqual(view["stage"], 2)
        self.assertEqual(view["items"], 500)
        self.assertFalse(view["active"])
        self.assertNotIn("secret", repr(view))
        self.assertGreaterEqual(view["elapsed_ms"], 0)

    def test_archive_progress_and_elapsed_are_bounded_scalars(self):
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_PERF_TRACE": "1"}):
            profile = StageBook("conversation_archive.archive_turns", evicted_messages = 1200, evicted_turns = 500)
            for _ in range(260):
                profile.call("match_evicted_turn", lambda: None)
            value = state.snapshot()
            self.assertEqual(value["stage"], 7)
            self.assertEqual(value["processed"], 260)
            self.assertEqual(value["total"], 500)
            self.assertGreaterEqual(value["elapsed_ms"], 0)
            profile.report(archived_messages = 260, evicted_turns = 500)
            self.assertEqual(state.snapshot()["stage"], 10)

    def test_different_accounts_cannot_read_other_progress(self):
        one = AccountContext("qa-one", "qa-one")
        two = AccountContext("qa-two", "qa-two")
        token = bind_account(one)
        try:
            state.begin("checkpoint.original_exact_count", items = 724)
            self.assertEqual(state.snapshot()["items"], 724)
        finally:
            reset_account(token)
        token = bind_account(two)
        try:
            self.assertEqual(state.snapshot()["items"], 0)
        finally:
            reset_account(token)

    def test_flag_disables_tracer(self):
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_PERF_TRACE": "0"}):
            with self.assertNoLogs("studio.context_perf"):
                trace_call("checkpoint.original_exact_count", lambda: 1, messages = 100)
            self.assertEqual(state.snapshot()["stage"], 1)


if __name__ == "__main__":
    unittest.main()
