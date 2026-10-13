# Main sync candidate for PR33 — 2026-10-13

QA staging only. No main or integration branch change.

Source main: e751e19447f7c85130beb00245a3f2abf2567bdb
Source tested QA snapshot: 78790a2060a363bd82f64c73fc631d80f0dcfde6
Merge base: 781a1a09f03e706ad7ac7adecaec352a9692a3a2

The nine main-edited paths are distinct from the 92 PR33 paths; all nine main blobs can be incorporated unchanged. This candidate keeps both parents. DO NOT move integration until existing exact-78790a2060a3 CI results have been assessed; a candidate is *not* a Windows QA release or a replacement for its existing EXE.

Rebuild and recheck combined EXE and context tests after fast-forwarding integration, if ever approved by the existing QA gates.
