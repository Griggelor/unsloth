# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic CPU archive benchmark for https://github.com/unslothai/unsloth/issues/14519.

Exercises archive_turns -> encode_with_identity -> _st_encode -> SentenceTransformer.encode
with real randomly initialized local BERT weights and a synthetic tokenizer. This is
not a full HTTP/compaction/Stop integration test. No user chat or model download.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import time

import pytest


class Metrics:
    def __init__(self):
        self.events = []

    def call(self, name, func, *args, **kwargs):
        start = time.perf_counter()
        cpu = time.process_time()
        try:
            return func(*args, **kwargs)
        finally:
            self.events.append({
                "stage": name,
                "wall_ms": round(1000 * (time.perf_counter() - start), 3),
                "cpu_ms": round(1000 * (time.process_time() - cpu), 3),
            })

    def summarize(self, offset):
        rows = self.events[offset:]
        return {
            name: {
                "calls": len([r for r in rows if r["stage"] == name]),
                "wall_ms": round(sum(r["wall_ms"] for r in rows if r["stage"] == name), 3),
                "cpu_ms": round(sum(r["cpu_ms"] for r in rows if r["stage"] == name), 3),
            }
            for name in sorted({r["stage"] for r in rows})
        }


def local_cpu_bert(tmp_path):
    from transformers import BertConfig, BertModel, BertTokenizerFast
    from sentence_transformers import SentenceTransformer, models

    root = tmp_path / "random-local-bert"
    root.mkdir()
    vocab = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
    vocab += [f"word{i}" for i in range(256)]
    vocabulary = root / "vocab.txt"
    vocabulary.write_text("\n".join(vocab) + "\n", encoding="utf-8")
    BertTokenizerFast(vocab_file=str(vocabulary), do_lower_case=True).save_pretrained(root)
    BertModel(BertConfig(
        vocab_size=len(vocab), hidden_size=128, num_hidden_layers=4,
        num_attention_heads=4, intermediate_size=256, max_position_embeddings=256,
    )).save_pretrained(root)
    transformer = models.Transformer(str(root), max_seq_length=128)
    return SentenceTransformer(modules=[
        transformer,
        models.Pooling(transformer.get_word_embedding_dimension())
    ], device="cpu")


def synthetic_tool_chat(turns):
    history = []
    for i in range(turns):
        args = " ".join(f"word{(i * 7 + j * 13) % 256}" for j in range(92))
        result = " ".join(f"word{(i * 17 + j * 19) % 256}" for j in range(430))
        call_id = f"synthetic-{i}"
        history += [
            {"role": "user", "content": f"Review synthetic task {i}."},
            {"role": "assistant", "content": "", "tool_calls": [{
                "id": call_id, "type": "function",
                "function": {"name": "synthetic_tool", "arguments": json.dumps({"text": args})},
            }]},
            {"role": "tool", "tool_call_id": call_id, "content": result},
            {"role": "assistant", "content": f"Synthetic result word{i % 256}."},
        ]
    return history


