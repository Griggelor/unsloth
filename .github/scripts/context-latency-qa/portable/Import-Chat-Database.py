# SPDX-License-Identifier: AGPL-3.0-only
"""Opt-in, local-only chat database snapshot for an extracted portable QA build.

Never opens the user's normal Unsloth database for writing. The destination is
strictly the sibling qa-runtime/studio/studio.db of THIS unpacked QA package.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
from datetime import datetime, timezone

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _under(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _open_ro(path: Path) -> sqlite3.Connection:
    # URI mode=ro, plus query_only, prevents SQL writes to the host DB.
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=30000")
    return connection


def _verify_chat_snapshot(conn: sqlite3.Connection) -> tuple[int, int]:
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"chat_threads", "chat_messages"}.issubset(tables):
        raise ValueError("Selected SQLite file does not contain Unsloth chat tables")
    if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise ValueError("Chat database failed SQLite quick_check")
    return (conn.execute("SELECT count(*) FROM chat_threads").fetchone()[0],
            conn.execute("SELECT count(*) FROM chat_messages").fetchone()[0])


def _copy_originals(source_folder: Path, target_folder: Path) -> tuple[int, int]:
    """Copy regular SHA-named original attachments, never follow source links."""
    if not source_folder.exists():
        return (0, 0)
    if source_folder.is_symlink() or not source_folder.is_dir():
        raise ValueError("Chat originals path is not a real directory")
    target_folder.mkdir(parents=True, exist_ok=True)
    copied = 0
    skipped = 0
    with os.scandir(source_folder) as entries:
        for item in entries:
            if not _SHA256.fullmatch(item.name):
                continue
            info = item.stat(follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("Original attachment is not a regular file")
            destination = target_folder / item.name
            if destination.is_symlink():
                raise ValueError("Destination attachment is a symlink")
            if destination.exists():
                if _hash_file(destination) != item.name:
                    raise ValueError("Existing private attachment digest mismatch")
                skipped += 1
                continue
            handle, name = tempfile.mkstemp(prefix=".qa-original-", dir=target_folder)
            try:
                with os.fdopen(handle, "wb") as output, open(item.path, "rb") as inp:
                    digest = hashlib.sha256()
                    for block in iter(lambda: inp.read(1024 * 1024), b""):
                        output.write(block)
                        digest.update(block)
                if digest.hexdigest() != item.name:
                    raise ValueError("Source original attachment digest mismatch")
                if destination.exists():
                    raise ValueError("Destination attachment appeared during import")
                os.replace(name, destination)
                copied += 1
            finally:
                if os.path.exists(name):
                    os.unlink(name)
    return copied, skipped


def import_snapshot(source: Path, qa_package: Path, *, replace: bool = False) -> tuple[int, int, int]:
    qa = qa_package.resolve(strict=True)
    runtime = (qa / "qa-runtime").resolve(strict=True)
    studio = (runtime / "studio").resolve(strict=True)
    if not _under(runtime, qa) or not _under(studio, runtime):
        raise ValueError("Unsafe portable QA layout")
    destination = studio / "studio.db"
    source = source.resolve(strict=True)
    if source.name.lower() != "studio.db" or not source.is_file():
        raise ValueError("Please select the original Unsloth studio.db")
    if _under(source, qa) or _under(destination.resolve(), source.parent):
        raise ValueError("Import source and portable destination must be separate")
    if destination.is_symlink() or not _under(destination.resolve(), studio):
        raise ValueError("Unsafe destination database path")
    if any(Path(str(destination) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Portable database has journal/WAL files; close QA and resolve them before import")
    if destination.exists() and not replace:
        raise FileExistsError("Portable studio.db already exists. Use a fresh QA extraction or explicitly choose -Replace")

    file_descriptor, temporary = tempfile.mkstemp(prefix=".studio-import-", suffix=".db", dir=studio)
    os.close(file_descriptor)
    staging = Path(temporary)
    try:
        with _open_ro(source) as original:
            source_counts = _verify_chat_snapshot(original)
            with sqlite3.connect(staging) as output:
                original.backup(output, pages=256, sleep=0.05)
        with sqlite3.connect(staging) as output:
            copied_counts = _verify_chat_snapshot(output)
            if copied_counts != source_counts:
                raise RuntimeError("Backup row counts do not match the source snapshot")
            output.execute("PRAGMA journal_mode=DELETE")
        if destination.exists():
            backups = studio / "import-backups"
            backups.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = backups / ("studio-before-import-" + stamp + ".db")
            if backup.exists():
                raise FileExistsError("QA backup name collision; retry later")
            with _open_ro(destination) as old:
                with sqlite3.connect(backup) as out:
                    old.backup(out)
            with sqlite3.connect(backup) as out:
                if out.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RuntimeError("Backup of prior QA database is invalid")
        attachments, _ = _copy_originals(source.parent / "chat-originals", studio / "chat-originals")
        os.replace(staging, destination)
        return (*copied_counts, attachments)
    finally:
        staging.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Import normal Unsloth chats into isolated portable QA")
    parser.add_argument("--source", type=Path, required=True, help="Original studio.db (read-only)")
    parser.add_argument("--replace", action="store_true", help="Back up and replace an existing QA-only studio.db")
    args = parser.parse_args()
    try:
        counts = import_snapshot(args.source, Path(__file__).resolve().parent, replace=args.replace)
    except (OSError, sqlite3.Error, RuntimeError, ValueError) as exc:
        print("Import refused:", exc, file=sys.stderr)
        return 1
    print(f"Local QA import completed: {counts[0]} threads, {counts[1]} messages, {counts[2]} original attachment files.")
    print("Source database was opened read-only. No chat content was transmitted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
