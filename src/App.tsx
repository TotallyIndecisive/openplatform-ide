import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loader, Editor } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import "./App.css";

// Bundle Monaco locally (no CDN at runtime).
(self as any).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

const DEFAULT_SKETCH = `// ESP32 Blink — esp32:esp32:esp32 (ESP32 Dev Module)
// Uses millis() instead of delay()
const int LED_PIN = 23;
unsigned long prev = 0;
const unsigned long interval = 5000; // 5 seconds
bool state = false;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.begin(115200);
}

void loop() {
  unsigned long now = millis();
  if (now - prev >= interval) {
    prev = now;
    state = !state;
    digitalWrite(LED_PIN, state ? HIGH : LOW);
    Serial.println(state ? "on" : "off");
  }
}
`;

type Port = {
  address: string;
  isUsb: boolean;
  vid?: string;
  pid?: string;
  serialNumber?: string;
  manufacturer?: string;
  product?: string;
};

type ChipInfo = {
  port: string;
  esptool: string;
  success: boolean;
  command: string;
  summary: string;
  output: string;
};

// Faster upload on CP2102; defaults otherwise match standard esp32:esp32:esp32
const FQBN = "esp32:esp32:esp32:UploadSpeed=921600";
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");
const MAX_SERIAL = 20000;

function djb2(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
  }
  return h.toString(36);
}

