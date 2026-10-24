# Openplatform IDE capability review — 24 October 2026

This review is based on the project source, local desktop interaction, the installed
PlatformIO/clangd tools, and the connected ESP32. The existing visual design is retained.
It is an Arduino/PlatformIO desktop IDE foundation, not yet full VS Code or Zed parity.

## Existing capabilities

Tauri 2/Rust hosts a React/Monaco editor, a lazy directory explorer, preview/pinned tabs,
a command palette, file finder, project search, a declaration outline, native file
dialogs, recent projects, a PTY terminal rendered by xterm.js, streamed PlatformIO
output, USB serial discovery, chip identification, and a serial receiver.

The original upload handler sometimes ran `pio run` immediately before
`pio run -t upload`. Its cache key considered only open editor buffers, not every
source/header/configuration file. Saves could fail while the build proceeded; closing
or switching projects discarded dirty buffers. The serial stop command returned before
the reader actually released its port. PlatformIO and VS Code paths were tied to this
Mac. Monaco had syntax colouring and a heuristic outline, but no language server.

## Implemented in this pass

| Area | Behaviour now |
| --- | --- |
| Build and upload | One incremental `pio run -t upload -e <environment> --upload-port <port>`. PlatformIO decides what must rebuild. Failed saves stop the task. |
| Task ownership | Immediate frontend lock plus backend lock, job IDs, process-group cancellation, elapsed time, CR/LF progress parsing, bounded output, and cleanup on window destruction. |
| Configuration | Environments are read through PlatformIO's configuration parser and selected explicitly. Selection is remembered per project. |
| Serial | Stop waits for reader and writer handles to close; upload restores an active monitor; send text with no ending/LF/CRLF; ports refresh every 2.5 seconds. |
| Files | Atomic replacement saves preserve permissions, detect external changes against the loaded baseline, and leave dirty edits intact on errors. New files/projects refuse to overwrite existing data. |
| Editor safety | Dirty tab/project/window confirmation, local dirty-buffer recovery, reload clean buffers on focus, explicit Reload File command, absolute Monaco model identities. |
| Diagnostics | GCC/Clang errors and warnings appear as editor markers and clickable Problems entries. |
| C++ | Project-scoped clangd JSON-RPC transport, live document sync, diagnostics, completion, hover, definition, references, and formatting. Requests time out and providers/listeners are cleaned up on project changes. |
| C++ configuration | Generate Compilation Database command runs PlatformIO's `compiledb` target, creates a `.clangd` file if absent, and restarts clangd. GCC-only parsing flags are removed without changing firmware compiler flags. |
| Tools | Portable executable discovery and explicit overrides; toolchain check, Clean, Test, Static Analysis, and Install Dependencies commands. |
| Project creation | ESP32/GPIO 23 remains the default; Arduino Uno and classic Nano templates are available in the palette. `src`, `include`, `lib`, `test`, `.gitignore`, and `.clangd` are scaffolded. |
| Search | Literal ripgrep search, ignored build/index folders, stale-result suppression, worker-thread execution, and symlink skipping in fallback traversal. |
| Development | VS Code tasks, repeatable frontend/backend tests, an ESP32 hardware smoke script, and ESP32/Uno examples. |

## Using the new commands

Open the palette with **Shift+Cmd+P**. Select the environment beside the serial port.
Use **Build: Generate Compilation Database** once after opening a project and again
after changing environments, build flags, or library dependencies. Until then clangd
reports that it needs a build database. Existing `.clangd` files are preserved; merge
GCC-only flag exclusions manually if an existing configuration needs them.

For libraries, add pinned dependencies under `lib_deps` in `platformio.ini`, then use
**Project: Install Dependencies**. **Build: Static Analysis** invokes `pio check`;
**Build: Run Tests** invokes `pio test` for the selected environment. Embedded tests may
flash a connected board; these commands are user-initiated and are not run on startup.
The integrated terminal remains available for full PlatformIO and Git commands.

**Editor: Reload File from Disk** resolves an external-edit conflict by explicitly
replacing the tab contents. A save conflict never silently overwrites the other editor's
changes. Recovery uses local webview storage, debounced by 400 ms; it is a convenience,
not a replacement for Save or version control. Files over 8 MiB are rejected by the text
editor. The outline remains a lightweight approximation rather than a semantic AST.

Tool overrides accepted at app launch:

