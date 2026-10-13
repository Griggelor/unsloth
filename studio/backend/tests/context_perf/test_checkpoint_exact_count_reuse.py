# SPDX-License-Identifier: AGPL-3.0-only
"""Exact-checkpoint-count reuse: regression guards over the production fitter.

No estimator is allowed to declare an overlong original history to fit.
The optimization skips only a demonstrably identical second *exact* count.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))

from core.inference.checkpoint import fit_checkpoint_context  # noqa: E402


def long_history(*, system = "Stable system instruction."):
    rows = [{"role": "system", "content": system}]
    for idx in range(30):
        rows += [
            {"role": "user", "content": f"task-{idx} " + ("a" * 400)},
            {"role": "assistant", "content": f"result-{idx} " + ("b" * 400)},
        ]
    rows.append({"role": "user", "content": "Newest user question."})
    return rows


class ExactCounts:
    def __init__(self):
        self.counted: list[list[dict]] = []

    def __call__(self, rows):
        self.counted.append(list(rows))
        return sum(4 + (len(str(r.get("content", ""))) + 3) // 4 for r in rows)


class ExactCheckpointCountReuse(unittest.TestCase):
    def fitted(self, rows, callback, **kwargs):
        return fit_checkpoint_context(
            rows,
            context_length = 4096,
            max_tokens = 512,
            count_tokens = callback,
            can_reset = True,
            searchable = False,
            **kwargs,
        )

    def test_overlong_unchanged_projection_never_exact_counts_original_twice(self):
        messages = long_history()
        counter = ExactCounts()
        fitted, meta = self.fitted(messages, counter)
        self.assertIsNotNone(meta)
        self.assertTrue(meta["checkpoint_started"])
        self.assertTrue(meta["fits"])
        self.assertEqual(counter.counted[0], messages)
        self.assertEqual(len(counter.counted), 2)
        self.assertEqual(meta["prompt_tokens_before"], ExactCounts()(messages))
        self.assertLess(len(fitted), len(messages))
        self.assertEqual(fitted[-1], messages[-1])
        self.assertEqual(messages[0]["content"], "Stable system instruction.")

    def test_whitespace_changes_projection_and_must_still_be_counted_exactly(self):
        messages = long_history(system = "Stable system instruction.  \n")
        counter = ExactCounts()
        fitted, meta = self.fitted(messages, counter)
        self.assertIsNotNone(meta)
        self.assertEqual(len(counter.counted), 3)
        self.assertEqual(counter.counted[0], messages)
        self.assertNotEqual(counter.counted[1], messages)
        self.assertEqual(messages[0]["content"], "Stable system instruction.  \n")

    def test_small_history_still_counts_once(self):
        messages = [
            {"role": "system", "content": "Keep context."},
            {"role": "user", "content": "Hello."},
        ]
        counter = ExactCounts()
        result, meta = self.fitted(messages, counter)
        self.assertIsNone(meta)
        self.assertEqual(result, messages)
        self.assertEqual(len(counter.counted), 1)

    def test_tool_exchange_remains_in_correct_protected_latest_turn(self):
        messages = long_history()
        messages[-1:] = [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call-a",
                        "type": "function",
                        "function": {"name": "run", "arguments": "{}"},
                    },
                ],
                "content": "",
            },
            {"role": "tool", "tool_call_id": "call-a", "content": "success"},
            {"role": "user", "content": "Explain result."},
        ]
        counter = ExactCounts()
        fitted, meta = self.fitted(messages, counter)
        self.assertTrue(meta["fits"])
        self.assertEqual(fitted[-1], messages[-1])
        self.assertEqual(len(counter.counted), 2)
        # Protected final turn and system stay. A reset may intentionally
        # archive an older completed tool exchange, but must not mutate it.
        self.assertEqual(messages[-2]["tool_call_id"], "call-a")

    def test_no_system_message_keeps_last_user_on_reset(self):
        messages = long_history()[1:]
        counter = ExactCounts()
        fitted, meta = self.fitted(messages, counter)
        self.assertTrue(meta["fits"])
        self.assertEqual(fitted[-1], messages[-1])
        self.assertEqual(len(counter.counted), 2)

    def test_forced_reset_still_runs_and_marks_manual_epoch(self):
        messages = long_history()
        counter = ExactCounts()
        fitted, meta = self.fitted(messages, counter, force_reset = True)
        self.assertEqual(len(counter.counted), 2)
        self.assertTrue(meta["manual"])
        self.assertTrue(meta["checkpoint_started"])
        self.assertEqual(fitted[-1], messages[-1])

    def test_existing_carried_block_must_still_be_repriced(self):
        system = "Sys\n<carried_forward>\n- Revisit this old detail.\n</carried_forward>\n"
        messages = long_history(system = system)
        counter = ExactCounts()
        self.fitted(messages, counter)
        self.assertGreaterEqual(len(counter.counted), 3)

    def test_exact_tokenizer_failure_never_falls_back_to_estimate(self):
        messages = long_history()

        def broken(_):
            raise RuntimeError("tokenizer broken")

        with self.assertRaisesRegex(RuntimeError, "tokenizer broken"):
            self.fitted(messages, broken)


if __name__ == "__main__":
    unittest.main(verbosity = 2)
