# SPDX-License-Identifier: AGPL-3.0-only
"""Verify indexing preserves the production archive matcher and avoids quadratic scans.

AST extraction executes actual _occurrences and _position_index without loading RAG
dependencies. This is a targeted deterministic test, not a Windows replay.
"""

from __future__ import annotations

import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / "studio/backend/core/rag/conversation_archive.py"


def matcher_functions():
    parsed = ast.parse(SOURCE.read_text(encoding = "utf-8"))
    target = [
        node
        for node in parsed.body
        if isinstance(node, ast.FunctionDef)
        and node.name in ("_occurrences", "_position_index")
    ]
    assert len(target) == 2
    namespace = {
        "_probe_text": lambda item: item.get("content", ""),
        "_normalise_cased": lambda value: value,
    }
    exec(compile(ast.Module(body = target, type_ignores = []), str(SOURCE), "exec"), namespace)
    return namespace["_occurrences"], namespace["_position_index"]


class CountingPositions(list):
    def __init__(self, values):
        super().__init__(values)
        self.scanned = 0

    def __getitem__(self, index):
        # Count actual examined positions with both range() and indexed candidates.
        if isinstance(index, int):
            self.scanned += 1
        return super().__getitem__(index)


class ArchiveOccurrenceScaling(unittest.TestCase):
    def test_index_keeps_results_and_replaces_quadratic_scans(self):
        occurrences, index_positions = matcher_functions()
        for n in (60, 180):
            positions = CountingPositions(
                [[f"request-{i}", f"response-{i}"] for i in range(n)]
            )
            groups = [
                [
                    {"role": "user", "content": f"request-{i}"},
                    {"role": "assistant", "content": f"response-{i}"},
                ]
                for i in range(n)
            ]
            baseline = [occurrences(positions, group) for group in groups]
            self.assertEqual(baseline, [[i] for i in range(n)])
            self.assertEqual(positions.scanned, n * n)
            index = index_positions(positions)
            self.assertEqual(positions.scanned, n * n)
            indexed = [
                occurrences(positions, group, position_index = index)
                for group in groups
            ]
            self.assertEqual(indexed, baseline)
            self.assertLessEqual(positions.scanned, n * n + 2 * n)

    def test_duplicates_partial_last_and_tool_arguments_preserved(self):
        occurrences, index_positions = matcher_functions()
        positions = [
            ["same request", "reply"],
            ["different request"],
            ["same request", "reply"],
            ["unfinished request"],
            ["assistant call args plus details", "tool result"],
        ]
        groups = [
            [{"content": "same request"}, {"content": "reply"}],
            [{"content": "unfinished request"}, {"content": "unpersisted reply"}],
            [
                {"content": "assistant call args", "tool_calls": [{"id": "tool"}]},
                {"content": "tool result"},
            ],
            [{"content": "missing content"}],
        ]
        index = index_positions(positions)
        for group in groups:
            self.assertEqual(
                occurrences(positions, group, position_index = index),
                occurrences(positions, group),
            )

    def test_all_tool_calls_still_use_fuzzy_fallback(self):
        occurrences, index_positions = matcher_functions()
        positions = [["assistant call args plus details"], ["different tool"]]
        group = [{"content": "assistant call args", "tool_calls": [{"id": "a"}]}]
        self.assertEqual(occurrences(positions, group), [0])
        self.assertEqual(
            occurrences(positions, group, position_index = index_positions(positions)),
            [0],
        )


if __name__ == "__main__":
    unittest.main()
