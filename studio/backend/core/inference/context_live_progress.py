# SPDX-License-Identifier: AGPL-3.0-only
"""QA-only pre-first-token progress counters. No transcript data is retained."""
from __future__ import annotations

import threading
import time
from utils.account_context import current_account_id

_LOCK = threading.RLock()
_LATEST: dict[str, dict] = {}
_NAMES = {
    "checkpoint.original_exact_count": (2, "Originalhistorie zählen"),
    "llama.apply_template_and_tokenize": (3, "Chat-Template und Tokenizer"),
    "checkpoint.replay_exact_count": (4, "Checkpoint prüfen"),
    "checkpoint.reset_exact_count": (5, "Kompaktierten Kontext zählen"),
    "checkpoint.no_carry_exact_count": (5, "Minimal-Kontext zählen"),
    "conversation_archive.archive_turns": (6, "Alte Turns archivieren"),
    "load_branch_positions": (6, "Archivpositionen laden"),
    "index_branch_positions": (6, "Archivpositionen indizieren"),
    "index_live_positions": (6, "Aktuelle Turns indizieren"),
    "match_evicted_turn": (7, "Archiv-Turns zuordnen"),
    "match_live_turn": (7, "Aktive Turns abgleichen"),
    "chunk_turn": (8, "Archiv-Chunks bilden"),
    "embedding_encode": (9, "Archiv-Embeddings berechnen"),
    "context.ready": (10, "Kontext bereit, Modellübergabe"),
}


def begin(phase: str, *, items: int = 0, total: int = 0) -> None:
    """Only a fixed set of internal phase labels may be sent to the UI."""
    if phase not in _NAMES:
        return
    account = current_account_id()
    now = time.monotonic()
    with _LOCK:
        old = _LATEST.get(account)
        if phase == "checkpoint.original_exact_count" or not old or now - old["updated"] > 1800:
            started = now
        else:
            started = old["started"]
        number, label = _NAMES[phase]
        continuing = bool(old and old["phase"] == phase)
        _LATEST[account] = {
            "stage": number,
            "label": label,
            "phase": phase,
            "items": max(0, int(items)),
            "processed": old["processed"] if continuing else 0,
            "total": max(0, int(total)),
            "started": started,
            "phase_started": old["phase_started"] if continuing else now,
            "updated": now,
            "active": True,
        }


def advance(phase: str, *, processed: int = 0, total: int = 0) -> None:
    account = current_account_id()
    now = time.monotonic()
    with _LOCK:
        item = _LATEST.get(account)
        if not item or item["phase"] != phase:
            return
        item["processed"] = max(0, int(processed))
        if total:
            item["total"] = max(0, int(total))
        item["updated"] = now


def end(phase: str) -> None:
    account = current_account_id()
    with _LOCK:
        item = _LATEST.get(account)
        if item and item["phase"] == phase:
            item["active"] = False
            item["updated"] = time.monotonic()


def snapshot() -> dict:
    """Read-only per-authenticated-account scalars; never block on the work itself."""
    now = time.monotonic()
    with _LOCK:
        item = _LATEST.get(current_account_id())
        if not item or now - item["updated"] > 1800:
            return {"enabled": True, "stage": 1, "label": "Anfrage vorbereiten", "items": 0,
                    "processed": 0, "total": 0, "elapsed_ms": 0, "active": False}
        return {
            "enabled": True,
            "stage": item["stage"],
            "label": item["label"],
            "items": item["items"],
            "processed": item["processed"],
            "total": item["total"],
            "elapsed_ms": int((now - item["phase_started"]) * 1000),
            "active": item["active"],
        }


def clear_for_test() -> None:
    with _LOCK:
        _LATEST.clear()
