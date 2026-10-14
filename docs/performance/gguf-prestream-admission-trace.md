# GGUF admission count trace: pre-SSE server bottleneck

User symptom: 22 minutes of Working with idle llama generation. Exact GGUF admission count may happen BEFORE StreamingResponse starts. UI-only streaming events cannot display a substage until after admission. This diagnostic experiment measures the count at its actual admission point with opt-in UNSLOTH_CONTEXT_PERF_TRACE=1.

Production change: wrapping _count_gguf_admission_prompt via trace_call('gguf.admission_exact_count', ... messages=len(messages)). Call results, errors and fallback behavior unchanged; no message contents/IDs logged. Trace logs wall_ms and cpu_ms. When disabled (default), the wrapper immediately delegates to the original function.

Traced count is not the only candidate: checkpoint exact count inside tool loops, O(n*n) conversation archive seat matches, embedding/chunking, SQLite and front-end autosave can also dominate. The experiment branch inherits the indexed archive seat scan with targeted parity tests.

Working phases GUI lives on the parent experimental branch. This diagnostic branch is a controlled code candidate only; it is NOT an EXE build and does not modify main, PR33 or the parent debug branch. Windows timings remain unverified.