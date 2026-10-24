import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { connectLanguage } from "./language";
import { parseDiagnostic, type BuildDiagnostic } from "./diagnostics";
import { listen } from "@tauri-apps/api/event";
import { loader, Editor } from "@monaco-editor/react";
import { open as openDialog, save as saveDialog, confirm } from "@tauri-apps/plugin-dialog";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

// Bundle Monaco locally (no CDN at runtime).
(self as any).MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};
loader.config({ monaco });

const DEFAULT_PIO_INI = `[env:esp32dev]\nplatform = espressif32\nboard = esp32dev\nframework = arduino\nmonitor_speed = 115200\nupload_speed = 921600\n`;

const DEFAULT_SRC = `#include <Arduino.h>\n\n#define LED_PIN 23\n\nunsigned long previousMillis = 0;\nconst unsigned long interval = 1000; // 1 second\nbool ledState = false;\n\nvoid setup() {\n  pinMode(LED_PIN, OUTPUT);\n  digitalWrite(LED_PIN, LOW);\n  Serial.begin(115200);\n}\n\nvoid loop() {\n  unsigned long currentMillis = millis();\n  if (currentMillis - previousMillis >= interval) {\n    previousMillis = currentMillis;\n    ledState = !ledState;\n    digitalWrite(LED_PIN, ledState ? HIGH : LOW);\n    Serial.println(ledState ? "on" : "off");\n  }\n}\n`;

const DEFAULT_INI_PATH = "platformio.ini";
const DEFAULT_SRC_PATH = "src/main.cpp";

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

type FileNode = { name: string; path: string; isDir: boolean; ext: string };
type Symbol = { name: string; kind: string; line: number };
type FileHit = { path: string; line: number; text: string };

/** A buffer in the workspace, mirroring Zed's `workspace::item::Item`. */
type Buffer = {
  path: string;       // workspace-relative, e.g. "src/main.cpp"
  abs: string;        // absolute path on disk
  language: string;
  value: string;
  saved: string;      // last value written to disk (drives the dirty dot)
  preview?: boolean;  // Zed's preview tab: replaced on the next single click
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");
const MAX_SERIAL = 20000;

/** Extension → Monaco language. Only what a PlatformIO project needs. */
function languageFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "c": case "cc": case "cpp": case "cxx":
    case "h": case "hh": case "hpp": case "hxx": case "ino": case "s":
      return "cpp";
    case "py": return "python";
    case "json": return "json";
    case "ini": case "cfg": case "conf": return "ini";
    case "md": return "markdown";
    case "yaml": case "yml": return "yaml";
    case "toml": return "toml";
    case "xml": return "xml";
    case "js": return "javascript";
    case "ts": return "typescript";
    case "sh": return "shell";
    default: return "plaintext";
  }
}

function baseName(p: string) {
  return p.split("/").pop() ?? p;
}

function fileIcon(name: string, isDir: boolean) {
  if (isDir) return "▸";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "ino"].includes(ext)) return "Ⓒ";
  if (ext === "py") return "🐍";
  if (ext === "ini" || ext === "toml" || ext === "cfg") return "⚙";
  if (ext === "json") return "{}";
  if (ext === "md") return "▤";
  return "▫";
}

/** One entry in a `modal_layer` overlay (palette / finder / search). */
type Item = { label: string; detail?: string; run: () => void };

