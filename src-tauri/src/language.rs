use std::{io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::Mutex, thread};
use serde_json::{json, Value};
use tauri::Emitter;

struct Session { child: Child, input: ChildStdin, id: String }
#[derive(Default)]
pub struct LanguageState(Mutex<Option<Session>>);

pub fn stop(state: &LanguageState) {
    if let Some(mut session) = state.0.lock().unwrap().take() {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
}

fn read_message(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut size = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 { return Err("Language server closed".into()); }
        if line.trim().is_empty() { break; }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("Content-Length") { size = value.trim().parse::<usize>().ok(); }
        }
    }
    let size = size.filter(|n| *n <= 16 * 1024 * 1024).ok_or("Invalid LSP Content-Length")?;
    let mut body = vec![0; size];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn language_start(app: tauri::AppHandle, state: tauri::State<LanguageState>, cwd: String, session_id: String) -> Result<bool, String> {
    stop(&state);
    let has_database = std::path::Path::new(&cwd).join("compile_commands.json").is_file();
    let mut child = Command::new(crate::tooling::clangd()?).current_dir(&cwd)
        .args(["--background-index", "--header-insertion=never", "--log=error"])
        .arg(format!("--compile-commands-dir={cwd}"))
        // Permit only installed PlatformIO toolchain drivers, never arbitrary project executables.
        .arg(format!("--query-driver={}/.platformio/packages/toolchain-*/bin/*", crate::home()))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|e| format!("clangd: {e}"))?;
    let input = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    *state.0.lock().unwrap() = Some(Session {child, input, id:session_id.clone()});
    let a = app.clone(); let id = session_id.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(message) = read_message(&mut reader) {
            let _ = a.emit("language-message", json!({"sessionId":id,"message":message}));
        }
        let _ = a.emit("language-status", json!({"sessionId":id,"message":"C++ language server stopped"}));
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = app.emit("language-log", json!({"sessionId":session_id,"message":line}));
        }
    });
    Ok(has_database)
}

#[tauri::command]
pub fn language_send(state: tauri::State<LanguageState>, session_id: String, message: Value) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    let session = slot.as_mut().filter(|s| s.id == session_id).ok_or("Language server session has ended")?;
    let body = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
    write!(session.input, "Content-Length: {}\r\n\r\n", body.len()).map_err(|e| e.to_string())?;
    session.input.write_all(&body).map_err(|e| e.to_string())?;
    session.input.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn language_stop(state: tauri::State<LanguageState>, session_id: Option<String>) {
    let mut slot = state.0.lock().unwrap();
    if slot.as_ref().is_some_and(|s| session_id.as_ref().is_none_or(|id| id == &s.id)) {
        if let Some(mut session) = slot.take() { let _ = session.child.kill(); let _ = session.child.wait(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framed_messages_preserve_utf8_and_consecutive_responses() {
        let body = r#"{"text":"µ LED"}"#;
        let wire = format!("Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}Content-Length: 2\r\n\r\n{{}}", body.len(), body);
        let mut reader = BufReader::new(wire.as_bytes());
        assert_eq!(read_message(&mut reader).unwrap()["text"], "µ LED");
        assert_eq!(read_message(&mut reader).unwrap(), json!({}));
        assert!(read_message(&mut reader).is_err());
    }
    #[test]
    fn rejects_unbounded_frames() {
        assert!(read_message(&mut BufReader::new(&b"Content-Length: 999999999\r\n\r\n"[..])).is_err());
    }
}
