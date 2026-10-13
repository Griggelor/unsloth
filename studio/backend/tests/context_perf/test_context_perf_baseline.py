# SPDX-License-Identifier: AGPL-3.0-only
"""Production-function behavioral guards for long-chat context fitting.

No mocks of fit_rolling_context/fit_checkpoint_context: these are real imported
production functions. The injected count callback is intentionally a deterministic
synthetic counter, NOT a benchmark of llama-server tokenization.
"""
from __future__ import annotations

import pathlib
import sys
import unittest

REPO = pathlib.Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "studio" / "backend"))
from core.inference import context_window as cw  # noqa: E402
from core.inference import checkpoint as ck  # noqa: E402


def history(pairs=16, chars=640):
    rows = [{"role": "system", "content": "Keep user intent and maintain tool coherence."}]
    for n in range(pairs):
        rows.append({"role": "user", "content": f"QUESTION-{n}: " + "q" * chars})
        rows.append({"role": "assistant", "content": f"ANSWER-{n}: " + "a" * chars})
    rows.append({"role": "user", "content": "NOW: continue with the last task."})
    return rows


class Counter:
    def __init__(self):
        self.calls = 0
        self.bytes_seen = 0

    def __call__(self, messages):
        self.calls += 1
        self.bytes_seen += sum(len(str(m.get("content", ""))) for m in messages)
        return sum(4 + (len(str(m.get("content", ""))) + 3) // 4 for m in messages)


def rolling(messages, counter, context_length=4096, max_tokens=512, **kwargs):
    return cw.fit_rolling_context(
        messages,
        context_length=context_length,
        max_tokens=max_tokens,
        count_tokens=counter,
        **kwargs,
    )


class ContextProductionInvariants(unittest.TestCase):
    def test_short_context_counts_entire_original_once(self):
        messages = history(pairs=2, chars=32)
        counter = Counter()
        result, meta = rolling(messages, counter, context_length=32768)
        self.assertEqual(result, messages)
        self.assertIsNone(meta)
        self.assertEqual(counter.calls, 1)
        self.assertGreaterEqual(counter.bytes_seen, len(messages[-1]["content"]))

    def test_rolling_overflow_does_multiple_full_counts(self):
        messages = history(pairs=30)
        counter = Counter()
        fitted, meta = rolling(messages, counter)
        self.assertIsNotNone(meta)
        self.assertGreater(counter.calls, 1)
        self.assertGreater(counter.bytes_seen, sum(len(m["content"]) for m in messages))
        self.assertLess(len(fitted), len(messages))

    def test_overflow_keeps_system_and_latest_user(self):
        messages = history(pairs=40)
        fitted, meta = rolling(messages, Counter())
        self.assertIsNotNone(meta)
        self.assertEqual(fitted[0]["content"], messages[0]["content"])
        self.assertEqual(fitted[-1]["content"], messages[-1]["content"])

    def test_input_is_not_mutated_by_fit(self):
        messages = history(pairs=40)
        original = [(m["role"], m["content"]) for m in messages]
        rolling(messages, Counter())
        self.assertEqual(original, [(m["role"], m["content"]) for m in messages])

    def test_same_input_is_deterministic(self):
        messages = history(pairs=40)
        results = [rolling(messages, Counter()) for _ in range(3)]
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[1], results[2])

    def test_oversized_only_user_cannot_be_silently_lost(self):
        messages = [{"role": "system", "content": "rules"},
                    {"role": "user", "content": "X" * 40000}]
        fitted, meta = rolling(messages, Counter(), context_length=1024, max_tokens=128)
        self.assertEqual(fitted, messages)
        self.assertIsNotNone(meta)
        self.assertFalse(meta["fits"])
        self.assertEqual(meta["dropped_messages"], 0)

    def test_counter_failure_propagates(self):
        messages = history(pairs=2)
        def broken_count(_):
            raise RuntimeError("tokenizer unavailable")
        with self.assertRaisesRegex(RuntimeError, "tokenizer unavailable"):
            rolling(messages, broken_count)

    def test_checkpoint_no_overflow_also_counts_full_prompt(self):
        messages = history(pairs=2, chars=32)
        counter = Counter()
        fitted, meta = ck.fit_checkpoint_context(
            messages, context_length=32768, max_tokens=512,
            count_tokens=counter, can_reset=False,
        )
        self.assertEqual(fitted, messages)
        self.assertIsNone(meta)
        self.assertEqual(counter.calls, 1)

    def test_rolling_truncation_is_stable_after_repeat(self):
        messages = history(pairs=40)
        first, _ = rolling(messages, Counter())
        second, _ = rolling(first, Counter())
        self.assertEqual(first, second)

    def test_fitting_does_not_modify_protected_id_set(self):
        messages = history(pairs=40)
        pinned = {id(messages[1])}
        before = set(pinned)
        rolling(messages, Counter(), protected_message_ids=pinned)
        self.assertEqual(before, pinned)

    def test_short_even_with_saved_sticky_boundary_is_not_dropped(self):
        messages = history(pairs=1, chars=32)
        fitted, _ = rolling(messages, Counter(), context_length=32768, sticky_dropped=8)
        self.assertEqual(fitted, messages)

    def test_context_growth_never_changes_original_records(self):
        messages = history(pairs=16)
        for limit in (2048, 4096, 8192):
            rolling(messages, Counter(), context_length=limit)
        self.assertEqual(messages[-1]["content"], "NOW: continue with the last task.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
