# Experimental bounded chat rendering (WIP)

Status: **planner and unit tests only**. The production chat UI is **not** changed and this is **not yet** a pull-request-ready rendering optimization.

## Problem and scope

Long-running coding chats retain their history in `studio.db` but the default chat UI eventually mounts all messages. The existing progressive mount makes the first paint fast, but deliberately widens to the complete DOM. The experiment asks whether an actual bounded viewport can reduce sustained DOM/paint cost **without** harming streaming, reading, copy, search, export, or accessibility.

No change to persistence, context compaction, model inference, or prompt replay is proposed.

## Prior negative evidence to beat

`tests/studio/studiobench/CONTRIBUTING-perf.md` documents an earlier fully virtualized prototype. It reduced selected costs but degraded `send_turn` from 61.1 to 37.3 FPS at the 100K rung and increased p95 frames from 34 to 375 ms. It also lost mounted messages after an interaction and truncated select-all copy until the copy path changed. A prior `content-visibility:auto` experiment on message roots was likewise unhelpful.

The new experiment must beat the **shipping** implementation, not just the old rejected virtualizer.

## Phase 1: pure window planner (implemented)

`src/components/assistant-ui/experimental-render-window.ts` produces one reader-centred index range and an optional protected live tail. It always returns original message indices, merges overlaps and adjacency, clamps an index stale after deletion, and never duplicates rows. A streaming caller must capture the protected tail's starting index **once** when a run begins, not slide the protected start whenever a new token arrives.

`tests/experimental-render-window.test.ts` covers boundary, long-thread, pinning, overlapping, append, deletion, invalid-input and exhaustive small-history invariants.

Run from `studio/frontend`:

```bash
node --experimental-strip-types --test tests/experimental-render-window.test.ts
```

## Phase 2: integration (NOT implemented)

- Build a separately gated prototype beside `ProgressiveMessages`; keep the current UI default, avoid switching provider trees mid-run.
- Preserve `MessageByIndexProvider` original indexes, and keep the active streamed reply mounted without re-positioning every historical row per token.
- Measure true row heights and retain reader scroll anchor across inserts, edits, expansion, image loads and history switches. No presumed constant-size messages.
- Provide an explicit, complete-history API for export and copy; do not trust the bounded DOM as the whole history.
- Teach find-in-page, screen readers (`aria-posinset` / `aria-setsize`), keyboard navigation and print about unmounted messages.
- Run existing stream, copy, find-in-page, edit/fork, compaction and browser tests before claiming a usable mode.

## Release and PR gate

Only consider an upstream draft PR once the prototype builds and passes functional regression tests. Performance claims require Unsloth Studiobench A/B against a pinned baseline **and a concurrent base-vs-base null control**; run liveness checks, `floor_table`, and `ui_parity` (visible and behaviour modes) as prescribed in `tests/studio/studiobench/CONTRIBUTING-perf.md`. Report `send_turn` frame distributions, first append, continuous token streaming, thread switch, long-context size rungs, memory/DOM, export/copy completeness and scroll stability.

Do not cite the pure planner tests as proof that the chat UI is faster or even usable: they establish indexing correctness only.
