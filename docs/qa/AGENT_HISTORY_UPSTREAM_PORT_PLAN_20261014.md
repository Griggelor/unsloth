# Clean upstream port plan — 2026-10-14

**No official pull request has been opened or sent.** This is an isolated preparation artifact, not release approval.

## Bases and branches

- Official upstream: `unslothai/unsloth@aad900ec04d4e1a27d608295e27feee2f4c1acbc`.
- Original virtualization fork PR #30: `Griggelor/unsloth@4fefa53080b4abb5f14f2fd14fe54ff28abb9509`.
- Current repair/characterization: `qa/agent-history-wheel-continuity-20261014`.
- Empty clean candidate branch on official upstream base: `qa/upstream-agent-history-candidate-20261014`.
- Context performance PR #33 and progress PR #34 remain **out of scope**.

## File-selection rule

Include only necessary runtime virtualization, settings, menu, browser find/search integration, associated i18n and focused UI/tests/docs. Exclude setup.ps1/setup.sh, Core tests, model code, inference/context/archive, unrelated workflow changes, non-virtualization benchmarks and install fixes.

PR #30 changes 69 files total, including 44 relevant UI/test files. The official upstream moved 98 commits beyond our old fork main. Seven candidate paths have BOTH our changes and later upstream changes:

1. `studio/frontend/src/components/assistant-ui/thread.tsx`
2. `studio/frontend/src/features/chat/chat-page.tsx`
3. `studio/frontend/src/features/chat/components/chat-header-menu.tsx`
4. `studio/frontend/src/features/settings/tabs/chat-tab.tsx`
5. `studio/frontend/src/i18n/locales/ar.ts`
6. `studio/frontend/src/i18n/locales/de.ts`
7. `studio/frontend/src/i18n/locales/en.ts`

Do not replace those seven with the old fork versions. Reconcile old/main/source three-way for each, review final JSX/props, translations, and run exact-SHA frontend/unit/browser gates.

## Wheel-scroll acceptance

User observed transient partially empty areas after repeated mouse-wheel travel, especially toward the past in Dynamic and toward latest in Fixed. Existing scripted scroll_to mixed wheel with direct scrollTop and artificial scroll events, so it could conceal this problem.

A separate physical wheel-only E2E probe is committed; it checks intersection/coverage inside the actual viewport, not only nonempty DOM, in both modes and directions.

Fixed-low product change approved by user: adapt beyond five rows up to a hard 32-row cap with a conservative 8,000-estimated-descendant budget, only expanding as measured viewport coverage requires it. Very large single tool cards cannot be strictly capped at 8,000 descendants without nested content virtualization; this remains an explicit limitation.

## Required evidence before upstream submission

- [ ] Corrected frontend TypeScript build and static/unit tests on exact repair SHA.
- [ ] Isolated real-browser physical wheel continuity E2E passes in both directions, short and heavy messages; verified no synthetic scroll repairs.
- [ ] Exact-head 50k/200k/400k synthetic DOM, search, thread switching, native thumb, tail and deletion tests.
- [ ] Manual Windows WebView2 with safe profile and both modes; memory data/visible gaps recorded.
- [ ] New upstream-base port is reviewed; no unintended changes or direct overwrite of seven conflicting files.
- [ ] Upstream PR title/body/screenshots/benchmarks/limitations reviewed with user.
- [ ] User explicitly authorizes sending to `unslothai/unsloth`.

Do not merge, deploy, or claim release while any gate above is pending.

## Verified follow-up evidence (2026-10-14)

- A clean source candidate has been ported from the official main commit `aad900ec04d4e1a27d608295e27feee2f4c1acbc` onto fork branch `qa/upstream-agent-history-candidate-20261014`.
- Source candidate commit `4de45a27376075b13ae6dfb0173ee914c583fe38`: GitHub Actions run [38600450729](https://github.com/Griggelor/unsloth/actions/runs/38600450729) passed focused frontend unit tests, TypeScript typecheck, production Vite build and startup bundle gate.
- Startup transfer costs remain real and are documented: source candidate 6,602.1 KiB raw and 1,990.7 KiB transfer (Node 22, Ubuntu CI). Eager preference settings were factored away from heavy virtual indexes; after 1.4 KiB transfer reduction, a measured ~0.7% threshold increase was included with supporting evidence rather than silently ignoring the gate.
- Browser matrix was independently run on `qa/upstream-agent-history-validation-20261014` copied from that exact source candidate (only a temporary workflow differs): [run 38600900259](https://github.com/Griggelor/unsloth/actions/runs/38600900259), all eight checks green, including 50k/200k/400k DOM churn, menu, DOM, idle-scroll, static contracts and GC retention.
- Standalone wheel-only characterization [38591890459](https://github.com/Griggelor/unsloth/actions/runs/38591890459) on the repair branch passed the idle/stable-viewport gate in Dynamic and Fixed, with **some very low or zero intermediate coverage** while actively scrolling. This cannot be promoted to a claim of zero transient blank frames.
- A second wheel-only check using the ported source itself was started in fork branch `qa/upstream-agent-history-wheel-verification-20261014` and must be assessed by its final result, not assumed green.
- No Windows WebView2 manual acceptance on the ported source, no upstream PR, no merge, no release. All three experimental PR30/33/34 remain separate.
- Temporary `.github/workflows/qa-agent-history-upstream-port.yml` must be removed before any official submission (the resulting final SHA requires revalidation). The separately copied validation branches are **never** upstream PR heads.

### Release caveat

The 8,000-descendant Fixed budget is a conservative **measured-window policy**, plus a hard 32-mounted-message cap. A mandatory single very large row can exceed 8,000 descendants until separately virtualized; therefore it must not be described as an absolute RAM ceiling. User-visible transient gaps were observed in synthetic wheel sampling even when each sequence settled correctly. Closing this issue and obtaining Windows confirmation remain approval gates.

## Final automated upstream candidate QA (as of 2026-10-14)

- Clean port source commit: `4de45a27376075b13ae6dfb0173ee914c583fe38`. [Compile + budget run 38600450729](https://github.com/Griggelor/unsloth/actions/runs/38600450729) SUCCESS.
- Validation copy differs only by temporary QA workflow. [Focused browser run 38600900259](https://github.com/Griggelor/unsloth/actions/runs/38600900259): all eight jobs SUCCESS (static/formatter, menu, dom, idle-scroll, dom-churn 50k/200k/400k, GC retention).
- Standalone upstream copy wheel-only run [38601389681](https://github.com/Griggelor/unsloth/actions/runs/38601389681) SUCCESS; evidence artifact `11913707385`. All twelve wheel-burst sequences met the settled-visible gate after 1.2 seconds, while preserving stored synthetic chat.
- The **transient-coverage problem remains**: Dynamic toward newest in burst 0 recorded 0.000 minimum intermediate coverage; Fixed toward older history recorded as low as 0.131, in a 1440x960 test viewport. These are observed, not conjectural. The current test checks stable visibility rather than proving a zero-gap animation. User-reported partially empty areas therefore require targeted Windows/WebView2 review and preferably a stricter time-bounded transient-gap gate.
- No upstream PR is opened. The candidate is a prepared review branch, NOT a fully release-approved version. Remove QA-only workflow from final upstream submission; revalidate any resulting source SHA.
