# SPDX-License-Identifier: AGPL-3.0-only
"""Demonstrate archive position scan multiplicity with the actual _occurrences body.

This extracts the production function by AST. The two text normalizers are stubbed
so the test exercises the position-scanning algorithm without embedding packages.
Not a complete archive correctness or Windows timing benchmark.
"""

from __future__ import annotations

import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / "studio/backend/core/rag/conversation_archive.py"


def function_from_source():
    parsed = ast.parse(SOURCE.read_text(encoding = "utf-8"))
    target = next(
        node
        for node in parsed.body
        if isinstance(node, ast.FunctionDef) and node.name == "_occurrences"
    )
    namespace = {
        "_probe_text": lambda item: item.get("content", ""),
        "_normalise_cased": lambda value: value,
    }
    exec(compile(ast.Module(body = [target], type_ignores = []), str(SOURCE), "exec"), namespace)
    return namespace["_occurrences"]


class CountingPositions(list):
    def __init__(self, values):
        super().__init__(values)
        self.scanned = 0

    def __iter__(self):
        for value in super().__iter__():
            self.scanned += 1
            yield value


class ArchiveOccurrenceScaling(unittest.TestCase):
    def test_full_history_scanned_once_per_evicted_turn(self):
        occurrences = function_from_source()
        for n in (60, 180):
            positions = CountingPositions(
                [[f"request-{i}", f"response-{i}"] for i in range(n)]
            )
            for i in range(n):
                group = [
                    {"role": "user", "content": f"request-{i}"},
                    {"role": "assistant", "content": f"response-{i}"},
                ]
                self.assertEqual(occurrences(positions, group), [i])
            # This deterministic counter establishes quadratic scanning, not wall time.
            self.assertEqual(positions.scanned, n * n)

    def test_duplicate_turns_and_final_partial_position_are_preserved(self):
        occurrences = function_from_source()
        positions = [
            ["same request", "reply"],
            ["different request"],
            ["same request", "reply"],
            ["unfinished request"],
        ]
        group = [
            {"content": "same request"},
            {"content": "reply"},
        ]
        self.assertEqual(occurrences(positions, group), [0, 2])
        self.assertEqual(
            occurrences(
                positions,
                [
                    {"content": "unfinished request"},
                    {"content": "not-yet-persisted assistant response"},
                ],
            ),
            [3],
        )


if __name__ == "__main__":
    unittest.main()
