# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved.
"""Fast policy guard for an offline, verified install when PyPI still answers.

The real update/idempotency E2E is the behavioral proof. This contract test
checks that both platform launchers enter the same existing fast-path escapes
instead of beginning an upgrade when a newer release is visible.
"""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_newer_pypi_release_cannot_bypass_verified_offline_fast_path():
    scripts = (
        (
            ROOT / "studio" / "setup.ps1",
            "elseif ($InstalledVer -and $LatestVer)",
            "elseif (-not $LatestVer)",
            "(Test-UvOfflineRequested)",
            "(Test-StudioInstallVerified)",
            "$SkipPythonDeps = $true",
            "$script:OfflineFastPath = $true",
            "Invoke-FastPathEscapes",
        ),
        (
            ROOT / "studio" / "setup.sh",
            'elif [ -n "$INSTALLED_VER" ] && [ -n "$LATEST_VER" ]; then',
            'elif [ -z "$LATEST_VER" ]; then',
            "_uv_offline_requested",
            "_setup_install_is_verified",
            "_SKIP_PYTHON_DEPS=true",
            "_OFFLINE_FAST_PATH=true",
            "_fast_path_escapes",
        ),
    )
    for path, begin, end, offline, verified, skip, fast, escapes in scripts:
        script = path.read_text(encoding = "utf-8")
        assert script.count(begin) == 1, path
        branch = script.split(begin, 1)[1].split(end, 1)[0]
        for required in (offline, verified, skip, fast, escapes):
            assert required in branch, f"{path}: missing {required}"
        assert "keeping the verified install" in branch, path
