# SPDX-License-Identifier: AGPL-3.0-only
"""ASGI HTTP contract benchmark using Unsloth's real FastAPI router + SQLite.

TestClient exercises request validation, dependency resolution, serialization,
actual chat-history routes and actual studio_db storage. It does *not* exercise
Windows networking, a real TCP socket or the frontend, and no model is loaded.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from types import ModuleType

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from storage import studio_db  # noqa: E402

# The global routes/models package initializers import *all* Studio endpoints
# and ML/data layers. This test intentionally mounts the real chat-history
# router alone. Use namespace package wrappers to load its real submodules
# without unrelated startup imports (and their substantial dependencies).
for package in ("routes", "models"):
    stub = ModuleType(package)
    stub.__path__ = [str(ROOT / "studio" / "backend" / package)]
    sys.modules[package] = stub
chat_history = importlib.import_module("routes.chat_history")
from bench_production_storage import messages_for, synthetic_tokens  # noqa: E402


def bench_http(target_tokens: int) -> dict:
    with tempfile.TemporaryDirectory(prefix = "unsloth-production-http-perf-") as home:
        os.environ["UNSLOTH_STUDIO_HOME"] = home
        os.environ["UNSLOTH_STUDIO_PROJECTS_HOME"] = str(Path(home) / "Projects")
        studio_db.reset_schema_state_for_tests()

        thread_id = f"synthetic-http-{target_tokens}"
        studio_db.upsert_chat_thread(
            {
                "id": thread_id,
                "title": "Synthetic HTTP only",
                "modelType": "base",
                "modelId": "not-loaded",
                "pairId": None,
                "archived": False,
                "createdAt": 1_700_000_000_000,
            }
        )
        app = FastAPI()
        app.include_router(chat_history.router, prefix = "/api/chat")
        app.dependency_overrides[chat_history.get_current_subject] = lambda: "synthetic-test-user"

        url = f"/api/chat/threads/{thread_id}/messages"
        messages = messages_for(thread_id, target_tokens)
        body = json.dumps(
            {"messages": messages, "pruneMissing": False, "deletedMessageIds": []},
            separators = (",", ":"),
        )
        size_bytes = len(body.encode("utf-8"))

        with TestClient(app, raise_server_exceptions = True) as client:

            def do_sync():
                t0 = time.perf_counter()
                response = client.put(
                    url,
                    content = body,
                    headers = {"content-type": "application/json"},
                )
                elapsed_ms = round(1000 * (time.perf_counter() - t0), 3)
                if response.status_code != 200:
                    # Never print response contents (even synthetic ones):
                    # CI should not train a habit of dumping real chat payloads.
                    raise AssertionError(f"PUT full-sync failed: HTTP {response.status_code}")
                result = response.json()
                got = result.get("messages")
                assert len(got) == len(messages), (len(got), len(messages))
                assert got[0]["id"] == messages[0]["id"]
                assert got[-1]["id"] == messages[-1]["id"]
                return elapsed_ms, len(response.content)

            first_ms, response_bytes = do_sync()
            repeat_ms, second_response_bytes = do_sync()
            assert second_response_bytes == response_bytes, "unstable unchanged response size"

            t = time.perf_counter()
            response = client.post("/api/chat/messages:counts", json = {"threadIds": [thread_id]})
            counts_ms = round((time.perf_counter() - t) * 1000, 3)
            assert response.status_code == 200
            assert response.json()["countsByThreadId"][thread_id] == len(messages)

            changed = {
                **messages[-1],
                "content": [{"type": "text", "text": "new final message"}],
            }
            t = time.perf_counter()
            response = client.put(
                f"{url}/{changed['id']}",
                json = changed,
            )
            single_ms = round((time.perf_counter() - t) * 1000, 3)
            assert response.status_code == 200, f"single message PUT HTTP {response.status_code}"
            assert response.json()["content"] == changed["content"]
            assert (
                studio_db.get_chat_message(thread_id, messages[0]["id"])["content"]
                == messages[0]["content"]
            )

        return {
            "execution": "real_chat_history_router_fastapi_testclient_actual_sqlite_inprocess_asgi",
            "requested_estimated_tokens": target_tokens,
            "actual_estimated_tokens": synthetic_tokens(messages),
            "message_count": len(messages),
            "request_json_bytes": size_bytes,
            "response_json_bytes": response_bytes,
            "full_put_ms": first_ms,
            "repeat_unchanged_full_put_ms": repeat_ms,
            "counts_post_ms": counts_ms,
            "single_message_put_ms": single_ms,
            "correctness": "two-full-put-responses-count-and-delta-verified",
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokens", type = int, nargs = "+", default = [200000, 1000000])
    parser.add_argument("--out", type = Path, required = True)
    opts = parser.parse_args()

    rows = []
    for target in opts.tokens:
        case = bench_http(target)
        rows.append(case)
        print(
            f"production-asgi {target}: {case['request_json_bytes']/1e6:.2f} MB request, "
            f"{case['response_json_bytes']/1e6:.2f} MB reply; "
            f"PUT={case['full_put_ms']} ms; repeat={case['repeat_unchanged_full_put_ms']} ms; "
            f"count={case['counts_post_ms']} ms; single={case['single_message_put_ms']} ms",
            flush = True,
        )
    opts.out.parent.mkdir(parents = True, exist_ok = True)
    opts.out.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_type": "real_fastapi_route_in_process_asgi_plus_real_sqlite",
                "sha": os.environ.get("GITHUB_SHA", "local"),
                "limitations": [
                    "FastAPI TestClient, not a TCP socket/Windows browser or production reverse proxy.",
                    "Counts are approximate chars/4, not actual llama-server tokenizer tokens.",
                    "No llama-server and no generation pathway exercised.",
                    "Do not compare wall times across dissimilar GitHub-hosted runners as a hard gate.",
                ],
                "cases": rows,
            },
            indent = 2,
        ),
        encoding = "utf-8",
    )


if __name__ == "__main__":
    main()
