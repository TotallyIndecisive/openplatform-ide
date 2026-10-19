use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

const PIO: &str = "/Users/smckenzie/.platformio/penv/bin/pio";


// ---------------------------------------------------------------- helpers ---

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/Users/smckenzie".into())
}
fn config_dir() -> String {
    let h = home();
    format!("{h}/.openplatform-ide")
}
fn recent_path() -> PathBuf {
    PathBuf::from(config_dir()).join("recent.json")
}
fn load_recent() -> Vec<String> {
    let p = recent_path();
    if !p.exists() { return vec![]; }
    let s = std::fs::read_to_string(p).unwrap_or_default();
    serde_json::from_str(&s).unwrap_or_default()
}
fn save_recent(list: Vec<String>) -> Result<(), String> {
    let p = recent_path();
    std::fs::create_dir_all(p.parent().unwrap_or(&p)).map_err(|e| format!("mkdir: {e}"))?;
    let c = serde_json::to_string_pretty(&list).map_err(|e| format!("json: {e}"))?;
    std::fs::write(p, c).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

static ESPTOOL_BIN_CACHE: OnceLock<Option<String>> = OnceLock::new();

fn esptool_bin() -> Option<String> {
    ESPTOOL_BIN_CACHE
        .get_or_init(|| {
            let base = PathBuf::from(home())
                .join(".openplatform-ide/Arduino15/packages/esp32/tools/esptool_py");
            let entries = std::fs::read_dir(&base).ok()?;
            for e in entries.flatten() {
                let d = e.path();
                if !d.is_dir() {
                    continue;
                }
                for name in ["esptool", "esptool.py", "esptool.exe"] {
                    let p = d.join(name);
                    if p.is_file() {
                        return Some(p.to_string_lossy().to_string());
                    }
                }
            }
            None
        })
        .clone()
}

// ------------------------------------------------------ device recognition ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialPortInfo {
    address: String,
    is_usb: bool,
    vid: Option<String>,
    pid: Option<String>,
    serial_number: Option<String>,
    manufacturer: Option<String>,
    product: Option<String>,
}