@pytest.mark.parametrize("turns", [8, 40])
def test_archive_real_cpu_bert_hotpath(turns, rag_conn, tmp_path, monkeypatch):
    import torch
    from core.rag import config, conversation_archive, embeddings
    from sentence_transformers import SentenceTransformer

    torch.set_num_threads(4)
    torch.manual_seed(1234)
    model = local_cpu_bert(tmp_path)
    assert isinstance(model, SentenceTransformer)
    monkeypatch.setattr(config, "CONVERSATION_ARCHIVE", True)
    monkeypatch.setattr(config, "effective_embedding_model", lambda: "qa-generated-bert")
    monkeypatch.setattr(conversation_archive, "can_archive", lambda tid: True)
    # Exclude transcript mapping, which is not the measured CPU hotspot.
    monkeypatch.setattr(conversation_archive, "_transcript_positions", lambda *a, **k: None)
    monkeypatch.setattr(embeddings, "_get", lambda model_name=None: model)
    monkeypatch.setattr(
        embeddings, "_get_backend",
        lambda model_name=None: embeddings._SentenceTransformersBackend()
    )
    monkeypatch.setattr(config, "CHUNK_TOKENS", 96)
    monkeypatch.setattr(config, "CHUNK_OVERLAP", 16)
    monkeypatch.setattr(
        embeddings, "embedding_identity",
        lambda model_name=None: config.embedding_identity("sentence-transformers", model_name or "qa-generated-bert")
    )

    m = Metrics()
    counts = {"token_counts": 0, "chunk_calls": 0, "batch_chunks": [], "batch_tokens": []}
    original_counter = embeddings.token_counter
    original_chunk = conversation_archive.chunk_pages
    original_encode = embeddings.encode_with_identity
    original_st = embeddings._st_encode
    original_model = model.encode

    def counted_tokenizer(model_name=None):
        counter = original_counter(model_name)
        def count(text):
            counts["token_counts"] += 1
            return counter(text)
        return count

    def timed_chunk(*a, **kw):
        counts["chunk_calls"] += 1
        return m.call("chunk_pages", original_chunk, *a, **kw)

    def timed_embed(texts, **kw):
        counts["batch_chunks"].append(len(texts))
        counts["batch_tokens"].append(sum(
            len(model.tokenizer.encode(t, add_special_tokens=False)) for t in texts
        ))
        return m.call("encode_with_identity", original_encode, texts, **kw)

    monkeypatch.setattr(embeddings, "token_counter", counted_tokenizer)
    monkeypatch.setattr(conversation_archive, "chunk_pages", timed_chunk)
    monkeypatch.setattr(embeddings, "encode_with_identity", timed_embed)
    monkeypatch.setattr(
        embeddings, "_st_encode",
        lambda *a, **kw: m.call("_st_encode", original_st, *a, **kw)
    )
    monkeypatch.setattr(
        model, "encode",
        lambda *a, **kw: m.call("SentenceTransformer.encode", original_model, *a, **kw)
    )

    messages = synthetic_tool_chat(turns)
    tid = f"qa-synthetic-{turns}"
    start_wall = time.perf_counter()
    start_cpu = time.process_time()
    written = conversation_archive.archive_turns(tid, messages)
    first = m.summarize(0)
    wall_ms = 1000 * (time.perf_counter() - start_wall)
    cpu_ms = 1000 * (time.process_time() - start_cpu)
    # Save even a failing outcome to reveal the performance attribution.
    if written <= 0 or first.get("SentenceTransformer.encode", {}).get("calls") != 1:
        pytest.fail(f"Archive/encode was not exercised: written={written} metrics={first}")

    baseline = len(m.events)
    repeated_start = time.perf_counter()
    repeated = conversation_archive.archive_turns(tid, messages)
    repeat_ms = 1000 * (time.perf_counter() - repeated_start)
    repeat = m.summarize(baseline)
    assert repeated == 0
    assert repeat.get("SentenceTransformer.encode", {}).get("calls", 0) == 0

    monkeypatch.setattr(config, "CONVERSATION_ARCHIVE", False)
    baseline = len(m.events)
    disabled_start = time.perf_counter()
    disabled = conversation_archive.archive_turns(f"disabled-{tid}", messages)
    disabled_ms = 1000 * (time.perf_counter() - disabled_start)
    assert disabled == 0 and m.summarize(baseline).get("SentenceTransformer.encode", {}).get("calls", 0) == 0

    report = {
        "scenario": "synthetic long agent chat -> real archive -> CPU SentenceTransformer BERT",
        "limitations": "No HTTP/real model/GUI cancellation, generated small BERT, transcript mapping bypassed",
        "python": os.sys.version.split()[0], "turns": turns,
        "messages": len(messages), "torch_threads": torch.get_num_threads(),
        "written_documents": written, "chunk_calls": counts["chunk_calls"],
        "token_counter_invocations": counts["token_counts"],
        "embedding_batch_chunks": counts["batch_chunks"],
        "embedding_batch_tokens": counts["batch_tokens"],
        "first_wall_ms": round(wall_ms, 3),
        "first_process_cpu_ms": round(cpu_ms, 3),
        "stage_timings": first,
        "repeat_wall_ms": round(repeat_ms, 3),
        "repeat_stage_timings": repeat,
        "archive_off_wall_ms": round(disabled_ms, 3),
    }
    metrics_dir = Path(os.environ.get("RAG_QA_METRICS_DIR") or tmp_path / "metrics")
    metrics_dir.mkdir(parents=True, exist_ok=True)
    (metrics_dir / f"archive_bert_{turns}_turns.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print("QA_ARCHIVE_BERT " + json.dumps(report, sort_keys=True), flush=True)
