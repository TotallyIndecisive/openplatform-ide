use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager};
mod tooling;
mod tasks;
mod language;




// ---------------------------------------------------------------- helpers ---

fn home() -> String {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| ".".into())
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
            let pio_tool = PathBuf::from(home()).join(".platformio/packages/tool-esptoolpy/esptool.py");
            if pio_tool.is_file() { return Some(pio_tool.to_string_lossy().into()); }
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
    let mut cmd = if esptool.ends_with(".py") {
        let mut c = Command::new(PathBuf::from(home()).join(if cfg!(windows) {".platformio/penv/Scripts/python.exe"} else {".platformio/penv/bin/python"}));
        c.arg(esptool); c
    } else { Command::new(esptool) };
    let o = cmd.args(["--port", port, sub])
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

/// Open a folder in VS Code (so changes are visible in real time).
#[tauri::command]
fn open_in_vscode(path: String) -> Result<(), String> {
    Command::new(tooling::resolve("code", "OPENPLATFORM_CODE", &["/opt/homebrew/bin/code".into(), "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code".into()])?)
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
async fn search_text(root: String, query: String, case_sensitive: bool) -> Result<Vec<FileHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_text_blocking(root, query, case_sensitive)).await.map_err(|e| e.to_string())?
}

fn search_text_blocking(root: String, query: String, case_sensitive: bool) -> Result<Vec<FileHit>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    // --- preferred: ripgrep with the source globs from LANG_INCLUDES ---
    for rg in ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "rg"] {
        let mut cmd = Command::new(rg);
        cmd.args(["--fixed-strings", "--json", "--with-filename", "--line-number", "--max-count", "50"]);
        if !case_sensitive {
            cmd.arg("-i");
        }
        for ignored in TREE_IGNORES { cmd.arg("-g").arg(format!("!**/{ignored}/**")); }
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
            if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) { continue; }
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