/// Enumerate serial ports + USB descriptors (the same data Arduino's
/// `serial-discovery` obtains from IOKit).
#[tauri::command]
fn list_serial_ports() -> Vec<SerialPortInfo> {
    let mut out = Vec::new();
    let ports = serialport::available_ports().unwrap_or_default();
    for p in ports {
        // Match Arduino's serial-discovery: expose the callout device (`/dev/cu.*`),
        // not the dial-in twin (`/dev/tty.*`).
        if p.port_name.starts_with("/dev/tty.") {
            continue;
        }
        let is_usb = matches!(p.port_type, serialport::SerialPortType::UsbPort(_));
        let (vid, pid, serial_number, manufacturer, product) = match p.port_type {
            serialport::SerialPortType::UsbPort(u) => (
                Some(format!("{:#06x}", u.vid)),
                Some(format!("{:#06x}", u.pid)),
                u.serial_number,
                u.manufacturer,
                u.product,
            ),
            _ => (None, None, None, None, None),
        };
        out.push(SerialPortInfo {
            address: p.port_name,
            is_usb,
            vid,
            pid,
            serial_number,
            manufacturer,
            product,
        });
    }
    // USB ports first, then alphabetical — makes the picker stable.
    out.sort_by(|a, b| b.is_usb.cmp(&a.is_usb).then(a.address.cmp(&b.address)));
    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChipInfo {
    port: String,
    esptool: String,
    success: bool,
    /// The esptool subcommand that actually answered (e.g. `chip-id`).
    command: String,
    /// A one-line summary extracted from esptool output, when recognised.
    summary: String,
    output: String,
}

/// Run one `esptool <sub>` invocation against a port; returns (ok, combined output).
fn run_esptool(esptool: &str, port: &str, sub: &str) -> Option<(bool, String)> {
    let o = Command::new(esptool)
        .args(["--port", port, sub])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()?;
    let mut out = String::from_utf8_lossy(&o.stdout).to_string();
    out.push_str(&String::from_utf8_lossy(&o.stderr));
    Some((o.status.success(), out))
}

fn first_line_with(haystack: &str, needles: &[&str]) -> Option<String> {
    haystack
        .lines()
        .find(|l| needles.iter().any(|n| l.to_lowercase().contains(n)))
        .map(|l| l.trim().to_string())
}

fn identify_chip_blocking(port: String) -> ChipInfo {
    let Some(esptool) = esptool_bin() else {
        return ChipInfo {
            port,
            esptool: String::new(),
            success: false,
            command: String::new(),
            summary: String::new(),
            output: "esptool not found yet (is the ESP32 core still installing?)".into(),
        };
    };

    // esptool 5.x canonical is `chip-id`; older releases accepted `chip_id`.
    // `flash-id` is a last-ditch fallback that still proves we reached the chip.
    let mut last = String::new();
    for sub in ["chip-id", "chip_id", "flash-id"] {
        if let Some((ok, output)) = run_esptool(&esptool, &port, sub) {
            if ok {
                let summary = first_line_with(&output, &["chip type", "chip is"])
                    .unwrap_or_else(|| format!("{sub}: ok"));
                return ChipInfo {
                    port,
                    esptool,
                    success: true,
                    command: sub.to_string(),
                    summary,
                    output,
                };
            }
            last = output;
        }
    }

    ChipInfo {
        port,
        esptool,
        success: false,
        command: String::new(),
        summary: String::new(),
        output: if last.is_empty() {
            "esptool could not open the port (is another program using it?)".into()
        } else {
            last
        },
    }
}

/// Ask the ESP32's ROM bootloader who it is (`esptool chip-id`).
/// Non-destructive: reads chip registers only, never writes flash/eFuse.
///
/// Declared `async` so the multi-second esptool call runs on a blocking worker
/// thread instead of the UI main thread (no more spinning cursor).
#[tauri::command]
async fn identify_chip(port: String) -> ChipInfo {
    let p = port.clone();
    tauri::async_runtime::spawn_blocking(move || identify_chip_blocking(port))
        .await
        .unwrap_or_else(|e| ChipInfo {
            port: p,
            esptool: String::new(),
            success: false,
            command: String::new(),
            summary: String::new(),
            output: format!("identify task panicked: {e}"),
        })
}

// ---------------------------------------------------------- cli streaming ---

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CliOutput {
    stream: String,
    line: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CliExit {
    code: Option<i32>,
    args: Vec<String>,
}

/// Spawn `arduino-cli` (with our config) and stream its output to the webview
/// as `cli-output` events, ending with a `cli-exit` event.
///
/// Returns as soon as the process is spawned — the `wait()` happens on a
/// background thread, so a long compile/upload never freezes the webview.
#[tauri::command]
fn cli_start(app: tauri::AppHandle, cwd: Option<String>, args: Vec<String>) -> Result<(), String> {
    let mut cmd = Command::new(PIO);
    if let Some(ref d) = cwd {
        cmd.current_dir(d);
    }
    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn pio: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let a1 = app.clone();
    let t1 = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = a1.emit("cli-output", CliOutput { stream: "stdout".into(), line });
        }
    });
    let a2 = app.clone();
    let t2 = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = a2.emit("cli-output", CliOutput { stream: "stderr".into(), line });
        }
    });

    // The waiter is what used to run on the main thread and beachball the UI.
    let a3 = app.clone();
    thread::spawn(move || {
        let status = child.wait();
        let _ = t1.join();
        let _ = t2.join();
        let code = status.ok().and_then(|s| s.code());
        let _ = a3.emit("cli-exit", CliExit { code, args });
    });
    Ok(())
}

/// Open a folder in VS Code (so changes are visible in real time).
#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    Command::new("/opt/homebrew/bin/code")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open vscode: {e}"))
}

// ----------------------------------------------------------- search / LSP ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileHit {
    path: String,
    line: u32,
    text: String,
}

const LANG_INCLUDES: &[&str] = &[
    "*.c", "*.cc", "*.cpp", "*.cxx", "*.h", "*.hh", "*.hpp", "*.hxx", "*.ino", "*.s",
    "*.py", "*.json", "*.ini", "*.txt", "*.md", "*.yaml", "*.yml", "*.toml",
];

