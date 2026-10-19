# Zed editor reverse-engineering findings

Target: `/Applications/Zed.app` (Zed 20261014.161923, arm64, `dev.zed.Zed`)

## Evidence sources

| ID | Method | Result |
|---|---|---|
| `inspect_macho` (REA) | Mach-O load commands | 249 MB thin arm64 binary, ~241 MB `__TEXT`, 43,318 symbols |
| `inspect_signature` (REA) | codesign | `dev.zed.Zed`, team `MQ55VZLNZQ`, hardened runtime, `allow-jit` |
| `inspect_plist` (REA) | Info.plist | Editor role, `public.plain-text`/`public.text`/`folder` doc types |
| `otool -L` (ordinary shell) | linkage | **32 system dylibs only** — Metal, MetalKit, CoreVideo, QuartzCore. No Electron/Chromium/WebView |
| `nm -gU` (ordinary shell) | exported Rust symbols | 4,381 `gpui` exports; crate map below |
| `strings` (ordinary shell) | behavioral strings | `workspace::dock::Dock`, `workspace::pane::Pane`, `gpui::elements::uniform_list`, `metal_renderer`, settings schema |

Deep native decompilation (Hopper) **did not complete** in this environment: REA allows 120 s of
Hopper startup, while analysing a 249 MB Rust binary (≈400 k procedures) exceeds it. That facet is
unresolved; conclusions below rest on shipped-artifact metadata, symbol tables, and behavior strings.

## 1. How Zed gets its speed

### Native GPU UI, no web runtime
Zed links **32 system frameworks total**, of which the graphics path is
`Metal` + `MetalKit` + `QuartzCore` + `CoreVideo` + `CoreGraphics`.
There is **no** Electron, Chromium, or WebKit framework. Its own UI toolkit, **GPUI**, is the single
largest code body in the binary (4,381 exported symbols).

GPU-specific strings confirm a real Metal pipeline:
`metal_renderer`, `metal_atlas`, `metal_texture_cache`, `render_frame`, and heavy use of
`quad` (458 hits) + `shadow` — i.e. the whole UI is drawn as GPU quads from an atlas.

### Virtualized lists, not scroll-into-view
`gpui::elements::uniform_list` (115) and `gpui::elements::list` (106) are the list primitives.
`uniform_list` renders **only the visible rows** and recycles elements as you scroll — this is why a
10,000-line file and a 100,000-file tree cost the same to display.

### Data model designed for edits
- Text is stored in a **rope** (`rope::point`, `rope::point_utf16`, `rope::chunk`) — O(log n) insert/delete, cheap clones for multi-cursor.
- Syntax is **tree-sitter** incremental parsing (`tree_sitter`, `grammars::native_grammars`, `grammars::load_queries`), loaded even as WASM (`tree_sitter::wasm_language`).
- The editor separates a **buffer** (`language::buffer::Buffer`) from a **display map** (`editor::display_map`) that layers folds, wrapping, inlay hints and cursors over the immutable rope.
- `multi_buffer::anchor` provides stable positions across excerpt aggregation.

### Entity/observer architecture
`gpui::app::entity_map` (280) plus observer/subscriber invocation is the whole reactive layer:
views are entities, and only entities that observe a change re-render. There is no virtual DOM diff.

## 2. Layout model (what to replicate)

Directly observed type/namespace strings:

```
workspace::Workspace           top-level container
workspace::dock::Dock          dockable panel container (left/right/bottom)
workspace::pane::Pane          tab group / split unit
workspace::pane               (242 symbols)
workspace::item::Item          anything tabbable
workspace::multi_workspace     multiple windows
workspace::modal_layer         centered overlays (command palette)
workspace::toolbar / status_bar / title_bar
workspace4pane / pane_group.border
```

The compositor is a **recursive split tree of Panes** inside a Workspace. Each edge hosts a **Dock**;
each Dock hosts panels. Panels seen in the settings schema and symbols:

`project_panel`, `outline_panel`, `git_panel`, `terminal`, `diagnostics`, `debug_panel`,
`collaboration_panel`, `agent` (assistant).

Geometry is theme/config driven, not hard-coded: `default_width`, `default_height`,
`bottom_dock_layout`, `pane_split_direction_horizontal|vertical`, `centered_layout`,
`resize_all_panels_in_dock`, `zoom_padding`, `sidebar_side`.

Tab behavior worth copying: `preview_tabs` (`enable_preview_from_project_panel`,
`enable_keep_preview_on_code_navigation`) — single-click previews a file in an italic tab; editing
promotes it to a permanent tab.

## 3. Feature functions (evidence-backed)

| Area | Evidence |
|---|---|
| Command palette | `command_palette`; setting `use_command_history`; `workspace::modal_layer` |
| File finder | `file_finder`; `prefill_query_from_selection`, `include_ignored` |
| Editor core | `editor::actions` (1,561), `editor::display_map`, `editor::navigation`, folds (`editor::FoldAtLevel`, `display_folds`) |
| LSP | `project::lsp_store`, `lsp`, full LSP capability schema strings (completion, hover, definition, code action, formatting, rename, semantic tokens, inlay hints, call hierarchy) |
| Terminal | `terminal` (140 symbols), `terminal_view`, `terminal_panel`, ANSI colour theme keys |
| Search | `text_finder::Toggle`, `search` (117), buffer search, `whole_word`/`regex` |
| Diagnostics | `diagnostic` (51), `lsp_pull_diagnostics`, `diagnostics_max_severity`, `sticky_scroll` |
| Vim mode | `vim`, `vim::motion`, `vim::normal/visual`, mode backgrounds in theme |
| Git | `git_ui::git_panel`, `project::git_store`, `git_gutter`, `inline_blame`, `branch_picker` |
| Tasks/debug | DAP schema (`adapter`, `breakpoints`, `launch`, `attach`), `debugger_ui`, task `variables`/`shell` |
| REPL | `repl::session`, `repl::outputs::ExecutionView`, `ReplSettingsContent` |

