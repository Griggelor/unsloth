# SPDX-License-Identifier: AGPL-3.0-only
"""QA-only relocation of distlib/uv Windows console launcher to private Python."""
from __future__ import annotations

import io
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import zipfile
from importlib.metadata import entry_points


def valid_zip_exe(blob: bytes) -> None:
    if not blob.startswith(b"MZ"):
        raise RuntimeError("Invalid Windows EXE header")
    with zipfile.ZipFile(io.BytesIO(blob), "r") as archive:
        if "__main__.py" not in archive.namelist() or archive.testzip() is not None:
            raise RuntimeError("Damaged console-script embedded ZIP")


def main() -> None:
    if len(sys.argv) != 2:
        raise RuntimeError("Expected QA root directory argument")
    qa = Path(sys.argv[1]).resolve(strict=True)
    if qa.name.casefold() not in ("portable_unsloth_1911", "qa-context-portable"):
        raise RuntimeError("Unexpected QA package directory: " + str(qa))
    venv = (qa / "qa-runtime/studio/unsloth_studio").resolve(strict=True)
    scripts = (venv / "Scripts").resolve(strict=True)
    py = (scripts / "python.exe").resolve(strict=True)
    exe = (scripts / "unsloth.exe").resolve(strict=True)
    if Path(sys.executable).resolve(strict=True) != py or Path(sys.prefix).resolve() != venv:
        raise RuntimeError("Refusing nonprivate Python")
    if not exe.is_relative_to(qa) or not py.is_relative_to(qa):
        raise RuntimeError("Portable paths escaped QA root")
    eps = [ep for ep in entry_points(group="console_scripts") if ep.name == "unsloth"]
    if len(eps) != 1:
        raise RuntimeError("Ambiguous or missing installed unsloth console-script metadata")
    data = exe.read_bytes()
    valid_zip_exe(data)
    matches = list(re.finditer(rb"#!([^\r\n]{1,4096})\r?\n(?=PK\x03\x04)", data))
    if len(matches) != 1:
        raise RuntimeError("Unable to identify EXACTLY ONE Windows console launcher shebang")
    match = matches[0]
    old = match.group(1).decode("utf-8").strip().strip('"')
    if not old.casefold().endswith(r"\unsloth_studio\scripts\python.exe"):
        raise RuntimeError("Unexpected console interpreter: " + old)
    print("QA_CLI_ORIGINAL_INTERPRETER", old, flush=True)
    if old.casefold() == str(py).casefold():
        print("QA_CLI_ALREADY_BOUND", flush=True)
        return
    patched = data[:match.start()] + ('#!"' + str(py) + '"\n').encode("utf-8") + data[match.end():]
    # Deep Unsloth wheel integrity checks refuse a console executable shorter
    # than the originally installed RECORD size. A moved install can shorten
    # the shebang. Preserve size using a formally valid ZIP archive comment.
    if len(patched) < len(data):
        deficit = len(data) - len(patched)
        eocd = patched.rfind(b"PK\x05\x06")
        if eocd < 0 or eocd + 22 > len(patched):
            raise RuntimeError("ZIP central-directory end marker is missing")
        previous_comment = int.from_bytes(patched[eocd + 20:eocd + 22], "little")
        if eocd + 22 + previous_comment != len(patched) or previous_comment + deficit > 65535:
            raise RuntimeError("Unexpected ZIP comment layout")
        patched = (
            patched[:eocd + 20]
            + (previous_comment + deficit).to_bytes(2, "little")
            + patched[eocd + 22:]
            + (b" " * deficit)
        )
    valid_zip_exe(patched)
    backup = scripts / "unsloth.exe.before-portable-cli-rebind.bak"
    if backup.exists():
        # Repeated relocation is allowed only when the old backup is a valid console EXE.
        valid_zip_exe(backup.read_bytes())
    else:
        shutil.copy2(exe, backup)
        if backup.read_bytes() != data:
            raise RuntimeError("CLI launcher backup failed verification")
    fd, tmp = tempfile.mkstemp(prefix="qa-unsloth-cli-", suffix=".tmp", dir=scripts)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(patched)
            f.flush()
            os.fsync(f.fileno())
        if Path(tmp).read_bytes() != patched:
            raise RuntimeError("Staged launcher differs from validated bytes")
        os.replace(tmp, exe)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    valid_zip_exe(exe.read_bytes())
    print("QA_CLI_PORTABLE_REBIND_OK", py, flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("QA_CLI_PORTABLE_REBIND_FAILED:", type(exc).__name__, str(exc), file=sys.stderr, flush=True)
        raise SystemExit(1)
