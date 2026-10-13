# SPDX-License-Identifier: AGPL-3.0-only
"""Experimental bounded exact prefix: exercise REAL production checkpoint fitter.

Synthetic token callback deliberately models only additive tokenizer semantics.
No claim of correctness on arbitrary templates or an observed llama-server speedup.
The flag is OFF by default and must stay off until exact-model A/B testing.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
from core.inference.checkpoint import fit_checkpoint_context  # noqa: E402
from core.inference.early_context_probe import bounded_exact_prefix_probe  # noqa: E402


def long_chat(
    pairs = 170,
    chars = 5000,
    tools = False,
):
    messages = [{"role": "system", "content": "Be accurate. Never drop the newest question."}]
    for n in range(pairs):
        messages.append({"role": "user", "content": f"Question {n}: " + "a" * chars})
        if tools:
            call = f"tool-{n}"
            messages.append(
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": call,
                            "type": "function",
                            "function": {"name": "read", "arguments": "{}"},
                        }
                    ],
                }
            )
            messages.append(
                {"role": "tool", "tool_call_id": call, "content": "Result " + "t" * chars}
            )
        messages.append({"role": "assistant", "content": f"Answer {n}: " + "b" * chars})
    messages.append({"role": "user", "content": "Please answer the newest task."})
    return messages


class TokenCounter:
    def __init__(self, *, always_fits = False):
        self.scanned_lengths = []
        self.scanned_full = False
        self.always_fits = always_fits

    def __call__(self, messages):
        self.scanned_lengths.append(len(messages))
        if self.always_fits:
            return 100
        return sum(
            4 + (len(str(m.get("content", ""))) + 3) // 4 + 16 * bool(m.get("tool_calls"))
            for m in messages
        )


def fit(
    messages,
    counter,
    *,
    enabled,
    can_reset = True,
    **kwargs,
):
    with patch.dict(os.environ, {"UNSLOTH_CONTEXT_EARLY_PROBE": "1" if enabled else "0"}):
        return fit_checkpoint_context(
            messages,
            context_length = 4096,
            max_tokens = 512,
            count_tokens = counter,
            can_reset = can_reset,
            searchable = False,
            **kwargs,
        )


class ExperimentalBoundedPrefix(unittest.TestCase):
    def test_opt_in_preserves_exact_fitted_messages_and_all_records(self):
        messages = long_chat()
        before = [dict(m) for m in messages]
        counter_old, counter_new = TokenCounter(), TokenCounter()
        old, old_meta = fit(messages, counter_old, enabled = False)
        new, new_meta = fit(messages, counter_new, enabled = True)
        self.assertEqual(old, new)
        self.assertEqual(old_meta["prompt_tokens_after"], new_meta["prompt_tokens_after"])
        self.assertTrue(old_meta["checkpoint_started"])
        self.assertTrue(new_meta["checkpoint_started"])
        self.assertTrue(new_meta["prompt_tokens_before_is_prefix_probe"])
        self.assertLess(new_meta["prefix_tokenized_messages"], len(messages) // 4)
        self.assertEqual(counter_old.scanned_lengths[0], len(messages))
        self.assertTrue(all(n < len(messages) for n in counter_new.scanned_lengths))
        self.assertEqual(messages, before)
        self.assertEqual(new[-1], messages[-1])

    def test_tool_calls_and_results_are_not_split_by_probe(self):
        messages = long_chat(tools = True)
        counter = TokenCounter()
        answer, meta = fit(messages, counter, enabled = True)
        self.assertTrue(meta["prompt_tokens_before_is_prefix_probe"])
        self.assertTrue(meta["fits"])
        self.assertEqual(answer[-1], messages[-1])
        prefix_messages = meta["prefix_tokenized_messages"]
        self.assertEqual(messages[prefix_messages]["role"], "user")
        self.assertIn(messages[prefix_messages - 1]["role"], ("assistant", "tool"))
        self.assertTrue(all(n < len(messages) for n in counter.scanned_lengths))

    def test_no_proven_overflow_falls_back_to_the_full_exact_count(self):
        messages = long_chat()
        counter = TokenCounter(always_fits = True)
        result, meta = fit(messages, counter, enabled = True)
        self.assertEqual(result, messages)
        self.assertIsNone(meta)
        self.assertEqual(counter.scanned_lengths[-1], len(messages))

    def test_archive_gate_denial_cannot_precompact_a_thread(self):
        messages = long_chat()
        counter = TokenCounter()
        result, meta = fit(messages, counter, enabled = True, can_reset = False)
        self.assertIsNotNone(meta)
        self.assertEqual(counter.scanned_lengths[1], len(messages))
        self.assertNotIn("prompt_tokens_before_is_prefix_probe", meta)
        self.assertEqual(result[-1], messages[-1])

    def test_multimodal_messages_fall_back_to_full(self):
        messages = long_chat()
        messages[1] = {
            **messages[1],
            "content": [
                {"type": "text", "text": "an image"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}},
            ],
        }
        counter = TokenCounter()
        self.assertIsNone(
            bounded_exact_prefix_probe(
                messages,
                context_length = 4096,
                prompt_target = 3584,
                count_tokens = counter,
            )
        )
        fit(messages, counter, enabled = True)
        self.assertEqual(counter.scanned_lengths[0], len(messages))

    def test_no_exact_count_proof_returns_none(self):
        messages = long_chat()
        counter = TokenCounter(always_fits = True)
        found = bounded_exact_prefix_probe(
            messages,
            context_length = 4096,
            prompt_target = 3584,
            count_tokens = counter,
        )
        self.assertIsNone(found)
        self.assertTrue(counter.scanned_lengths)
        self.assertLess(counter.scanned_lengths[0], len(messages))

    def test_probe_tokenizer_exception_uses_unchanged_full_count(self):
        messages = long_chat()
        calls = []

        def broken_then_full(rows):
            calls.append(len(rows))
            # A PREFIX ending on an older turn may be invalid for a model
            # template. The separately selected new active prompt remains
            # valid and still must get an exact count.
            if len(rows) < len(messages) and rows[-1] is not messages[-1]:
                raise ValueError("prefix not valid for this chat template")
            return sum(len(m.get("content", "")) // 4 for m in rows)

        fit(messages, broken_then_full, enabled = True)
        # After falling back to the full count, the production fitter is
        # still required to count the *reduced active prompt* exactly.
        self.assertIn(len(messages), calls)
        self.assertEqual(calls[-1], 2)

    def test_incomplete_tool_batch_disqualifies_probe(self):
        messages = long_chat()
        messages.insert(
            3,
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "no-result", "function": {"name": "x", "arguments": "{}"}}],
            },
        )
        self.assertIsNone(
            bounded_exact_prefix_probe(
                messages,
                context_length = 4096,
                prompt_target = 3584,
                count_tokens = TokenCounter(),
            )
        )

    def test_small_chats_use_only_one_exact_count_even_with_opt_in(self):
        msgs = [
            {"role": "system", "content": "Remain on task."},
            {"role": "user", "content": "Hi."},
        ]
        counter = TokenCounter()
        result, meta = fit(msgs, counter, enabled = True)
        self.assertIsNone(meta)
        self.assertEqual(result, msgs)
        self.assertEqual(counter.scanned_lengths, [len(msgs)])

    def test_manual_compact_keeps_original_explicit_behavior(self):
        messages = long_chat()
        counter = TokenCounter()
        _, meta = fit(messages, counter, enabled = True, force_reset = True)
        self.assertEqual(counter.scanned_lengths[0], len(messages))
        self.assertNotIn("prompt_tokens_before_is_prefix_probe", meta)
        self.assertTrue(meta["manual"])


if __name__ == "__main__":
    unittest.main(verbosity = 2)
