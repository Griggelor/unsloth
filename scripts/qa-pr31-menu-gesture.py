#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Ephemeral test-interaction A/B: force keyboard-open after Radix selection.

Do not change the application, hide failures, or commit the modified test to PR30.
One fresh Enter gesture per mode, with immediate open-state check and no retry.
"""

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-file", type = Path, required = True)
    args = parser.parse_args()
    src = args.test_file.read_text(encoding = "utf-8")
    old = """        if trigger.get_attribute("aria-expanded") != "true":
            trigger.click()
        submenu = page.locator('[data-test-id="agent-dom-level-trigger"]')"""
    new = """        initial_expanded = trigger.get_attribute("aria-expanded")
        if initial_expanded == "true":
            page.keyboard.press("Escape")
        trigger.focus()
        trigger.press("Enter")
        resulting_expanded = trigger.get_attribute("aria-expanded")
        if resulting_expanded != "true":
            raise AssertionError(
                f"Fresh keyboard menu-open failed for {level}: "
                f"before={initial_expanded!r}, after={resulting_expanded!r}"
            )
        submenu = page.locator('[data-test-id="agent-dom-level-trigger"]')"""
    if src.count(old) != 1:
        raise RuntimeError(f"Unexpected production E2E test shape: {src.count(old)} anchors")
    args.test_file.write_text(src.replace(old, new, 1), encoding = "utf-8")
    print("QA-only menu gesture probe inserted, no application code changed")


if __name__ == "__main__":
    main()
