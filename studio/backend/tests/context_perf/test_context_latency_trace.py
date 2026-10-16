# SPDX-License-Identifier: AGPL-3.0-only
"""Opt-in trace privacy, ASGI passthrough and concurrent context tests."""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
from utils.context_latency_trace import (  # noqa: E402
    ContextLatencyMiddleware, _kind, trace_call, trace_phase,
)


class ContextLatencyTraceTests(unittest.TestCase):
    def test_route_classification_never_exposes_identifiers(self):
        checks = [
            ("/api/chat/threads/PRIVATE/messages", "PUT", "chat_sync"),
            ("/api/chat/threads/PRIVATE/messages", "GET", "chat_read"),
            ("/api/chat/threads/PRIVATE/messages/SECRET", "PUT", "chat_message_write"),
            ("/api/chat/messages:counts", "POST", "chat_counts"),
            ("/api/chat/messages:batch", "POST", "chat_batch"),
            ("/v1/chat/completions", "POST", "generation"),
            ("/api/models/load", "POST", "model_load"),
            ("/api/chat/threads/PRIVATE/attachments", "PUT", None),
        ]
        for path, method, expected in checks:
            kind = _kind(path, method)
            self.assertEqual(kind, expected)
            self.assertNotIn("PRIVATE", str(kind))
            self.assertNotIn("SECRET", str(kind))

    def test_disabled_mode_no_logging(self):
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_LATENCY_TRACE": "0"}):
            with self.assertNoLogs("studio.context_latency"):
                self.assertEqual(trace_call("checkpoint.initial_exact_count", lambda v: v + 1, 8), 9)
                self.assertEqual(trace_phase("archive")(lambda: "intact")(), "intact")

    def test_exception_does_not_leak_text(self):
        secret = "PRIVATE-EXCEPTION-CONTENT"
        def fail(message):
            raise ValueError(message)
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_LATENCY_TRACE": "1"}):
            with self.assertLogs("studio.context_latency", level=logging.INFO) as got:
                with self.assertRaises(ValueError):
                    trace_call("checkpoint.initial_exact_count", fail, secret)
        output = "\n".join(got.output)
        self.assertNotIn(secret, output)
        self.assertIn("status=error", output)

    def test_asgi_body_passthrough_and_privacy(self):
        secret = b"PRIVATE-PROMPT-NOT-FOR-LOG"
        read_frames = [
            {"type": "http.request", "body": secret[:7], "more_body": True},
            {"type": "http.request", "body": secret[7:], "more_body": False},
        ]
        received = []
        sent = []
        async def endpoint(scope, receive, send):
            received.append(await receive())
            received.append(await receive())
            self.assertEqual(trace_call("db.sync_chat_messages", lambda: 5), 5)
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": secret, "more_body": False})
        async def read():
            return read_frames.pop(0)
        async def send(frame):
            sent.append(frame)
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_LATENCY_TRACE": "1"}):
            with self.assertLogs("studio.context_latency", level=logging.INFO) as got:
                asyncio.run(ContextLatencyMiddleware(endpoint)(
                    {"type": "http", "path": "/api/chat/threads/PRIVATE/messages", "method": "PUT"},
                    read, send,
                ))
        self.assertEqual(received[0]["body"] + received[1]["body"], secret)
        self.assertEqual(sent[-1]["body"], secret)
        output = "\n".join(got.output)
        self.assertIn("request_bytes=26", output)
        self.assertIn("response_bytes=26", output)
        self.assertIn("stage=db.sync_chat_messages", output)
        self.assertNotIn("PRIVATE", output)
        self.assertNotIn("/api/chat", output)

    def test_concurrent_requests_keep_ids_separate(self):
        async def endpoint(scope, receive, send):
            await asyncio.sleep(0)
            trace_call("db.count_chat_messages_for_threads", lambda: None)
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b"", "more_body": False})
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}
        async def send(frame):
            pass
        async def scenario():
            middleware = ContextLatencyMiddleware(endpoint)
            await asyncio.gather(*[
                middleware(
                    {"type": "http", "path": "/api/chat/messages:counts", "method": "POST"},
                    receive, send,
                )
                for _ in range(2)
            ])
        with patch.dict(os.environ, {"UNSLOTH_CONTEXT_LATENCY_TRACE": "1"}):
            with self.assertLogs("studio.context_latency", level=logging.INFO) as got:
                asyncio.run(scenario())
        began = [line for line in got.output if "event=begin" in line]
        ids = [line.split("rid=")[1].split(" ")[0] for line in began]
        self.assertEqual(len(ids), 2)
        self.assertEqual(len(set(ids)), 2)
        for rid in ids:
            self.assertTrue(any("stage=db.count_chat_messages_for_threads rid=" + rid in line for line in got.output))


if __name__ == "__main__":
    unittest.main()
