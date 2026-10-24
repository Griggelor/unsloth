# SPDX-License-Identifier: AGPL-3.0-only
"""CI-only: reconcile a complete QA dependency install after pinned mainline wheel replacement.

The original dependency pass wrote its completion manifest for the old package.
A following wheel replacement changes installed distribution version and requirement
file digests. Before any metadata rewrite, verify all boot dependencies and wheel
payload using the installed mainline verify_install implementation.
"""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
from pathlib import Path
import json
import shutil
import sys


def abort(message):
    raise RuntimeError(message)


def main():
    if len(sys.argv) != 3:
        abort('Usage: Finalize-Mainline-Install.py <qa-package-root> <expected-upstream-sha>')
    root = Path(sys.argv[1]).resolve(strict=True)
    sha = sys.argv[2]
    if len(sha) != 40 or any(c not in '0123456789abcdef' for c in sha):
        abort('Invalid upstream source SHA')
    venv = (root / 'qa-runtime/studio/unsloth_studio').resolve(strict=True)
    if Path(sys.prefix).resolve() != venv:
        abort('Interpreter is NOT from staged private QA venv')
    srcinfo = json.loads((root / 'UPSTREAM_MAINLINE_QA_MANIFEST.json').read_text(encoding='utf-8-sig'))
    if srcinfo.get('kind') != 'WINDOWS_PORTABLE_MAINLINE_QA' or srcinfo.get('upstream_sha') != sha:
        abort('Pinned QA source manifest mismatch')
    if srcinfo.get('test_status') != 'relocation and liveness passed':
        abort('QA source package has not passed the relocated backend test')

    archive = venv / 'Lib/site-packages/studio/backend/core/rag/conversation_archive.py'
    if sha256(archive.read_bytes()).hexdigest() != srcinfo.get('archive_sha256'):
        abort('Mainline archive digest mismatch')
    from studio import install_manifest as im
    if not Path(im.__file__).resolve().is_relative_to(venv):
        abort('Nonprivate install_manifest module')
    old = im.read_manifest(venv)
    if not isinstance(old, dict) or old.get('schema') != im.MANIFEST_SCHEMA:
        abort('Original completed-install manifest missing')
    if old.get('package', 'unsloth') != 'unsloth':
        abort('Non-unsloth package in original completion manifest')
    current, conflict = im.installed_version_probe('unsloth', ('unsloth-zoo',))
    if not current or conflict:
        abort('Installed mainline distribution missing or conflicting')
    state_before = im.verify_install(root=venv, req_root=im.requirements_root(), manifest=old)
    print('PRE_FINALIZE_STATE', state_before, flush=True)
    if state_before['ok']:
        print('QA_INSTALL_ALREADY_COMPLETE', flush=True)
        return
    if state_before['reason'] != 'studio_install_version_changed':
        abort('Unexpected install failure before reconciliation: ' + repr(state_before))
    proposed = deepcopy(old)
    proposed['package_version'] = current
    proposed['requirement_files'] = im.requirement_digests(im.requirements_root())
    proposal = im.verify_install(root=venv, req_root=im.requirements_root(), manifest=proposed, deep=True)
    print('PROPOSED_FINAL_STATE', proposal, flush=True)
    if not proposal['ok']:
        damage = im.damaged_payload_files('unsloth', limit=30, budget_seconds=0, companion_names=('unsloth-zoo',))
        for index, entry in enumerate(damage, start=1):
            print('DAMAGED_WHEEL_PAYLOAD_%02d: %s' % (index, entry), flush=True)
        abort('Actual package dependencies or wheel payload are incomplete; refusing metadata rewrite')
    path = im.manifest_path(venv)
    original = path.read_bytes()
    backup = venv / 'unsloth_install_manifest.pre-mainline-ci.json'
    if backup.exists():
        abort('Existing manifest backup unexpectedly present')
    proposed['qa_source_commit'] = sha
    proposed['qa_previous_manifest_sha256'] = sha256(original).hexdigest()
    with im._manifest_lock(venv) as locked:
        if not locked or path.read_bytes() != original:
            abort('Install manifest lock unavailable or metadata changed under lock')
        shutil.copy2(path, backup)
        if not im._publish_json(path, proposed, only_if_present=True):
            abort('Failed to atomically publish validated QA completion manifest')
        checked = im.verify_install(root=venv, deep=True)
        if not checked['ok']:
            shutil.copy2(backup, path)
            abort('Post-write verification failed: ' + repr(checked))
    print('MAINLINE_QA_INSTALL_MANIFEST_VERIFIED', checked, flush=True)


if __name__ == '__main__':
    main()
