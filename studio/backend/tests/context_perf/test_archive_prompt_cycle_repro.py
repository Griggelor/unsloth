# SPDX-License-Identifier: AGPL-3.0-only
"""Reproduce multi-compaction, multi-prompt archive behavior with no user data.

This test uses production group_turns/truncate_oldest_messages/evicted_messages,
persisted synthetic tool-call parts, a real isolated SQLite RAG DB, and the
deterministic embedder from the existing QA fixtures. Separate CPU BERT benchmark
covers encode cost. All diagnostics are numeric: no chat content is published.
"""
from __future__ import annotations

import json
import os
import time
from collections import Counter
from pathlib import Path

import pytest

from core.inference.context_window import (
    evicted_messages,
    group_turns,
    truncate_oldest_messages,
)
from core.rag import config, conversation_archive, embeddings, store
from storage import studio_db


def _cycle(i: int) -> list[dict]:
    """One persisted agent cycle: user / assistant tool card / assistant reply."""
    payload = " ".join(f"synthetic_{i}_{(j * 7 + i) % 43}" for j in range(45))
    return [
        {"role": "user", "content": [{"type": "text", "text": f"Task {i} unique synthetic marker {i*i}"}]},
        {"role": "assistant", "content": [{
            "type": "tool-call", "toolCallId": f"qa-call-{i}", "toolName": "synthetic_file_search",
            "args": {"query": f"query {i}", "limit": 8}, "result": payload,
        }]},
        {"role": "assistant", "content": [{"type": "text", "text": f"Agent summary {i} synthetic unique {i * 17}"}]},
    ]


def _append(thread_id: str, rows: list[dict]) -> None:
    studio_db.upsert_chat_thread({
        "id": thread_id,
        "title": "synthetic QA thread",
        "modelType": "base",
        "modelId": "synthetic-local-model",
        "createdAt": 1,
    })
    initial = len(studio_db.list_chat_messages(thread_id) or [])
    for index, row in enumerate(rows):
        studio_db.upsert_chat_message({
            "id": f"{thread_id}-row-{initial+index}",
            "threadId": thread_id,
            "role": row["role"],
            "content": row["content"],
            "createdAt": initial + index + 2,
        })


def _wire(thread_id: str) -> list[dict]:
    return conversation_archive._as_wire(studio_db.list_chat_messages(thread_id) or [])


def _archive_cycle(thread_id: str, *, keep_ratio: float = 0.43) -> tuple[int, int, int]:
    before = _wire(thread_id)
    after, dropped = truncate_oldest_messages(before, keep_ratio)
    gone = evicted_messages(before, after)
    assert dropped and gone, "Synthetic transcript must trigger actual rolling compaction"
    # live and branch are passed as production _archive_and_recall does.
    written = conversation_archive.archive_turns(
        thread_id, gone, live=after, branch=before,
    )
    return written, len(group_turns(gone)), len(gone)


class Counters:
    def __init__(self, monkeypatch):
        self.total = Counter()
        self.events = []
        self.fail_next_encode = False
        self.original_embed = embeddings.encode_with_identity
        original_chunk = conversation_archive.chunk_pages
        original_precheck = conversation_archive._archived_under
        original_create = store.create_document
        original_positions = conversation_archive._transcript_positions

        def embed(texts, **kwargs):
            self.total["embedding_calls"] += 1
            self.total["embedding_chunks"] += len(texts)
            if self.fail_next_encode:
                self.fail_next_encode = False
                self.total["forced_encode_failure"] += 1
                raise RuntimeError("QA injected synthetic embedding failure")
            return self.original_embed(texts, **kwargs)

        def chunk(*args, **kwargs):
            self.total["chunking_calls"] += 1
            return original_chunk(*args, **kwargs)

        def precheck(*args, **kwargs):
            self.total["precheck_calls"] += 1
            found = original_precheck(*args, **kwargs)
            self.total["precheck_hits" if found else "precheck_misses"] += 1
            return found

        def create(*args, **kwargs):
            self.total["document_create_calls"] += 1
            return original_create(*args, **kwargs)

        def positions(*args, **kwargs):
            self.total["position_lookup_calls"] += 1
            return original_positions(*args, **kwargs)

        monkeypatch.setattr(embeddings, "encode_with_identity", embed)
        monkeypatch.setattr(conversation_archive, "chunk_pages", chunk)
        monkeypatch.setattr(conversation_archive, "_archived_under", precheck)
        monkeypatch.setattr(conversation_archive, "_transcript_positions", positions)
        monkeypatch.setattr(store, "create_document", create)

    def snap(self):
        return dict(self.total)

    def delta(self, start):
        return {k: self.total[k] - start.get(k, 0) for k in sorted(set(start) | set(self.total))}


