# SPDX-License-Identifier: AGPL-3.0-only
"""CPU-only characterization of very long chat histories.

Calls the actual production rolling/checkpoint fit functions with an explicit
synthetic, CPU-scanning counter. No llama-server, tokenizer, GPU or HTTP service
is invoked. SQLite and JSON measurements are clearly labeled *surrogates*;
they are NOT presented as numbers from the production FastAPI endpoint.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import sqlite3
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
from core.inference import context_window as rolling  # noqa: E402
from core.inference import checkpoint  # noqa: E402


class ScanningTokenCount:
    """Models per-call byte traversal; not a model tokenizer or an exact token count."""
    def __init__(self):
        self.calls = 0
        self.scanned_bytes = 0
        self.cpu_seconds = 0.0

    def __call__(self, messages):
        started = time.process_time()
        count = 0
        self.calls += 1
        for message in messages:
            value = message.get("content", "")
            if not isinstance(value, str):
                value = json.dumps(value, ensure_ascii=False)
            encoded = value.encode("utf-8")
            hashlib.blake2b(encoded, digest_size=16).digest()
            self.scanned_bytes += len(encoded)
            count += 4 + (len(encoded) + 3) // 4
        self.cpu_seconds += time.process_time() - started
        return count


def synthetic_history(estimated_tokens: int, max_messages: int = 2048):
    """Allocate one shared payload; HTTP/JSON encoding still walks every message."""
    count = max(6, min(max_messages, (estimated_tokens // 1024) * 2))
    if count % 2:
        count += 1
    chars = max(12, ((estimated_tokens - 256) * 4) // count)
    payload = "SYNTHETIC-NO-USER-DATA " + "x" * max(0, chars - 23)
    messages = [{"role": "system", "content": "Keep the latest user request."}]
    for i in range(count):
        messages.append({
            "role": "user" if i % 2 == 0 else "assistant",
            "content": payload,
        })
    messages.append({"role": "user", "content": "Continue the most recent task."})
    return messages


def approx_tokens(messages):
    return sum(4 + (len(str(m.get("content", "")).encode("utf-8")) + 3) // 4 for m in messages)


def describe_fit(policy, original, context_size: int = 262144):
    counter = ScanningTokenCount()
    started_wall = time.perf_counter()
    started_cpu = time.process_time()
    kwargs = dict(
        context_length=context_size,
        max_tokens=8192,
        count_tokens=counter,
    )
    if policy == "rolling":
        fitted, metadata = rolling.fit_rolling_context(original, **kwargs)
    elif policy in ("checkpoint", "checkpoint_early"):
        prior = os.environ.get("UNSLOTH_CONTEXT_EARLY_PROBE")
        os.environ["UNSLOTH_CONTEXT_EARLY_PROBE"] = "1" if policy == "checkpoint_early" else "0"
        try:
            fitted, metadata = checkpoint.fit_checkpoint_context(
                original, can_reset=True, searchable=False, **kwargs
            )
        finally:
            if prior is None:
                os.environ.pop("UNSLOTH_CONTEXT_EARLY_PROBE", None)
            else:
                os.environ["UNSLOTH_CONTEXT_EARLY_PROBE"] = prior
    else:
        raise ValueError(policy)
    return {
        "kind": "production_context_fit_with_synthetic_count",
        "policy": policy,
        "wall_ms": round((time.perf_counter() - started_wall) * 1000, 3),
        "cpu_ms": round((time.process_time() - started_cpu) * 1000, 3),
        "count_cpu_ms": round(counter.cpu_seconds * 1000, 3),
        "token_count_invocations": counter.calls,
        "counter_bytes_scanned": counter.scanned_bytes,
        "input_messages": len(original),
        "output_messages": len(fitted),
        "fitted_sha256": hashlib.sha256(json.dumps(fitted, sort_keys=True, ensure_ascii=False).encode("utf8")).hexdigest(),
        "output_estimated_tokens": approx_tokens(fitted),
        "dropped_messages": (metadata or {}).get("dropped_messages", 0),
        "fits": (metadata or {}).get("fits", True),
        "prefix_exact_probe_used": (metadata or {}).get("prompt_tokens_before_is_prefix_probe", False),
        "prefix_tokenized_messages": (metadata or {}).get("prefix_tokenized_messages", 0),
    }


def snapshot_surrogate(messages, run_sqlite: bool):
    """Measure Python JSON and SQLite operations, NOT the production FastAPI route."""
    started = time.perf_counter()
    req = json.dumps({"messages": messages}, separators=(",", ":"))
    serialize_ms = 1000 * (time.perf_counter() - started)
    started = time.perf_counter()
    parsed = json.loads(req)["messages"]
    parse_ms = 1000 * (time.perf_counter() - started)
    result = {
        "kind": "json_snapshot_surrogate_not_frontend_or_http",
        "request_bytes": len(req.encode("utf-8")),
        "serialize_ms": round(serialize_ms, 3),
        "parse_ms": round(parse_ms, 3),
    }
    if run_sqlite:
        with tempfile.TemporaryDirectory(prefix="unsloth-context-perf-") as temp:
            connection = sqlite3.connect(str(Path(temp) / "perf.db"))
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT, content TEXT)")
            started = time.perf_counter()
            connection.execute("BEGIN IMMEDIATE")
            connection.executemany(
                "INSERT INTO messages(id,role,content) VALUES (?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET role=excluded.role, content=excluded.content",
                [(i, m["role"], m["content"]) for i, m in enumerate(parsed)],
            )
            connection.commit()
            upsert_ms = 1000 * (time.perf_counter() - started)
            started = time.perf_counter()
            all_rows = connection.execute("SELECT role,content FROM messages ORDER BY id").fetchall()
            fetched_bytes = len(json.dumps(all_rows).encode("utf-8"))
            readback_ms = 1000 * (time.perf_counter() - started)
            result.update({
                "sqlite_kind": "sqlite_upsert_and_full_readback_surrogate_not_studio_db",
                "sqlite_upsert_ms": round(upsert_ms, 3),
                "sqlite_full_readback_ms": round(readback_ms, 3),
                "sqlite_return_bytes": fetched_bytes,
            })
            connection.close()
    return result


def static_production_path_observations():
    """Source evidence only; these flags are not proof of runtime latency."""
    files = {
        "chat_api": ROOT / "studio/frontend/src/features/chat/api/chat-api.ts",
        "studio_db": ROOT / "studio/backend/storage/studio_db.py",
        "chat_history_route": ROOT / "studio/backend/routes/chat_history.py",
        "context_window": ROOT / "studio/backend/core/inference/context_window.py",
        "checkpoint": ROOT / "studio/backend/core/inference/checkpoint.py",
        "llama_cpp": ROOT / "studio/backend/core/inference/llama_cpp.py",
        "inference_route": ROOT / "studio/backend/routes/inference.py",
    }
    src = {k: p.read_text(encoding="utf-8") for k, p in files.items()}
    return {
        "kind": "source_observation_not_execution",
        "full_snapshot_frontend_put": "body: JSON.stringify({" in src["chat_api"] and "pruneMissing:" in src["chat_api"],
        "backend_sync_returns_full_history": "return list_chat_messages(thread_id)" in src["studio_db"],
        "backend_sync_uses_sqlite_batch_upsert": 'conn.executemany(' in src["studio_db"],
        "messages_count_endpoint": '"/messages:counts"' in src["chat_history_route"],
        "rolling_initial_exact_count": "initial_tokens = count_tokens(fitted)" in src["context_window"],
        "checkpoint_initial_exact_count": "initial_tokens = count_tokens(list(messages))" in src["checkpoint"],
        "llama_token_count_via_template": 'f"{self.base_url}/apply-template"' in src["llama_cpp"],
        "llama_token_count_via_tokenize": 'f"{self.base_url}/tokenize"' in src["llama_cpp"],
        "admission_count_on_python_thread": "asyncio.to_thread(" in src["inference_route"] and "_count_gguf_admission_prompt" in src["inference_route"],
    }


def run(output: Path, quick: bool = False):
    cases = [(1024, "1k"), (32768, "32k"), (200000, "200k"),
             (1000000, "1m")]
    if not quick:
        cases.append((10000000, "10m"))
    findings = []
    for token_target, label in cases:
        messages = synthetic_history(token_target)
        row = {
            "case": label,
            "target_estimated_tokens": token_target,
            "actual_estimated_tokens": approx_tokens(messages),
            "characters": sum(len(m["content"]) for m in messages),
            "input_messages": len(messages),
            "fits": [describe_fit(policy, messages) for policy in ("rolling", "checkpoint", "checkpoint_early")],
        }
        # The experimental optimization is allowed to change HOW we obtain the
        # overflow witness, not WHICH conversation is presented to the model.
        # A deterministic hash checks all retained tool/body/role fields.
        conventional, early = row["fits"][1], row["fits"][2]
        for key in ("fitted_sha256", "output_messages", "dropped_messages", "fits"):
            if conventional[key] != early[key]:
                raise AssertionError(
                    f"{label}: early context fit changed {key}: "
                    f"{conventional[key]} vs {early[key]}"
                )
        row["exact_fit_parity"] = "verified"
        # Keep one large snapshot experiment (10m), or 1m in quick mode.
        if label == ("1m" if quick else "10m"):
            row["snapshot"] = snapshot_surrogate(messages, run_sqlite=True)
        findings.append(row)
        print(f"{label}: " + " | ".join(
            f"{m['policy']}: {m['wall_ms']:.1f}ms; "
            f"{m['token_count_invocations']} counts; "
            f"{m['counter_bytes_scanned']/1e6:.1f} MB scanned"
            for m in row["fits"]
        ), flush=True)
    result = {
        "schema_version": 1,
        "commit_sha": os.getenv("GITHUB_SHA", "local"),
        "mode": "quick" if quick else "full",
        "execution_type": "cpu_only_synthetic_no_llama_server",
        "units": "estimated_tokens_are_chars_divided_by_four_not_llama_tokens",
        "runner": {"python": sys.version.split()[0], "os": sys.platform},
        "baseline_characterization": static_production_path_observations(),
        "cases": findings,
        "maxrss_raw_platform_specific": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "limitations": [
            "No local model or llama-server prefill and no true tokenizer timings.",
            "Synthetic hash-scanning counter, not the llama-server count_chat_tokens method.",
            "Python JSON/SQLite snapshot surrogate, not real FastAPI and WebView timing.",
            "Runner wall times are evidence, not stable pass/fail performance budgets.",
            "Early checkpoint is opt-in and assumes the chosen chat template is approximately prefix-monotonic.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"Evidence written: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--quick", action="store_true")
    opts = parser.parse_args()
    run(opts.out, quick=opts.quick)