/// Project-wide literal search (`Cmd+Shift+F`).
///
/// Prefers `rg` (the same engine Zed shells out to); falls back to an
/// in-process walk so the overlay still works on a machine without ripgrep.
#[tauri::command]
fn search_text(root: String, query: String, case_sensitive: bool) -> Result<Vec<FileHit>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    // --- preferred: ripgrep with the source globs from LANG_INCLUDES ---
    for rg in ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "rg"] {
        let mut cmd = Command::new(rg);
        cmd.args(["--json", "--with-filename", "--line-number", "--max-count", "50"]);
        if !case_sensitive {
            cmd.arg("-i");
        }
        for glob in LANG_INCLUDES {
            cmd.arg("-g").arg(glob);
        }
        cmd.arg("--").arg(&query).arg(&root);
        let out = match cmd.output() {
            Ok(o) => o,
            Err(_) => continue,
        };
        if !out.status.success() && out.stdout.is_empty() {
            continue; // rg unavailable / no matches at all
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut hits: Vec<FileHit> = Vec::new();
        for line in text.lines() {
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("type").and_then(|t| t.as_str()) != Some("match") {
                continue;
            }
            let data = &v["data"];
            let path = data["path"]["text"].as_str().unwrap_or("").to_string();
            let line_no = data["line_number"].as_u64().unwrap_or(0) as u32;
            let text = data["lines"]["text"].as_str().unwrap_or("").trim_end().to_string();
            let rel = path.strip_prefix(&root).unwrap_or(&path).trim_start_matches('/').to_string();
            hits.push(FileHit { path: rel, line: line_no, text });
            if hits.len() >= 400 {
                break;
            }
        }
        return Ok(hits);
    }

    // --- fallback: walk and scan in-process ---
    let needle = if case_sensitive { query.clone() } else { query.to_lowercase() };
    let mut hits: Vec<FileHit> = Vec::new();
    let mut stack = vec![PathBuf::from(&root)];
    let mut budget = 5_000usize;
    while let Some(dir) = stack.pop() {
        if budget == 0 || hits.len() >= 400 {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            budget = budget.saturating_sub(1);
            let name = entry.file_name().to_string_lossy().to_string();
            if TREE_IGNORES.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
            if !LANG_INCLUDES.iter().any(|g| g.ends_with(&format!(".{ext}"))) {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let rel = path
                .to_string_lossy()
                .strip_prefix(&root)
                .unwrap_or_default()
                .trim_start_matches('/')
                .to_string();
            for (i, l) in content.lines().enumerate() {
                let hay = if case_sensitive { l.to_string() } else { l.to_lowercase() };
                if hay.contains(&needle) {
                    hits.push(FileHit { path: rel.clone(), line: i as u32 + 1, text: l.trim_end().to_string() });
                    if hits.len() >= 400 {
                        break;
                    }
                }
            }
        }
    }
    Ok(hits)
}


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Symbol {
    name: String,
    kind: String,
    line: u32,
}

/// Outline for the current file — declarations and their kinds (`Cmd+Shift+O`).
///
/// A tree-sitter/clangd outline is not available here: Apple's `clangd` has no
/// symbol dump (`--symbol-info` is gone), and the ESP32 toolchain's own clangd
/// is not shipped with PlatformIO. C/C++ declarations have a small, regular
/// surface, so a declaration scan is both accurate enough for navigation and
/// instant. This mirrors how Zed shows function/type entries in its outline.
#[tauri::command]
fn document_symbols(path: String) -> Result<Vec<Symbol>, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(scan_declarations(&text))
}