def _docs(conn, thread_id):
    return store.list_documents(conn, store.conversation_archive_scope(thread_id))


def _execute(counters, conn, thread_id, phase, *, fail=False):
    before = counters.snap()
    before_docs = _docs(conn, thread_id)
    if fail:
        counters.fail_next_encode = True
    start = time.perf_counter()
    written, evicted_groups, evicted_messages_count = _archive_cycle(thread_id)
    elapsed = round((time.perf_counter() - start)*1000, 3)
    after_docs = _docs(conn, thread_id)
    d = counters.delta(before)
    item = {
        "phase": phase,
        "evicted_groups": evicted_groups,
        "evicted_messages": evicted_messages_count,
        "stored_docs_before": len(before_docs),
        "stored_docs_after": len(after_docs),
        "written_returned": written,
        "wall_ms": elapsed,
        **d,
    }
    print("QA_CYCLE " + json.dumps(item, sort_keys=True), flush=True)
    return item


def _record(scenario, records):
    root = Path(os.environ.get("RAG_CYCLE_METRICS_DIR") or ".pytest_cache/rag_cycle")
    root.mkdir(parents=True, exist_ok=True)
    (root / (scenario + ".json")).write_text(
        json.dumps({"scenario": scenario, "records": records}, indent=2)+"\n", encoding="utf-8"
    )


@pytest.fixture
def isolated_archive(rag_home, rag_conn, stub_embeddings, monkeypatch):
    monkeypatch.setattr(config, "CONVERSATION_ARCHIVE", True)
    return rag_conn


def test_agent_prompt_compaction_reuses_saved_turns(isolated_archive, monkeypatch):
    """Prompt1 -> growing agent tool loop -> Prompt2 -> repeat Prompt2.

    The second compaction sees most turns previously evicted. It must not
    re-embed successful writes, even though the full transcript grew.
    """
    conn = isolated_archive
    tid = "qa-agent-repeat-success"
    counts = Counters(monkeypatch)
    _append(tid, sum((_cycle(i) for i in range(15)), []))
    _append(tid, [{"role": "user", "content": [{"type": "text", "text": "Prompt 1 synthetic"}]}])
    a = _execute(counts, conn, tid, "prompt1_compaction")
    assert a["stored_docs_after"] > 0 and a.get("embedding_chunks", 0) > 0

    # Agent executes additional tools after prompt 1, fills the window again.
    _append(tid, [{"role": "assistant", "content": [{"type": "text", "text": "Prompt 1 reply"}]}])
    _append(tid, sum((_cycle(i) for i in range(15, 21)), []))
    b = _execute(counts, conn, tid, "agent_tool_refill_compaction")
    assert b.get("precheck_hits", 0) > 0

    _append(tid, sum((_cycle(i) for i in range(21, 26)), []))
    _append(tid, [{"role": "user", "content": [{"type": "text", "text": "Prompt 2 synthetic"}]}])
    c = _execute(counts, conn, tid, "prompt2_compaction")
    assert c.get("precheck_hits", 0) > 0

    # An identical compaction of the same transcript MUST be a pure dedup pass.
    d = _execute(counts, conn, tid, "prompt2_identical_repeat")
    assert d.get("embedding_chunks", 0) == 0, d
    assert d.get("chunking_calls", 0) == 0, d
    assert d["written_returned"] == 0
    # Every initially archived entry must remain in the store.
    assert len(_docs(conn, tid)) >= a["stored_docs_after"]
    _record("prompt_growth_success", [a, b, c, d])


