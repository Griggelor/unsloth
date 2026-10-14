# SPDX-License-Identifier: AGPL-3.0-only
"""QA characterization: repeated REAL wheel events, no synthetic scroll rescue.

Run only against an isolated, disposable Studio instance with synthetic fixture
messages. This intentionally tests the interaction absent from scroll_to(): no
post-wheel scrollTop assignments and no manually dispatched 'scroll' events.

Example:
  python -m tests.studio.playwright_agent_history_wheel_continuity \
    --url http://127.0.0.1:5401 --username unsloth --password YOUR_QA_PW

Produces a JSON diagnostic record; a non-visible window after 1.2s of wheel
inactivity is a hard failure. Until reproduced and fixed, this is a QA probe,
not a passing release gate.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.studio.studiobench.runtime.lifecycle import (
    authenticate,
    auth_request_json,
    seed_init_script,
)
from tests.studio.playwright_agent_history_scroll import create_fixture

_JS = """() => {
  const viewport = document.querySelector('.aui-thread-viewport');
  const list = document.querySelector('[data-agent-history-scroll-list="true"]');
  const rows = [...document.querySelectorAll('[data-agent-history-row]')];
  if (!viewport || !list) return null;
  const box = viewport.getBoundingClientRect();
  const intersect = rows.map(el => {
    const b = el.getBoundingClientRect();
    return Math.max(0, Math.min(box.bottom, b.bottom) - Math.max(box.top, b.top));
  });
  return {
    mode: list.dataset.agentHistoryDomLevel,
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    viewportHeight: viewport.clientHeight,
    mounted: rows.length,
    first: rows[0]?.dataset.agentHistoryRow ?? null,
    last: rows.at(-1)?.dataset.agentHistoryRow ?? null,
    visibleRows: intersect.filter(px => px > 1).length,
    coveragePx: Math.min(viewport.clientHeight, intersect.reduce((a, b) => a + b, 0)),
    topSpacer: list.querySelector('[data-agent-history-spacer="top"]')?.getBoundingClientRect().height,
    bottomSpacer: list.querySelector('[data-agent-history-spacer="bottom"]')?.getBoundingClientRect().height,
  };
}"""


def visible_state(page, expected_mode: str, maximum: int, stage: str) -> dict:
    snap = page.evaluate(_JS)
    if snap is None or snap["mode"] != expected_mode:
        raise AssertionError(f"{stage}: expected Agent History mode {expected_mode}, got {snap}")
    if not 1 <= snap["mounted"] <= maximum:
        raise AssertionError(f"{stage}: violated mounted-row cap {maximum}: {snap}")
    return snap


def capture_wheel_burst(page, mode: str, expected_mode: str, maximum: int,
                        direction: int, burst: int) -> dict:
    viewport = page.locator(".aui-thread-viewport")
    viewport.hover()
    samples = []
    for _ in range(7):
        page.mouse.wheel(0, direction * 1680)
        # Still physical mouse wheel; the timeout permits browser paint/RAF.
        page.wait_for_timeout(35)
        snap = visible_state(page, expected_mode, maximum, "during wheel")
        samples.append(snap)
    # No further wheel, synthetic scroll or programmatic scrollTop. A "needs one
    # more wheel to show messages" failure must remain reproducible at rest.
    page.wait_for_timeout(1200)
    settled = visible_state(page, expected_mode, maximum, "after wheel settled")
    if settled["visibleRows"] == 0:
        name = f"agent-history-wheel-gap-{mode}-{direction}-{burst}.png"
        page.screenshot(path=name)
        raise AssertionError(
            f"{mode} direction={direction} burst={burst}: blank after idle "
            f"(synthetic screenshot {name}): {settled}"
        )
    return {
        "mode": mode, "direction": "toward_newest" if direction > 0 else "toward_oldest",
        "burst": burst,
        "wheel_events": len(samples),
        "blank_intermediate_samples": sum(s["visibleRows"] == 0 for s in samples),
        "minimum_intermediate_visible_rows": min(s["visibleRows"] for s in samples),
        "settled": settled,
    }


def run(url: str, username: str, password: str, messages: int) -> None:
    from playwright.sync_api import sync_playwright

    base = url.rstrip("/")
    auth = authenticate(base, username, password)
    tid = create_fixture(base, auth, messages)
    baseline = auth_request_json(auth, f"{base}/api/chat/threads/{tid}/messages")
    try:
        with sync_playwright() as driver:
            browser = driver.chromium.launch(headless=True)
            try:
                results = []
                for mode, policy, cap in (("dynamic", "medium", 16),
                                          ("fixed", "legacy", 32)):
                    context = browser.new_context(viewport={"width": 1440, "height": 960})
                    try:
                        context.add_init_script(seed_init_script(auth, []))
                        history_state = {
                            "state": {"enabledThreads": {tid: True},
                                      "domLevelByThreadId": {
                                          tid: "dynamic" if mode == "dynamic" else "fixed-low"}},
                            "version": 0,
                        }
                        context.add_init_script(
                            "(() => {const k='unsloth_agent_chat_history_v1';"
                            "localStorage.setItem(k," +
                            json.dumps(json.dumps(history_state)) + ");})();"
                        )
                        page = context.new_page()
                        page.goto(f"{base}/chat?thread={tid}",
                                  wait_until="domcontentloaded", timeout=120_000)
                        page.wait_for_function(
                            """([policy, n]) => {
                              const list = document.querySelector('[data-agent-history-scroll-list="true"]');
                              return list?.dataset.agentHistoryDomLevel === policy &&
                                document.querySelectorAll('[data-agent-history-row]').length > 0 &&
                                document.querySelectorAll('[data-agent-history-row]').length <= n;
                            }""",
                            arg=[policy, cap], timeout=60_000,
                        )
                        # Disjoint travel across dozens of screens in both
                        # directions, using only user-like wheel input.
                        for direction in (-1, 1):
                            for burst in range(3):
                                results.append(capture_wheel_burst(
                                    page, mode, policy, cap, direction, burst
                                ))
                    finally:
                        context.close()
                persisted = auth_request_json(
                    auth, f"{base}/api/chat/threads/{tid}/messages"
                )
                if persisted.get("messages") != baseline.get("messages"):
                    raise AssertionError("Wheel test mutated the persisted synthetic chat")
                print(json.dumps({"test": "physical-wheel-continuity",
                                  "status": "PASS", "results": results}, sort_keys=True))
            finally:
                browser.close()
    finally:
        auth_request_json(auth, f"{base}/api/chat/threads",
                          method="DELETE", body={"ids": [tid]})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--username", default="unsloth")
    parser.add_argument("--password", required=True)
    parser.add_argument("--messages", type=int, default=400)
    args = parser.parse_args()
    if args.messages < 128 or args.messages % 2:
        parser.error("--messages must be even and >=128")
    run(args.url, args.username, args.password, args.messages)