export default function App() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [port, setPort] = useState("");
  const [chip, setChip] = useState<ChipInfo | null>(null);
  const [out, setOut] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [serialOpen, setSerialOpen] = useState(false);
  const [serialText, setSerialText] = useState("");
  const [baud, setBaud] = useState(115200);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [environment, setEnvironment] = useState("");
  const [diagnostics, setDiagnostics] = useState<BuildDiagnostic[]>([]);
  const [languageStatus, setLanguageStatus] = useState("C++ idle");
  const [languageRevision, setLanguageRevision] = useState(0);
  const [serialInput, setSerialInput] = useState("");
  const [lineEnding, setLineEnding] = useState("\n");
  const taskLock = useRef(false);
  const cancelRequested = useRef(false);
  const jobRef = useRef<{id: string; root: string} | null>(null);
  const eventsReady = useRef<Promise<unknown>>(Promise.resolve());
  const serialOpenRef = useRef(false);
  serialOpenRef.current = serialOpen;

  // --- workspace: buffers (tabs), tree, panel, overlays ---
  const [buffers, setBuffers] = useState<Buffer[]>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [treeRoot, setTreeRoot] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileNode[]>>({});
  const [panel, setPanel] = useState<"files" | "outline" | "serial" | "problems" | "git" | "debug" | "libraries" | "boards">("files");
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(240);
  const [outline, setOutline] = useState<Symbol[]>([]);
  const [overlay, setOverlay] = useState<null | "palette" | "finder" | "search">(null);
  const [overlayQuery, setOverlayQuery] = useState("");
  const [overlaySel, setOverlaySel] = useState(0);
  const [overlayItems, setOverlayItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [buildState, setBuildState] = useState<"idle" | "ok" | "err" | "cancelled">("idle");

  // The bottom region shows exactly one view at a time: the terminal or the
  // build/upload output. `null` means the region is collapsed.
  const [bottom, setBottom] = useState<"terminal" | "output" | null>(null);
  const termOpen = bottom === "terminal";
  const outOpen = bottom === "output";
  const [termCwd, setTermCwd] = useState("");

  const serRef = useRef<HTMLPreElement>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const activeRef = useRef<string>("");
  const buffersRef = useRef<Buffer[]>([]);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const overlayInputRef = useRef<HTMLInputElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termOpenRef = useRef(false);
  const termStartedRef = useRef(false);
  const termStartRef = useRef<((cwd?: string) => void) | null>(null);
  const homeDirRef = useRef<string>("");

  activeRef.current = activePath;
  buffersRef.current = buffers;
  // cli-exit handoff: lets sequential steps (compile -> upload) await completion
  // without a race between `invoke` resolving and the exit event arriving.
  const exitResolver = useRef<((code: number | null) => void) | null>(null);


  const log = useCallback(
    (s: string) => setOut((o) => [...o, s].slice(-3000)),
    []
  );

  function onCliExit(code: number | null) {
    if (exitResolver.current) {
      const r = exitResolver.current;
      exitResolver.current = null;
      r(code);
    }
  }

  function waitExit(): Promise<number | null> {
    return new Promise(resolve => { exitResolver.current = resolve; });
  }

  const active = buffers.find((b) => b.path === activePath) ?? null;
  const activeValue = active?.value ?? "";
  const activeLang = active?.language ?? "cpp";

  // ---- device recognition ----
  async function scan() {
    try {
      const p = await invoke<Port[]>("list_serial_ports");
      setPorts(p);
      const usb = p.find((x) => x.isUsb);
      setPort((cur) => p.some(x => x.address === cur) ? cur : usb?.address || "");
    } catch (e) {
      log(`scan error: ${e}`);
    }
  }

  const loadRecents = useCallback(async () => {
    try {
      const r = await invoke<string[]>("list_recent");
      setRecents(r);
    } catch (e) {
      log(`list_recent error: ${e}`);
    }
  }, [log]);

  // ---- startup + event wiring ----
  useEffect(() => {
    const offs: Array<Promise<() => void>> = [];
    offs.push(listen("app-exit-requested", () => { void getCurrentWindow().close(); }));
    offs.push(
      listen<{ jobId: string; stream: string; line: string }>("cli-output", (e) => {
        if (e.payload.jobId !== jobRef.current?.id) return;
        const line = stripAnsi(e.payload.line);
        setOut((o) => [...o, line].slice(-3000));
        const diagnostic = parseDiagnostic(line, jobRef.current.root);
        if (diagnostic) setDiagnostics(ds => [...ds, diagnostic].slice(-1000));
        if (line.trim()) setStatus(line.trim().slice(0, 140));
        // esptool reports flashing progress as: `Writing at 0x00010000... (42 %)`
        const m = line.match(/(?:\(|\s)(\d+(?:\.\d+)?)\s*%/);
        if (m) setProgress(Number(m[1]));
        else if (/Hash of data verified/i.test(line)) setProgress(100);
      })
    );
    offs.push(
      listen<{ jobId: string; code: number | null; args: string[]; cancelled: boolean; elapsedMs: number }>("cli-exit", (e) => {
        if (e.payload.jobId !== jobRef.current?.id) return;
        setProgress(null);
        setStatus("");
        setBuildState(e.payload.cancelled ? "cancelled" : e.payload.code === 0 ? "ok" : "err");
        log(`\n[${e.payload.cancelled ? "cancelled" : `exit ${e.payload.code}`} · ${(e.payload.elapsedMs / 1000).toFixed(2)}s] pio ${e.payload.args.join(" ")}`);
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
    offs.push(
      listen<{ data: string }>("terminal-data", (e) => {
        termRef.current?.write(e.payload.data);
      })
    );
    offs.push(
      listen<{ open: boolean; cwd: string; shell: string; message: string }>(
        "terminal-status",
        (e) => {
          if (e.payload.open) setTermCwd(e.payload.cwd);
          log(`[terminal] ${e.payload.message}`);
        }
      )
    );
    eventsReady.current = Promise.all(offs);
    const polling = setInterval(scan, 2500);
    let disposed = false;
    scan();
    loadRecents();
    invoke<{ projectDir?: string; home: string; esptool?: string }>("app_paths")
      .then((p) => {
        if (disposed) return;
        homeDirRef.current = p.home;
        if (p.projectDir) void openProjectDir(p.projectDir);
      })
      .catch((e) => log(`app_paths error: ${e}`));
    return () => {
      disposed = true;
      clearInterval(polling);
      Promise.all(offs).then((fs) => fs.forEach((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [out, outOpen]);
  useEffect(() => {
    serRef.current?.scrollTo({ top: serRef.current.scrollHeight });
  }, [serialText]);

  // ============================================================== terminal ===
  //
  // Zed's rule (`terminal_view::default_working_directory`): a terminal opens in
  // the project directory when a project is open, and in $HOME otherwise. We
  // resolve the same way, then hand the directory to the backend, which spawns
  // the login shell inside a real PTY.

  const resolveTerminalCwd = useCallback(() => {
    return projectDir || homeDirRef.current || "";
  }, [projectDir]);

  /** Create the xterm instance once, then keep it alive across open/close. */
  const ensureTerminal = useCallback(() => {
    if (termRef.current) return termRef.current;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      theme: {
        background: "#171a1e",
        foreground: "#abb2bf",
        cursor: "#4c8bf5",
        selectionBackground: "#3a4048",
        black: "#1e2227", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
        blue: "#4c8bf5", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
        brightBlack: "#7f848e", brightRed: "#e06c75", brightGreen: "#98c379",
        brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
        brightCyan: "#56b6c2", brightWhite: "#d7dae0",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Keystrokes go straight to the child's stdin.
    term.onData((d) => { invoke("terminal_write", { data: d }).catch(() => {}); });
    termRef.current = term;
    fitRef.current = fit;
    return term;
  }, []);

  /** Spawn (or restart) the shell in `cwd` / the resolved project directory. */
  const startTerminal = useCallback(
    async (cwd?: string) => {
      const dir = cwd ?? resolveTerminalCwd();
      const term = ensureTerminal();
      const fit = fitRef.current;
      // The host div is always mounted, so the grid is already attached; only
      // the very first call needs to open it.
      if (termHostRef.current && !term.element) {
        term.open(termHostRef.current);
      }
      try { fit?.fit(); } catch { /* host not laid out yet */ }
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      termStartedRef.current = true;
      try {
        const used = await invoke<string>("terminal_start", { cwd: dir, cols, rows });
        setTermCwd(used);
      } catch (e) {
        term.writeln(`\x1b[31mfailed to start terminal: ${e}\x1b[0m`);
        log(`terminal_start error: ${e}`);
      }
    },
    [ensureTerminal, resolveTerminalCwd, log]
  );
  termStartRef.current = startTerminal;

  /** Activity-bar / menu entry point. */
  const toggleTerminal = useCallback(() => {
    setBottom((cur) => {
      const next = cur === "terminal" ? null : "terminal";
      termOpenRef.current = next === "terminal";
      // Spawn only once: the host div stays mounted, so revealing the dock is
      // enough on later toggles. Restarting here is what produced a second,
      // "old" terminal every time the button was pressed.
      if (next === "terminal" && !termStartedRef.current) {
        termStartedRef.current = true;
        setTimeout(() => termStartRef.current?.(), 0);
      }
      return next;
    });
  }, []);

  /** Activity-bar / menu entry point for the build & upload output. */
  const toggleOutput = useCallback(() => {
    setBottom((cur) => (cur === "output" ? null : "output"));
  }, []);

  /** Bring the output forward when a build step starts.
   *
   * If the user is sitting in the terminal, switch to the output so the run is
   * visible; otherwise leave their current view alone. */
  const revealOutput = useCallback(() => {
    setBottom("output");
  }, []);

  // The host div is always mounted, so attach xterm to it once. This effect
  // only keeps the grid sized while the dock is visible.
  useEffect(() => {
    const el = termHostRef.current;
    if (!el) return;
    // Attach on first render; the node is stable from here on.
    const term = ensureTerminal();
    if (!term.element) term.open(el);
    if (!termOpen) return;
    const fit = () => {
      try {
        fitRef.current?.fit();
        if (term.cols && term.rows) {
          invoke("terminal_resize", { cols: term.cols, rows: term.rows }).catch(() => {});
        }
      } catch { /* ignore transient layout */ }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    term.focus();
    return () => ro.disconnect();
  }, [termOpen, ensureTerminal]);

  // ===================================================== workspace buffers ===

  /** Refresh the tree from disk. Cheap: one directory level at a time. */
  const refreshTree = useCallback(
    async (dir: string) => {
      try {
        const nodes = await invoke<FileNode[]>("list_dir", { path: dir });
        setTreeRoot(nodes);
      } catch (e) {
        log(`tree error: ${e}`);
      }
    },
    [log]
  );

  /** Zed's preview tab: a single click opens italic and is replaced by the
   *  next preview; typing (or double-click) promotes it to a pinned tab. */
  const openFile = useCallback(
    async (abs: string, opts: { preview?: boolean; pin?: boolean } = {}) => {
      const rel = projectDir && abs.startsWith(projectDir + "/")
        ? abs.slice(projectDir.length + 1)
        : abs;
      const existing = buffersRef.current.find((b) => b.path === rel);
      if (existing) {
        if (opts.pin) {
          setBuffers((bs) => bs.map((b) => (b.path === rel ? { ...b, preview: false } : b)));
        }
        setActivePath(rel);
        return;
      }
      let value = "";
      try {
        value = await invoke<string>("read_file", { path: abs });
      } catch (e) {
        log(`read error: ${e}`);
        return;
      }
      const buf: Buffer = {
        path: rel,
        abs,
        language: languageFor(rel),
        value,
        saved: value,
        preview: opts.preview ?? false,
      };
      setBuffers((bs) => {
        // Guard against a duplicate append when two opens are in flight
        // (e.g. opening both project files back to back).
        if (bs.some((b) => b.path === buf.path)) return bs;
        // Replacing an unpinned preview keeps the tab bar from growing forever.
        const idx = bs.findIndex((b) => b.preview);
        if (buf.preview && idx >= 0) {
          const next = bs.slice();
          next[idx] = buf;
          return next;
        }
        return [...bs, buf];
      });
      setActivePath(rel);
    },
    [projectDir, log]
  );

  /** Load a PlatformIO project: reset buffers, then open ini + main.cpp. */
  const openProjectDir = useCallback(
    async (dir: string) => {
      if (taskLock.current) { log("Wait for the running task before switching projects."); return; }
      if (buffersRef.current.some(b => b.value !== b.saved) && !await confirm("Discard unsaved edits and switch projects?", { title: "Unsaved files", kind: "warning" })) return;
      try { await invoke("read_file", {path: `${dir}/platformio.ini`}); }
      catch (e) { log(`Open failed: ${e}`); return; }


      // Read everything before touching state, so the reset and the initial
      // tabs land in one commit instead of racing each other.
      const initial: Buffer[] = [];
      for (const rel of [DEFAULT_INI_PATH, DEFAULT_SRC_PATH]) {
        const abs = `${dir}/${rel}`;
        try {
          const value = await invoke<string>("read_file", { path: abs });
          initial.push({
            path: rel,
            abs,
            language: languageFor(rel),
            value,
            saved: value,
            preview: false,
          });
        } catch {
          // Missing file — the tree is still usable.
        }
      }

      try {
        const drafts: Buffer[] = JSON.parse(localStorage.getItem(`drafts:${dir}`) ?? "[]");
        for (const draft of drafts) {
          if (!draft.abs?.startsWith(dir + "/") || draft.value === draft.saved) continue;
          const index = initial.findIndex(b => b.abs === draft.abs);
          // Keep the original disk baseline so a concurrent external edit is
          // detected by Save, rather than silently overwritten by recovery.
          if (index >= 0) initial[index] = {...draft, preview: false};
          else initial.push({...draft, preview: false});
        }
        if (drafts.length) log("Recovered unsaved editor drafts.");
      } catch { /* A corrupt recovery record must not prevent opening a project. */ }
      setProjectDir(dir);
      setExpanded({});
      setOutline([]);
      setDiagnostics([]);
      buffersRef.current = initial;
      setBuffers(initial);
      setActivePath(initial[initial.length - 1]?.path ?? "");

      try {
        const envs = await invoke<string[]>("project_environments", {projectDir: dir});
        setEnvironments(envs);
        const savedEnv = localStorage.getItem(`environment:${dir}`);
        setEnvironment(savedEnv && envs.includes(savedEnv) ? savedEnv : envs[0] ?? "");
      } catch (e) { setEnvironments([]); setEnvironment(""); log(`PlatformIO configuration: ${e}`); }
      await refreshTree(dir);
      invoke("add_recent", { projectDir: dir }).then(loadRecents).catch(() => {});
      log(`Opened project: ${dir}`);
    },
    [refreshTree, loadRecents, log]
  );

  const updateActive = useCallback((text: string) => {
    setBuffers((bs) =>
      bs.map((b) =>
        b.path === activeRef.current
          ? { ...b, value: text, preview: false } // editing promotes a preview
          : b
      )
    );
  }, []);

  const toggleDir = useCallback(
    async (node: FileNode) => {
      if (expanded[node.path]) {
        setExpanded((e) => {
          const next = { ...e };
          delete next[node.path];
          return next;
        });
        return;
      }
      try {
        const kids = await invoke<FileNode[]>("list_dir", { path: node.path });
        setExpanded((e) => ({ ...e, [node.path]: kids }));
      } catch (e) {
        log(`tree error: ${e}`);
      }
    },
    [expanded, log]
  );

  const closeBuffer = useCallback(async (path: string) => {
    const buffer = buffersRef.current.find(b => b.path === path);
    if (buffer && buffer.value !== buffer.saved && !await confirm(`Discard unsaved edits in ${baseName(path)}?`, {title: "Unsaved file", kind: "warning"})) return;
    setBuffers(bs => {
      const idx = bs.findIndex(b => b.path === path);
      const next = bs.filter(b => b.path !== path);
      if (path === activeRef.current) setActivePath(next[Math.min(idx, next.length - 1)]?.path ?? "");
      return next;
    });
  }, []);

  // Recover dirty buffers after a crash and protect native window close.
  useEffect(() => {
    if (!projectDir) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(`drafts:${projectDir}`, JSON.stringify(buffers.filter(b => b.value !== b.saved))); }
      catch { log("Draft recovery storage is full. Save your open files."); }
    }, 400);
    return () => clearTimeout(timer);
  }, [buffers, projectDir, log]);

  useEffect(() => {
    const off = getCurrentWindow().onCloseRequested(async event => {
      if (taskLock.current || buffersRef.current.some(b => b.value !== b.saved)) {
        event.preventDefault();
        const close = await confirm("Close the IDE? Unsaved edits remain in local recovery and any running task will be stopped.", { title: "Close Openplatform IDE", kind: "warning" });
        if (close) await getCurrentWindow().destroy();
      }
    });
    return () => { void off.then(f => f()); };
  }, []);

  // Reload clean files edited in VS Code. Dirty files retain their original
  // baseline and Save refuses to overwrite conflicting external changes.
  useEffect(() => {
    const reload = async () => {
      for (const b of buffersRef.current) {
        if (b.value !== b.saved) continue;
        try {
          const disk = await invoke<string>("read_file", {path:b.abs});
          if (disk !== b.saved) setBuffers(bs => bs.map(x => x.abs === b.abs && x.value === b.value && x.saved === b.saved ? {...x, value:disk, saved:disk} : x));
        } catch { /* Deleted files are reported if the user tries to save. */ }
      }
      if (projectDir) void refreshTree(projectDir);
    };
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [projectDir, refreshTree]);

  useEffect(() => {
    if (!projectDir) return;
    let stale = false;
    let connection: { dispose: () => void } | undefined;
    // Delay startup one tick so StrictMode's discarded mount does not launch
    // a second native language process.
    const timer = setTimeout(() => {
      connectLanguage(projectDir, log, status => { if (!stale) setLanguageStatus(status); })
        .then(client => { if (stale) client.dispose(); else connection = client; })
        .catch(e => { if (!stale) { setLanguageStatus("C++ unavailable"); log(`[clangd] ${e}`); } });
    }, 100);
    return () => { stale = true; clearTimeout(timer); connection?.dispose(); };
  }, [projectDir, languageRevision, log]);

  useEffect(() => {
    const registration = monaco.editor.registerEditorOpener({ openCodeEditor: async (_source, uri, selection) => {
      if (uri.scheme !== "file") return false;
      await openFile(uri.fsPath, {pin:true});
      setTimeout(() => {
        const ed = editorRef.current;
        if (!ed || !selection) return;
        if ("startLineNumber" in selection) { ed.setSelection(selection); ed.revealRangeInCenter(selection); }
        else { ed.setPosition(selection); ed.revealPositionInCenter(selection); }
      }, 80);
      return true;
    } });
    return () => registration.dispose();
  }, [openFile]);

  useEffect(() => {
    for (const model of monaco.editor.getModels()) {
      const path = model.uri.fsPath;
      monaco.editor.setModelMarkers(model, "platformio", diagnostics.filter(d => d.path === path).map(d => ({
        startLineNumber:d.line, endLineNumber:d.line, startColumn:d.column, endColumn:d.column + 1,
        message:d.message, severity:d.severity === "error" ? monaco.MarkerSeverity.Error : d.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      })));
    }
  }, [diagnostics, activePath]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const openUris = new Set(buffersRef.current.map(b => monaco.Uri.file(b.abs).toString()));
      for (const model of monaco.editor.getModels()) {
        if (model.uri.scheme === "file" && !openUris.has(model.uri.toString()) && editorRef.current?.getModel() !== model) model.dispose();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [buffers]);

  // ---- outline for the active buffer (declaration scan) ----
  useEffect(() => {
    if (panel !== "outline" || !active || active.language !== "cpp") {
      setOutline([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      invoke<Symbol[]>("document_symbols", { path: active.abs, content: active.value })
        .then((s) => !cancelled && setOutline(s))
        .catch(() => !cancelled && setOutline([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [panel, active?.path, activeValue, active]);

  function gotoLine(line: number) {
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.focus();
  }

  // ==================================================== project management ===

  async function saveBuffer(b: Buffer): Promise<boolean> {
    try {
      await invoke("write_file", { path: b.abs, content: b.value, expected: b.saved });
      setBuffers((bs) =>
        bs.map((x) => (x.abs === b.abs ? { ...x, saved: b.value, preview: false } : x))
      );
      return true;
    } catch (e) {
      log(`save error: ${e}`);
      return false;
    }
  }

  async function saveAll() {
    for (const b of buffersRef.current) {
      if (b.value !== b.saved && !await saveBuffer(b)) return false;
    }
    log("✓ Saved");
    return true;
  }

  async function saveActive() {
    const b = buffersRef.current.find((x) => x.path === activeRef.current);
    if (b) await saveBuffer(b);
  }

  /** File ▸ New Project — pick a folder, scaffold a PlatformIO project there. */
  async function newProject(template: "esp32" | "uno" | "nano" = "esp32") {
    setMenuOpen(false);
    const dest = await saveDialog({
      title: "Create new PlatformIO project",
      defaultPath: "MyProject",
      canCreateDirectories: true,
    });
    if (!dest) return;
    try {
      const dir = await invoke<string>("create_new_project", {
        projectDir: dest,
        platformioIni: template === "esp32" ? DEFAULT_PIO_INI : `[env:${template}]\nplatform = atmelavr\nboard = ${template === "uno" ? "uno" : "nanoatmega328"}\nframework = arduino\nmonitor_speed = 115200\n`,
        srcContent: template === "esp32" ? DEFAULT_SRC : DEFAULT_SRC.replace("#define LED_PIN 23", "#define LED_PIN LED_BUILTIN"),
      });
      await openProjectDir(dir);
      log(`Created project: ${dir}`);
    } catch (e) {
      log(`new project error: ${e}`);
    }
  }

  /** File ▸ Open Project — browse to a folder (or its platformio.ini). */
  async function openProject() {
    setMenuOpen(false);
    const picked = await openDialog({
      title: "Open PlatformIO project",
      directory: true,
      multiple: false,
    });
    if (typeof picked !== "string") return;
    // Accept selecting the platformio.ini itself as well as the project folder.
    const dir = picked.endsWith("platformio.ini")
      ? picked.slice(0, -"platformio.ini".length).replace(/\/$/, "")
      : picked;
    await openProjectDir(dir);
  }

  const pickFolder = useCallback(
    async (title: string, defaultPath: string) => {
      const dest = await saveDialog({
        title,
        defaultPath,
        canCreateDirectories: true,
      });
      return typeof dest === "string" ? dest : null;
    },
    []
  );

  /** Save As — write the active buffer (or the whole project) elsewhere. */
  async function saveAs() {
    setMenuOpen(false);
    if (active) {
      const dest = await pickFolder("Save file as", baseName(active.path));
      if (!dest) return;
      try {
        await invoke("write_file", { path: dest, content: active.value });
        log(`Saved as: ${dest}`);
        openFile(dest, { pin: true });
      } catch (e) {
        log(`save as error: ${e}`);
      }
      return;
    }
    const dest = await pickFolder("Save project as (choose target folder)", "MyProject");
    if (!dest) return;
    try {
      const dir = await invoke<string>("write_pio_project", {
        projectDir: dest,
        platformioIni: DEFAULT_PIO_INI,
        srcContent: DEFAULT_SRC,
      });
      await openProjectDir(dir);
      log(`Saved project as: ${dir}`);
    } catch (e) {
      log(`save as error: ${e}`);
    }
  }

  /** New File — create an empty file inside the project, then open it. */
  async function newFile() {
    setMenuOpen(false);
    if (!projectDir) return;
    const dest = await saveDialog({
      title: "Create new file in project",
      defaultPath: `${projectDir}/src/`,
      canCreateDirectories: true,
    });
    if (typeof dest !== "string") return;
    try {
      await invoke("create_file", { path: dest });
      await refreshTree(projectDir);
      await openFile(dest, { pin: true });
      log(`Created file: ${dest.replace(projectDir + "/", "")}`);
    } catch (e) {
      log(`new file error: ${e}`);
    }
  }

  // ==================================================== modal_layer overlays ===

  // The palette must invoke the *current* handlers, not the ones captured when
  // it opened — otherwise build/upload act on a stale buffer snapshot.
  const actionsRef = useRef<Record<string, () => void>>({});

  const commands = useMemo(
    () => [
      ["File: New Project", "⇧⌘N"],
      ["File: New Arduino Uno Project", ""],
      ["File: New Arduino Nano Project", ""],
      ["File: Open Project", "⌘O"],
      ["File: New File", ""],
      ["File: Save", "⌘S"],
      ["File: Save All", "⌥⌘S"],
      ["File: Save As", "⇧⌘S"],
      ["Workspace: Open in VS Code", ""],
      ["Panel: Show Files", ""],
      ["Panel: Show Outline", ""],
      ["Panel: Show Serial Monitor", ""],
      ["Panel: Toggle Sidebar", "⌘B"],
      ["Build: Verify", ""],
      ["Build: Upload", ""],
      ["Build: Cancel", ""],
      ["Build: Clean", ""],
      ["Build: Generate Compilation Database", ""],
      ["Build: Static Analysis", ""],
      ["Build: Run Tests", ""],
      ["Project: Install Dependencies", ""],
      ["Tools: Check Toolchain", ""],
      ["C++: Restart Language Server", ""],
      ["Editor: Format Document", ""],
      ["Editor: Reload File from Disk", ""],
      ["Panel: Show Problems", ""],
      ["Device: Refresh Ports", "⟳"],
      ["Device: Identify Chip", ""],
      ["Serial: Toggle Monitor", ""],
      ["Terminal: Toggle", "⌃`"],
      ["Terminal: New", ""],
      ["Terminal: Restart Shell", ""],
      ["Output: Toggle", ""],
    ] as Array<[string, string]>,
    []
  );

  const openPalette = useCallback(() => {
    setOverlay("palette");
    setOverlayQuery("");
    setOverlaySel(0);
    setOverlayItems(
      commands.map(([label, key]) => ({
        label,
        detail: key,
        run: () => actionsRef.current[label]?.(),
      }))
    );
  }, [commands]);

  // Keep the action table pointing at the newest closures on every render.
  actionsRef.current = {
    "File: New Project": () => newProject(),
    "File: New Arduino Uno Project": () => newProject("uno"),
    "File: New Arduino Nano Project": () => newProject("nano"),
    "File: Open Project": openProject,
    "File: New File": newFile,
    "File: Save": () => saveActive(),
    "File: Save All": () => saveAll(),
    "File: Save As": saveAs,
    "Workspace: Open in VS Code": () =>
      projectDir ? invoke("open_in_vscode", { path: projectDir }) : undefined,
    "Panel: Show Files": () => { setPanel("files"); setPanelOpen(true); },
    "Panel: Show Outline": () => { setPanel("outline"); setPanelOpen(true); },
    "Panel: Show Serial Monitor": () => { setPanel("serial"); setPanelOpen(true); },
    "Panel: Toggle Sidebar": () => setPanelOpen((v) => !v),
    "Build: Verify": () => verify(),
    "Build: Upload": () => upload(),
    "Build: Cancel": () => cancelTask(),
    "Build: Clean": () => projectTask(["run", "-t", "clean"], "cleaning"),
    "Build: Generate Compilation Database": async () => {
      if (await projectTask(["run", "-t", "compiledb"], "indexing") === 0) {
        try { await invoke("configure_language", {projectDir}); setLanguageRevision(n => n + 1); }
        catch (e) { log(`C++ configuration: ${e}`); }
      }
    },
    "Build: Static Analysis": () => projectTask(["check"], "analyzing"),
    "Build: Run Tests": () => projectTask(["test"], "testing"),
    "Project: Install Dependencies": () => projectTask(["pkg", "install"], "installing"),
    "Tools: Check Toolchain": async () => { revealOutput(); log(JSON.stringify(await invoke("toolchain_status"), null, 2)); },
    "C++: Restart Language Server": () => setLanguageRevision(n => n + 1),
    "Editor: Format Document": () => editorRef.current?.getAction("editor.action.formatDocument")?.run(),
    "Editor: Reload File from Disk": async () => {
      if (!active || (active.value !== active.saved && !await confirm("Discard edits and reload this file?", {kind:"warning"}))) return;
      try { const value = await invoke<string>("read_file", {path:active.abs}); setBuffers(bs => bs.map(b => b.abs === active.abs ? {...b, value, saved:value} : b)); }
      catch (e) { log(`Reload failed: ${e}`); }
    },
    "Panel: Show Problems": () => { setPanel("problems"); setPanelOpen(true); },
    "Device: Refresh Ports": () => scan(),
    "Device: Identify Chip": () => identify(),
    "Serial: Toggle Monitor": () => toggleSerial(),
    "Terminal: Toggle": () => toggleTerminal(),
    "Terminal: New": () => {
      setBottom("terminal");
      termOpenRef.current = true;
      setTimeout(() => actionsRef.current["Terminal: Restart Shell"]?.(), 0);
    },
    "Terminal: Restart Shell": () => startTerminal(resolveTerminalCwd()),
    "Output: Toggle": () => toggleOutput(),
  };

  const openFinder = useCallback(() => {
    setOverlay("finder");
    setOverlayQuery("");
    setOverlaySel(0);
    setOverlayItems([]);
  }, []);

  const openSearch = useCallback(() => {
    setOverlay("search");
    setOverlayQuery("");
    setOverlaySel(0);
    setOverlayItems([]);
  }, []);

  // -- palette: filter the command list as you type --
  useEffect(() => {
    if (overlay !== "palette") return;
    const q = overlayQuery.toLowerCase();
    setOverlayItems(
      commands
        .filter(([label]) => label.toLowerCase().includes(q))
        .map(([label, key]) => ({
          label,
          detail: key,
          run: () => actionsRef.current[label]?.(),
        }))
    );
    setOverlaySel(0);
  }, [overlay, overlayQuery, commands]);

  // -- finder / search: debounce a backend query --
  useEffect(() => {
    if (overlay !== "finder" && overlay !== "search") return;
    if (!projectDir) return;
    const q = overlayQuery;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        if (overlay === "finder") {
          const files = await invoke<string[]>("search_files", { root: projectDir, query: q });
          if (stale) return;
          setOverlayItems(
            files.slice(0, 200).map((f) => ({
              label: f.split("/").pop() ?? f,
              detail: f,
              run: () => openFile(`${projectDir}/${f}`, { pin: true }),
            }))
          );
        } else {
          if (q.trim().length < 2) {
            setOverlayItems([]);
            return;
          }
          const hits = await invoke<FileHit[]>("search_text", {
            root: projectDir,
            query: q,
            caseSensitive: false,
          });
          if (stale) return;
          setOverlayItems(
            hits.slice(0, 300).map((h) => ({
              label: h.text.trim().slice(0, 120),
              detail: `${h.path}:${h.line}`,
              run: async () => {
                await openFile(`${projectDir}/${h.path}`, { pin: true });
                setTimeout(() => gotoLine(h.line), 60);
              },
            }))
          );
        }
        setOverlaySel(0);
      } catch (e) {
        log(`search error: ${e}`);
      }
    }, overlay === "finder" ? 60 : 220);
    return () => { stale = true; clearTimeout(t); };
  }, [overlay, overlayQuery, projectDir, openFile, log]);

  useEffect(() => {
    if (overlay) setTimeout(() => overlayInputRef.current?.focus(), 0);
  }, [overlay]);

  // -- global keybindings, matching Zed's defaults --
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openPalette();
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        openFinder();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) saveAs();
        else if (e.altKey) saveAll();
        else saveActive();
      } else if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeRef.current) closeBuffer(activeRef.current);
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setPanelOpen((v) => !v);
      } else if (e.ctrlKey && e.key === "`") {
        // Zed: ⌃` toggles the terminal panel.
        e.preventDefault();
        actionsRef.current["Terminal: Toggle"]?.();
      } else if (e.key === "Escape" && overlay) {
        setOverlay(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, openPalette, openFinder, openSearch, active]);

  // ============================================================ build/upload ===

  /** The backend and this immediate ref both enforce one task at a time.
   * Upload uses a single incremental PlatformIO run; dependency tracking also
   * observes headers and files edited outside the open tabs. */
  async function projectTask(args: string[], label: string, needsPort = false): Promise<number | null> {
    if (taskLock.current || !projectDir || (needsPort && !port)) return -1;
    taskLock.current = true;
    cancelRequested.current = false;
    const restoreMonitor = (needsPort || args[0] === "test") && serialOpenRef.current;
    const monitorPort = port;
    setBusy(label);
    setProgress(null);
    setDiagnostics([]);
    revealOutput();
    const id = crypto.randomUUID();
    try {
      if (!await saveAll()) { log("Task stopped: a file could not be saved."); return -1; }
      const envs = await invoke<string[]>("project_environments", {projectDir});
      setEnvironments(envs);
      if (!envs.length) throw new Error("No [env:name] section in platformio.ini");
      const selected = envs.includes(environment) ? environment : envs[0];
      setEnvironment(selected);
      localStorage.setItem(`environment:${projectDir}`, selected);
      if (cancelRequested.current) { setBuildState("cancelled"); log("Task cancelled before starting."); return null; }
      if (needsPort || args[0] === "test") await stopSerial();
      await eventsReady.current;
      jobRef.current = {id, root:projectDir};
      const done = waitExit();
      const command = [...args, "-e", selected, ...(needsPort ? ["--upload-port", monitorPort] : [])];
      log(`\n--- ${label}: pio ${command.join(" ")} ---`);
      try {
        await invoke("cli_start", {cwd:projectDir, args:command, jobId:id});
        if (cancelRequested.current) await invoke("cli_cancel");
      }
      catch (e) { onCliExit(-1); throw e; }
      const code = await done;
      setBuildState(code === null ? "cancelled" : code === 0 ? "ok" : "err");
      log(code === 0 ? `✓ ${label} complete` : `✗ ${label} ${code === null ? "cancelled" : `failed (exit ${code})`}`);
      return code;
    } catch (e) { log(`${label}: ${e}`); setBuildState("err"); return -1; }
    finally {
      jobRef.current = null;
      exitResolver.current = null;
      if (restoreMonitor) {
        try { await invoke("serial_start", {port:monitorPort, baud}); setSerialOpen(true); }
        catch (e) { log(`Could not resume serial monitor: ${e}`); }
      }
      taskLock.current = false;
      setBusy(null); setProgress(null); setStatus("");
    }
  }

  function cancelTask() { cancelRequested.current = true; void invoke("cli_cancel").catch(e => log(`Cancel: ${e}`)); }

  async function verify() { await projectTask(["run"], "compiling"); }
  async function upload() { await projectTask(["run", "-t", "upload"], "uploading", true); }

  async function identify() {
    if (!port || taskLock.current) return;
    taskLock.current = true;
    const restore = serialOpenRef.current;
    await stopSerial();
    setBusy("identify chip");
    setProgress(null);
    setStatus(`probing ${port}…`);
    // Same rule as a build: pull the output forward if the terminal is up.
    revealOutput();
    log(`\n--- esptool chip-id on ${port} ---`);
    try {
      const c = await invoke<ChipInfo>("identify_chip", { port });
      setChip(c);
      log(c.output);
    } catch (e) {
      log(`identify error: ${e}`);
    } finally {
      if (restore) { try { await invoke("serial_start", {port, baud}); } catch (e) { log(`Serial resume: ${e}`); } }
      taskLock.current = false;
      setBusy(null);
      setStatus("");
    }
  }

  // ============================================================ serial monitor ===

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

  // ============================================================== render tree ===

  function GitPanel({projectDir}: {projectDir: string}) {
    const [status, setStatus] = useState<any>(null);
    const [log, setLog] = useState<any>(null);
    const [branches, setBranches] = useState<any>(null);
    const [remotes, setRemotes] = useState<any>(null);
    const [auth, setAuth] = useState<any>(null);
    const authChecked = useRef(false);
    const [msg, setMsg] = useState("");
    const [repoName, setRepoName] = useState("");
    const [privateRepo, setPrivateRepo] = useState(true);
    const [remoteUrl, setRemoteUrl] = useState("");
    const [remoteName, setRemoteName] = useState("origin");
    const [branchName, setBranchName] = useState("");
    async function refresh() {
      if (!projectDir) return;
      try { const s = await invoke("git_status", {projectDir}); setStatus(s); } catch {}
      try { const l = await invoke("git_log", {projectDir, limit: 30}); setLog(l); } catch {}
      try { const b = await invoke("git_branches", {projectDir}); setBranches(b); } catch {}
      try { const r = await invoke("git_remote_list", {projectDir}); setRemotes(r); } catch {}
      if (!authChecked.current) {
        authChecked.current = true;
        try { const a = await invoke("gh_auth_status"); setAuth(a); } catch(e:any){ setAuth({error: e.toString()}); }
      }
    }
    useEffect(() => { authChecked.current = false; refresh(); }, [projectDir]);
    async function addAll() { if (!projectDir) return; try { await invoke("git_add", {projectDir, paths: ["."]}); await refresh(); } catch {} }
    async function commit() { if (!projectDir || !msg.trim()) return; try { await invoke("git_commit", {projectDir, message: msg}); setMsg(""); await refresh(); } catch {} }
    async function init() { if (!projectDir) return; try { await invoke("git_init", {projectDir}); await refresh(); } catch {} }
    async function push() { if (!projectDir) return; try { const r:any = await invoke("git_push", {projectDir}); alert(r.output || r.error || JSON.stringify(r)); await refresh(); } catch(e:any){ alert(e.toString()); } }
    async function pull() { if (!projectDir) return; try { const r:any = await invoke("git_pull", {projectDir}); alert(r.output || r.error || JSON.stringify(r)); await refresh(); } catch(e:any){ alert(e.toString()); } }
    async function addRemote() { if (!projectDir || !remoteUrl.trim()) return; try { const r:any = await invoke("git_remote_add", {projectDir, name: remoteName, url: remoteUrl}); alert(r.output || r.error || JSON.stringify(r)); setRemoteUrl(""); await refresh(); } catch(e:any){ alert(e.toString()); } }
    async function publishToGitHub() { if (!projectDir || !repoName.trim()) return; try { const r:any = await invoke("gh_repo_create", {projectDir, name: repoName, private: privateRepo}); alert(r.output || r.error || JSON.stringify(r)); await refresh(); } catch(e:any){ alert(e.toString()); } }
    async function createRemoteOnly() { if (!projectDir || !repoName.trim()) return; try { const r:any = await invoke("gh_repo_create_remote", {projectDir, name: repoName, private: privateRepo}); alert(r.output || r.error || JSON.stringify(r)); await refresh(); } catch(e:any){ alert(e.toString()); } }
    async function checkout() { if (!projectDir || !branchName.trim()) return; try { const r:any = await invoke("git_checkout", {projectDir, branch: branchName, create: false}); alert(r.output || r.error || JSON.stringify(r)); setBranchName(""); await refresh(); } catch(e:any){ alert(e.toString()); } }
    return (
      <div style={{padding:8, fontSize:12, overflow:"auto", height:"100%"}}>
        <div style={{display:"flex", gap:4, marginBottom:8, flexWrap:"wrap"}}>
          <button onClick={refresh}>Refresh</button>
          <button onClick={addAll}>Stage All</button>
          <button onClick={init}>Init</button>
          <button onClick={push}>Push</button>
          <button onClick={pull}>Pull</button>
        </div>
        <div style={{color:"var(--text-hi)", marginBottom:4}}>Commit</div>
        <input value={msg} onChange={e=>setMsg(e.target.value)} placeholder="Commit message" style={{width:"100%", marginBottom:4}} />
        <button onClick={commit} disabled={!msg.trim()}>Commit</button>
        <div style={{marginTop:12, color:"var(--text-hi)"}}>GitHub</div>
        <div style={{fontSize:11, color:"var(--muted)", marginBottom:4}}>{auth?.output || auth?.error || "Checking auth..."}</div>
        <div style={{display:"flex", gap:4, marginBottom:4}}>
          <input value={repoName} onChange={e=>setRepoName(e.target.value)} placeholder="Repository name" style={{flex:1}} />
          <label style={{display:"flex", alignItems:"center", gap:2}}><input type="checkbox" checked={privateRepo} onChange={e=>setPrivateRepo(e.target.checked)} />Private</label>
        </div>
        <div style={{display:"flex", gap:4, flexWrap:"wrap"}}>
          <button onClick={publishToGitHub}>Publish to GitHub (create + push)</button>
          <button onClick={createRemoteOnly}>Create repo + add remote</button>
        </div>
        <div style={{marginTop:12, color:"var(--text-hi)"}}>Remotes</div>
        <pre style={{whiteSpace:"pre-wrap", fontSize:11}}>{remotes?.output || remotes?.error || "—"}</pre>
        <div style={{display:"flex", gap:4, marginBottom:4}}>
          <input value={remoteName} onChange={e=>setRemoteName(e.target.value)} placeholder="origin" style={{width:80}} />
          <input value={remoteUrl} onChange={e=>setRemoteUrl(e.target.value)} placeholder="https://github.com/user/repo.git" style={{flex:1}} />
          <button onClick={addRemote}>Add Remote</button>
        </div>
        <div style={{marginTop:12, color:"var(--text-hi)"}}>Branches</div>
        <div style={{display:"flex", gap:4, marginBottom:4}}>
          <input value={branchName} onChange={e=>setBranchName(e.target.value)} placeholder="branch name" style={{flex:1}} />
          <button onClick={checkout}>Checkout</button>
        </div>
        <pre style={{whiteSpace:"pre-wrap", fontSize:11}}>{branches?.output || branches?.error || "—"}</pre>
        <div style={{marginTop:12, color:"var(--text-hi)"}}>Status</div>
        <pre style={{whiteSpace:"pre-wrap", fontSize:11}}>{status?.output || status?.error || "—"}</pre>
        <div style={{marginTop:12, color:"var(--text-hi)"}}>Log</div>
        <pre style={{whiteSpace:"pre-wrap", fontSize:11}}>{log?.output || log?.error || "—"}</pre>
      </div>
    );
  }

  function DebugPanel({projectDir}: {projectDir: string}) {
    const [state, setState] = useState<any>(null);
    async function start() {
      if (!projectDir) return;
      try { const r = await invoke("debug_start", {projectDir}); setState(r); } catch(e:any){ setState({error: e.toString()}); }
    }
    async function stop() {
      try { const r = await invoke("debug_stop"); setState(r); } catch(e:any){ setState({error: e.toString()}); }
    }
    return (
      <div style={{padding:8, fontSize:12, overflow:"auto", height:"100%"}}>
        <div style={{display:"flex", gap:4, marginBottom:8}}>
          <button onClick={start}>Start (OpenOCD)</button>
          <button onClick={stop}>Stop</button>
        </div>
        <div style={{color:"var(--muted)", fontSize:11}}>ESP32 debugging requires a JTAG probe. Starts OpenOCD with a basic config.</div>
        <pre style={{whiteSpace:"pre-wrap", fontSize:11, marginTop:8}}>{state ? JSON.stringify(state, null, 2) : "—"}</pre>
      </div>
    );
  }

  function LibrariesPanel({projectDir}: {projectDir: string}) {
    const [q, setQ] = useState("");
    const [res, setRes] = useState<any>(null);
    async function search() {
      try { const r = await invoke("pio_library_search", {query: q}); setRes(r); } catch(e:any){ setRes({error: e.toString()}); }
    }
    async function install(lib: string) {
      if (!projectDir) return;
      try { const r = await invoke("pio_library_install", {projectDir, lib}); setRes(r); } catch(e:any){ setRes({error: e.toString()}); }
    }
    return (
      <div style={{padding:8, fontSize:12, overflow:"auto", height:"100%"}}>
        <div style={{display:"flex", gap:4, marginBottom:8}}>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search libraries..." style={{flex:1}} />
          <button onClick={search}>Search</button>
        </div>
        <div style={{color:"var(--muted)", fontSize:11, marginBottom:4}}>Search results (JSON from PlatformIO)</div>
        <pre style={{whiteSpace:"pre-wrap", fontSize:10, maxHeight:200, overflow:"auto"}}>{res?.output || res?.error || "—"}</pre>
        <input placeholder="Library name to install" style={{width:"100%", marginTop:8}} onKeyDown={e=>{ if(e.key==="Enter"){ const v=(e.target as HTMLInputElement).value; if(v){ install(v); (e.target as HTMLInputElement).value=""; }}}} />
      </div>
    );
  }

  function BoardsPanel() {
    const [res, setRes] = useState<any>(null);
    async function list() {
      try { const r = await invoke("pio_boards_list"); setRes(r); } catch(e:any){ setRes({error: e.toString()}); }
    }
    useEffect(() => { list(); }, []);
    return (
      <div style={{padding:8, fontSize:12, overflow:"auto", height:"100%"}}>
        <button onClick={list}>Refresh</button>
        <pre style={{whiteSpace:"pre-wrap", fontSize:10, marginTop:8}}>{res?.output || res?.error || "—"}</pre>
      </div>
    );
  }

  function renderNodes(nodes: FileNode[], depth: number) {
    return nodes.map((n) => {
      const kids = expanded[n.path];
      const isActive = active?.abs === n.path;
      const activeBuf = buffers.find((b) => b.abs === n.path);
      const dirty = activeBuf && activeBuf.value !== activeBuf.saved;
      return (
        <div key={n.path}>
          <div
            className={`tree-row${isActive ? " selected" : ""}${n.isDir ? " dir" : ""}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            title={n.path}
            onClick={() => (n.isDir ? toggleDir(n) : openFile(n.path, { preview: true }))}
            onDoubleClick={() => !n.isDir && openFile(n.path, { pin: true })}
          >
            <span className="twisty">{n.isDir ? (kids ? "▾" : "▸") : ""}</span>
            <span className="ico">{fileIcon(n.name, n.isDir)}</span>
            <span className={`nm${activeBuf?.preview ? " preview" : ""}`}>{n.name}</span>
            {dirty && <span className="dirty">●</span>}
          </div>
          {n.isDir && kids && renderNodes(kids, depth + 1)}
        </div>
      );
    });
  }

  const panelTitle =
    panel === "files" ? "Project" : panel === "outline" ? "Outline" : panel === "problems" ? "Problems" : panel === "serial" ? "Serial" : panel === "git" ? "Git" : panel === "debug" ? "Debug" : panel === "libraries" ? "Libraries" : "Boards";

  return (
    <div className="wrap" onMouseMove={(e) => e.stopPropagation()}>
      {/* ------------------------------------------------------------ title bar */}
      <div className="titlebar">
        <div className="menu">
          <button className="menu-btn" onClick={() => setMenuOpen(!menuOpen)}>
            File ▾
          </button>
          {menuOpen && (
            <>
              <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
              <div className="menu-drop">
                <button onClick={() => newProject()}>
                  New Project…<span className="accel">⇧⌘N</span>
                </button>
                <button onClick={openProject}>
                  Open Project…<span className="accel">⌘O</span>
                </button>
                <button onClick={newFile}>
                  New File…<span className="accel">⌘N</span>
                </button>
                <div className="menu-sep" />
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    saveActive();
                  }}
                >
                  Save<span className="accel">⌘S</span>
                </button>
                <button onClick={() => { setMenuOpen(false); saveAll(); }}>
                  Save All<span className="accel">⌥⌘S</span>
                </button>
                <button onClick={saveAs}>
                  Save As…<span className="accel">⇧⌘S</span>
                </button>
                <div className="menu-sep" />
                <button onClick={() => { setMenuOpen(false); openPalette(); }}>
                  Command Palette…<span className="accel">⇧⌘P</span>
                </button>
                <button onClick={() => { setMenuOpen(false); openFinder(); }}>
                  Go to File…<span className="accel">⌘P</span>
                </button>
                <button onClick={() => { setMenuOpen(false); openSearch(); }}>
                  Find in Project…<span className="accel">⇧⌘F</span>
                </button>
                {recents.length > 0 && (
                  <>
                    <div className="menu-sep" />
                    <div className="menu-label">Recent projects</div>
                    {recents.map((r) => (
                      <button
                        key={r}
                        className="menu-recent"
                        title={r}
                        onClick={() => {
                          setMenuOpen(false);
                          openProjectDir(r);
                        }}
                      >
                        {r.split("/").pop()}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <span className="brand">openplatform-ide</span>
        <span className="sub">{projectDir ? baseName(projectDir) : "no project"}</span>

        <div className="actions">
          <button onClick={scan} title="Refresh serial ports">⟳</button>
          <select aria-label="Build environment" value={environment} disabled={!!busy} onChange={e => { setEnvironment(e.target.value); localStorage.setItem(`environment:${projectDir}`, e.target.value); }}>
            {environments.map(env => <option key={env} value={env}>{env}</option>)}
          </select>
          <select aria-label="Serial port" disabled={!!busy || serialOpen} value={port} onChange={(e) => setPort(e.target.value)}>
            <option value="">— port —</option>
            {ports.map((p) => (
              <option key={p.address} value={p.address}>
                {p.address}
                {p.isUsb ? ` [${p.vid}:${p.pid}${p.product ? " " + p.product : ""}]` : ""}
              </option>
            ))}
          </select>
          <button onClick={identify} disabled={!port || !!busy}>
            {busy === "identify chip" ? "probing…" : "Identify"}
          </button>
          <button onClick={verify} disabled={!!busy || !projectDir}>
            {busy === "compiling" ? "compiling…" : "✓ Verify"}
          </button>
          <button onClick={upload} disabled={!port || !!busy || !projectDir}>
            {busy === "uploading" || busy === "compiling" ? "working…" : "↑ Upload"}
          </button>
          {busy && busy !== "identify chip" && <button onClick={cancelTask} title="Cancel task">■ Stop</button>}
          <button onClick={openPalette} title="Command palette">⌘</button>
        </div>
      </div>

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

      {/* ---------------------------------------------------------- workspace */}
      <div className="workspace">
        <div className="activity-bar">
          <button
            className={panelOpen && panel === "files" ? "active" : ""}
            title="Project files"
            onClick={() => { setPanel("files"); setPanelOpen(true); }}
          >
            ▤
          </button>
          <button
            className={panelOpen && panel === "outline" ? "active" : ""}
            title="Outline"
            onClick={() => { setPanel("outline"); setPanelOpen(true); }}
          >
            ≡
          </button>
          <button
            className={panelOpen && panel === "serial" ? "active" : ""}
            title="Serial monitor"
            onClick={() => { setPanel("serial"); setPanelOpen(true); }}
          >
            ⌁
          </button>
          <button title={`Problems (${diagnostics.length})`} onClick={() => { setPanel("problems"); setPanelOpen(true); }}>!</button>
          <button className={panelOpen && panel === "git" ? "active" : ""} title="Git" onClick={() => { setPanel("git"); setPanelOpen(true); }}>⎇</button>
          <button className={panelOpen && panel === "debug" ? "active" : ""} title="Debug" onClick={() => { setPanel("debug"); setPanelOpen(true); }}>🐞</button>
          <button className={panelOpen && panel === "libraries" ? "active" : ""} title="Libraries" onClick={() => { setPanel("libraries"); setPanelOpen(true); }}>📚</button>
          <button className={panelOpen && panel === "boards" ? "active" : ""} title="Boards" onClick={() => { setPanel("boards"); setPanelOpen(true); }}>▦</button>
          <span className="rail-spacer" />
          <button
            className={outOpen ? "active" : ""}
            title="Build & upload output"
            onClick={toggleOutput}
          >
            ⧉
          </button>
          <button
            className={termOpen ? "active" : ""}
            title="Terminal (⌃`)"
            onClick={toggleTerminal}
          >
            &gt;_
          </button>
          <button title="Command palette (⇧⌘P)" onClick={openPalette}>⌘</button>
        </div>

        {panelOpen && (
          <>
            <div className="dock" style={{ flex: `0 0 ${panelWidth}px`, width: panelWidth }}>
              <div className="dock-head">
                <span>{panelTitle}</span>
                <span className="spacer" />
                {panel === "files" && (
                  <>
                    <button title="New file" onClick={newFile}>＋</button>
                    <button title="Refresh" onClick={() => refreshTree(projectDir)}>⟳</button>
                  </>
                )}
                {panel === "serial" && (
                  <button title="Clear" onClick={() => setSerialText("")}>clear</button>
                )}
                <button title="Hide panel (⌘B)" onClick={() => setPanelOpen(false)}>✕</button>
              </div>

              <div className="dock-body">
                {panel === "files" &&
                  (treeRoot.length ? (
                    <div className="tree">{renderNodes(treeRoot, 0)}</div>
                  ) : (
                    <div className="tree-empty">No project open.</div>
                  ))}

                {panel === "outline" &&
                  (outline.length ? (
                    outline.map((s, i) => (
                      <div className="outline-row" key={`${s.name}-${i}`} onClick={() => gotoLine(s.line)}>
                        <span className="kind">{s.kind}</span>
                        <span className="nm">{s.name}</span>
                        <span className="ln">{s.line}</span>
                      </div>
                    ))
                  ) : (
                    <div className="tree-empty">
                      {active ? "No symbols found." : "No file open."}
                    </div>
                  ))}

                {panel === "problems" && (diagnostics.length ? diagnostics.map((d, i) => (
                  <div className="outline-row" key={i} title={d.message} onClick={async () => { await openFile(d.path, {pin:true}); setTimeout(() => gotoLine(d.line), 80); }}>
                    <span className="kind">{d.severity}</span><span className="nm">{baseName(d.path)}:{d.line} — {d.message}</span>
                  </div>
                )) : <div className="tree-empty">No compiler diagnostics. Verify to check the project.</div>)}
                {panel === "git" && <GitPanel projectDir={projectDir} />}
                {panel === "debug" && <DebugPanel projectDir={projectDir} />}
                {panel === "libraries" && <LibrariesPanel projectDir={projectDir} />}
                {panel === "boards" && <BoardsPanel />}
                {panel === "serial" && (
                  <div className="serial-panel">
                    <div className="serial-tools">
                      <select
                        value={baud}
                        onChange={(e) => setBaud(Number(e.target.value))}
                        disabled={serialOpen}
                      >
                        {[9600, 19200, 57600, 115200, 230400].map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                      <button onClick={toggleSerial} disabled={!serialOpen && (!port || !!busy)}>
                        {serialOpen ? "■ Stop" : "▷ Start"}
                      </button>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>
                        {serialOpen ? `● ${port}` : "○ stopped"}
                      </span>
                    </div>
                    <form onSubmit={async e => { e.preventDefault(); try { await invoke("serial_write", {data:serialInput + lineEnding}); setSerialInput(""); } catch (error) { log(`Serial send: ${error}`); } }}>
                      <input aria-label="Serial message" placeholder="Send to board…" value={serialInput} onChange={e => setSerialInput(e.target.value)} disabled={!serialOpen} />
                      <select aria-label="Line ending" value={lineEnding} onChange={e => setLineEnding(e.target.value)}><option value="">None</option><option value={"\n"}>LF</option><option value={"\r\n"}>CRLF</option></select>
                      <button disabled={!serialOpen} type="submit">Send</button>
                    </form>
                    <pre ref={serRef} className="serial">{serialText || "—"}</pre>
                  </div>
                )}
              </div>
            </div>
            <div
              className="dock-splitter"
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = panelWidth;
                const move = (ev: MouseEvent) => {
                  const w = Math.max(160, Math.min(520, startW + ev.clientX - startX));
                  setPanelWidth(w);
                };
                const up = () => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                };
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              }}
            />
          </>
        )}

        {/* ------------------------------------------------------------ pane */}
        <div className="pane">
          <div className="tabbar">
            {buffers.map((b) => (
              <button
                key={b.path}
                className={`tab${b.path === activePath ? " active" : ""}${b.preview ? " preview" : ""}`}
                title={b.path}
                onClick={() => setActivePath(b.path)}
                onDoubleClick={() =>
                  setBuffers((bs) => bs.map((x) => (x.path === b.path ? { ...x, preview: false } : x)))
                }
              >
                <span className="tab-name">{baseName(b.path)}</span>
                {b.value !== b.saved && <span className="dirty">●</span>}
                <span
                  className="close"
                  onClick={(e) => { e.stopPropagation(); closeBuffer(b.path); }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>

          {active ? (
            <>
              <div className="breadcrumbs">
                {active.path.split("/").map((part, i, all) => (
                  <span key={i}>
                    <span className="crumb">{part}</span>
                    {i < all.length - 1 && <span className="sep"> › </span>}
                  </span>
                ))}
              </div>
              <div className="editor-host">
                <Editor
                  height="100%"
                  language={activeLang}
                  theme="vs-dark"
                  value={activeValue}
                  path={monaco.Uri.file(active.abs).toString()}
                  keepCurrentModel
                  onChange={(v) => updateActive(v ?? "")}
                  onMount={(ed) => {
                    editorRef.current = ed;
                    ed.onDidChangeCursorPosition((e) =>
                      setCursor({ line: e.position.lineNumber, col: e.position.column })
                    );
                  }}
                  options={{
                    fontSize: 13,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                    minimap: { enabled: false },
                    wordWrap: "on",
                    automaticLayout: true,
                    renderLineHighlight: "all",
                    scrollBeyondLastLine: false,
                    fontLigatures: true,
                    smoothScrolling: true,
                    cursorBlinking: "smooth",
                    guides: { indentation: true, bracketPairs: true },
                    bracketPairColorization: { enabled: true },
                    stickyScroll: { enabled: true },
                    inlayHints: { enabled: "on" },
                    renderWhitespace: "selection",
                    padding: { top: 8 },
                  }}
                />
              </div>
            </>
          ) : (
            <div className="pane-empty">
              <div style={{ fontSize: 15, color: "var(--text-hi)" }}>openplatform-ide</div>
              <div>No file open — pick one from the Project panel.</div>
              <div>
                <kbd>⌘P</kbd> go to file &nbsp; <kbd>⇧⌘P</kbd> commands &nbsp;{" "}
                <kbd>⇧⌘F</kbd> find in project
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------- bottom dock: terminal */}
      {/*
        Kept mounted at all times and hidden with CSS when another bottom view
        is active. Unmounting it would orphan xterm's DOM node: `term.element`
        stays set, so a later `term.open()` is skipped and the freshly mounted
        host div renders empty — the "blank terminal after toggling" bug.
      */}
      <div
        className={`bottom-dock terminal-dock${termOpen ? "" : " hidden"}`}
        aria-hidden={!termOpen}
      >
        <div className="dock-head">
          <span>Terminal</span>
          {termCwd && <span className="term-cwd" title={termCwd}>{`'${termCwd}'`}</span>}
          <span className="spacer" />
          <button title="New terminal in project" onClick={() => startTerminal()}>＋</button>
          <button title="Restart shell" onClick={() => startTerminal(termCwd || undefined)}>⟳</button>
          <button title="Hide terminal (⌃`)" onClick={() => setBottom(null)}>✕</button>
        </div>
        <div
          className="terminal-host"
          ref={termHostRef}
          onMouseDown={() => termRef.current?.focus()}
        />
      </div>

      {/* ------------------------------------- bottom dock: build & upload output */}
      {outOpen && (
        <div className="bottom-dock output-dock">
          <div className="dock-head">
            <span>Output</span>
            {busy && <span className="tag">● {busy}</span>}
            <span className="spacer" />
            <button onClick={() => setOut([])}>clear</button>
            <button title="Hide output" onClick={() => setBottom(null)}>✕</button>
          </div>
          <pre ref={logRef} className="out">{out.length ? out.join("\n") : "Ready."}</pre>
        </div>
      )}

      {/* ---------------------------------------------------------- status bar */}
      <div className="statusbar">
        <span
          className={`sb-item click ${buildState === "ok" ? "ok" : buildState === "err" ? "err" : ""}`}
          onClick={toggleOutput}
          title="Build & upload output"
        >
          {buildState === "idle" ? "○ ready" : buildState === "ok" ? "✓ ok" : buildState === "cancelled" ? "○ cancelled" : "✗ failed"}
          {busy ? ` · ${busy}` : ""}
        </span>
        <span className="sb-item click" onClick={() => { setPanel("serial"); setPanelOpen(true); }}>
          {serialOpen ? `● ${port} @ ${baud}` : `○ ${port || "no port"}`}
        </span>
        <span className="sb-item click" onClick={toggleOutput} title="Output">
          {outOpen ? "▾ output" : "▸ output"}
        </span>
        <span className="sb-item click" onClick={toggleTerminal} title="Terminal (⌃`)">
          {termOpen ? "▾ terminal" : "▸ terminal"}
        </span>
        <span className="spacer" />
        {active && (
          <>
            <span className="sb-item">{active.path}</span>
            <span className="sb-item">{activeLang}</span>
            <span className="sb-item">Ln {cursor.line}, Col {cursor.col}</span>
          </>
        )}
        <span className="sb-item click" title="Restart C++ language server" onClick={() => setLanguageRevision(n => n + 1)}>{languageStatus}</span>
      </div>

      {/* -------------------------------------------------------- modal_layer */}
      {overlay && (
        <div className="overlay" onClick={() => setOverlay(null)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              ref={overlayInputRef}
              value={overlayQuery}
              placeholder={
                overlay === "palette"
                  ? "Run a command…"
                  : overlay === "finder"
                  ? "Go to file…"
                  : "Find in project…"
              }
              onChange={(e) => setOverlayQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setOverlaySel((s) => Math.min(s + 1, overlayItems.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setOverlaySel((s) => Math.max(s - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const it = overlayItems[overlaySel];
                  if (it) {
                    setOverlay(null);
                    it.run();
                  }
                }
              }}
            />
            <div className="palette-list">
              {overlayItems.length === 0 ? (
                <div className="palette-empty">
                  {overlay === "search" && overlayQuery.trim().length < 2
                    ? "Type at least two characters."
                    : "No matches."}
                </div>
              ) : (
                overlayItems.map((it, i) => (
                  <div
                    key={`${it.label}-${it.detail ?? i}`}
                    className={`palette-item${i === overlaySel ? " sel" : ""}`}
                    onMouseEnter={() => setOverlaySel(i)}
                    onClick={() => {
                      setOverlay(null);
                      it.run();
                    }}
                  >
                    <span className="label">{it.label}</span>
                    {it.detail && <span className="detail">{it.detail}</span>}
                  </div>
                ))
              )}
            </div>
            <div className="palette-foot">
              <span>↑↓ navigate</span>
              <span>↵ select</span>
              <span>esc close</span>
              <span style={{ flex: 1 }} />
              <span>{overlayItems.length} results</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