def test_failed_first_embed_repeats_all_evicted_chunks_next_prompt(isolated_archive, monkeypatch):
    """If the first giant encode fails before writes, next prompt redoes old work."""
    conn = isolated_archive
    tid = "qa-agent-repeat-failure"
    counts = Counters(monkeypatch)
    _append(tid, sum((_cycle(i) for i in range(15)), []))
    _append(tid, [{"role": "user", "content": [{"type": "text", "text": "Prompt 1 synthetic"}]}])
    a = _execute(counts, conn, tid, "prompt1_failed_encode", fail=True)
    assert a["written_returned"] == 0
    assert a["stored_docs_after"] == 0
    assert a.get("forced_encode_failure",0) == 1

    # The saved transcript is identical. After a failed/aborted encode, there
    # is no database checkpoint of chunks that finished computation.
    b = _execute(counts, conn, tid, "same_context_retry")
    assert b.get("embedding_chunks", 0) == a.get("embedding_chunks", 0)
    assert b.get("precheck_hits", 0) == 0
    assert b["stored_docs_after"] > 0

    c = _execute(counts, conn, tid, "same_context_after_success")
    assert c.get("embedding_chunks", 0) == 0
    assert c.get("precheck_hits", 0) > 0
    _record("failed_first_embed_repeat", [a,b,c])


def test_noop_compaction_with_growing_transcript_stays_fast(isolated_archive, monkeypatch):
    """Grow persisted transcript without changing a previously evicted subset."""
    conn = isolated_archive
    tid = "qa-agent-repeated-original-subset"
    counts = Counters(monkeypatch)
    _append(tid, sum((_cycle(i) for i in range(15)), []))
    wire = _wire(tid)
    live, _ = truncate_oldest_messages(wire, 0.43)
    old_evicted = evicted_messages(wire, live)
    assert old_evicted
    assert conversation_archive.archive_turns(tid, old_evicted, live=live, branch=wire) > 0
    _append(tid, sum((_cycle(i) for i in range(15,25)), []))
    start = counts.snap()
    t0 = time.perf_counter()
    newwire = _wire(tid)
    written = conversation_archive.archive_turns(tid, old_evicted, live=live, branch=newwire)
    elapsed = round((time.perf_counter()-t0)*1000, 3)
    d = counts.delta(start)
    print("QA_CYCLE " + json.dumps({
        "phase": "same_evicted_subset_after_agent_growth",
        "written": written, "wall_ms": elapsed, **d,
    },sort_keys=True),flush=True)
    assert written == 0
    assert d.get("embedding_chunks",0) == 0
    assert d.get("chunking_calls",0) == 0
    _record("persisted_growth_reuse", [{"phase":"repeat_subset", "wall_ms":elapsed, **d}])


def test_changed_embedding_identity_intentionally_recomputes(isolated_archive, monkeypatch):
    """Re-embedding after changing the vector-space identity is expected, not a dedup bug."""
    conn = isolated_archive
    tid = "qa-agent-identity-change"
    counts = Counters(monkeypatch)
    _append(tid, sum((_cycle(i) for i in range(8)), []))
    wire = _wire(tid)
    live,_ = truncate_oldest_messages(wire,0.43)
    evicted = evicted_messages(wire,live)
    assert conversation_archive.archive_turns(tid,evicted,live=live,branch=wire) > 0
    first = counts.snap()
    actual_identity=embeddings.embedding_identity
    # The next encode's predicted and written identities change together.
    monkeypatch.setattr(embeddings, "embedding_identity", lambda model_name=None: "st-qa-identity-v2")
    wrote = conversation_archive.archive_turns(tid,evicted,live=live,branch=wire)
    changed = counts.delta(first)
    print("QA_CYCLE " + json.dumps({
        "phase":"intentional_identity_change", "written":wrote, **changed
    },sort_keys=True),flush=True)
    assert changed.get("embedding_chunks",0) > 0
    assert changed.get("precheck_misses",0) > 0
    monkeypatch.setattr(embeddings,"embedding_identity",actual_identity)
    _record("identity_change", [{"phase":"intentional_identity_change",**changed}])
