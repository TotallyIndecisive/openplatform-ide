# Openplatform IDE (Tauri + React)

A lightweight, fast cross-platform IDE for Arduino and ESP32 development. It focuses on
simple device recognition, code editing, compiling, and uploading to ESP32 boards, in a
workspace modelled on [Zed](https://zed.dev).

The editor layout, docks, panes, command palette and terminal follow Zed's model; the
reverse-engineering notes behind those decisions are in [`docs/zed-analysis.md`](docs/zed-analysis.md).

## Features

- ESP32 board detection (manual port selection) with USB descriptor details
- Monaco code editor for C/C++ with breadcrumbs, outline and sticky scroll
- Compile and upload via PlatformIO Core (`pio run`, `pio run -t upload`)
- Integrated terminal — a real PTY running your login shell
- Separate build/upload output view with progress and one-click clear
- Serial monitor (with safe DTR/RTS handling)
- Fast upload with 921600 baud support
- Project explorer, outline, project-wide search and file finder
- Command palette, preview tabs, and a Zed-style activity bar / dock / status bar
- New / Open / Save / Save As with native dialogs and a recent-projects list
- Progress bar and non-blocking UI
- Works on macOS and Linux

## Capabilities roadmap

Every capability the IDE has, in the order it was implemented, with the date it landed.

1. **2026-10-18** — Project backend: load, create, and list recent projects; `platformio.ini`-compatible on-disk format.
2. **2026-10-18** — File menu with New / Open Project and recent-project reopen.
3. **2026-10-18** — File dropdown: New File, Open, Save, Save As via native dialogs, with a recent-projects list (max 10, stored at `~/.openplatform-ide/recent.json`).
4. **2026-10-18** — PlatformIO build backend: compile and upload through `pio run` / `pio run -t upload`, replacing the old `arduino-cli` path.
5. **2026-10-19** — Zed-style workspace: activity bar, collapsible resizable dock, tabbed pane with breadcrumbs, status bar, and the One Dark palette.
6. **2026-10-19** — Command palette (⇧⌘P), file finder (⌘P), and project-wide search (⇧⌘F).
7. **2026-10-19** — Preview-tab semantics, keybindings (⌘S / ⌥⌘S / ⌘B / ⌘W), and an in-process C/C++ outline scanner.
8. **2026-10-19** — Integrated terminal: a real PTY running your login shell, opening in the project directory (or `$HOME` on a cold launch), with resize-aware reflow.
9. **2026-10-19** — Separate build/upload output view, auto-revealed from the terminal when an identify, verify or upload starts.
10. **2026-10-19** — Terminal survives panel toggles: the dock stays mounted so the shell session and scrollback persist.

## Quick start

1. Install dependencies: `npm install`
2. Run in dev: `npm run tauri dev`
3. Build: `npm run tauri build`

## Requirements

- Node.js + npm
- Rust toolchain (for Tauri)
- PlatformIO Core, with `pio` on the path used by the backend
- ESP32 board connected via USB

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⇧⌘P | Command palette |
| ⌘P | Go to file |
| ⇧⌘F | Find in project |
| ⌘S / ⌥⌘S / ⇧⌘S | Save / Save all / Save as |
| ⌘B | Toggle sidebar |
| ⌘W | Close tab |
| ⌃\` | Toggle terminal |
