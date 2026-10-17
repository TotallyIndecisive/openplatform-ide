# ESP32 IDE (Tauri + React)

A lightweight, fast cross-platform IDE for ESP32 development. It focuses on simple device recognition, code editing, compiling, and uploading to ESP32 boards.

## Features
- ESP32 board detection (manual port selection)
- Monaco code editor for C/C++
- Compile and upload via bundled `arduino-cli`
- Serial monitor (with safe DTR/RTS handling)
- Fast upload with 921600 baud support
- Progress bar and non-blocking UI
- Works on macOS and Linux

## Quick start
1. Install dependencies: `npm install`
2. Run in dev: `npm run tauri dev`
3. Build: `npm run tauri build`

## Requirements
- Node.js + npm
- Rust toolchain (for Tauri)
- ESP32 board connected via USB
