# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic local-only probe tests; no model, server or private data required."""
import json
import logging
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.inference import prompt_prefix_probe as probe  # noqa: E402


def test_common_prefix_exact_ids():
    assert probe.common_prefix_tokens([11, 2, 3], [11, 2, 9, 10]) == 2
    assert probe.common_prefix_tokens([1, 2], [1, 2, 3]) == 2
    assert probe.common_prefix_tokens([1, 2], [1, 2]) == 2
    assert probe.common_prefix_tokens([], [1]) == 0


def test_probe_disabled_never_calls_http(monkeypatch):
    monkeypatch.delenv("UNSLOTH_PROMPT_PREFIX_PROBE", raising=False)
    with patch.object(probe.httpx, "Client") as mocked:
        probe.observe_chat_payload({"messages": []}, base_url="http://127.0.0.1:1234", headers={}, verify=True)
        mocked.assert_not_called()


def test_remote_endpoint_is_denied(monkeypatch):
    monkeypatch.setenv("UNSLOTH_PROMPT_PREFIX_PROBE", "1")
    with patch.object(probe.httpx, "Client") as mocked:
        probe.observe_chat_payload({"messages": [{"role": "user", "content": "top secret"}]},
                                   base_url="https://example.org", headers={}, verify=True)
        mocked.assert_not_called()


class FakeResponse:
    def __init__(self, value): self.value = value
    def raise_for_status(self): pass
    def json(self): return self.value


class FakeClient:
    def __init__(self, **kwargs): self.calls = []
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def post(self, url, json):
        self.calls.append(url)
        if url.endswith("/apply-template"):
            return FakeResponse({"prompt": "synthetic-only"})
        return FakeResponse({"tokens": list(FakeClient.tokens)})


def test_two_real_token_sequences_log_lcp_without_content(monkeypatch, caplog):
    monkeypatch.setenv("UNSLOTH_PROMPT_PREFIX_PROBE", "1")
    probe._LAST.clear()
    payload = {"messages": [{"role": "user", "content": "SENSITIVE_SYNTHETIC_TEXT"}],
               "tools": [{"type": "function", "function": {"name": "x"}}]}
    with patch.object(probe.httpx, "Client", FakeClient), caplog.at_level(logging.INFO, logger=probe.__name__):
        FakeClient.tokens = [5, 6, 7, 8]
        probe.observe_chat_payload(payload, base_url="http://127.0.0.1:4444", headers={}, verify=True)
        FakeClient.tokens = [5, 6, 9, 10, 11]
        payload["messages"].append({"role": "user", "content": "SENSITIVE_OTHER"})
        probe.observe_chat_payload(payload, base_url="http://127.0.0.1:4444", headers={}, verify=True)
    records = [json.loads(r.message.split("prompt_prefix_probe ", 1)[1]) for r in caplog.records]
    assert len(records) == 2
    assert records[1]["lcp"] == 2
    assert records[1]["first_different_token"] == 2
    assert records[1]["first_changed_message"] == 1
    assert records[1]["tool_manifest_changed"] is False
    assert "SENSITIVE" not in caplog.text
    assert "tokens" not in records[1] or records[1]["prompt_tokens"] == 5
    assert all("http" not in str(r) for r in records)


def test_production_log_emitter_receives_only_sanitized_data(monkeypatch):
    monkeypatch.setenv("UNSLOTH_PROMPT_PREFIX_PROBE", "1")
    probe._LAST.clear()
    emitted = []
    with patch.object(probe.httpx, "Client", FakeClient):
        FakeClient.tokens = [3, 5]
        probe.observe_chat_payload(
            {"messages": [{"role": "user", "content": "NEVER_LOG_THIS"}]},
            base_url="http://localhost:4444", headers={}, verify=True,
            emit=emitted.append,
        )
    assert len(emitted) == 1
    assert "NEVER_LOG_THIS" not in emitted[0]
    assert emitted[0].startswith("prompt_prefix_probe ")
    assert json.loads(emitted[0].split(" ", 1)[1])["status"] == "ok"
