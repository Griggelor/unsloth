# Agent History: measured wheel-gap investigations (2026-10-14)

**Disposition: QA evidence only. NO upstream PR, merge, release, or implementation port is authorized.**
The official-upstream-based clean candidate stays unchanged at `4de45a27376075b13ae6dfb0173ee914c583fe38`.

## Environment and acceptance

Headless Chromium, viewport 1440×960, 400 purely synthetic short chat messages, repeated actual Playwright mouse-wheel events (7 × 1680px per burst, 35ms between); no test-side `scrollTop` writes or synthetic scroll-repair events. A request ends with 1.2s idle and checks ≥55% mounted-message coverage away from physical ends. A rAF probe measures contiguous underfilled time (below 55% interior coverage). These are local browser measurements, NOT manual Windows/WebView2 validation. They do not prove a zero-gap UI.

## Independent baseline

- Clean candidate source: `qa/upstream-agent-history-candidate-20261014`, commit `4de45a27`; successful source compile + bundle run 38600450729 and the eight-job focused browser QA run 38600900259 on a validation-only copy.
- Baseline duration run [38605024038](https://github.com/Griggelor/unsloth/actions/runs/38605024038), artifact 11914738822: Dynamic older 33/67/67ms, Dynamic newer 133/0/0ms, Fixed older 33/67/67ms, Fixed newer 0/0/0ms.
- Source with QA-only staged-window instrumentation run [38605953928](https://github.com/Griggelor/unsloth/actions/runs/38605953928), artifact 11915781956: worst Dynamic-newer gap 133ms while staged at window [383,386), target row 385. Instrumentation changes tests/diagnostic DOM attributes, not UI shipping behavior.

## Controlled A/B attempts — ALL NEGATIVE

1. **Early target alignment:** [38606529499](https://github.com/Griggelor/unsloth/actions/runs/38606529499), artifact 11915289819. Allowed alignment as soon as the first staged row mounts. Dynamic-newer worst gap remained 133ms. Do NOT port.
2. **Allow four short, unmeasured simple-text rows (no complex/tool/media rows):** [38609880904](https://github.com/Griggelor/unsloth/actions/runs/38609880904), artifact 11916834517, branch `qa/upstream-agent-history-lightweight-stage-ab-20261014`, commit `cb14b2b8`. Unit, typecheck and wheel CI succeeded, but Dynamic-newer gap remained 133ms; Dynamic-older and Fixed-older remained at up to 67ms. Do NOT port: additional code and speculative DOM admission without measured gain.
3. **Retarget when wheel position leaves CURRENT mounted range (rather than planned destination):** source of QA-only instrumentation [38610803020](https://github.com/Griggelor/unsloth/actions/runs/38610803020), artifact 11918230687, recorded Dynamic-newer 100ms maximum in that baseline run. Retarget variant [38611496807](https://github.com/Griggelor/unsloth/actions/runs/38611496807), artifact 11917921504, branch `qa/upstream-agent-history-wheel-retarget-ab-20261014`, commit `51a881d1`, all CI green but 133ms maximum. Single-run 100↔133ms differences are not statistically significant; there is **no demonstrated improvement**. Do NOT port.

## What frame geometry actually shows

The baseline frame-by-frame trace run 38610803020 shows the scroll viewport moving 1680px while conservative staged DOM expansion is still tracking a previous target:

- At t≈11055ms: scrollTop≈245761, staged window [356,363), viewport coverage 68%.
- At t≈11071ms: physical scrollTop≈247441, window only [356,365), its last row ends **334px above** viewport top; coverage 0%.
- At t≈11105ms: window [356,369), last row reaches 120px into viewport; coverage ~13%.
- At t≈11121ms: window [356,371), coverage ~36%.
- A subsequent physical wheel leap to scrollTop≈249360 recreates the gap while window [372,379) is still staged.
- By t≈11288ms: final window [384,400) is mounted, coverage ~83%.

Retarget-to-mounted-range experiment can move the target forward (e.g. to 370 and then 385) yet does not shorten the measured blank interval reliably. Thus *position correction alone* and *speculative four-text batches* are insufficient in these tests.

**Bounded conclusion:** There is a real transient mismatch between native physical wheel advance and committed virtual DOM coverage, under repeated unusually large wheel deltas. The user additionally reported similar but direction-dependent partial gaps on Windows WebView2. The exact production importance and a safe fix have not yet been measured.

## Constraints, next architecture experiment, and acceptance gates

- Do not globally increase mounted row counts or disable conservative unknown/heavy-tool admission. Existing 50k/200k/400k DOM churn and GC retention wins must remain.
- A “hard RAM limit” is not an enforceable guarantee with arbitrary single huge tool results. Current Fixed adaptive policy has **hard 32-row cap** and an **8k estimated/measured descendant admission target**; a necessary single huge tool row can exceed this until its nested content is itself virtualized.
- Before implementing the next fix, measure geometry under both small and large wheel deltas, variable-height messages, fully known vs unseen height ledgers, heavy tool cards, and Windows WebView2. Record long-frame duration and coverage during user gestures, not merely idle success.
- Candidate architecture to evaluate next: predictive physical-wheel viewport coverage with a strict DOM cost/time budget and a single skeleton fallback while unknown heavy items are being staged, rather than blindly accelerating unknown tool rows. Ensure no additional scrollTop “owner”, prevent search/navigation interference and preserve native wheel feel.
- Require repeatable A/B improvements (multiple runs, same test distributions) and exact-SHA unit, TypeScript, focused browser, heavy DOM, wheel/keyboard/search/copy, and Windows WebView2 acceptance before any release.
- Until then, keep `qa/upstream-agent-history-candidate-20261014` unchanged. The official PR has NOT been opened or transmitted.