/// Regex-free declaration scanner for C/C++/Arduino sources.
fn scan_declarations(text: &str) -> Vec<Symbol> {
    // Return types are all "function" when followed by `name(` and
    // "variable" otherwise; the kind is decided per-line below.
    const KEYWORDS: &[(&str, &str)] = &[
        ("struct", "type"),
        ("class", "type"),
        ("enum", "type"),
        ("union", "type"),
        ("typedef", "type"),
        ("void", "declaration"),
        ("bool", "declaration"),
        ("int", "declaration"),
        ("long", "declaration"),
        ("float", "declaration"),
        ("double", "declaration"),
        ("char", "declaration"),
        ("size_t", "declaration"),
        ("String", "declaration"),
        ("unsigned", "declaration"),
        ("signed", "declaration"),
        ("static", "declaration"),
        ("const", "declaration"),
        ("volatile", "declaration"),
        ("uint8_t", "declaration"),
        ("uint16_t", "declaration"),
        ("uint32_t", "declaration"),
        ("uint64_t", "declaration"),
        ("int8_t", "declaration"),
        ("int16_t", "declaration"),
        ("int32_t", "declaration"),
        ("int64_t", "declaration"),
    ];

    let mut out: Vec<Symbol> = Vec::new();
    let mut in_block_comment = false;

    for (i, raw) in text.lines().enumerate() {
        let mut line = raw;

        // Track /* ... */ so declarations inside comments are skipped.
        if in_block_comment {
            match line.find("*/") {
                Some(idx) => {
                    in_block_comment = false;
                    line = &line[idx + 2..];
                }
                None => continue,
            }
        }
        if let Some(idx) = line.find("/*") {
            if line[idx..].find("*/").is_none() {
                in_block_comment = true;
                line = &line[..idx];
            }
        }
        if let Some(idx) = line.find("//") {
            line = &line[..idx];
        }

        let t = line.trim();
        // Only top-level declarations (column 0), which keeps nested body
        // statements out of the outline.
        let top_level = !raw.is_empty() && !raw.starts_with(char::is_whitespace);
        if !top_level || t.is_empty() || t.starts_with('}') {
            continue;
        }

        // `#define NAME ...` — a very common Arduino idiom worth listing.
        if let Some(rest) = t.strip_prefix("#define ") {
            let name: String = rest
                .trim_start()
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                out.push(Symbol { name, kind: "constant".into(), line: i as u32 + 1 });
            }
            continue;
        }
        if t.starts_with('#') {
            continue;
        }

        for (kw, _kind) in KEYWORDS {
            // The keyword must stand alone (not just be a prefix of a longer
            // identifier) and be separated from the rest by whitespace.
            if !t.starts_with(kw) || t.len() <= kw.len() {
                continue;
            }
            let after = &t[kw.len()..];
            let matches = after.starts_with(' ')
                || after.starts_with('*')
                || after.starts_with('\t');
            if !matches {
                continue;
            }
            let rest = after.trim_start_matches([' ', '\t', '*']).trim_start();

            // Skip over multi-word types and modifiers:
            // `unsigned long previousMillis`, `const uint8_t buf`, `static int x`.
            const TYPE_WORDS: &[&str] = &[
                "unsigned", "signed", "long", "short", "int", "char", "float",
                "double", "const", "volatile", "static", "size_t", "bool",
                "uint8_t", "uint16_t", "uint32_t", "uint64_t",
                "int8_t", "int16_t", "int32_t", "int64_t", "String",
            ];
            let mut rest = rest;
            loop {
                let word: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || *c == '_')
                    .collect();
                if word.is_empty() || !TYPE_WORDS.contains(&word.as_str()) || rest.len() <= word.len() {
                    break;
                }
                rest = rest[word.len()..].trim_start_matches([' ', '\t', '*']).trim_start();
            }

            // A function declaration has `name(` with no initialiser; a
            // variable declaration has `=`, `;` or `[]` after the name.
            let ident: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':')
                .collect();
            let after_ident = rest[ident.len()..].trim_start();
            let name = ident.trim_end_matches(':').to_string();
            if name.is_empty() || &name == kw {
                continue;
            }
            let is_func = after_ident.starts_with('(');

            let is_type_kw = matches!(kw.as_ref(), "struct" | "class" | "enum" | "union");
            out.push(Symbol {
                name: if is_type_kw {
                    format!("{kw} {name}")
                } else {
                    name
                },
                kind: if *kw == "typedef" || is_type_kw {
                    "type".into()
                } else if is_func {
                    "function".into()
                } else {
                    "variable".into()
                },
                line: i as u32 + 1,
            });
            break;
        }
    }
    out
}

// ------------------------------------------------------------ sketch files ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    home: String,
    sketch_dir: String,
    project_dir: Option<String>,
    esptool: Option<String>,
}

#[tauri::command]
fn app_paths() -> AppPaths {
    let home = home();
    let project_dir = format!("{home}/.openplatform-ide/projects/BlinkPIO");
    AppPaths {
        sketch_dir: format!("{home}/.openplatform-ide/Arduino"),
        project_dir: Some(project_dir),
        esptool: esptool_bin(),
        home,
    }
}

