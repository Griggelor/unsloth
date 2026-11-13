# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Regression tests for content-free prompt prefix diagnostics."""

import logging
from core.inference.prompt_prefix_diagnostics import _PREVIOUS, record_prefix


def test_prefix_changed_after_first_two_kib(caplog):
    _PREVIOUS.clear()
    source = [{"role": "system", "content": "X" * 3500}, {"role": "user", "content": "private question"}]
    changed = [{"role": "system", "content": "X" * 2048 + "Z" + "X" * 1451}, {"role": "user", "content": "private question"}]
    with caplog.at_level(logging.INFO):
        record_prefix("test-thread", source, [{"name": "one"}])
        record_prefix("test-thread", changed, [{"name": "one"}])
    assert "stable_prefix_chars_floor=2048" in caplog.text
    assert "tools_changed=False" in caplog.text
    assert "private question" not in caplog.text


def test_tools_changed_and_messages_not_logged(caplog):
    _PREVIOUS.clear()
    with caplog.at_level(logging.INFO):
        record_prefix("other-thread", [{"role": "user", "content": "unique sensitive data"}], [{"name": "one"}])
        record_prefix("other-thread", [{"role": "user", "content": "unique sensitive data"}], [{"name": "two"}])
    assert "tools_changed=True" in caplog.text
    assert "unique sensitive data" not in caplog.text
