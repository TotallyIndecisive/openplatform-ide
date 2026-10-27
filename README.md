# OpenPlatform

A focused macOS workspace for Arduino and ESP32 development. Built with Tauri, React, Monaco and PlatformIO.

![OpenPlatform v1 workspace](docs/images/workspace-v1.jpg)

## Version 1 workspace

- A light, compact editor with teal accents, centered open-file tabs, a minimap, breadcrumbs and syntax highlighting.
- A short floating dock with small icons and hover/focus labels. Choose visible tools in Settings; the dock grows or shrinks to fit.
- A persistent terminal beside a separate window for Serial Output, Build Output and Problems. Both windows can stay open together.
- Native macOS menus for File, Edit, View, Build, Tools and Window. File actions are in the system menu bar rather than inside the workspace.
- Consistent floating panels for projects, files, outline, GitHub, libraries, boards, basic OpenOCD controls and appearance settings.

## Development tools

- New, open and recent projects; ESP32, Arduino Uno and Nano templates; native Save / Save As dialogs.
- Monaco C/C++ editing with clangd completion, hover, definitions, references, formatting and live diagnostics.
- Project search, file finder, command palette, preview tabs and unsaved-file recovery.
- Explicit PlatformIO build environment and USB serial port selection; identify, verify, upload and cancel controls.
- Real PTY terminal with persistent scrollback and shell restart.
- Serial receive/send, baud selection, None/LF/CRLF endings and automatic monitor release/resume around uploads.
- Compiler diagnostics in the Problems view. Build, clean, test, analysis, dependency installation and compilation database commands.
- Git status, staging, commit, branches, remotes, history, push/pull and GitHub publishing.
- PlatformIO library search/install and searchable board catalogue. Configure the selected board in `platformio.ini`.

## Run locally

Requires Node.js/npm, Rust, PlatformIO Core and clangd. GitHub publishing uses `gh`; basic hardware debugging uses OpenOCD and a compatible JTAG probe.

```sh
npm install
npm run tauri dev
```

Build the macOS application:

```sh
npm run tauri -- build --debug --bundles app
```

The local app is written to `src-tauri/target/debug/bundle/macos/OpenPlatform.app`. This is a development build, not a signed/notarized installer.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⇧⌘P | Command palette |
| ⌘P | Go to file |
| ⇧⌘F | Find in project |
| ⌘O / ⇧⌘N | Open / new project |
| ⌘N | New file |
| ⌘S / ⌥⌘S / ⇧⌘S | Save / save all / save as |
| ⌘W | Close tab |
| ⌘B | Toggle auxiliary panel |
| ⌃` | Toggle terminal |
| ⌘, | Settings |

For C++ navigation, run **Build → Generate Compilation Database** after opening a new project or changing its environment. F12 goes to a definition. Appearance settings and dock visibility are remembered locally.

Tool executable overrides are `OPENPLATFORM_PIO`, `OPENPLATFORM_CLANGD` and `OPENPLATFORM_CODE`. `OPENPLATFORM_PROJECT` selects the initial project; otherwise the most recent existing project opens.

## v1 validation

The v1 design pass was checked with a production frontend build, a native macOS debug bundle, and focused visual checks of the workspace, native File menu and dock customization. A full regression or hardware test pass was intentionally outside this layout-focused change.

The [earlier capability review](docs/ide-capabilities.md) records backend validation from 24 October; its roadmap is historical and predates the current Git, board and library panels. The [v1 layout notes](docs/design-v1.md) describe the current presentation.