/// Write PlatformIO project files (platformio.ini + src/main.cpp)
#[tauri::command]
fn write_pio_project(
    project_dir: String,
    platformio_ini: String,
    src_content: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&project_dir);
    let src_dir = dir.join("src");
    std::fs::create_dir_all(&src_dir).map_err(|e| format!("mkdir: {e}"))?;
    std::fs::write(dir.join("platformio.ini"), platformio_ini).map_err(|e| format!("write ini: {e}"))?;
    std::fs::write(src_dir.join("main.cpp"), src_content).map_err(|e| format!("write src: {e}"))?;
    let _ = add_recent(project_dir.clone());
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn list_recent() -> Vec<String> {
    load_recent()
}

// -------------------------------------------------------------- file tree ---

/// One node of a workspace file tree (Zed's `project_panel` equivalent).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    /// Extension-only kind; the UI picks the language from this.
    ext: String,
}

/// Directories never worth walking for a PlatformIO/Arduino project.
const TREE_IGNORES: &[&str] = &[
    ".git", ".pio", ".vscode", ".idea", "node_modules", "target", ".DS_Store",
    "managed_components", "build",
];

/// List one directory level. The panel is virtualized and loads per-directory,
/// so huge projects (`.pio`, `node_modules`) never block the UI thread.
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileNode>, String> {
    let mut out: Vec<FileNode> = Vec::new();
    let entries = std::fs::read_dir(&path).map_err(|e| format!("read dir: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if TREE_IGNORES.contains(&name.as_str()) {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            PathBuf::from(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        out.push(FileNode { name, path: entry.path().to_string_lossy().to_string(), is_dir, ext });
    }
    // Directories first, then files; each group alphabetical (Zed's tree order).
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Read any text file in the workspace (the tab `Item`).
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Write any text file in the workspace.
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}

/// Walk a project once and return every file, for the fuzzy file finder
/// (`Cmd+P`). Skips heavy/ignored directories and stops at a bounded count.
#[tauri::command]
fn search_files(root: String, query: String) -> Result<Vec<String>, String> {
    let q = query.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    let mut stack = vec![PathBuf::from(&root)];
    let mut budget = 20_000usize;
    while let Some(dir) = stack.pop() {
        if budget == 0 {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            budget = budget.saturating_sub(1);
            let name = entry.file_name().to_string_lossy().to_string();
            if TREE_IGNORES.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let full = path.to_string_lossy().to_string();
                let rel = full.strip_prefix(&root).unwrap_or(&full).trim_start_matches('/').to_string();
                let hay = rel.to_lowercase();
                if q.is_empty() || hay.contains(&q) {
                    hits.push(rel);
                    if hits.len() >= 500 {
                        return Ok(hits);
                    }
                }
            }
        }
    }
    // Shallow paths first — the thing you want is usually near the root.
    hits.sort_by_key(|h| (h.matches('/').count(), h.clone()));
    Ok(hits)
}
#[tauri::command]
fn add_recent(project_dir: String) -> Result<(), String> {
    let mut list = load_recent();
    list.retain(|x| x != &project_dir);
    list.insert(0, project_dir);
    if list.len() > 10 { list.truncate(10); }
    save_recent(list)
}
#[tauri::command]
fn create_new_project(project_dir: String, platformio_ini: String, src_content: String) -> Result<String, String> {
    let dir = PathBuf::from(&project_dir);
    let src_dir = dir.join("src");
    std::fs::create_dir_all(&src_dir).map_err(|e| format!("mkdir: {e}"))?;
    std::fs::write(dir.join("platformio.ini"), platformio_ini).map_err(|e| format!("write ini: {e}"))?;
    std::fs::write(src_dir.join("main.cpp"), src_content).map_err(|e| format!("write src: {e}"))?;
    let _ = add_recent(project_dir.clone());
    Ok(dir.to_string_lossy().to_string())
}

// -------------------------------------------------------- serial monitor ---