- `OPENPLATFORM_PIO`: absolute path to PlatformIO Core.
- `OPENPLATFORM_CLANGD`: absolute path to clangd.
- `OPENPLATFORM_CODE`: absolute path to the VS Code CLI.
- `OPENPLATFORM_PROJECT`: initial project folder; otherwise the most recent existing
  PlatformIO project opens.

## Validation on this Mac

- Production frontend build and packaged macOS debug app build succeeded.
- Fourteen Rust tests passed, including real PTY I/O, LSP framing/bounds, streamed
  progress, save conflicts, non-overwriting creation, and unsaved outline content.
- Two frontend diagnostic tests passed, including spaces and Windows drive letters.
- ESP32-D0WDQ6 revision 1, 4 MiB flash, CP2102, `/dev/cu.usbserial-0001` detected.
- Fresh GPIO 23 example build/upload: **19.14 s** reported by PlatformIO.
- Repeat incremental upload: **12.98 s**; firmware data transfer approximately
  **3.1 s** at 921600 baud. These are individual observations, not benchmark averages
  or an old-versus-new controlled comparison.
- Arduino Uno example compiled successfully in **2.16 s** with the installed AVR toolchain; no Arduino board was available for a hardware upload test.
- Serial smoke check observed both `GPIO 23: on` and `GPIO 23: off` at 115200 baud.
  The electrical LED output was not visually measured.
- Native app upload with the serial monitor already active succeeded and restored
  serial monitoring. Native build cancellation returned control to the editor.
- `clangd --check` on the actual ESP32 source passed after excluding four GCC-only
  flags. Native **F12** on `pinMode` opened its actual Arduino core declaration.
- Installed versions used: PlatformIO Core 6.1.19; Espressif platform 55.3.37;
  Arduino ESP32 framework 3.3.7; esptool 5.1.2; Xtensa GCC 14.2.0; Apple clangd 21.

## Remaining work, ordered by practical value

| Priority | Gap | Concrete next implementation |
| --- | --- | --- |
| High | Distribution and toolchain onboarding | Signed/notarized installers; detect/install managed PlatformIO and clangd; versioned toolchain support and actionable recovery for interrupted downloads. |
| High | Broader reliability coverage | Automated native UI tests for save/reopen/recovery, process crash, unplug/replug, failed flash, concurrent edits, and long-running terminals; hardware matrix for ESP32 variants and AVR boards on Windows/Linux/macOS. |
| High | File/workspace management | Rename/move/trash and undo, folders, workspace settings, full session/tab/cursor restoration, and filesystem notifications instead of focus-only reload. |
| High | Language completeness | Signature help, code actions, semantic rename with preview, semantic tokens, semantic outline, workspace symbols, and automatic environment-aware index regeneration. |
| Medium | Boards/libraries UI | Searchable board catalogue, framework/platform versions, package browser, install progress, library examples, and dependency version editing. `platformio.ini` and CLI currently provide this control. |
| Medium | Debugging | Debug Adapter Protocol session management, breakpoints, call stack, registers/watch/memory, and OpenOCD/GDB adapter configuration. A classic WROOM32 board's USB-UART connection alone is not a JTAG probe. |
| Medium | Git | Status, diff, stage/unstage, commit, branches, conflict resolution and history views; Git is currently available through the terminal/VS Code. |
| Medium | Arduino-specific tools | Serial plotter, timestamped/log-to-file monitoring, selectable encoding, sketch import/conversion, and a richer examples browser. |
| Medium | Editing/workspace parity | Split editors, multiple terminal sessions, workspace-wide replace with preview, configurable keymaps/settings, and multi-root workspaces. |
| Later | Advanced delivery | OTA discovery/configuration, filesystem-image upload, firmware artifact inspection, and safe measured optimizations beyond normal incremental upload. |
| Later | Extension/remote ecosystem | Plugin API, extension isolation, remote development/containers, collaboration, and integrated assistant workflows. |

Avoid using `nobuild` as the default speed shortcut: skipping dependency checks can flash
stale firmware. Keep `.pio` build artifacts between uploads; use Clean only when needed.
921600 baud worked on this connection; if a different cable/board has transfer errors,
set `upload_speed = 460800` or `115200` in that project's environment and retry.

Upstream references: [PlatformIO build/upload workflow](https://docs.platformio.org/en/stable/core/quickstart.html),
[clangd compilation databases](https://clangd.llvm.org/installation.html),
[clangd cross-compiler discovery](https://clangd.llvm.org/design/compile-commands), and
[clangd flag configuration](https://clangd.llvm.org/config).
