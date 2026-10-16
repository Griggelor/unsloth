# Unsloth Studio Context Latency — Windows QA executable

Unsigned experimental build, **not an installer or official release**. Git commit and SHA256 are in QA_MANIFEST.json. No update or installer is published.

**Important:** The EXE is a Tauri desktop launcher, *not an embedded Python backend*. Its normal backend is taken from the machine's managed Unsloth environment. Running the EXE alone against an old managed installation will NOT test the new context latency timers. The debug build does not contain an installer; it requires an existing Studio environment.

For a dedicated disposable **test profile / matching backend installation**, do the following after you have backed up your existing Studio data and fully exited Studio (including its tray instance) and backend:

1. Verify QA_MANIFEST.json SHA-256 against unsloth-studio-CONTEXT-QA-UNSIGNED.exe.
2. Run Apply-QA-Backend.ps1 (supply -BackendPath if managed Python is at another location). It checks SHA-256 of FIVE expected original files and aborts BEFORE modification on a mismatch. It creates a timestamped backup and copies only six Python source files. It never writes chat databases.
3. Run Launch-QA.ps1 (pass -BackendPath if needed). This enables UNSLOTH_CONTEXT_LATENCY_TRACE=1 for the launched process and starts the QA EXE. An already-running backend would bypass the fresh instrumentation; stop it before launch. The flag defaults OFF in all other runs.
4. Reproduce the long agent chat, collect sanitized context_latency logs. Logs include endpoint class, random request ID, request/response bytes, wall/thread CPU timings and stage labels, but not chat contents or private IDs. Share only the relevant context_latency records after checking them.
5. Completely quit Studio; use Restore-QA-Backend.ps1 -BackupDirectory <full backup directory> to revert, and restart normally.

Never apply the patch to a backend installation that does not precisely match this commit's upstream baseline: the script refuses to overwrite mismatched files. The QA EXE itself uses the debug Tauri build; **do not rely on first-time setup through this debug executable**, since the debug Rust installer locates install.ps1 from the build machine source directory. Do not run it concurrently with an active production profile. There is no measured Windows performance improvement yet — only an opt-in attribution probe.

Source branch: experiment/context-latency-attribution-20261016.
