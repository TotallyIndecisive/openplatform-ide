use std::{path::PathBuf, process::Command};
use serde_json::{json, Value};

pub fn resolve(name: &str, override_var: &str, extras: &[PathBuf]) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(override_var) {
        let path = PathBuf::from(value);
        return path.is_file().then_some(path).ok_or_else(|| format!("{override_var} does not point to a file"));
    }
    let mut candidates: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|dir| dir.join(name)).collect();
    candidates.extend_from_slice(extras);
    candidates.into_iter().find(|p| p.is_file()).ok_or_else(|| format!("{name} not found. Install it or set {override_var} to its executable path, then restart the IDE."))
}

pub fn pio() -> Result<PathBuf, String> {
    let home = PathBuf::from(crate::home());
    resolve(if cfg!(windows) { "pio.exe" } else { "pio" }, "OPENPLATFORM_PIO", &[
        home.join(".platformio/penv/bin/pio"), home.join(".platformio/penv/Scripts/pio.exe"),
        home.join(".local/bin/pio"), PathBuf::from("/opt/homebrew/bin/pio"),
    ])
}

pub fn clangd() -> Result<PathBuf, String> {
    resolve(if cfg!(windows) { "clangd.exe" } else { "clangd" }, "OPENPLATFORM_CLANGD", &[
        "/opt/homebrew/opt/llvm/bin/clangd".into(), "/usr/local/opt/llvm/bin/clangd".into(), "/usr/bin/clangd".into(),
    ])
}

#[tauri::command]
pub async fn toolchain_status() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let inspect = |path: Result<PathBuf, String>| match path {
            Ok(path) => match Command::new(&path).arg("--version").output() {
                Ok(out) if out.status.success() => json!({"path":path,"version":String::from_utf8_lossy(&out.stdout).trim()}),
                Ok(out) => json!({"error":String::from_utf8_lossy(&out.stderr)}),
                Err(e) => json!({"error":e.to_string()}),
            },
            Err(e) => json!({"error":e}),
        };
        json!({"platformio":inspect(pio()),"clangd":inspect(clangd())})
    }).await.unwrap_or_else(|e| json!({"error":e.to_string()}))
}

#[tauri::command]
pub async fn project_environments(project_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new(pio()?).current_dir(project_dir)
            .args(["project", "config", "--json-output"]).output().map_err(|e| e.to_string())?;
        if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).into()); }
        let config: Vec<(String, Value)> = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        Ok(config.into_iter().filter_map(|(name, _)| name.strip_prefix("env:").map(str::to_owned)).collect())
    }).await.map_err(|e| e.to_string())?
}

/// Never replace a user's language configuration. Strip GCC-only flags from
/// clangd parsing; the actual PlatformIO build command remains untouched.
#[tauri::command]
pub fn configure_language(project_dir: String) -> Result<(), String> {
    use std::io::Write;
    let path = PathBuf::from(project_dir).join(".clangd");
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(b"CompileFlags:\n  Remove: [-mlongcalls, -mdisable-hardware-atomics, -fstrict-volatile-bitfields, -fno-tree-switch-conversion]\n").map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
