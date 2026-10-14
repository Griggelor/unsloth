# QA diagnostic EXE – Working phases and element counts

This is an **unsigned debug-only** Windows Tauri binary, not an installer or release.
It was built from the exact source_commit in QA_MANIFEST.json.

In the chat, before any visible answer you should see:
- Working 1 – Client and history preparation: frontend message count
- Working 2 – Backend request and admission: frontend message count
- Working 3 – Exact context token count: backend request message count
- Working 4 – Archive and recall: number of evicted messages
- Working 5 – Prepare inference request: message count after fit

Each phase displays its *own continuously ticking elapsed time*. It is not a total request duration.
The status persists while Python is doing blocking work, even with llama generation idle.
No actual tool outputs or message texts are embedded in status events.

**Critical deployment requirement:** The Windows UI binary alone does not prove the Python
backend was replaced. To see stages 3–5, the Python server running alongside Studio
must be from the SAME source_commit as this binary. If the local Python server is older,
you will only see stages 1–2 and that is a deployment mismatch, not a timing measurement.
Run against a separate protected QA test profile, not your production chat history.

For detailed log analysis the same-commit Python backend additionally supports
UNSLOTH_CONTEXT_PERF_TRACE=1 (set before backend startup) to show exact-count
and archiving substage wall_ms/cpu_ms and element counts without message contents.

To compare the original quadratic matcher vs experimental indexed matcher,
use the baseline and optimized branches separately. Do not conclude a speedup from
the UI display or compile success alone. Never use this build for production data.
