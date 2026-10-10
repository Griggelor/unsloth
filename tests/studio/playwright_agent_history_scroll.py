# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026-present the Unsloth AI Inc. team. All rights reserved. See /studio/LICENSE.AGPL-3.0
"""Real-browser regression gate for the opt-in, bounded Agenten-Chatverlauf.

Run ONLY against an isolated disposable Studio instance, not a production installation:
    python -m tests.studio.playwright_agent_history_scroll \
        --url http://127.0.0.1:5401 --username unsloth --password '...' --messages 400

Requires the repository's Playwright/Chromium test prerequisites and a running backend.
This test writes and then deletes ONE uniquely named fixture thread on that instance.
Missing prerequisites, auth failures, missing virtualizer and any incomplete traversal
are hard failures, not skipped or counted as passes. It checks bounded find/reveal
navigation, but not clipboard/export parity.
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
        auth,
        f"{base}/api/chat/threads",
        method = "POST",
        body = {
            "id": thread_id,
            "title": "agent-history-e2e-" + thread_id,
            "modelType": "base",
            "modelId": "agent-history-fixture",
            "createdAt": now,
        },
    )
    messages = []
    parent = None
    for index in range(count):
        message_id = str(uuid.uuid4())
        messages.append(
            {
                "id": message_id,
                "threadId": thread_id,
                "parentId": parent,
                "role": "user" if index % 2 == 0 else "assistant",
                "content": [
                    {"type": "text", "text": f"agent-history-e2e-row-{index:05d} unique-fixture"}
                ],
                "attachments": None,
                "metadata": None,
                "createdAt": now + index * 1000,
            }
        )
        parent = message_id
    auth_request_json(
        auth,
        f"{base}/api/chat/threads/{thread_id}/messages",
        method = "PUT",
        timeout = 120,
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
    if (
        len(set(ordinals)) != len(ordinals)
        or ordinals != list(range(ordinals[0], ordinals[-1] + 1))
        or any(size != expected for size in state["sizes"])
        or not (1 <= ordinals[0] <= ordinals[-1] <= expected)
    ):
        raise AssertionError(f"{where}: invalid ARIA positions/total: {state}")
    return state


def scroll_to(page, fraction: float, expected: int, label: str) -> dict:
    # Like the shipped Studio readiness probe, scroll + user wheel intent together.
    # A one-shot programmatic jump alone can be cancelled by intent-aware autoscroll.
    viewport = page.locator(VIEWPORT)
    viewport.hover()
    for _ in range(12):
        page.mouse.wheel(0, -1800 if fraction == 0 else 1800)
        page.evaluate(
            """fraction => {
          const el = document.querySelector('.aui-thread-viewport');
          el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction;
          el.dispatchEvent(new Event('scroll'));
        }""",
            fraction,
        )
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


def search_snapshot(page) -> dict:
    """Read-only diagnostics. A missing search result is always a hard failure."""
    return page.evaluate("""() => {
      const bar = document.querySelector('[data-find-bar-layer]');
      const input = bar?.querySelector('input');
      const counter = bar?.querySelector('[aria-live="polite"]');
      const viewport = document.querySelector('.aui-thread-viewport');
      const rows = [...document.querySelectorAll('[data-agent-history-row]')];
      const marked = [...document.querySelectorAll('[data-agent-history-find-active="true"]')];
      return {
        query: input?.value ?? null,
        counter: counter?.textContent?.trim() ?? null,
        focused: document.activeElement === input,
        barVisible: !!bar && !bar.hidden,
        currentRows: [rows[0]?.getAttribute('data-agent-history-row') ?? null,
                      rows.at(-1)?.getAttribute('data-agent-history-row') ?? null],
        mounted: rows.length,
        searchHitRows: marked.map(row => row.getAttribute('data-agent-history-row')),
        scrollTop: viewport?.scrollTop ?? null,
        scrollHeight: viewport?.scrollHeight ?? null,
        pageErrors: window.__agentSearchErrors ?? null
      };
    }""")


def require_search_state(
    page,
    script: str,
    label: str,
    timeout: int = 15_000,
    arg = None,
) -> None:
    try:
        page.wait_for_function(script, arg = arg, timeout = timeout)
    except Exception as exc:
        raise AssertionError(f"{label}: {search_snapshot(page)}") from exc


def require_visible_search_row(page, row_index: int, label: str) -> None:
    """Indexing + DOM mounting is not enough: the hit must intersect the viewport."""
    require_search_state(
        page,
        """index => {
          const viewport = document.querySelector('.aui-thread-viewport');
          const row = document.querySelector(
            '[data-agent-history-row="' + index +
            '"][data-agent-history-find-active="true"]'
          );
          if (!viewport || !row || !viewport.contains(row)) return false;
          const view = viewport.getBoundingClientRect();
          const hit = row.getBoundingClientRect();
          return hit.width > 0 && hit.height > 0 &&
            hit.bottom > view.top + 8 && hit.top < view.bottom - 8 &&
            document.querySelectorAll('[data-agent-history-row]').length <= 96;
        }""",
        label,
        arg = row_index,
    )


def check_chat_header_menu(page, messages: int) -> None:
    """Exercise the real header menu, which lives outside AssistantRuntimeProvider."""
    trigger = page.locator('[data-test-id="chat-header-more-menu-trigger"]')
    trigger.wait_for(state = "visible", timeout = 30_000)
    trigger.click()
    disable = page.get_by_role("menuitem", name = "Agenten-Chatverlauf deaktivieren")
    disable.wait_for(state = "visible", timeout = 30_000)
    if messages != 400:
        page.keyboard.press("Escape")
        return

    # On 400 rows also verify the complete user-facing opt-in/off path.
    disable.click()
    page.wait_for_function(
        """() => document.querySelector('[data-agent-history-scroll-list="true"]') === null""",
        timeout = 30_000,
    )
    trigger.click()
    page.get_by_role("menuitem", name = "Agenten-Chatverlauf aktivieren").click()
    page.wait_for_function(
        """expected => !!document.querySelector(
          '[data-agent-history-row][aria-setsize="' + expected + '"]'
        )""",
        arg = messages,
        timeout = 30_000,
    )
    census(page, messages, "menu-toggled-on")


def check_runtime_window_size(page, thread_id: str, messages: int) -> None:
    """Change row limits through the real menu, verify DOM and persisted per-chat scope."""
    trigger = page.locator('[data-test-id="chat-header-more-menu-trigger"]')

    def choose(size: int) -> None:
        trigger.click()
        page.locator('[data-slot="dropdown-menu-sub-trigger"]').filter(
            has_text = "Agentenfenster:"
        ).hover()
        page.locator(f'[data-test-id="agent-window-size-{size}"]').click()
        page.wait_for_function(
            """size => {
              const rows = document.querySelectorAll('[data-agent-history-row]');
              return rows.length === size;
            }""",
            arg = size,
            timeout = 30_000,
        )
        state = census(page, messages, f"window-{size}")
        if state["mounted"] != size:
            raise AssertionError(f"window-{size}: expected exactly {size} mounted rows: {state}")

    choose(5)
    stored = page.evaluate(
        """threadId => JSON.parse(localStorage.getItem(
          'unsloth_agent_chat_history_v1'
        ) || '{}').state?.windowRowsByThreadId?.[threadId] ?? 32""",
        thread_id,
    )
    if stored != 5:
        raise AssertionError(f"Small window preference not persisted: {stored}")

    # Preserve the bounded navigation contract at the recommended small setting.
    scroll_to(page, 0, messages, "five-top")
    scroll_to(page, 1, messages, "five-bottom")

    page.reload(wait_until = "domcontentloaded")
    page.locator(LIST).wait_for(state = "attached", timeout = 60_000)
    page.wait_for_function(
        """() => document.querySelectorAll('[data-agent-history-row]').length === 5""",
        timeout = 60_000,
    )
    census(page, messages, "five-after-reload")
    choose(2)
    choose(8)
    choose(16)
    choose(32)
    stored = page.evaluate(
        """threadId => JSON.parse(localStorage.getItem(
          'unsloth_agent_chat_history_v1'
        ) || '{}').state?.windowRowsByThreadId?.[threadId] ?? 32""",
        thread_id,
    )
    if stored != 32:
        raise AssertionError(f"Default window preference not restored: {stored}")
    census(page, messages, "window-default-restored")


def run(url: str, username: str, password: str, messages: int) -> None:
    from playwright.sync_api import sync_playwright

    base = url.rstrip("/")
    auth = authenticate(base, username, password)
    thread_id = None
    try:
        thread_id = create_fixture(base, auth, messages)
        # Read-after-write snapshot before any browser rendering, navigation or
        # search. A mere message count cannot detect silent edits or reordering.
        baseline = auth_request_json(auth, f"{base}/api/chat/threads/{thread_id}/messages")
        baseline_messages = baseline["messages"]
        with sync_playwright() as driver:
            browser = driver.chromium.launch(headless = True)
            try:
                context = browser.new_context(viewport = {"width": 1440, "height": 960})
                context.add_init_script(
                    seed_init_script(
                        auth,
                        [],
                        {
                            "unsloth_agent_chat_history_v1": {
                                "state": {"enabledThreads": {thread_id: True}},
                                "version": 0,
                            }
                        },
                    )
                )
                page = context.new_page()
                page.goto(
                    f"{base}/chat?thread={thread_id}",
                    wait_until = "domcontentloaded",
                    timeout = 120_000,
                )
                page.locator(LIST).wait_for(state = "attached", timeout = 60_000)
                page.wait_for_function(
                    """expected => document.querySelectorAll(
                      '[data-agent-history-row][aria-setsize="' + expected + '"]'
                    ).length > 0""",
                    arg = messages,
                    timeout = 60_000,
                )
                tail = census(page, messages, "initial")
                check_chat_header_menu(page, messages)
                if messages == 400:
                    check_runtime_window_size(page, thread_id, messages)
                if tail["ordinal"][-1] != messages:
                    raise AssertionError(f"initial window not at transcript tail: {tail}")
                top = scroll_to(page, 0, messages, "top")
                middle = scroll_to(page, 0.5, messages, "middle")
                bottom = scroll_to(page, 1, messages, "bottom")
                # Reproduction: a query for message 6 must reach beyond the
                # 32 rows mounted at the transcript tail, without disabling
                # bounded virtualization or changing the persisted history.
                page.keyboard.press("Control+f")
                find_input = page.locator("[data-find-bar-layer] input")
                find_input.wait_for(state = "visible", timeout = 30_000)
                find_input.fill("row-00005")
                # Distinguish indexing / count from seek / mount / scroll.
                require_search_state(
                    page,
                    """() => document.querySelector(
                      '[data-find-bar-layer] [aria-live="polite"]'
                    )?.textContent?.includes('1/1') ?? false""",
                    "search-index",
                )
                require_search_state(
                    page,
                    """() => !!document.querySelector(
                      '[data-agent-history-row="5"][data-agent-history-find-active="true"]'
                    )""",
                    "search-reveal",
                )
                require_visible_search_row(page, 5, "search-early-visible")
                census(page, messages, "search-early-message")
                # Prove actual browser copy of a selected mounted message works
                # under the bounded renderer. This does NOT claim that Ctrl+A
                # across the *entire* transcript is yet equivalent to default.
                context.grant_permissions(["clipboard-read", "clipboard-write"])
                page.locator('[data-agent-history-row="5"]').click()
                selected = page.evaluate(
                    """() => {
                      const row = document.querySelector('[data-agent-history-row="5"]');
                      if (!row) return false;
                      const selection = window.getSelection();
                      const range = document.createRange();
                      range.selectNodeContents(row);
                      selection.removeAllRanges();
                      selection.addRange(range);
                      return !selection.isCollapsed && selection.toString().includes('row-00005');
                    }"""
                )
                if not selected:
                    raise AssertionError("Visible virtualized row could not be selected")
                page.keyboard.press("Control+c")
                copied = page.evaluate("async () => navigator.clipboard.readText()")
                if "agent-history-e2e-row-00005" not in copied:
                    raise AssertionError(
                        f"Copy of visible virtualized message differs: {copied[:160]!r}"
                    )
                page.evaluate("() => window.getSelection()?.removeAllRanges()")
                # Scrolling away from an active one-result query then pressing
                # Enter must re-seek even if React's selected hit is unchanged.
                scroll_to(page, 1, messages, "search-reader-scroll-away")
                find_input.focus()
                find_input.press("Enter")
                require_visible_search_row(page, 5, "search-repeat-visible")
                census(page, messages, "search-repeat-single-result")
                find_input.fill("unique-fixture")
                require_search_state(
                    page,
                    """expected => document.querySelector(
                      '[data-find-bar-layer] [aria-live="polite"]'
                    )?.textContent?.includes('1/' + expected) ?? false""",
                    "search-all-rows",
                    arg = messages,
                )
                census(page, messages, "search-full-thread")
                find_input.fill(f"row-{messages - 1:05d}")
                require_search_state(
                    page,
                    """expected => !!document.querySelector(
                      '[data-agent-history-row="' + String(expected - 1) + '"][data-agent-history-find-active="true"]'
                    )""",
                    "search-last-row",
                    arg = messages,
                )
                require_visible_search_row(page, messages - 1, "search-last-visible")
                census(page, messages, "search-latest-message")
                page.keyboard.press("Escape")
                page.reload(wait_until = "domcontentloaded", timeout = 120_000)
                page.locator(LIST).wait_for(state = "attached", timeout = 60_000)
                page.wait_for_function(
                    """expected => Array.from(document.querySelectorAll(
                      '[data-agent-history-row]')).some(
                        row => row.getAttribute('aria-setsize') === String(expected)
                      )""",
                    arg = messages,
                    timeout = 60_000,
                )
                after_reload = census(page, messages, "reload")
                if after_reload["ordinal"][-1] != messages:
                    raise AssertionError("Reload lost the transcript tail")
                stored = auth_request_json(auth, f"{base}/api/chat/threads/{thread_id}/messages")
                if len(stored.get("messages", [])) != messages:
                    raise AssertionError("Virtual scrolling changed the persisted transcript count")
                if stored["messages"] != baseline_messages:
                    raise AssertionError(
                        "Virtual scrolling or search altered persisted message content, "
                        "metadata, identity or order"
                    )
                print(
                    json.dumps(
                        {
                            "status": "PASS",
                            "messages": messages,
                            "mounted_initial": tail["mounted"],
                            "mounted_top": top["mounted"],
                            "mounted_middle": middle["mounted"],
                            "mounted_bottom": bottom["mounted"],
                            "mounted_reload": after_reload["mounted"],
                            "transcript_preserved": True,
                            "visible_message_clipboard_copy": True,
                        },
                        sort_keys = True,
                    )
                )
            finally:
                browser.close()
    finally:
        if thread_id is not None:
            auth_request_json(
                auth,
                f"{base}/api/chat/threads",
                method = "DELETE",
                body = {"ids": [thread_id]},
            )


def main() -> None:
    parser = argparse.ArgumentParser(description = __doc__)
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
