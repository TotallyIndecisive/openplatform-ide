# OpenPlatform

OpenPlatform is a focused macOS IDE for developing Arduino and ESP32 projects with [PlatformIO](https://platformio.org/). It brings code editing, board tools, a terminal, serial output and GitHub source control into one compact workspace, so you can write firmware, build it, upload it to a board and manage its history without leaving the IDE.

![OpenPlatform v1 workspace](docs/images/workspace-v1.jpg)

The project is in active development. The `v1.0.0` tag captures the first workspace design; the source-control and account improvements described below were added afterwards and are currently unreleased. This guide describes the current `main` branch as of 27 October 2026.

## The workspace

The editor is at the centre of the app, with open documents above it and a terminal beside a separate output window below. A compact floating dock gives access to project tools; its small icons show labels on hover or focus, and you can choose which tools are visible in Settings. Standard File, Edit, View, Build, Tools and Window menus live in the macOS menu bar.

The workspace includes a file explorer, outline, syntax highlighting, breadcrumbs, minimap, preview tabs and locally remembered appearance preferences. Unsaved-file recovery and checks for external file changes help protect editing work.

## What you can do

- **Create and edit projects:** create, open and revisit PlatformIO projects, including ESP32, Arduino Uno and classic Nano templates. Work with multiple open files, save individual files or all files, and find files or text across a project.
- **Navigate C/C++ code:** use clangd-powered completion, hover information, definitions, references, formatting and diagnostics. Generate a compilation database to give clangd the project's build settings.
- **Build and upload:** choose a PlatformIO environment and serial port, identify a connected chip, verify or upload firmware, and cancel a running task. Build, clean, run tests, run static analysis, install dependencies and generate the compilation database from the IDE. Build messages and diagnostics appear in Output and Problems.
- **Work with a board:** inspect and send serial data, choose the baud rate and line ending, and release the serial monitor around uploads. Search the board catalogue and configure the project in `platformio.ini`.
- **Use libraries:** search for and install PlatformIO libraries for the project.
- **Use Git and GitHub:** initialize a repository, inspect changes and diffs, stage or unstage files, commit, create or switch branches, view history, fetch, pull and push. Connect an existing remote or publish a new public or private GitHub repository.
- **Use a terminal:** run shell commands in a real, persistent terminal alongside the output window.
- **Start basic hardware debugging:** use the OpenOCD controls with a suitable installation and JTAG probe. This is basic process control, not a complete graphical debugger.

PlatformIO supplies the board platforms, frameworks, compilers and libraries for a project. A project's `platformio.ini` is the source of truth for its environments and board configuration. Hardware support and debugging depend on the board, platform configuration and connected equipment.

## Set up on macOS

These instructions build and run the current source. You need an internet connection for the initial tool and PlatformIO package downloads.

### 1. Install the prerequisites

Install Apple's command-line developer tools:

```sh
xcode-select --install
```

Install [Homebrew](https://brew.sh/) if you do not already have it. In Terminal, install Node.js, Git and PlatformIO Core:

```sh
brew install node git platformio
```

Use Node.js 22.12 or later and the npm that comes with it. Install the stable Rust toolchain using the instructions at [rustup.rs](https://rustup.rs/), then restart Terminal or load the environment as directed by the installer. [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/) describe the macOS build requirements in more detail.

For C/C++ code intelligence, install LLVM/clangd. GitHub CLI is needed for GitHub sign-in, account switching and publishing:

```sh
brew install llvm gh
```

Make clangd available to the shell that launches OpenPlatform:

```sh
export PATH="$(brew --prefix llvm)/bin:$PATH"
```

Add that line to your shell configuration if you want it on future Terminal sessions. A compatible [OpenOCD](https://openocd.org/) installation and JTAG probe are optional and only needed for the basic hardware debugging controls.

### 2. Download and run the IDE

```sh
git clone https://github.com/TotallyIndecisive/openplatform-ide.git
cd openplatform-ide
npm ci
npm run tauri dev
```

The first build can take a while while Rust and JavaScript dependencies are compiled. Keep the Terminal session open while using the development app.

### 3. Build a local application

To build a macOS app bundle for local development:

```sh
npm run tauri -- build --debug --bundles app
```

The bundle is created at `src-tauri/target/debug/bundle/macos/OpenPlatform.app`. It is a local debug build, not a signed or notarized installer. The project does not currently describe a packaged end-user installation in this guide.

## Start a project

1. Use **File → New Project** to create a project from a board template, or **File → Open Project** to open an existing PlatformIO project. Recent projects are available in the app.
2. Select the PlatformIO environment for your board. Check `platformio.ini` for the board, framework and any library dependencies.
3. Open the source file from the project explorer and edit it in the central editor. Run **Build → Generate Compilation Database** after opening a project and again when its environment, build flags or dependencies change so clangd can provide accurate C/C++ navigation.
4. Connect your board, refresh and select its serial port, then verify or upload the project. The first PlatformIO build may download the platform and toolchain. Use the output and Problems views to inspect errors.
5. Open Serial Output to monitor messages or send text. Select the baud rate used by your firmware; the monitor can be released and resumed around an upload.

Running embedded tests can upload test firmware to a connected board. Check your PlatformIO test configuration before running them.

## Git and GitHub

Git is available for local repository work; GitHub features additionally require GitHub CLI (`gh`) and an authenticated account.

1. Open **Settings → Accounts**, choose **Edit**, and save the Git author name and email you want OpenPlatform to use for commits. If no author preference is saved, Git's existing configuration is used.
2. Use **Sign in to GitHub** and complete the GitHub CLI authorization flow in your browser. You can sign in another account and switch between accounts already authenticated in GitHub CLI.
3. Open the GitHub tool from the dock. Initialize the repository if needed, inspect the changed files and their diffs, stage the changes you want, enter a commit message and commit.
4. Publish a new public or private repository, or connect an existing `origin`. Use Fetch, Pull and Push to synchronize subsequent work.

Pull uses fast-forward only. If local and remote histories have diverged, resolve the history using Git before trying again. If the project is inside a parent Git repository, staging applies to the whole repository; the panel shows the repository root.

Accounts fields are locked until **Edit** is selected. The Git author preference is local to OpenPlatform; changing the GitHub username switches to an account already authenticated in GitHub CLI and does not edit the profile on GitHub. The last-sign-in indicator records successful sign-ins performed through the updated IDE and advances after each elapsed 24-hour period. Earlier or external sign-ins show **Not recorded**. GitHub CLI manages authentication credentials; OpenPlatform does not display or store access tokens in Settings.

See the [GitHub and source-control guide](docs/github-source-control.md) for more detail on the workflow, credentials and validation.

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
| F12 | Go to definition in C/C++ |

## Troubleshooting and configuration

- **PlatformIO or clangd is not found:** check `which pio` and `which clangd` in the Terminal used to launch the app. If installed in a nonstandard location, start the development app with `OPENPLATFORM_PIO` or `OPENPLATFORM_CLANGD` set to the executable's absolute path. Regenerate the compilation database if C/C++ navigation is incomplete.
- **A board or port is missing:** reconnect the board, check the USB cable and refresh the port list. Make sure the chosen environment matches the board and that another application is not using the serial port.
- **GitHub sign-in or publishing fails:** check that `gh` is installed and available, and complete its browser authorization. Check the selected account and repository permissions. `GH_PATH` can point to a nonstandard GitHub CLI executable.
- **Pull reports divergent history:** OpenPlatform intentionally uses fast-forward-only pulls. Resolve the divergence with Git, then retry.

Other supported executable overrides are `OPENPLATFORM_CODE` and `GH_PATH`. `OPENPLATFORM_PROJECT` selects the initial project; otherwise the most recent existing project opens. Environment variables must be available to the process launching the app; Finder-launched apps may not inherit your Terminal's shell configuration.

## Project history

The dates below summarize the project from its first recorded Git commit through the current changes. For individual changes and the earlier development notes, see the [changelog](CHANGELOG.md).

| Date | Milestone |
| --- | --- |
| 17 October 2026 | Initial OpenPlatform IDE prototype and core application foundation. |
| 18 October 2026 | PlatformIO project creation and opening, project files and recent-project workflows. |
| 19 October 2026 | A more integrated workspace with file navigation, command palette, project search, terminal and output. |
| 24 October 2026 | Development-tool and reliability work across clangd, safe file handling, build environments, serial and task controls, plus Git, library, board and basic OpenOCD panels. |
| 25 October 2026 | Native macOS application menus and continued workspace refinement. |
| 27 October 2026 | `v1.0.0` workspace checkpoint: centred editor and document tabs, compact configurable floating dock, and terminal and output side by side. Subsequent unreleased changes expanded Git/GitHub workflows and added the locked Accounts settings and sign-in age indicator. |

## Development and validation

OpenPlatform uses Tauri and Rust for the desktop backend, React and TypeScript for the interface, Monaco for editing, xterm for the terminal, and PlatformIO for embedded workflows.

```sh
npm run build          # Type-check and build the frontend
npm test               # Frontend diagnostics tests
npm run test:backend   # Rust backend tests
```

The v1 layout was checked with a frontend build, a macOS debug bundle and focused visual checks. The Git work was checked with disposable local repositories, a controlled GitHub CLI fixture and a private GitHub repository for creation, push, fetch and pull. The revised last-sign-in recording and switching between two real GitHub accounts have not yet been tested end to end. Hardware and full regression testing were outside the v1 layout validation.

Additional documentation:

- [GitHub and source control](docs/github-source-control.md)
- [v1 layout notes](docs/design-v1.md)
- [Earlier capability review](docs/ide-capabilities.md) — historical; its roadmap predates the current Git, board and library panels
- [Changelog](CHANGELOG.md)
