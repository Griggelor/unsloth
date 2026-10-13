# SPDX-License-Identifier: AGPL-3.0-only
"""Production reset fast path never scans full old payloads for token estimates."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
from core.inference import context_window as cw  # noqa: E402


def rows(*, tool = False):
    messages = [{"role": "system", "content": "Keep user instructions."}]
    for i in range(30):
        messages += [
            {"role": "user", "content": f"User {i}: " + "x" * 4096},
            {"role": "assistant", "content": f"Assistant {i}: " + "y" * 4096},
        ]
        if tool:
            messages += [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": f"call-{i}",
                            "type": "function",
                            "function": {"name": "find", "arguments": "{}"},
                        },
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": f"call-{i}",
                    "content": "Tool result " + "z" * 4096,
                },
            ]
    messages.append({"role": "user", "content": "Explain the result."})
    return messages


class FullResetNoOldBodyScan(unittest.TestCase):
    def test_full_reset_skips_expensive_estimate_for_standard_estimator(self):
        history = rows()
        old = [dict(x) for x in history]
        expected, expected_dropped = cw.truncate_oldest_messages(
            history,
            0.0,
            estimate_message = lambda m: cw.estimate_message_tokens(m),
        )
        with patch.object(
            cw, "estimate_message_tokens", side_effect = AssertionError("estimated old history")
        ) as stub:
            output, dropped = cw.truncate_oldest_messages(
                history,
                0.0,
                estimate_message = stub,
            )
        self.assertEqual((output, dropped), (expected, expected_dropped))
        self.assertEqual(history, old)
        self.assertEqual(stub.call_count, 0)

    def test_media_aware_estimator_does_not_scan_old_messages(self):
        history = rows()
        with patch.object(
            cw,
            "estimate_message_tokens_without_unpriced_media",
            side_effect = AssertionError("estimated old media"),
        ) as stub:
            output, dropped = cw.truncate_oldest_messages(
                history,
                0.0,
                estimate_message = stub,
            )
        self.assertEqual(stub.call_count, 0)
        self.assertEqual(dropped, len(history) - 2)
        self.assertEqual(output, [history[0], history[-1]])

    def test_custom_estimator_still_runs_original_algorithm(self):
        history = rows()
        calls = []

        def estimator(message):
            calls.append(message["role"])
            return 1

        output, dropped = cw.truncate_oldest_messages(
            history,
            0.0,
            estimate_message = estimator,
        )
        self.assertEqual(len(calls), len(history))
        self.assertEqual(output[0], history[0])
        self.assertEqual(output[-1], history[-1])
        self.assertEqual(dropped, len(history) - 2)

    def test_protected_old_turn_is_kept_entirely(self):
        history = rows(tool = True)
        # A protected tool result pins its entire originating tool exchange.
        protected = {id(history[4])}
        fast, lost = cw.truncate_oldest_messages(
            history,
            0.0,
            protected_message_ids = protected,
        )
        slow, old_lost = cw.truncate_oldest_messages(
            history,
            0.0,
            protected_message_ids = protected,
            estimate_message = lambda x: cw.estimate_message_tokens(x),
        )
        self.assertEqual((fast, lost), (slow, old_lost))
        self.assertTrue(any(message is history[4] for message in fast))
        self.assertEqual(fast[-1], history[-1])

    def test_min_dropped_zero_estimator_does_not_change_keep_ratio_nonzero(self):
        history = rows()
        fast, fast_dropped = cw.truncate_oldest_messages(history, 0.5)
        old, old_dropped = cw.truncate_oldest_messages(
            history,
            0.5,
            estimate_message = lambda x: cw.estimate_message_tokens(x),
        )
        self.assertEqual((fast, fast_dropped), (old, old_dropped))

    def test_min_dropped_one_uses_original_cost_path(self):
        history = rows()
        calls = []

        def estimator(message):
            calls.append(1)
            return 1

        cw.truncate_oldest_messages(history, 0.0, min_dropped = 1, estimate_message = estimator)
        self.assertEqual(len(calls), len(history))

    def test_only_two_messages_are_not_dropped(self):
        history = [
            {"role": "system", "content": "Rules"},
            {"role": "user", "content": "Latest"},
        ]
        output, dropped = cw.truncate_oldest_messages(history, 0.0)
        self.assertEqual(output, history)
        self.assertEqual(dropped, 0)


if __name__ == "__main__":
    unittest.main(verbosity = 2)
