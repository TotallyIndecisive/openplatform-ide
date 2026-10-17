use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

/// The bundled `arduino-cli` that ships with Arduino IDE 2.3.10.
const CLI: &str =
    "/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli";
/// Our dedicated CLI config/data dir. Keeps the user's `~/Library/Arduino15` untouched.
const CFG: &str = "/Users/smckenzie/.esp32-ide/arduino-cli.yaml";

// ---------------------------------------------------------------- helpers ---

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/Users/smckenzie".into())
}

static ESPTOOL_BIN_CACHE: OnceLock<Option<String>> = OnceLock::new();

fn esptool_bin() -> Option<String> {
    ESPTOOL_BIN_CACHE
        .get_or_init(|| {
            let base = PathBuf::from(home())
                .join(".esp32-ide/Arduino15/packages/esp32/tools/esptool_py");
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
fn cli_start(app: tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    let mut cmd = Command::new(CLI);
    cmd.arg("--config-file")
        .arg(CFG)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn arduino-cli: {e}"))?;
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

// ------------------------------------------------------------ sketch files ---

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPaths {
    home: String,
    sketch_dir: String,
    esptool: Option<String>,
}

#[tauri::command]
fn app_paths() -> AppPaths {
    let home = home();
    AppPaths {
        sketch_dir: format!("{home}/.esp32-ide/Arduino"),
        esptool: esptool_bin(),
        home,
    }
}

/// Persist the editor buffer as a real Arduino sketch folder
/// (`<sketch_dir>/<main_name>.ino`) so `arduino-cli` can compile it.
#[tauri::command]
fn write_sketch(sketch_dir: String, main_name: String, content: String) -> Result<String, String> {
    let dir = PathBuf::from(&sketch_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    let base = main_name.trim_end_matches(".ino");
    let file = dir.join(format!("{base}.ino"));
    std::fs::write(&file, content).map_err(|e| format!("write: {e}"))?;
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
        .manage(SerialState::default())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            identify_chip,
            cli_start,
            open_in_vscode,
            app_paths,
            write_sketch,
            serial_start,
            serial_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
