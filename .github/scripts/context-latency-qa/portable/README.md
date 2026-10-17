# Portable Unsloth Studio — context latency QA (Windows x64)

**Experimental, unsigned and isolated. Not an official installer or release.**

Unzip the *entire* artifact into its own directory on an NTFS disk and run `Start-Portable-QA.cmd`. Do not copy the EXE alone.

The package has its own:
- Desktop executable (separate Tauri identifier and single-instance scope)
- Instrumented Python backend and standalone CPython runtime, in `qa-runtime/studio/`
- llama.cpp executable/runtime under `qa-runtime/llama.cpp`
- Chat database, projects, sandboxes, model/cache assets and logs under `qa-runtime/`

The portable Cargo feature selects only the EXE-relative backend, even under debug builds, and rejects a missing interpreter, CLI or tracing module. It also suppresses QA autostart edits and startup deep-link registration. The portable Cargo feature prevents the desktop from consulting `~/.unsloth/desktop_studio_home` or falling back to `~/.unsloth/studio` on this build. The bundled backend Python is relocated inside the *extracted QA folder only* using a private CPython standard-library venv launcher (replacing the nonrelocatable uv trampoline), plus verified `pyvenv.cfg`. On startup it verifies the Python paths and diagnostic module before opening the app. It never applies a patch or edits the installed Unsloth backend.

The QA build has no installer and no updater endpoints. Its built-in environment is constructed on a clean Windows CI worker using the exact source commit and a **no-PyTorch, GGUF-chat-focused** installation. That can be CPU-oriented. Real GPU parity and model-specific llama prefill timings must be compared carefully; the 16-minute Python pre-inference delay is the primary measurement target. A separate model-cache tree may require downloading the test model again.

To revert, shut down the portable QA app and delete its extracted directory. It does not migrate or alter your normal chats. You may still see a separate Windows WebView2 cache and OS security prompt because this executable is unsigned.

Content-free timing logs use `UNSLOTH_CONTEXT_LATENCY_TRACE=1`, injected into only the portable backend child. Do not share unrelated application logs without checking them.

**Limitations:** The Windows artifact is not accepted as functional until the CI verifies Python relocation, module import, successful Tauri compilation and build artifact creation. Large synthetic CI runs do not reproduce the user's full 16:29 pre-inference stall. Portable executable/venv packaging can be large.