#[derive(Default)]
struct SerialState {
    stop: Mutex<Option<Arc<AtomicBool>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialData {
    data: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SerialStatus {
    open: bool,
    port: String,
    message: String,
}

/// Stream a serial port to the webview as `serial-data` text chunks.
///
/// DTR/RTS are de-asserted right after opening — this is essential on ESP32
/// boards where the auto-reset circuit wires them to EN/GPIO0; asserting them
/// would hold (or repeatedly reset) the chip.
#[tauri::command]
fn serial_start(
    app: tauri::AppHandle,
    state: tauri::State<SerialState>,
    port: String,
    baud: u32,
) -> Result<(), String> {
    // Stop any previous monitor first.
    if let Some(prev) = state.stop.lock().unwrap().take() {
        prev.store(true, Ordering::SeqCst);
    }
    let stop = Arc::new(AtomicBool::new(false));
    *state.stop.lock().unwrap() = Some(stop.clone());

    let mut p = serialport::new(&port, baud)
        .timeout(Duration::from_millis(120))
        .open()
        .map_err(|e| format!("open {port}: {e}"))?;
    let _ = p.write_data_terminal_ready(false);
    let _ = p.write_request_to_send(false);

    let a = app.clone();
    let opened_port = port.clone();
    thread::spawn(move || {
        let _ = a.emit(
            "serial-status",
            SerialStatus {
                open: true,
                port: opened_port.clone(),
                message: format!("monitoring {opened_port} @ {baud}"),
            },
        );
        let mut buf = [0u8; 4096];
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match p.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = a.emit("serial-data", SerialData { data });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
        }
        let _ = a.emit(
            "serial-status",
            SerialStatus {
                open: false,
                port: opened_port,
                message: "monitor stopped".into(),
            },
        );
    });
    Ok(())
}


#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PioProject {
    ini: String,
    src: String,
}

#[tauri::command]
fn load_pio_project(project_dir: String) -> Result<PioProject, String> {
    let dir = PathBuf::from(&project_dir);
    let ini_path = dir.join("platformio.ini");
    let src_path = dir.join("src").join("main.cpp");
    let ini = std::fs::read_to_string(&ini_path).map_err(|e| format!("read ini: {e}"))?;
    let src = std::fs::read_to_string(&src_path).map_err(|e| format!("read src: {e}"))?;
    Ok(PioProject { ini, src })
}
#[tauri::command]
fn serial_stop(state: tauri::State<SerialState>) {
    if let Some(s) = state.stop.lock().unwrap().take() {
        s.store(true, Ordering::SeqCst);
    }
}

// ------------------------------------------------------------------ setup ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            identify_chip,
            cli_start,
            open_in_vscode,
            app_paths,
            write_pio_project,
            load_pio_project,
            list_recent,
            add_recent,
            create_new_project,
            list_dir,
            read_file,
            write_file,
            search_files,
            search_text,
            document_symbols,
            serial_start,
            serial_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outline_picks_functions_constants_and_types() {
        let src = r#"#include <Arduino.h>

#define LED_PIN 23

unsigned long previousMillis = 0;
const unsigned long interval = 1000; // 1 second
bool ledState = false;

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  // not a top-level declaration
  int local = 1;
}

struct Point {
  int x;
};

// void commentedOut() {}
"#;
        let syms = scan_declarations(src);
        let names: Vec<&str> = syms.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"setup"), "got {names:?}");
        assert!(names.contains(&"loop"), "got {names:?}");
        assert!(names.contains(&"LED_PIN"), "got {names:?}");
        assert!(names.contains(&"struct Point"), "got {names:?}");
        assert!(names.contains(&"ledState"), "got {names:?}");

        // Nested locals and commented-out declarations must not appear.
        assert!(!names.contains(&"local"));
        assert!(!names.contains(&"commentedOut"));

        // Kinds are classified, not guessed.
        let kind = |n: &str| syms.iter().find(|s| s.name == n).map(|s| s.kind.clone());
        assert_eq!(kind("setup").as_deref(), Some("function"));
        assert_eq!(kind("loop").as_deref(), Some("function"));
        assert_eq!(kind("LED_PIN").as_deref(), Some("constant"));
        assert_eq!(kind("struct Point").as_deref(), Some("type"));
        assert_eq!(kind("ledState").as_deref(), Some("variable"));
        assert_eq!(kind("previousMillis").as_deref(), Some("variable"));
    }

    #[test]
    fn outline_reports_real_line_numbers() {
        let syms = scan_declarations("int a;\n\nvoid f() {\n}\n");
        let f = syms.iter().find(|s| s.name == "f").expect("f");
        assert_eq!(f.line, 3);
    }

    #[test]
    fn tree_ignores_cover_build_artifacts() {
        for d in [".pio", "node_modules", ".git"] {
            assert!(TREE_IGNORES.contains(&d));
        }
    }
}
