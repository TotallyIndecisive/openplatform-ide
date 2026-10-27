# Changelog

## 1.0.0 — 27 October 2026

- Implement the approved compact light workspace, centered document tabs and teal editor styling.
- Replace the tall activity rail with a centered floating icon dock, hover labels and saved visibility settings.
- Show the persistent terminal beside independent Serial Output, Build Output and Problems tabs.
- Move file operations into native macOS menus and use an integrated native title bar.
- Restyle project, file, outline, GitHub, library, board, debug, search and settings views.
- Preserve existing development workflows; add readable library/board results and adjustable editor appearance.
- Validate the frontend build, macOS app bundle and key visual states.

## 2025-10-16
- Initial app created (Tauri 2 + React + TypeScript)
- Added device recognition, code editing, compile/upload
- Fixed ctags compatibility on macOS (used Arduino-patched arm64 ctags)
- Made UI non-blocking with progress bar
- Added serial monitor with safe DTR/RTS handling

## 2025-10-17
- Optimized upload speed (921600 baud)
- Added compile cache to skip redundant recompiles
- Switched default blink example to use millis() (5s interval)
- Backend esptool lookup cached for faster startup

## 2026-10-24

- Single-pass incremental upload, explicit environments, cancellable job-owned tasks,
  bounded progress/output, serial port release/join and monitor recovery.
- Atomic conflict-aware saves, dirty-file guards/recovery, safe project/file creation,
  external edit reload, absolute editor models and worker-thread literal search.
- clangd completion/hover/definition/references/formatting/diagnostics, compilation
  database tooling and clickable compiler Problems.
- Serial transmit, portable tool discovery, toolchain checks, clean/check/test/package
  commands, Uno/Nano templates, ESP32/Uno examples, VS Code tasks and regression tests.