/// Lightweight outline for the current in-memory file, also available without
/// clangd. This declaration scanner is approximate for macros and templates.
#[tauri::command]
fn document_symbols(path: String, content: Option<String>) -> Result<Vec<Symbol>, String> {
    if let Some(text) = content { return Ok(scan_declarations(&text)); }
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
    let project_dir = std::env::var("OPENPLATFORM_PROJECT").ok().or_else(|| load_recent().into_iter().find(|p| PathBuf::from(p).join("platformio.ini").is_file()));
    AppPaths {
        sketch_dir: format!("{home}/.openplatform-ide/Arduino"),
        project_dir,
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
    if dir.exists() && std::fs::read_dir(&dir).map_err(|e| e.to_string())?.next().is_some() { return Err("Choose an empty folder; existing project files will not be overwritten".into()); }
    let src_dir = dir.join("src");
    std::fs::create_dir_all(&src_dir).map_err(|e| format!("mkdir: {e}"))?;
    std::fs::write(dir.join("platformio.ini"), platformio_ini).map_err(|e| format!("write ini: {e}"))?;
    std::fs::write(src_dir.join("main.cpp"), src_content).map_err(|e| format!("write src: {e}"))?;
    for child in ["include", "lib", "test"] { std::fs::create_dir_all(dir.join(child)).map_err(|e| e.to_string())?; }
    tooling::configure_language(project_dir.clone())?;
    std::fs::write(dir.join(".gitignore"), ".pio/\ncompile_commands.json\n.cache/\n").map_err(|e| e.to_string())?;
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
    "managed_components", "build", ".cache", "compile_commands.json",
];

/// List one directory level. The panel is virtualized and loads per-directory,
/// so huge projects (`.pio`, `node_modules`) never block the UI thread.
#[tauri::command]
fn git_status(project_dir: String) -> Result<serde_json::Value, String> {
    let out = Command::new("git").args(["-C", &project_dir, "status", "--porcelain=v1", "-b"]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn git_diff(project_dir: String, path: Option<String>) -> Result<serde_json::Value, String> {
    let mut args = vec!["-C".to_string(), project_dir.clone(), "diff".to_string()];
    if let Some(ref p) = path { args.push("--".to_string()); args.push(p.clone()); }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = Command::new("git").args(args_ref).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn git_add(project_dir: String, paths: Vec<String>) -> Result<serde_json::Value, String> {
    let mut args = vec!["-C".to_string(), project_dir.clone(), "add".to_string()];
    for p in paths { args.push(p); }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = Command::new("git").args(args_ref).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn git_reset(project_dir: String, paths: Vec<String>) -> Result<serde_json::Value, String> {
    let mut args = vec!["-C".to_string(), project_dir.clone(), "reset".to_string()];
    for p in paths { args.push(p); }
    let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = Command::new("git").args(args_ref).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn git_commit(project_dir: String, message: String) -> Result<serde_json::Value, String> {
    let out = Command::new("git").args(["-C", &project_dir, "commit", "-m", &message]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn git_log(project_dir: String, limit: Option<u32>) -> Result<serde_json::Value, String> {
    let n = limit.unwrap_or(50).to_string();
    let out = Command::new("git").args(["-C", &project_dir, "log", "--oneline", "-n", &n]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn git_branches(project_dir: String) -> Result<serde_json::Value, String> {
    let out = Command::new("git").args(["-C", &project_dir, "branch", "-a"]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn git_init(project_dir: String) -> Result<serde_json::Value, String> {
    let out = Command::new("git").args(["-C", &project_dir, "init"]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn debug_start(project_dir: String) -> Result<serde_json::Value, String> {
    let mut cmd = Command::new("openocd");
    cmd.current_dir(&project_dir);
    cmd.args(["-f", "interface/ftdi/esp32_devkitj_v1.cfg", "-f", "target/esp32.cfg"]);
    let child = cmd.spawn();
    match child {
        Ok(_) => Ok(serde_json::json!({"success": true, "message": "OpenOCD started (basic config)"})),
        Err(e) => Ok(serde_json::json!({"success": false, "error": format!("Failed to start openocd: {}", e)}))
    }
}

#[tauri::command]
fn debug_stop() -> Result<serde_json::Value, String> {
    let _ = Command::new("pkill").args(["-f", "openocd"]).output();
    let _ = Command::new("pkill").args(["-f", "gdb"]).output();
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
fn pio_library_search(query: String) -> Result<serde_json::Value, String> {
    let out = Command::new("pio").args(["lib", "search", &query, "--json-output"]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn pio_library_install(project_dir: String, lib: String) -> Result<serde_json::Value, String> {
    let out = Command::new("pio").args(["lib", "-d", &project_dir, "install", &lib]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

#[tauri::command]
fn pio_boards_list() -> Result<serde_json::Value, String> {
    let out = Command::new("pio").args(["boards", "--json-output"]).output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(serde_json::json!({"success": out.status.success(), "output": text, "error": err}))
}

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
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 8 * 1024 * 1024 { return Err("This file exceeds the 8 MiB text editor limit".into()); }
    std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Write any text file in the workspace.
#[tauri::command]
fn write_file(path: String, content: String, expected: Option<String>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let target = if target.exists() { target.canonicalize().map_err(|e| e.to_string())? } else { target };
    if let Some(expected) = expected {
        let disk = std::fs::read_to_string(&target).map_err(|e| format!("Cannot verify {path}: {e}"))?;
        if disk != expected { return Err(format!("{path} changed on disk. Reload it before saving; your edits are still in the tab.")); }
    }
    let parent = target.parent().ok_or("Missing parent directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    if let Ok(meta) = std::fs::metadata(&target) { temp.as_file().set_permissions(meta.permissions()).map_err(|e| e.to_string())?; }
    temp.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(&target).map_err(|e| format!("save {path}: {e}"))?;
    Ok(())
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map(|_| ()).map_err(|e| format!("Create file: {e}"))
}

/// Walk a project once and return every file, for the fuzzy file finder
/// (`Cmd+P`). Skips heavy/ignored directories and stops at a bounded count.
#[tauri::command]
async fn search_files(root: String, query: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || search_files_blocking(root, query)).await.map_err(|e| e.to_string())?
}

fn search_files_blocking(root: String, query: String) -> Result<Vec<String>, String> {
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
            if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) { continue; }
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
    if dir.exists() && std::fs::read_dir(&dir).map_err(|e| e.to_string())?.next().is_some() { return Err("Choose an empty folder; existing project files will not be overwritten".into()); }
    let src_dir = dir.join("src");
    std::fs::create_dir_all(&src_dir).map_err(|e| format!("mkdir: {e}"))?;
    std::fs::write(dir.join("platformio.ini"), platformio_ini).map_err(|e| format!("write ini: {e}"))?;
    std::fs::write(src_dir.join("main.cpp"), src_content).map_err(|e| format!("write src: {e}"))?;
    for child in ["include", "lib", "test"] { std::fs::create_dir_all(dir.join(child)).map_err(|e| e.to_string())?; }
    tooling::configure_language(project_dir.clone())?;
    std::fs::write(dir.join(".gitignore"), ".pio/\ncompile_commands.json\n.cache/\n").map_err(|e| e.to_string())?;
    let _ = add_recent(project_dir.clone());
    Ok(dir.to_string_lossy().to_string())
}

// -------------------------------------------------------- serial monitor ---

struct SerialSession {
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
    writer: Box<dyn serialport::SerialPort>,
}
#[derive(Default)]
struct SerialState {
    session: Mutex<Option<SerialSession>>,
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
    serial_stop_inner(&state);
    let mut slot = state.session.lock().map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let mut p = serialport::new(&port, baud)
        .timeout(Duration::from_millis(120))
        .open()
        .map_err(|e| format!("open {port}: {e}"))?;
    let _ = p.write_data_terminal_ready(false);
    let _ = p.write_request_to_send(false);

    let a = app.clone();
    let opened_port = port.clone();
    let writer = p.try_clone().map_err(|e| e.to_string())?;
    let signal = stop.clone();
    let handle = thread::spawn(move || {
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
            if signal.load(Ordering::SeqCst) {
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
    *slot = Some(SerialSession { stop, thread: handle, writer });
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
fn serial_stop_inner(state: &SerialState) {
    let mut slot = state.session.lock().unwrap();
    if let Some(s) = slot.take() {
        s.stop.store(true, Ordering::SeqCst);
        drop(s.writer);
        // The reader has a 120ms timeout. Join guarantees that both handles
        // are closed before esptool/avrdude attempts to claim the port.
        let _ = s.thread.join();
    }
}
#[tauri::command]
fn serial_stop(state: tauri::State<SerialState>) { serial_stop_inner(&state); }

#[tauri::command]
fn serial_write(state: tauri::State<SerialState>, data: String) -> Result<(), String> {
    let mut slot = state.session.lock().map_err(|e| e.to_string())?;
    let session = slot.as_mut().ok_or("Serial monitor is not open")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

// ----------------------------------------------------------------- terminal ---
//
// Modelled on Zed's `terminal` crate (`PtyProcessInfo` + alacritty-backed grid):
// a real PTY is spawned, the child's bytes are streamed to the webview, and
// keystrokes are written back. Output is rendered by xterm.js in the front end
// (the same division of labour as Zed's `terminal_view::terminal_element`,
// where the emulator owns the grid and the view only paints it).

struct TerminalSession {
    writer: Box<dyn std::io::Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct TerminalState {
    session: Mutex<Option<TerminalSession>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalData {
    data: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalStatus {
    open: bool,
    cwd: String,
    shell: String,
    message: String,
}

/// The shell Zed picks: `$SHELL`, falling back to the platform default.
fn default_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
        } else {
            "/bin/zsh".into()
        }
    })
}

/// Zed exports a small identity env to every terminal it spawns; we do the same
/// so tools that branch on being "in an IDE terminal" behave normally.
fn terminal_env() -> Vec<(String, String)> {
    vec![
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("TERM_PROGRAM".into(), "openplatform-ide".into()),
        ("TERM_PROGRAM_VERSION".into(), env!("CARGO_PKG_VERSION").into()),
    ]
}

/// Resolve the directory a terminal should start in.
///
/// Mirrors Zed's `default_working_directory`: the caller passes the open project
/// directory, and we fall back to `$HOME` when there is none — or when the path
/// no longer exists (e.g. a deleted project), so the shell always opens.
fn resolve_terminal_dir(cwd: &str) -> PathBuf {
    let p = PathBuf::from(cwd);
    if cwd.is_empty() || !p.is_dir() {
        PathBuf::from(home())
    } else {
        p
    }
}

/// Spawn a login-ish interactive shell in `cwd`.
///
/// `cwd` is resolved by the front end with Zed's precedence: the open project
/// directory when there is one, otherwise the user's home directory. An empty
/// or non-existent `cwd` falls back to home so the terminal always opens.
#[tauri::command]
fn terminal_start(
    app: tauri::AppHandle,
    state: tauri::State<TerminalState>,
    cwd: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    // Replace any previous session.
    terminal_stop_inner(&state);

    let dir = resolve_terminal_dir(&cwd);
    let shell = shell
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_shell);

    let pty = portable_pty::native_pty_system();
    let pair = pty
        .openpty(portable_pty::PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = portable_pty::CommandBuilder::new(&shell);
    // `-l` gives a login shell, matching what Zed presents on macOS.
    if !cfg!(target_os = "windows") {
        cmd.arg("-l");
    }
    cmd.cwd(&dir);
    for (k, v) in terminal_env() {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {shell}: {e}"))?;
    // The slave fd is not needed in the parent once the child owns it.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let stop = Arc::new(AtomicBool::new(false));
    let cwd_s = dir.to_string_lossy().to_string();

    let a = app.clone();
    let s = stop.clone();
    let cwd_out = cwd_s.clone();
    let shell_out = shell.clone();
    thread::spawn(move || {
        let _ = a.emit(
            "terminal-status",
            TerminalStatus {
                open: true,
                cwd: cwd_out,
                shell: shell_out,
                message: "terminal started".into(),
            },
        );
        let mut buf = [0u8; 8192];
        loop {
            if s.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = a.emit("terminal-data", TerminalData { data });
                }
                Err(_) => break,
            }
        }
        let _ = a.emit(
            "terminal-status",
            TerminalStatus {
                open: false,
                cwd: String::new(),
                shell: String::new(),
                message: "terminal exited".into(),
            },
        );
    });

    *state.session.lock().unwrap() = Some(TerminalSession { writer, master: pair.master, child, stop });
    Ok(cwd_s)
}

/// Write a keystroke / paste from the front end into the child's stdin.
#[tauri::command]
fn terminal_write(state: tauri::State<TerminalState>, data: String) -> Result<(), String> {
    let mut guard = state.session.lock().unwrap();
    let s = guard.as_mut().ok_or("no terminal session")?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    s.writer.flush().map_err(|e| format!("flush: {e}"))
}

/// Tell the PTY the viewport changed so full-screen programs reflow correctly.
#[tauri::command]
fn terminal_resize(
    state: tauri::State<TerminalState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.session.lock().unwrap();
    let s = guard.as_ref().ok_or("no terminal session")?;
    s.master
        .resize(portable_pty::PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

fn terminal_stop_inner(state: &TerminalState) {
    if let Some(mut s) = state.session.lock().unwrap().take() {
        s.stop.store(true, Ordering::SeqCst);
        let _ = s.child.kill();
    }
}

#[tauri::command]
fn terminal_stop(state: tauri::State<TerminalState>) {
    terminal_stop_inner(&state);
}

// ------------------------------------------------------------------ setup ---

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SerialState::default())
        .manage(TerminalState::default())
        .manage(tasks::TaskState::default())
        .manage(language::LanguageState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                tasks::cli_cancel(window.state::<tasks::TaskState>());
                serial_stop_inner(&window.state::<SerialState>());
                terminal_stop_inner(&window.state::<TerminalState>());
                language::stop(&window.state::<language::LanguageState>());
            }
        })
        .invoke_handler(tauri::generate_handler![
            git_status, git_diff, git_add, git_reset, git_commit, git_log, git_branches, git_init,
            debug_start, debug_stop,
            pio_library_search, pio_library_install, pio_boards_list,
            list_serial_ports,
            identify_chip,
            tasks::cli_start,
            tasks::cli_cancel,
            tooling::toolchain_status,
            tooling::project_environments,
            tooling::configure_language,
            language::language_start,
            language::language_send,
            language::language_stop,
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
            create_file,
            search_files,
            search_text,
            document_symbols,
            serial_start,
            serial_stop,
            serial_write,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. }
                    if app.get_webview_window("main").is_some() => {
                    // Route native Cmd+Q through the same unsaved-buffer guard
                    // as the window close button.
                    api.prevent_exit();
                    let _ = app.emit("app-exit-requested", ());
                }
                tauri::RunEvent::Exit => {
                    tasks::cli_cancel(app.state::<tasks::TaskState>());
                    serial_stop_inner(&app.state::<SerialState>());
                    terminal_stop_inner(&app.state::<TerminalState>());
                    language::stop(&app.state::<language::LanguageState>());
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_refuses_external_changes_and_preserves_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("main.cpp").to_string_lossy().to_string();
        std::fs::write(&path, "external edit").unwrap();
        assert!(write_file(path.clone(), "my edit".into(), Some("old".into())).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external edit");
        write_file(path.clone(), "my edit".into(), Some("external edit".into())).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "my edit");
    }

    #[test]
    fn creating_file_or_project_never_overwrites_existing_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("main.cpp").to_string_lossy().to_string();
        std::fs::write(&path, "keep me").unwrap();
        assert!(create_file(path.clone()).is_err());
        assert!(create_new_project(dir.path().to_string_lossy().into(), "ini".into(), "code".into()).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me");
    }

    #[test]
    fn outline_uses_unsaved_buffer_content() {
        let symbols = document_symbols("/not/on/disk.cpp".into(), Some("void unsaved() {}".into())).unwrap();
        assert!(symbols.iter().any(|s| s.name == "unsaved"));
    }

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
    fn outline_handles_a_real_arduino_sketch() {
        // The exact shape of the shipped blink example.
        let src = "#include <Arduino.h>\n\n#define LED_PIN 23\n\nunsigned long previousMillis = 0;\nconst unsigned long interval = 5000; // 5 seconds\nbool ledState = false;\n\nvoid setup() {\n  pinMode(LED_PIN, OUTPUT);\n}\n\nvoid loop() {\n  unsigned long now = millis();\n}\n";
        let syms = scan_declarations(src);
        let kind = |n: &str| syms.iter().find(|s| s.name == n).map(|s| s.kind.clone());

        // Multi-word declarations resolve to the variable, not the type word.
        assert_eq!(kind("previousMillis").as_deref(), Some("variable"));
        assert_eq!(kind("interval").as_deref(), Some("variable"));
        assert_eq!(kind("ledState").as_deref(), Some("variable"));
        assert_eq!(kind("setup").as_deref(), Some("function"));
        assert_eq!(kind("loop").as_deref(), Some("function"));
        assert_eq!(kind("LED_PIN").as_deref(), Some("constant"));

        // A nested local must not appear.
        assert!(kind("now").is_none(), "nested local leaked into outline");
    }

    #[test]
    fn tree_ignores_cover_build_artifacts() {
        for d in [".pio", "node_modules", ".git"] {
            assert!(TREE_IGNORES.contains(&d));
        }
    }

    #[test]
    fn terminal_shell_falls_back_to_a_real_binary() {
        // $SHELL wins; otherwise we must still name an executable shell.
        let shell = default_shell();
        assert!(!shell.trim().is_empty());
        if !cfg!(target_os = "windows") {
            assert!(
                PathBuf::from(&shell).is_file(),
                "shell {shell} is not a file"
            );
        }
    }

    #[test]
    fn terminal_env_marks_the_program_like_zed_does() {
        let env = terminal_env();
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("TERM"), Some("xterm-256color"));
        assert_eq!(get("TERM_PROGRAM"), Some("openplatform-ide"));
        assert!(get("COLORTERM").is_some());
    }

    /// Zed's `default_working_directory`: the project directory when one is
    /// open, otherwise home. The backend only needs to honour what it is given.
    #[test]
    fn terminal_cwd_prefers_the_project_then_home() {
        let tmp = std::env::temp_dir();
        let dir = tmp.to_string_lossy().to_string();

        // An existing directory is used verbatim.
        assert_eq!(resolve_terminal_dir(&dir), tmp);

        // Empty or bogus paths fall back to the home directory.
        let h = PathBuf::from(home());
        assert_eq!(resolve_terminal_dir(""), h);
        assert_eq!(resolve_terminal_dir("/definitely/not/here/xyzzy"), h);
    }

    /// Spawn a real PTY, run a command in it, and read the bytes back — this is
    /// the exact path `terminal_start` uses on the user's machine.
    #[test]
    fn a_pty_runs_a_command_and_streams_output() {
        let pty = portable_pty::native_pty_system();
        let pair = pty
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("printf pio-pty-roundtrip");
        cmd.cwd(std::env::temp_dir());

        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");

        let mut got = String::new();
        let mut buf = [0u8; 1024];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            got.push_str(&String::from_utf8_lossy(&buf[..n]));
            if got.contains("pio-pty-roundtrip") {
                break;
            }
        }
        let _ = child.kill();
        assert!(
            got.contains("pio-pty-roundtrip"),
            "pty produced {got:?}"
        );
    }
}
