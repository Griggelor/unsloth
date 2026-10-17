# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic host WAL + QA import regression; no user content or host install access."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest

DEFAULT = Path(__file__).resolve().parent.parent / "portable" / "Import-Chat-Database.py"


class LocalChatImportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.importer = Path(os.environ.get("UNSLOTH_QA_TEST_IMPORTER") or DEFAULT).resolve()
        assert cls.importer.is_file(), cls.importer

    def test_live_wal_snapshot_and_isolation(self):
        with tempfile.TemporaryDirectory(prefix="qa-chat-Ü-") as td:
            root = Path(td)
            qa = root / "Unsloth QA with spaces Ü"
            (qa / "qa-runtime" / "studio").mkdir(parents=True)
            shutil.copyfile(self.importer, qa / "Import-Chat-Database.py")
            normal = root / "SYNTHETIC normal installation"
            normal.mkdir()
            original_db = normal / "studio.db"
            conn = sqlite3.connect(original_db)
            try:
                self.assertEqual(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
                conn.execute("CREATE TABLE chat_threads(id TEXT PRIMARY KEY, title TEXT)")
                conn.execute("CREATE TABLE chat_messages(id TEXT PRIMARY KEY, thread_id TEXT, content_json TEXT)")
                conn.execute("INSERT INTO chat_threads VALUES(?,?)", ("synthetic-one", "Troubleshooting Ü"))
                conn.execute("INSERT INTO chat_messages VALUES(?,?,?)", ("synthetic-m1", "synthetic-one", "fake user data"))
                conn.commit()
                before_hash = hashlib.sha256(original_db.read_bytes()).hexdigest()
                originals = normal / "chat-originals"
                originals.mkdir()
                data = b"only fake original content"
                digest = hashlib.sha256(data).hexdigest()
                (originals / digest).write_bytes(data)
                cmd = [sys.executable, "-I", "-B", str(qa / "Import-Chat-Database.py"), "--source", str(original_db)]
                result = subprocess.run(cmd, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn("fake user data", result.stdout)
                self.assertEqual(hashlib.sha256(original_db.read_bytes()).hexdigest(), before_hash)
                copied_db = qa / "qa-runtime" / "studio" / "studio.db"
                with sqlite3.connect(copied_db) as copied:
                    self.assertEqual(copied.execute("SELECT count(*) FROM chat_threads").fetchone()[0], 1)
                    self.assertEqual(copied.execute("SELECT content_json FROM chat_messages").fetchone()[0], "fake user data")
                self.assertEqual((copied_db.parent / "chat-originals" / digest).read_bytes(), data)
                duplicate = subprocess.run(cmd, capture_output=True, text=True)
                self.assertNotEqual(duplicate.returncode, 0, "Must refuse unintended overwrite")
                replace = subprocess.run(cmd + ["--replace"], capture_output=True, text=True)
                self.assertEqual(replace.returncode, 0, replace.stderr)
                self.assertEqual(len(list((copied_db.parent / "import-backups").glob("*.db"))), 1)
                private_source = subprocess.run(cmd[:-1] + [str(copied_db), "--replace"], capture_output=True, text=True)
                self.assertNotEqual(private_source.returncode, 0, "Must refuse self-import")
                self.assertEqual(conn.execute("SELECT count(*) FROM chat_threads").fetchone()[0], 1)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
