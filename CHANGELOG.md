# Changelog (TL;DR)

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
