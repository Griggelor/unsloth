# Agent History + Context Performance integration (2026-10-13)

**QA-only two-parent merge commit**, no release and no merge into main.

- Source 1: PR30 4fefa53080b4abb5f14f2fd14fe54ff28abb9509 (Agent History / WebView2)
- Source 2: 11c07ec00c069a14f3b5836a6346934009a78494 (Context Performance / checkpoint / delta)
- Original context baseline: fa168bbf4de9abf5d75b4837d5fc44ea0454ec77
- Verified 0 overlapping changed file paths from that baseline to the two source heads.
- Applied all 18 context branch files to unchanged PR30 tree, with a narrow CI-only modification to trigger on integration branch and install TypeScript dependencies before Node tests.

Historical PR30 frontend/backend CI red, Context experiment Node job red due missing TypeScript dependency. They are **not** proven green by creating this integration; re-evaluate all tests on exact integration HEAD. Windows QA EXE is a separate unsigned test artifact, not a release or proof of WebView2 lock/unlock performance. Real Windows testing must use a protected test profile.
