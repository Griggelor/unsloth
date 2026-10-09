# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
"""Real-browser regression gate for the opt-in, bounded Agenten-Chatverlauf.

Run ONLY against an isolated disposable Studio instance, not a production installation:
    python -m tests.studio.playwright_agent_history_scroll \
        --url http://127.0.0.1:5401 --username unsloth --password '...' --messages 400

Requires the repository's Playwright/Chromium test prerequisites and a running backend.
This test writes and then deletes ONE uniquely named fixture thread on that instance.
Missing prerequisites, auth failures, missing virtualizer and any incomplete traversal
are hard failures, not skipped or counted as passes. It does not test find/copy parity.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

# Executed as a standalone Playwright driver from the checkout root.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from tests.studio.studiobench.runtime.lifecycle import (
    authenticate,
    auth_request_json,
    seed_init_script,
)

ROW = "[data-agent-history-row]"
LIST = '[data-agent-history-scroll-list="true"]'
VIEWPORT = ".aui-thread-viewport"
MAX_ROWS = 96


def create_fixture(base: str, auth, count: int) -> str:
    thread_id = str(uuid.uuid4())
    now = int(time.time() * 1000) - count * 1000
    auth_request_json(
        auth, f"{base}/api/chat/threads", method = "POST",
        body={
            "id": thread_id, "title": "agent-history-e2e-" + thread_id,
            "modelType": "base", "modelId": "agent-history-fixture",
            "createdAt": now,
        },
    )
    messages = []
    parent = None
    for index in range(count):
        message_id = str(uuid.uuid4())
        messages.append({
            "id": message_id,
            "threadId": thread_id,
            "parentId": parent,
            "role": "user" if index % 2 == 0 else "assistant",
            "content": [{"type": "text", "text": f"agent-history-e2e-row-{index:05d} unique-fixture"}],
            "attachments": None,
            "metadata": None,
            "createdAt": now + index * 1000,
        })
        parent = message_id
    auth_request_json(
        auth, f"{base}/api/chat/threads/{thread_id}/messages",
        method = "PUT", timeout = 120,
        body = {"messages": messages, "pruneMissing": True},
    )
    persisted = auth_request_json(auth, f"{base}/api/chat/threads/{thread_id}/messages")
    if len(persisted.get("messages", [])) != count:
        raise AssertionError("The backend did not persist the complete fixture")
    return thread_id


def census(page, expected: int, where: str) -> dict:
    state = page.evaluate("""() => {
      const rows = Array.from(document.querySelectorAll('[data-agent-history-row]'));
      const list = document.querySelector('[data-agent-history-scroll-list="true"]');
      const viewport = document.querySelector('.aui-thread-viewport');
      return {
        hasList: !!list, mounted: rows.length,
        ordinal: rows.map(row => Number(row.getAttribute('aria-posinset'))),
        sizes: rows.map(row => Number(row.getAttribute('aria-setsize'))),
        viewport: !!viewport,
        scrollTop: viewport?.scrollTop ?? null,
        scrollHeight: viewport?.scrollHeight ?? null
      };
    }""")
    if not state["hasList"] or not state["viewport"]:
        raise AssertionError(f"{where}: active agent renderer/viewport absent: {state}")
    if not (1 <= state["mounted"] <= MAX_ROWS):
        raise AssertionError(f"{where}: mounted rows not bounded: {state}")
    ordinals = state["ordinal"]
    if (len(set(ordinals)) != len(ordinals)
            or ordinals != list(range(ordinals[0], ordinals[-1] + 1))
            or any(size != expected for size in state["sizes"])
            or not (1 <= ordinals[0] <= ordinals[-1] <= expected)):
        raise AssertionError(f"{where}: invalid ARIA positions/total: {state}")
    return state


def scroll_to(page, fraction: float, expected: int, label: str) -> dict:
    # Like the shipped Studio readiness probe, scroll + user wheel intent together.
    # A one-shot programmatic jump alone can be cancelled by intent-aware autoscroll.
    viewport = page.locator(VIEWPORT)
    viewport.hover()
    for _ in range(12):
        page.mouse.wheel(0, -1800 if fraction == 0 else 1800)
        page.evaluate("""fraction => {
          const el = document.querySelector('.aui-thread-viewport');
          el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction;
          el.dispatchEvent(new Event('scroll'));
        }""", fraction)
        page.wait_for_timeout(100)
    state = census(page, expected, label)
    first, last = state["ordinal"][0], state["ordinal"][-1]
    if fraction == 0 and first != 1:
        raise AssertionError(f"{label}: first row not reachable: {state}")
    if fraction == 1 and last != expected:
        raise AssertionError(f"{label}: final row not reachable: {state}")
    if fraction == 0.5 and not (expected // 4 <= first <= 3 * expected // 4):
        raise AssertionError(f"{label}: middle of the transcript not reached: {state}")
    return state


def run(url: str, username: str, password: str, messages: int) -> None:
    from playwright.sync_api import sync_playwright

    base = url.rstrip("/")
    auth = authenticate(base, username, password)
    thread_id = None
    try:
        thread_id = create_fixture(base, auth, messages)
        with sync_playwright() as driver:
            browser = driver.chromium.launch(headless = True)
            try:
                context = browser.new_context(viewport = {"width": 1440, "height": 960})
                context.add_init_script(seed_init_script(
                    auth, [], {"unsloth_agent_chat_history_v1": {
                        "state": {"enabledThreads": {thread_id: True}},
                        "version": 0,
                    }},
                ))
                page = context.new_page()
                page.goto(f"{base}/chat?thread={thread_id}",
                          wait_until = "domcontentloaded", timeout = 120_000)
                page.locator(LIST).wait_for(state = "attached", timeout = 60_000)
                page.wait_for_function(
                    """expected => document.querySelectorAll(
                      '[data-agent-history-row][aria-setsize="' + expected + '"]'
                    ).length > 0""",
                    arg = messages, timeout = 60_000,
                )
                tail = census(page, messages, "initial")
                if tail["ordinal"][-1] != messages:
                    raise AssertionError(f"initial window not at transcript tail: {tail}")
                top = scroll_to(page, 0, messages, "top")
                middle = scroll_to(page, 0.5, messages, "middle")
                bottom = scroll_to(page, 1, messages, "bottom")
                page.reload(wait_until = "domcontentloaded", timeout = 120_000)
                page.locator(LIST).wait_for(state = "attached", timeout = 60_000)
                page.wait_for_function(
                    """expected => Array.from(document.querySelectorAll(
                      '[data-agent-history-row]')).some(
                        row => row.getAttribute('aria-setsize') === String(expected)
                      )""",
                    arg = messages, timeout = 60_000,
                )
                after_reload = census(page, messages, "reload")
                if after_reload["ordinal"][-1] != messages:
                    raise AssertionError("Reload lost the transcript tail")
                stored = auth_request_json(
                    auth, f"{base}/api/chat/threads/{thread_id}/messages"
                )
                if len(stored.get("messages", [])) != messages:
                    raise AssertionError("Virtual scrolling changed the persisted transcript")
                print(json.dumps({
                    "status": "PASS", "messages": messages,
                    "mounted_initial": tail["mounted"],
                    "mounted_top": top["mounted"],
                    "mounted_middle": middle["mounted"],
                    "mounted_bottom": bottom["mounted"],
                    "mounted_reload": after_reload["mounted"],
                    "transcript_preserved": True,
                }, sort_keys = True))
            finally:
                browser.close()
    finally:
        if thread_id is not None:
            auth_request_json(
                auth, f"{base}/api/chat/threads",
                method = "DELETE", body = {"ids": [thread_id]},
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required = True, help = "Disposable Studio instance only")
    parser.add_argument("--username", default = "unsloth")
    parser.add_argument("--password", required = True)
    parser.add_argument("--messages", type = int, default = 400)
    args = parser.parse_args()
    if args.messages < 128 or args.messages % 2:
        parser.error("--messages must be even and at least 128")
    run(args.url, args.username, args.password, args.messages)


if __name__ == "__main__":
    main()