export default function App() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [port, setPort] = useState("");
  const [chip, setChip] = useState<ChipInfo | null>(null);
  const [sketch, setSketch] = useState(DEFAULT_SKETCH);
  const [out, setOut] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [sketchPath, setSketchPath] = useState("");
  const [serialOpen, setSerialOpen] = useState(false);
  const [serialText, setSerialText] = useState("");
  const [baud, setBaud] = useState(115200);
  const [lastCompiledKey, setLastCompiledKey] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const serRef = useRef<HTMLPreElement>(null);

  // cli-exit handoff: lets sequential steps (compile -> upload) await completion
  // without a race between `invoke` resolving and the exit event arriving.
  const exitResolver = useRef<((code: number | null) => void) | null>(null);
  const pendingExit = useRef<number | null | undefined>(undefined);

  const log = (s: string) =>
    setOut((o) => [...o, ...(Array.isArray(s) ? s : [s])]);

  function onCliExit(code: number | null) {
    if (exitResolver.current) {
      const r = exitResolver.current;
      exitResolver.current = null;
      r(code);
    } else {
      pendingExit.current = code;
    }
  }

  function waitExit(): Promise<number | null> {
    if (pendingExit.current !== undefined) {
      const c = pendingExit.current;
      pendingExit.current = undefined;
      return Promise.resolve(c);
    }
    return new Promise((resolve) => {
      exitResolver.current = resolve;
    });
  }

  // ---- device recognition ----
  async function scan() {
    try {
      const p = await invoke<Port[]>("list_serial_ports");
      setPorts(p);
      const usb = p.find((x) => x.isUsb);
      setPort((cur) => cur || usb?.address || "");
    } catch (e) {
      log(`scan error: ${e}`);
    }
  }

  // ---- events from arduino-cli + serial ----
  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];
    offs.push(
      listen<{ stream: string; line: string }>("cli-output", (e) => {
        const line = stripAnsi(e.payload.line);
        setOut((o) => [...o, line]);
        if (line.trim()) setStatus(line.trim().slice(0, 140));
        // esptool reports flashing progress as: `Writing at 0x00010000... (42 %)`
        const m = line.match(/\((\d+)\s*%\)/);
        if (m) setProgress(Number(m[1]));
        else if (/Hash of data verified/i.test(line)) setProgress(100);
      })
    );
    offs.push(
      listen<{ code: number | null; args: string[] }>("cli-exit", (e) => {
        setBusy(null);
        setProgress(null);
        setStatus("");
        log(`\n[exit ${e.payload.code}] arduino-cli ${e.payload.args.join(" ")}`);
        onCliExit(e.payload.code);
      })
    );
    offs.push(
      listen<{ data: string }>("serial-data", (e) => {
        setSerialText((t) => {
          const next = t + e.payload.data;
          return next.length > MAX_SERIAL ? next.slice(-MAX_SERIAL) : next;
        });
      })
    );
    offs.push(
      listen<{ open: boolean; port: string; message: string }>(
        "serial-status",
        (e) => {
          setSerialOpen(e.payload.open);
          log(`[serial] ${e.payload.message}`);
        }
      )
    );
    scan();
    invoke<{ sketchDir: string; home: string; esptool?: string }>(
      "app_paths"
    ).then((p) => setSketchPath(`${p.sketchDir}/Blink`));
    return () => {
      Promise.all(offs).then((fs) => fs.forEach((f) => f()));
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [out]);
  useEffect(() => {
    serRef.current?.scrollTo({ top: serRef.current.scrollHeight });
  }, [serialText]);

  async function identify() {
    if (!port || busy) return;
    if (serialOpen) await stopSerial();
    setBusy("identify chip");
    setProgress(null);
    setStatus(`probing ${port}…`);
    log(`\n--- esptool chip-id on ${port} ---`);
    try {
      const c = await invoke<ChipInfo>("identify_chip", { port });
      setChip(c);
      log(c.output);
    } catch (e) {
      log(`identify error: ${e}`);
    } finally {
      setBusy(null);
      setStatus("");
    }
  }

  async function save(): Promise<string | null> {
    try {
      const paths = await invoke<{ sketchDir: string }>("app_paths");
      const dir = await invoke<string>("write_sketch", {
        sketchDir: `${paths.sketchDir}/Blink`,
        mainName: "Blink",
        content: sketch,
      });
      setSketchPath(dir);
      return dir;
    } catch (e) {
      log(`save error: ${e}`);
      return null;
    }
  }

  /** Run one arduino-cli invocation; resolves with its exit code. */
  async function runCli(
    args: string[],
    label: string,
    prefix?: string
  ): Promise<number | null> {
    if (serialOpen) await stopSerial();
    setBusy(label);
    setProgress(null);
    setStatus("");
    if (prefix) log(`\n--- ${prefix} ---`);
    const done = waitExit();
    try {
      await invoke("cli_start", { args });
    } catch (e) {
      log(`${label} error: ${e}`);
      exitResolver.current = null;
      setBusy(null);
      return -1;
    }
    return done;
  }

  async function verify() {
    if (busy) return;
    const dir = await save();
    if (!dir) return;
    const code = await runCli(
      ["compile", "--fqbn", FQBN, dir],
      "compiling",
      `Verify (compile) ${dir}`
    );
    if (code === 0) {
      const key = `${djb2(sketch)}|${FQBN}|${dir}`;
      setLastCompiledKey(key);
      log("✓ Verify OK");
    } else {
      setLastCompiledKey(null);
      log(`✗ Verify failed (exit ${code})`);
    }
  }

  async function upload() {
    if (busy || !port) return;
    const dir = await save();
    if (!dir) return;
    const key = `${djb2(sketch)}|${FQBN}|${dir}`;
    if (lastCompiledKey !== key) {
      const c = await runCli(
        ["compile", "--fqbn", FQBN, dir],
        "compiling",
        `Compile ${dir}`
      );
      if (c !== 0) {
        setLastCompiledKey(null);
        log(`✗ Compile failed (exit ${c}) — not uploading.`);
        return;
      }
      setLastCompiledKey(key);
      log("✓ Compiled. Uploading…");
    } else {
      log("✓ Using cached build. Uploading…");
    }
    const u = await runCli(
      ["upload", "-p", port, "--fqbn", FQBN, dir],
      "uploading",
      `Upload → ${port}`
    );
    log(
      u === 0
        ? "✓ Upload OK — press “Serial monitor” to watch the board run."
        : `✗ Upload failed (exit ${u})`
    );
  }

  async function toggleSerial() {
    if (serialOpen) {
      await stopSerial();
      return;
    }
    if (!port || busy) return;
    setSerialText("");
    try {
      await invoke("serial_start", { port, baud });
      setSerialOpen(true);
    } catch (e) {
      log(`serial error: ${e}`);
    }
  }

  async function stopSerial() {
    try {
      await invoke("serial_stop");
    } catch {}
    setSerialOpen(false);
  }

  function vscode() {
    if (sketchPath) invoke("open_in_vscode", { path: sketchPath });
  }

  const usbPorts = ports.filter((p) => p.isUsb);

  return (
    <div className="wrap">
      <header>
        <span className="brand">esp32-ide</span>
        <span className="sub">Tauri 2 · React · TS — Arduino-IDE-style</span>
        <div className="actions">
          <button onClick={scan}>⟳ Refresh ports</button>
          <select value={port} onChange={(e) => setPort(e.target.value)}>
            <option value="">— select port —</option>
            {ports.map((p) => (
              <option key={p.address} value={p.address}>
                {p.address}
                {p.isUsb
                  ? `  [${p.vid}:${p.pid}${p.product ? " " + p.product : ""}]`
                  : ""}
              </option>
            ))}
          </select>
          <button onClick={identify} disabled={!port || !!busy}>
            {busy === "identify chip" ? "probing…" : "Identify chip"}
          </button>
          <button onClick={verify} disabled={!!busy}>
            {busy === "compiling" ? "compiling…" : "✓ Verify"}
          </button>
          <button onClick={upload} disabled={!port || !!busy}>
            {busy === "uploading" || busy === "compiling"
              ? "working…"
              : "↑ Upload"}
          </button>
          <button onClick={vscode} disabled={!sketchPath}>
            Open in VS Code
          </button>
        </div>
      </header>

      {(busy || progress !== null) && (
        <div className="progress-wrap">
          <div className="progress">
            <div
              className={`bar${progress === null ? " indeterminate" : ""}`}
              style={progress !== null ? { width: `${progress}%` } : undefined}
            />
          </div>
          <span className="progress-label">
            {busy ?? "working"}
            {progress !== null ? ` — ${progress}%` : ""}
            {status ? ` · ${status}` : ""}
          </span>
        </div>
      )}

      {chip && (
        <div className={`chip ${chip.success ? "ok" : "bad"}`}>
          {chip.success
            ? `✓ ${chip.summary} on ${chip.port}  (esptool ${chip.command})`
            : `✗ chip identify failed on ${chip.port}: ${chip.output
                .slice(0, 240)
                .replace(/\n/g, " ")}`}
        </div>
      )}

      <main>
        <section className="editor">
          <div className="path">
            {sketchPath || "…"} <span className="hint">· Blink.ino</span>
          </div>
          <Editor
            height="100%"
            defaultLanguage="cpp"
            language="cpp"
            theme="vs-dark"
            value={sketch}
            onChange={(v) => setSketch(v ?? "")}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              wordWrap: "on",
              automaticLayout: true,
            }}
          />
        </section>

        <section className="console">
          <div className="console-head">
            <span>
              Output {busy && <span className="tag">● {busy}</span>}
            </span>
            <span className="spacer" />
            <label className="baud">
              baud
              <select
                value={baud}
                onChange={(e) => setBaud(Number(e.target.value))}
                disabled={serialOpen}
              >
                {[9600, 19200, 57600, 115200, 230400].map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={toggleSerial} disabled={!port || !!busy}>
              {serialOpen ? "■ Stop serial" : "▷ Serial monitor"}
            </button>
            <button onClick={() => setOut([])}>Clear</button>
          </div>
          <pre ref={logRef} className="out">
            {out.length ? out.join("\n") : "Ready."}
          </pre>
          <div className="serial-head">
            Serial monitor {serialOpen ? "● live" : "○ stopped"}
            {serialText && (
              <button className="mini" onClick={() => setSerialText("")}>
                clear
              </button>
            )}
          </div>
          <pre ref={serRef} className="serial">
            {serialText || "—"}
          </pre>
        </section>
      </main>

      <footer>
        {usbPorts.length > 0 ? (
          <span>
            USB ports:{" "}
            {usbPorts
              .map((p) => `${p.address} (${p.vid}/${p.pid})`)
              .join("   ")}
          </span>
        ) : (
          <span>No USB serial device detected</span>
        )}
        <span className="fqbn">FQBN {FQBN}</span>
      </footer>
    </div>
  );
}
