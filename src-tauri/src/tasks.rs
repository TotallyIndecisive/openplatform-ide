use std::{io::{BufReader, Read}, process::{Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct TaskState(Mutex<Option<TaskHandle>>);
struct TaskHandle { cancel: Arc<AtomicBool>, pid: u32 }

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Output { job_id: String, stream: String, line: String }
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit { job_id: String, code: Option<i32>, args: Vec<String>, cancelled: bool, elapsed_ms: u128 }

// Split CR progress updates as well as LF lines and bound individual messages.
fn stream(reader: impl Read, mut emit: impl FnMut(String)) {
    let mut line = Vec::new();
    for byte in BufReader::new(reader).bytes() {
        let Ok(byte) = byte else { break };
        if byte == b'\n' || byte == b'\r' {
            if !line.is_empty() { emit(String::from_utf8_lossy(&line).into()); line.clear(); }
        } else {
            line.push(byte);
            if line.len() >= 16384 { emit(String::from_utf8_lossy(&line).into()); line.clear(); }
        }
    }
    if !line.is_empty() { emit(String::from_utf8_lossy(&line).into()); }
}

#[tauri::command]
pub fn cli_start(app: tauri::AppHandle, state: tauri::State<TaskState>, cwd: String, args: Vec<String>, job_id: String) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    if slot.is_some() { return Err("A PlatformIO task is already running".into()); }
    if !std::path::Path::new(&cwd).join("platformio.ini").is_file() { return Err("Open a folder containing platformio.ini first".into()); }
    if args.is_empty() { return Err("Missing PlatformIO command".into()); }
    let mut cmd = Command::new(crate::tooling::pio()?);
    cmd.current_dir(&cwd).args(&args).env("PYTHONUNBUFFERED", "1").env("PLATFORMIO_FORCE_COLOR", "false")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; cmd.process_group(0); }
    let mut child = cmd.spawn().map_err(|e| format!("start PlatformIO: {e}"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    *slot = Some(TaskHandle { cancel: cancel.clone(), pid: child.id() });
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let a = app.clone(); let id = job_id.clone();
    let out = thread::spawn(move || stream(stdout, |line| { let _ = a.emit("cli-output", Output {job_id:id.clone(), stream:"stdout".into(), line}); }));
    let a = app.clone(); let id = job_id.clone();
    let err = thread::spawn(move || stream(stderr, |line| { let _ = a.emit("cli-output", Output {job_id:id.clone(), stream:"stderr".into(), line}); }));
    thread::spawn(move || {
        let start = Instant::now();
        let code = loop {
            if cancel.load(Ordering::SeqCst) {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Err(_) => { let _ = child.kill(); let _ = child.wait(); break None; },
                _ => thread::sleep(Duration::from_millis(25)),
            }
        };
        let _ = out.join(); let _ = err.join();
        *app.state::<TaskState>().0.lock().unwrap() = None;
        let _ = app.emit("cli-exit", Exit {job_id, code, args, cancelled:cancel.load(Ordering::SeqCst), elapsed_ms:start.elapsed().as_millis()});
    });
    Ok(())
}

#[tauri::command]
pub fn cli_cancel(state: tauri::State<TaskState>) {
    if let Some(task) = state.0.lock().unwrap().as_ref() {
        if !task.cancel.swap(true, Ordering::SeqCst) {
            // Terminate synchronously so app shutdown cannot leave build or
            // flashing subprocesses alive while the waiter is still asleep.
            #[cfg(unix)] unsafe { libc::kill(-(task.pid as i32), libc::SIGKILL); }
            #[cfg(windows)] { let _ = Command::new("taskkill").args(["/PID", &task.pid.to_string(), "/T", "/F"]).output(); }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn progress_is_delivered_before_newline_and_output_is_bounded() {
        let mut lines = vec![];
        super::stream(&b"Writing 10%\rWriting 20%\r\nDone"[..], |s| lines.push(s));
        assert_eq!(lines, ["Writing 10%", "Writing 20%", "Done"]);
        lines.clear();
        super::stream(&vec![b'x'; 40000][..], |s| lines.push(s));
        assert_eq!(lines.iter().map(String::len).sum::<usize>(), 40000);
        assert!(lines.iter().all(|s| s.len() <= 16384));
    }
}
