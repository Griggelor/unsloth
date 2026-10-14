# SPDX-License-Identifier: AGPL-3.0-only
"""Independent QA tests; no model or full Studio installation required."""
import asyncio
import importlib.util
from pathlib import Path
import threading
import unittest
import uuid

_PATH = Path(__file__).resolve().parents[2] / "core" / "inference" / "working_progress.py"
spec = importlib.util.spec_from_file_location("qa_working_progress", _PATH)
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)


class TestWorkingProgress(unittest.TestCase):
    def test_subject_isolation_and_lifecycle(self):
        rid = uuid.uuid4().hex
        key = progress.begin("owner-a", rid)
        self.assertIsNotNone(key)
        self.assertIsNone(progress.snapshot("owner-b", rid))
        self.assertIsNone(progress.begin("owner-a", rid))
        token = progress.activate(key)
        try:
            progress.publish("checkpoint.original_exact_count", current = 500,
                             total = 2000, unit = "messages")
        finally:
            progress.reset(token)
        row = progress.snapshot("owner-a", rid)
        self.assertEqual((row["phase"], row["current"], row["total"]),
                         ("checkpoint.original_exact_count", 500, 2000))
        self.assertEqual(row["status"], "running")
        self.assertNotIn("owner-a", repr(row))
        progress.finish(key)
        self.assertEqual(progress.snapshot("owner-a", rid)["status"], "done")

    def test_durable_worker_only_attaches_when_registered_by_owner(self):
        rid = uuid.uuid4().hex
        self.assertIsNone(progress.attach("owner-x", rid))
        key = progress.begin("owner-x", rid)
        self.assertEqual(progress.attach("owner-x", rid), key)
        self.assertIsNone(progress.attach("another-account", rid))
        self.assertIsNone(progress.attach("owner-x", "../" + rid))
        token = progress.activate(progress.attach("owner-x", rid))
        try:
            progress.publish("checkpoint.original_exact_count", total = 550,
                             current = 0, unit = "messages")
        finally:
            progress.reset(token)
        self.assertEqual(progress.snapshot("owner-x", rid)["phase"],
                         "checkpoint.original_exact_count")
        self.assertIsNone(progress.snapshot("another-account", rid))
        progress.finish(key)
        self.assertIsNone(progress.attach("owner-x", rid))

    def test_bad_ids_and_unscoped_calls_are_inert(self):
        self.assertIsNone(progress.begin("a", "../user"))
        self.assertIsNone(progress.begin("", uuid.uuid4().hex))
        progress.publish("checkpoint.original_exact_count", current = 9000)
        self.assertIsNone(progress.snapshot("a", "../user"))

    def test_cross_thread_status_visible_while_backend_blocked(self):
        rid = uuid.uuid4().hex
        key = progress.begin("owner-b", rid)
        started, unblock = threading.Event(), threading.Event()
        def blocked():
            token = progress.activate(key)
            try:
                progress.publish("checkpoint.original_exact_count", current = 500,
                                 total = 4000, unit = "messages")
                started.set()
                self.assertTrue(unblock.wait(timeout = 2))
            finally:
                progress.reset(token)
        thread = threading.Thread(target = blocked)
        thread.start()
        try:
            self.assertTrue(started.wait(timeout = 2))
            snap = progress.snapshot("owner-b", rid)
            self.assertEqual(snap["current"], 500)
            self.assertEqual(snap["status"], "running")
        finally:
            unblock.set()
            thread.join(timeout = 3)
            progress.finish(key)

    def test_async_stream_binding_propagates_and_cleans_up(self):
        rid = uuid.uuid4().hex
        key = progress.begin("owner-c", rid)
        async def stream():
            progress.publish("embedding_encode", current = 2, total = 4, unit = "chunks")
            yield "content"
        async def run():
            return [part async for part in progress.bind_response_stream(stream(), key)]
        self.assertEqual(asyncio.run(run()), ["content"])
        snap = progress.snapshot("owner-c", rid)
        self.assertEqual(snap["phase"], "embedding_encode")
        self.assertEqual(snap["status"], "done")

    def test_early_stream_close_runs_original_backend_cleanup(self):
        rid = uuid.uuid4().hex
        key = progress.begin("owner-close", rid)
        cleaned = []
        async def original():
            try:
                yield "first"
                await asyncio.sleep(30)
            finally:
                cleaned.append("released")
        async def stop_early():
            wrapper = progress.bind_response_stream(original(), key)
            self.assertEqual(await wrapper.__anext__(), "first")
            await wrapper.aclose()
        asyncio.run(stop_early())
        self.assertEqual(cleaned, ["released"])
        self.assertEqual(progress.snapshot("owner-close", rid)["status"], "failed")

    def test_capacity_bound(self):
        for _ in range(140):
            progress.begin("cap", uuid.uuid4().hex)
        self.assertLessEqual(len(progress._records), 128)


if __name__ == "__main__":
    unittest.main()