## 4. What this means for Openplatform IDE (ESP32 / PlatformIO)

The app currently embeds **Monaco** inside a Tauri WebView. That is the opposite of Zed's approach
and is the main reason it cannot match Zed's feel. Concrete, staged plan:

### Phase 1 — layout (no engine change, biggest visible win)
- Restructure the UI as **Workspace → Pane → Item** to mirror Zed.
- Add an icon **activity bar** on the far left and a collapsible **Dock sidebar** hosting
  *Project files*, *Outline*, *Serial* — instead of today's single header row + two editors.
- Make the center a **Pane with tabs** (`platformio.ini`, `main.cpp`) instead of side-by-side panes.
- Add a **status bar** (port, board, line:col, encoding, build state).
- Add a **command palette** (`Cmd+K` / `Cmd+Shift+P`) as a `modal_layer`, driving every action.

### Phase 2 — editor behavior
- Port Zed's **preview tab** semantics to the project panel.
- Add **command palette**, **file finder**, and **outline** backed by PlatformIO/LSP.
- Add **inlay hints**, **sticky scroll**, **relative line numbers**, **indent guides**,
  **breadcrumbs**, **bracket colouring** — all present as Zed settings, all implementable in Monaco.

### Phase 3 — speed (where the real gap is)
- Monaco is a full editor and is fine for our file sizes; the win is **not** rewriting to Rust.
- The measurable wins available now:
  1. **Virtualize the project tree** (Zed's `uniform_list`) — never render off-screen rows.
  2. **Defer language services** until a file is opened; today `pio run` and Monaco start together.
  3. **Persist the PlatformIO build cache** keyed by ini+src (already added) and never re-parse
     unchanged files on project switch.
  4. **Keep the WebView warm** — do not destroy/recreate windows when switching projects.
  5. Only load **C/C++** grammar + one theme at startup.

## 5. Integrated terminal (evidence-backed)

Zed's terminal is a first-class `Workspace` item, not a shell-out: a PTY is spawned, its bytes
are fed through an ANSI parser into a terminal grid, and that grid is rendered by the GPU.

### Architecture

| Layer | Evidence | Meaning |
|---|---|---|
| PTY | `terminal::pty_info::PtyProcessInfo`, `terminal::PtyEvent`, `nix::*` | openpty + `nix` syscalls; no `portable-pty` symbols |
| Emulator | `terminal::alacritty::*` (`event_loop`, `tty::unix::from_fd`, `grid::row`, `selection`) | embeds the `alacritty_terminal` crate |
| ANSI | `terminal::alacritty::ZedListener` impl of `vte::ansi::Handler` | `vte` parses bytes into grid ops |
| View | `terminal_view::TerminalView`, `terminal_view::terminal_element` | grid → GPU quads |
| Panel | `terminal_view::terminal_panel::TerminalPanel`, `TerminalProvider::spawn`, `new_terminal_pane` | the dock tab that owns terminals |
| Builders | `terminal::TerminalBuilder::new`, `new_display_only_with_bounds` | the "display only" variant is the inline assistant |
| Persistence | `terminal_view::persistence::{TerminalDb, get_working_directory}` | terminal db remembers each terminal's cwd |

### Shell selection

- Reads `$SHELL`; ships `/bin/zsh` as the literal fallback (strings in the binary).
- Exports `TERM_PROGRAM` to children (also `TERM`, `COLORTERM` shape colours).
- Shell/args are overridable via `terminal` settings (`shell`, `program`, `args`, `env`, `cwd`).

### Working directory — this is the part to replicate

`terminal_view::default_working_directory` matches a **4-variant enum** and dispatches:

| Variant | Call target | Directory |
|---|---|---|
| 0 | `project::terminals::Project::active_entry_directory` | dir of the **active editor tab's** file |
| 1 | `project::terminals::Project::active_project_directory` | the active **worktree root** |
| 2 | first worktree (`Workspace::worktrees` → `first_project_directory`) | the **first** project root |
| 3 | none (`-1`) | no cwd → the process default (**`$HOME`**) |

The other `project::terminals::Project` entry points confirm the same split:
`first_project_directory`, `active_project_directory`, `active_entry_directory`,
`create_local_terminal`, `create_terminal_task`, `clone_terminal`, `terminal_settings`.

Both directory resolvers route through `project::worktree_store::WorktreeStore::worktree_for_entry`,
so directories are always real worktree paths.

**Behaviour we adopt:** with a saved project open the terminal starts in (and stays in) the
project directory; on a cold launch with no project it starts in `$HOME`. Matches the two
relevant variants (1 and 3 above).

## Limits of this analysis

- Hopper decompilation is unresolved (120 s startup budget vs 249 MB Rust binary).
- Theme colours are compiled into the binary; no plain-JSON theme was recoverable from strings.
- Runtime behaviour (frame timing, actual input latency) was **not** observed — no runtime capture
  was performed, so speed claims are static-architecture inferences, not measurements.
