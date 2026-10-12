# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic first-10-seconds foreground/scroll differential (NOT Windows unlock)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tests.studio.playwright_agent_history_dom_churn_stress import INJECT, metrics
from tests.studio.playwright_agent_history_scroll import create_fixture
from tests.studio.studiobench.runtime.lifecycle import (
    authenticate,
    auth_request_json,
    seed_init_script,
)

METRIC_SCRIPT = """() => {
  const state = {transitions: [], longTasks: 0, maxLongTaskMs: 0};
  document.addEventListener('visibilitychange', () => {
    state.transitions.push(document.visibilityState);
  });
  try {
    new PerformanceObserver(list => {
      for (const item of list.getEntries()) {
        state.longTasks++;
        state.maxLongTaskMs = Math.max(state.maxLongTaskMs, item.duration);
      }
    }).observe({type: 'longtask', buffered: false});
  } catch (_) {}
  window.__qaForegroundRead = () => ({
    ...state,
    mounted: document.querySelectorAll('[data-agent-history-row]').length,
    dom: document.querySelector('[data-agent-history-scroll-list="true"]')
      ?.querySelectorAll('*').length ?? 0,
  });
}"""


def run(url: str, password: str, output: Path) -> list[dict]:
    from playwright.sync_api import sync_playwright

    base = url.rstrip("/")
    auth = authenticate(base, "unsloth", password)
    thread = create_fixture(base, auth, 1000)
    readings: list[dict] = []
    try:
        original = auth_request_json(auth, f"{base}/api/chat/threads/{thread}/messages")
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless = False)
            try:
                for mode in ("no_scroll", "immediate_scroll"):
                    context = browser.new_context(viewport = {"width": 1440, "height": 960})
                    context.add_init_script(seed_init_script(auth, [], {
                        "unsloth_agent_chat_history_v1": {
                            "state": {"globalEnabled": True, "globalWindowRows": 5},
                            "version": 0,
                        }
                    }))
                    errors: list[str] = []
                    try:
                        page = context.new_page()
                        page.on("pageerror", lambda _: errors.append("pageerror"))
                        page.on("crash", lambda: errors.append("crash"))
                        page.goto(f"{base}/chat?thread={thread}",
                                  wait_until = "domcontentloaded", timeout = 120000)
                        page.locator('[data-agent-history-scroll-list="true"]').wait_for(
                            state = "attached", timeout = 60000)
                        page.wait_for_function(
                            "n => document.querySelectorAll('[data-agent-history-row]').length === 5 && document.querySelector('[data-agent-history-row]')?.getAttribute('aria-setsize') === String(n)",
                            arg = 1000, timeout = 60000)
                        page.evaluate(INJECT, {
                            "regularCards": 1600, "heavyCards": 1600, "total": 1000
                        })
                        page.wait_for_function(
                            "() => document.querySelectorAll('[data-qa-heavy-fixture]').length === 5",
                            timeout = 90000)
                        page.evaluate(METRIC_SCRIPT)
                        cdp = context.new_cdp_session(page)
                        cdp.send("Performance.enable")
                        background = context.new_page()
                        background.goto("about:blank")
                        background.bring_to_front()
                        page.wait_for_function(
                            "() => document.visibilityState === 'hidden'",
                            timeout = 10000,
                        )
                        page.wait_for_timeout(3000)
                        before = metrics(cdp)
                        page.bring_to_front()
                        page.wait_for_function(
                            "() => document.visibilityState === 'visible'",
                            timeout = 10000,
                        )
                        if mode == "immediate_scroll":
                            page.evaluate("""() => {
                              const el = document.querySelector('.aui-thread-viewport');
                              el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.4;
                              el.dispatchEvent(new Event('scroll'));
                            }""")
                        page.wait_for_timeout(10000)
                        after = metrics(cdp)
                        observed = page.evaluate("() => window.__qaForegroundRead()")
                        if not 1 <= observed["mounted"] <= 5 or errors:
                            raise AssertionError(f"{mode}: broken window or browser errors")
                        if "visible" not in observed["transitions"]:
                            raise AssertionError(f"{mode}: no return to foreground detected")
                        readings.append({
                            "mode": mode, "secondsObserved": 10,
                            "mountedRows": observed["mounted"],
                            "messageDOMElements": observed["dom"],
                            "longTasks": observed["longTasks"],
                            "maxLongTaskMs": round(observed["maxLongTaskMs"], 2),
                            "taskMs": round(1000 * (after["TaskDuration"] - before["TaskDuration"]), 2),
                            "layoutMs": round(1000 * (after["LayoutDuration"] - before["LayoutDuration"]), 2),
                            "scriptMs": round(1000 * (after["ScriptDuration"] - before["ScriptDuration"]), 2),
                            "styleMs": round(1000 * (after["RecalcStyleDuration"] - before["RecalcStyleDuration"]), 2),
                            "browserErrors": len(errors),
                        })
                    finally:
                        context.close()
            finally:
                browser.close()
        final = auth_request_json(auth, f"{base}/api/chat/threads/{thread}/messages")
        if final["messages"] != original["messages"]:
            raise AssertionError("Synthetic message persistence changed")
    finally:
        auth_request_json(auth, f"{base}/api/chat/threads", method = "DELETE", body = {"ids": [thread]})
        output.parent.mkdir(parents = True, exist_ok = True)
        output.write_text(json.dumps({
            "status": "PASS" if len(readings) == 2 else "INCOMPLETE",
            "browser": "headed-chromium-xvfb",
            "notWindowsLockUnlock": True,
            "modelLoaded": False,
            "messages": 1000,
            "readings": readings,
        }, indent = 2) + "\n", encoding = "utf-8")
    return readings


def main() -> None:
    parser = argparse.ArgumentParser(description = __doc__)
    parser.add_argument("--url", required = True)
    parser.add_argument("--password", required = True)
    parser.add_argument("--output", default = "logs/agent-history/foreground-10s.json")
    args = parser.parse_args()
    report = run(args.url, args.password, Path(args.output))
    print(json.dumps({"status": "PASS", "cases": len(report), "measurements": report}))


if __name__ == "__main__":
    main()
