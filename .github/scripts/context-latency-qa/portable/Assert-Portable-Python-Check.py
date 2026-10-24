# SPDX-License-Identifier: AGPL-3.0-only
"""Validate the exact private CPython used by the isolated Portable QA.

A dedicated source file avoids Windows PowerShell 5.1's native argv quoting
removing embedded Python string quotes when using python -c.
"""
from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("Usage: validate.py <private_studio_root> <private_base_python_dir>")
    studio = Path(sys.argv[1]).resolve(strict=True)
    venv = (studio / 'unsloth_studio').resolve(strict=True)
    base = Path(sys.argv[2]).resolve(strict=True)
    exe = (venv / 'Scripts' / 'python.exe').resolve(strict=True)
    if Path(sys.prefix).resolve(strict=True) != venv:
        raise RuntimeError('QA virtual environment prefix mismatch')
    if Path(sys.base_prefix).resolve(strict=True) != base:
        raise RuntimeError('QA private CPython base mismatch')
    if Path(sys.executable).resolve(strict=True) != exe:
        raise RuntimeError('QA private Python executable mismatch')
    for entry in sys.path:
        if entry and not Path(entry).resolve().is_relative_to(studio):
            raise RuntimeError('Python import path escaped the private QA runtime: ' + entry)
    import studio.backend.utils.context_latency_trace as trace
    import unsloth_cli
    for mod in (trace, unsloth_cli):
        origin = Path(mod.__file__).resolve(strict=True)
        if not origin.is_relative_to(venv):
            raise RuntimeError('Imported external module: ' + str(origin))
    print('PRIVATE_PYTHON_VALIDATION_OK')


if __name__ == '__main__':
    main()
