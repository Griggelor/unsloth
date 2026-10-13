# SPDX-License-Identifier: AGPL-3.0-only
"""Real Studio SQLite persistence benchmark (no mock database, no user data).

The production storage.studio_db functions are invoked unchanged, with a fresh
temporary Studio home per case. The "tokens" parameter approximates bytes/4
and is never reported as a tokenizer's real input token count.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
from storage import studio_db  # noqa: E402


def messages_for(
    thread_id: str,
    target_tokens: int,
    max_messages: int = 2048,
) -> list[dict]:
    rows = max(4, min(max_messages, target_tokens // 256))
    if rows % 2:
        rows += 1
    payload_chars = max(32, (target_tokens * 4) // rows)
    # The payload is deliberately repetitive like agent tool output, with a
    # unique message header so order/corruption can be checked cheaply.
    pad = "Synthetic agent history. " + "Q" * max(0, payload_chars - 30)
    rows_out = []
    for i in range(rows):
        rows_out.append(
            {
                "id": f"msg-{i:06d}",
                "threadId": thread_id,
                "parentId": f"msg-{i-1:06d}" if i else None,
                "role": "user" if i % 2 == 0 else "assistant",
                "content": [{"type": "text", "text": f"TURN:{i:06d}\n" + pad}],
                "attachments": None,
                "metadata": None,
                "createdAt": 1_700_000_000_000 + i,
            }
        )
    return rows_out


def synthetic_tokens(messages: list[dict]) -> int:
    """Approximate count intentionally excludes chat-template overhead."""
    return sum((len(m["content"][0]["text"].encode("utf-8")) + 3) // 4 + 4 for m in messages)


def digest_messages(messages: list[dict]) -> str:
    h = hashlib.sha256()
    for m in messages:
        h.update(m["id"].encode())
        h.update(b"\0")
        h.update(m["content"][0]["text"].encode("utf-8"))
    return h.hexdigest()


def timed(callable_, *args, **kwargs):
    started = time.perf_counter()
    result = callable_(*args, **kwargs)
    return result, round((time.perf_counter() - started) * 1000, 3)


def bench_case(target_tokens: int, *, concurrent_counts: bool = True) -> dict:
    with tempfile.TemporaryDirectory(prefix = "unsloth-production-db-perf-") as temp:
        os.environ["UNSLOTH_STUDIO_HOME"] = temp
        os.environ["UNSLOTH_STUDIO_PROJECTS_HOME"] = str(Path(temp) / "Projects")
        # The production module caches schema readiness by db path. A fresh
        # sandbox and empty cache keep every measurement data-independent.
        studio_db.reset_schema_state_for_tests()
        thread_id = f"synthetic-{target_tokens}"
        thread = {
            "id": thread_id,
            "title": "Synthetic performance",
            "modelType": "base",
            "modelId": "not-loaded",
            "pairId": None,
            "archived": False,
            "createdAt": 1_700_000_000_000,
        }
        studio_db.upsert_chat_thread(thread)
        msgs = messages_for(thread_id, target_tokens)
        expected_digest = digest_messages(msgs)

        # Record substage readback cost using *the real production function*.
        # No SQL or app behavior is changed, only a duration wrapper.
        readback_timings = []
        original_read = studio_db.list_chat_messages

        def measured_read(*args, **kwargs):
            result, elapsed = timed(original_read, *args, **kwargs)
            readback_timings.append(elapsed)
            return result

        studio_db.list_chat_messages = measured_read

        try:
            saved, first_ms = timed(studio_db.sync_chat_messages, thread_id, msgs)
            assert len(saved) == len(msgs)
            assert digest_messages(saved) == expected_digest, "full sync lost/reordered messages"
            first_readback_ms = sum(readback_timings)
            readback_timings.clear()

            # A second identical full snapshot must be correct. Its expense is
            # relevant: it matches repeated client PUTs during a long chat.
            saved_again, repeat_ms = timed(studio_db.sync_chat_messages, thread_id, msgs)
            assert len(saved_again) == len(msgs)
            assert digest_messages(saved_again) == expected_digest
            repeat_readback_ms = sum(readback_timings)
            readback_timings.clear()
        finally:
            studio_db.list_chat_messages = original_read

        # Production count traverses metadata for a branch, not message bodies.
        counts, counts_ms = timed(studio_db.count_chat_messages_for_threads, [thread_id])
        assert counts[thread_id] == len(msgs), (counts, len(msgs))

        # A single-message write is the alternative already available in Studio.
        last = {**msgs[-1], "content": [{"type": "text", "text": "Updated final message"}]}
        _single, single_ms = timed(studio_db.upsert_chat_message, last)
        last_saved = studio_db.get_chat_message(thread_id, last["id"])
        assert last_saved["content"] == last["content"]
        assert studio_db.get_chat_message(thread_id, msgs[0]["id"])["content"] == msgs[0]["content"]

        concurrency_timings = {}
        if concurrent_counts:
            # True concurrent access to production sqlite helpers. The writer
            # updates one existing message; the reader repeatedly counts the
            # branch. Threads use separate sqlite connections under WAL.
            def writer():
                start = time.perf_counter()
                for i in range(3):
                    studio_db.upsert_chat_message(
                        {
                            **last,
                            "content": [{"type": "text", "text": f"Concurrent edit {i}"}],
                        }
                    )
                return 1000 * (time.perf_counter() - start)

            def reader():
                values = []
                for _ in range(5):
                    c, ms = timed(studio_db.count_chat_messages_for_threads, [thread_id])
                    assert c[thread_id] == len(msgs)
                    values.append(ms)
                return values

            with concurrent.futures.ThreadPoolExecutor(max_workers = 2) as pool:
                f_write = pool.submit(writer)
                f_read = pool.submit(reader)
                writer_ms = f_write.result(timeout = 45)
                readers_ms = f_read.result(timeout = 45)
            concurrency_timings = {
                "single_writes_total_ms": round(writer_ms, 3),
                "count_latencies_ms": readers_ms,
                "count_max_ms": max(readers_ms),
            }

        # Recreate the response body produced by ChatMessageListResponse at
        # wire level; do not call this an HTTP timing or Pydantic benchmark.
        _, jsonify_ms = timed(json.dumps, {"messages": saved}, ensure_ascii = False)
        response_estimate_bytes = len(
            json.dumps({"messages": saved}, ensure_ascii = False).encode("utf-8")
        )
        total_ms = first_ms + repeat_ms
        return {
            "execution": "actual_production_storage_studio_db_no_http_no_llama",
            "requested_estimated_tokens": target_tokens,
            "actual_estimated_tokens": synthetic_tokens(msgs),
            "message_count": len(msgs),
            "input_text_bytes": sum(len(m["content"][0]["text"]) for m in msgs),
            "response_json_bytes": response_estimate_bytes,
            "first_full_sync_ms": first_ms,
            "first_full_readback_ms": round(first_readback_ms, 3),
            "repeat_unchanged_full_sync_ms": repeat_ms,
            "repeat_full_readback_ms": round(repeat_readback_ms, 3),
            "two_full_syncs_ms": round(total_ms, 3),
            "counts_ms": counts_ms,
            "single_message_upsert_ms": single_ms,
            "response_json_encode_ms": jsonify_ms,
            "concurrent": concurrency_timings,
            "db_bytes": sum(p.stat().st_size for p in Path(temp).rglob("*.db*") if p.is_file()),
            "correctness": "full-and-repeat-snapshots-and-branch-counts-verified",
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tokens", type = int, nargs = "+", default = [200000, 1000000, 10000000])
    parser.add_argument("--out", type = Path, required = True)
    parser.add_argument("--no-concurrency", action = "store_true")
    args = parser.parse_args()
    rows = []
    for tokens in args.tokens:
        result = bench_case(tokens, concurrent_counts = not args.no_concurrency)
        rows.append(result)
        print(
            f"production-sqlite {tokens}: {result['message_count']} msgs, "
            f"first={result['first_full_sync_ms']} ms, "
            f"repeat={result['repeat_unchanged_full_sync_ms']} ms, "
            f"readback={result['first_full_readback_ms']} ms, "
            f"count={result['counts_ms']} ms, delta={result['single_message_upsert_ms']} ms",
            flush = True,
        )
    args.out.parent.mkdir(parents = True, exist_ok = True)
    args.out.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "run_type": "production_db_not_http",
                "commit_sha": os.environ.get("GITHUB_SHA", "local"),
                "python": sys.version.split()[0],
                "platform": sys.platform,
                "limitations": [
                    "Not a model tokenizer, estimated tokens are roughly bytes / four.",
                    "No HTTP transfer, WebView, Pydantic model validation or llama-server.",
                    "GitHub-hosted Linux runner, not representative of Windows disk/CPU latency.",
                    "No performance success claim from runner timings; compare same-hardware repeated runs.",
                ],
                "cases": rows,
            },
            indent = 2,
        ),
        encoding = "utf-8",
    )


if __name__ == "__main__":
    main()
