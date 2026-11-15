# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0

"""Regression tests for bounded and phase-specific prompt prefix diagnostics."""

import logging

from core.inference.prompt_prefix_diagnostics import _MAX_CHARS, _PREVIOUS, record_prefix


def test_prefix_changed_after_first_two_kib(caplog):
    _PREVIOUS.clear()
    source = [
        {"role": "system", "content": "X" * 3500},
        {"role": "user", "content": "private question"},
    ]
    changed = [
        {"role": "system", "content": "X" * 2048 + "Z" + "X" * 1451},
        {"role": "user", "content": "private question"},
    ]
    with caplog.at_level(logging.INFO):
        record_prefix("test-thread", source, [{"name": "one"}])
        record_prefix("test-thread", changed, [{"name": "one"}])
    assert "stable_prefix_chars_floor=2048" in caplog.text
    assert "tools_changed=False" in caplog.text
    assert "private question" not in caplog.text


def test_tools_changed_and_messages_not_logged(caplog):
    _PREVIOUS.clear()
    with caplog.at_level(logging.INFO):
        record_prefix(
            "other-thread", [{"role": "user", "content": "unique sensitive data"}],
            [{"name": "one"}],
        )
        record_prefix(
            "other-thread", [{"role": "user", "content": "unique sensitive data"}],
            [{"name": "two"}],
        )
    assert "tools_changed=True" in caplog.text
    assert "unique sensitive data" not in caplog.text


def test_phases_have_independent_comparison_baselines(caplog):
    _PREVIOUS.clear()
    source = [{"role": "system", "content": "X" * 3500}]
    changed = [{"role": "system", "content": "X" * 2048 + "Z" + "X" * 1451}]
    with caplog.at_level(logging.INFO):
        record_prefix("test-thread", source, phase = "agent")
        record_prefix("test-thread", changed, phase = "final")
        record_prefix("test-thread", changed, phase = "agent")
    assert "phase=final first_sample=1" in caplog.text
    assert "phase=agent stable_prefix_chars_floor=2048" in caplog.text


def test_large_request_comparison_is_bounded(caplog):
    _PREVIOUS.clear()
    source = [{"role": "user", "content": "X" * (_MAX_CHARS * 8)}]
    with caplog.at_level(logging.INFO):
        record_prefix("long-thread", source)
        record_prefix("long-thread", source)
    assert f"new_sample_chars={_MAX_CHARS}" in caplog.text
    assert "new_capped=1" in caplog.text
    assert len(_PREVIOUS) == 1


def test_diagnostic_serializer_failure_does_not_break_inference(caplog):
    _PREVIOUS.clear()

    class Broken:
        def __str__(self):
            raise ValueError("sensitive exception text")

    with caplog.at_level(logging.WARNING):
        record_prefix("broken-thread", [{"role": "user", "content": Broken()}])
    assert "prompt_prefix_diag unavailable phase=agent" in caplog.text
    assert "sensitive exception text" not in caplog.text


def test_another_thread_does_not_change_baseline(caplog):
    _PREVIOUS.clear()
    message = [{"role": "system", "content": "identical"}]
    with caplog.at_level(logging.INFO):
        record_prefix("thread-a", message)
        record_prefix("thread-b", [{"role": "system", "content": "unrelated"}])
        record_prefix("thread-a", message)
    assert caplog.text.count("first_sample=1") == 2
    assert "stable_prefix_chars_floor=" in caplog.text


def test_final_to_agent_boundary_catches_tool_change(caplog):
    from core.inference.turn_transition_diagnostics import _PREVIOUS_REQUEST, record_request_surface

    _PREVIOUS_REQUEST.clear()
    before = [{"role": "system", "content": "A" * 6500}, {"role": "user", "content": "secret one"}]
    after = [{"role": "system", "content": "A" * 6500}, {"role": "user", "content": "secret one"}, {"role": "user", "content": "secret two"}]
    browser = [{"type": "function", "function": {"name": "browser_navigate"}}]
    with caplog.at_level(logging.INFO):
        record_request_surface("boundary-a", before, phase = "final", tools = browser,
                               source_tools = browser, tool_choice = "none")
        record_request_surface("boundary-a", after, phase = "agent", tools = [],
                               source_tools = browser, tool_choice = "auto")
    assert "turn_boundary_diag" in caplog.text
    assert "tool_choice_changed=True" in caplog.text
    assert "wire_tools_changed=True" in caplog.text
    assert "source_tools_changed=False" in caplog.text
    assert "old_wire_browser=1 new_wire_browser=0" in caplog.text
    assert "secret one" not in caplog.text
    assert "secret two" not in caplog.text


def test_boundary_is_thread_isolated_and_phase_order_matters(caplog):
    from core.inference.turn_transition_diagnostics import _PREVIOUS_REQUEST, record_request_surface

    _PREVIOUS_REQUEST.clear()
    msg = [{"role": "system", "content": "private"}]
    with caplog.at_level(logging.INFO):
        record_request_surface("one", msg, phase = "final")
        record_request_surface("two", msg, phase = "agent")
        record_request_surface("one", msg, phase = "agent")
        record_request_surface("one", msg, phase = "agent")
    assert caplog.text.count("turn_boundary_diag thread=") == 1
    assert "private" not in caplog.text


def test_browser_inventory_and_template_changes_are_reported(caplog):
    from core.inference.turn_transition_diagnostics import _PREVIOUS_REQUEST, record_request_surface

    _PREVIOUS_REQUEST.clear()
    messages = [{"role": "system", "content": "private"}]
    with caplog.at_level(logging.INFO):
        record_request_surface("browser", messages, phase = "final",
                               template_kwargs = {"tools": [{"name": "browser_click"}], "reasoning_effort": "high"})
        record_request_surface("browser", messages, phase = "agent",
                               template_kwargs = {"tools": [], "reasoning_effort": "low"})
    assert "template_tools_changed=True" in caplog.text
    assert "template_other_changed=True" in caplog.text
    assert "old_template_browser=1 new_template_browser=0" in caplog.text
    assert "private" not in caplog.text


def test_surface_serializer_errors_fail_open(caplog):
    from core.inference.turn_transition_diagnostics import _PREVIOUS_REQUEST, record_request_surface

    _PREVIOUS_REQUEST.clear()
    class Broken:
        def __str__(self):
            raise RuntimeError("PRIVATE_EXCEPTION_TEXT")
    with caplog.at_level(logging.WARNING):
        record_request_surface("broken", [{"role": "user", "content": Broken()}], phase = "agent")
    assert "turn_boundary_diag unavailable phase=agent" in caplog.text
    assert "PRIVATE_EXCEPTION_TEXT" not in caplog.text
