# Adaptive chat-history DOM budgets — fork-local QA

Status: DRAFT / NOT RELEASE READY. Branch: `qa/agent-history-adaptive-dom-20261011`, stacked on PR #18.

## Intent and behavior

- Settings → Chat → Display: global **Off / Low / High**, defaulting to the prior persisted behavior for profiles that have not chosen a new global level.
- Per-chat menu: **Inherit / Off / Low / High**; explicit local choices override the global mode.
- Existing v1 explicit chat enable/disable exceptions retain precedence unless a new per-chat override is chosen.
- Off keeps the existing regular renderer, Low and High use a virtualized contiguous subset of messages.
- Targets: Low = 5,000 and High = 12,000 *message-subtree* DOM elements; bounded to at most 32 mounted messages. A single oversized message stays mounted and can exceed the target by design.
- Unknown rows are provisionally charged 1,000 elements and corrected with measurements. Measurements respond to window changes and throttled streaming resize events.
- Persisted transcript, message identity and backend are not changed. No transmission of chat content or measurements.

## Validation requirements

1. Run focused TypeScript budget and preference tests.
2. Run existing scrolling, search, browser-selection and persisted-transcript-integrity tests across 400 and 4,000 synthetic messages.
3. Compare measured DOM descendants, memory use, input latency and typing integrity under Off / Low / High on long real-world-shaped **synthetic** agent messages. Pay particular attention to individual huge tool results.
4. Validate scroll anchor, search-hit navigation and streaming auto-follow on macOS, Windows WebView2 and Chromium.
5. Validate global/per-chat combinations, preference reload, v1 migration and reset-all-preferences behavior.
6. Confirm that no additional raw personal logs, local transcript data, secrets or user materials are committed or uploaded.

## Residual risks

- DOM targets are advisory for the chat-message subtree, not a hard cap on application-wide DOM.
- A single giant row can exceed either target without being truncated.
- DOM descendant count is only a proxy for browser work; nodes differ in layout and paint cost.
- Loaded-model Windows WebView2 typing and extended agent runs remain release gates; green unit tests alone are insufficient.
- Automated browser tests against previous exact row-count presets cover legacy mode; adaptive dynamic-mode browser verification is a separate mandatory gate.

No merge or release without explicit owner approval.
