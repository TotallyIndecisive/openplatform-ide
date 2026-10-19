import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loader, Editor } from "@monaco-editor/react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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

function djb2(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
  }
  return h.toString(36);
}

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
  const [lastCompiledKey, setLastCompiledKey] = useState<string | null>(null);

  // --- workspace: buffers (tabs), tree, panel, overlays ---
  const [buffers, setBuffers] = useState<Buffer[]>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [treeRoot, setTreeRoot] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileNode[]>>({});
  const [panel, setPanel] = useState<"files" | "outline" | "serial">("files");
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(240);
  const [outline, setOutline] = useState<Symbol[]>([]);
  const [overlay, setOverlay] = useState<null | "palette" | "finder" | "search">(null);
  const [overlayQuery, setOverlayQuery] = useState("");
  const [overlaySel, setOverlaySel] = useState(0);
  const [overlayItems, setOverlayItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [buildState, setBuildState] = useState<"idle" | "ok" | "err">("idle");

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
  const termStartRef = useRef<((cwd?: string) => void) | null>(null);
  const homeDirRef = useRef<string>("");

  activeRef.current = activePath;
  buffersRef.current = buffers;
  // cli-exit handoff: lets sequential steps (compile -> upload) await completion
  // without a race between `invoke` resolving and the exit event arriving.
  const exitResolver = useRef<((code: number | null) => void) | null>(null);
  const pendingExit = useRef<number | null | undefined>(undefined);

  const log = useCallback(
    (s: string) => setOut((o) => [...o, ...(Array.isArray(s) ? s : [s])]),
    []
  );

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

  const active = buffers.find((b) => b.path === activePath) ?? null;
  const activeValue = active?.value ?? "";
  const activeLang = active?.language ?? "cpp";

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
        setBuildState(e.payload.code === 0 ? "ok" : "err");
        log(`\n[exit ${e.payload.code}] pio ${e.payload.args.join(" ")}`);
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
    scan();
    loadRecents();
    invoke<{ projectDir?: string; home: string; esptool?: string }>("app_paths")
      .then((p) => {
        homeDirRef.current = p.home;
        openProjectDir(p.projectDir ?? `${p.home}/.openplatform-ide/projects/BlinkPIO`);
      })
      .catch((e) => log(`app_paths error: ${e}`));
    return () => {
      Promise.all(offs).then((fs) => fs.forEach((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [out]);
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
      // Attach before spawning so no early output is lost.
      if (termHostRef.current && !term.element) {
        term.open(termHostRef.current);
      }
      try { fit?.fit(); } catch { /* host not laid out yet */ }
      const cols = term.cols || 80;
      const rows = term.rows || 24;
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
      if (next === "terminal") {
        // Defer until the host div is mounted, then open + spawn.
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
    setBottom((cur) => (cur === "terminal" ? "output" : cur));
  }, []);

  // While the panel is visible, keep xterm sized to its container.
  useEffect(() => {
    if (!termOpen) return;
    const el = termHostRef.current;
    if (!el) return;
    const term = ensureTerminal();
    if (!term.element) term.open(el);
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
      const rel = projectDir && abs.startsWith(projectDir)
        ? abs.slice(projectDir.length).replace(/^\//, "")
        : baseName(abs);
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
      setProjectDir(dir);
      setActivePath("");
      setExpanded({});
      setOutline([]);
      setLastCompiledKey(null);

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

      buffersRef.current = initial;
      setBuffers(initial);
      setActivePath(initial[initial.length - 1]?.path ?? "");

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

  const closeBuffer = useCallback((path: string) => {
    setBuffers((bs) => {
      const idx = bs.findIndex((b) => b.path === path);
      const next = bs.filter((b) => b.path !== path);
      if (path === activeRef.current) {
        const fallback = next[Math.min(idx, next.length - 1)];
        setActivePath(fallback?.path ?? "");
      }
      return next;
    });
  }, []);

  // ---- outline for the active buffer (declaration scan) ----
  useEffect(() => {
    if (panel !== "outline" || !active || active.language !== "cpp") {
      setOutline([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      invoke<Symbol[]>("document_symbols", { path: active.abs })
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
      await invoke("write_file", { path: b.abs, content: b.value });
      setBuffers((bs) =>
        bs.map((x) => (x.path === b.path ? { ...x, saved: x.value, preview: false } : x))
      );
      return true;
    } catch (e) {
      log(`save error: ${e}`);
      return false;
    }
  }

  async function saveAll() {
    for (const b of buffersRef.current) {
      if (b.value !== b.saved) await saveBuffer(b);
    }
    log("✓ Saved");
  }

  async function saveActive() {
    const b = buffersRef.current.find((x) => x.path === activeRef.current);
    if (b) await saveBuffer(b);
  }

  /** File ▸ New Project — pick a folder, scaffold a PlatformIO project there. */
  async function newProject() {
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
        platformioIni: DEFAULT_PIO_INI,
        srcContent: DEFAULT_SRC,
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
      await invoke("write_file", { path: dest, content: "" });
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
    "File: New Project": newProject,
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
    const t = setTimeout(async () => {
      try {
        if (overlay === "finder") {
          const files = await invoke<string[]>("search_files", { root: projectDir, query: q });
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
    return () => clearTimeout(t);
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

  /** Run one pio invocation; resolves with its exit code. */
  async function runCli(
    args: string[],
    cwd: string,
    label: string,
    prefix?: string
  ): Promise<number | null> {
    if (serialOpen) await stopSerial();
    setBusy(label);
    setProgress(null);
    setStatus("");
    // A compile/upload is starting: if the terminal is showing, swap to output.
    revealOutput();
    if (prefix) log(`\n--- ${prefix} ---`);
    const done = waitExit();
    try {
      await invoke("cli_start", { cwd, args });
    } catch (e) {
      log(`${label} error: ${e}`);
      exitResolver.current = null;
      setBusy(null);
      return -1;
    }
    return done;
  }

  /** cwd for pio. The project dir is authoritative; buffers are relative to it. */
  const pioDir = projectDir;
  const sourceText = useMemo(
    () => buffers.map((b) => `${b.path}\u0000${b.value}`).join("\u0001"),
    [buffers]
  );

  async function verify() {
    if (busy || !pioDir) return;
    await saveAll();
    const code = await runCli(["run"], pioDir, "compiling", `Verify (build) ${pioDir}`);
    if (code === 0) {
      setLastCompiledKey(`${djb2(sourceText)}|pio|${pioDir}`);
      setBuildState("ok");
      log("✓ Verify OK");
    } else {
      setLastCompiledKey(null);
      setBuildState("err");
      log(`✗ Verify failed (exit ${code})`);
    }
  }

  async function upload() {
    if (busy || !port || !pioDir) return;
    await saveAll();
    const key = `${djb2(sourceText)}|pio|${pioDir}`;
    if (lastCompiledKey !== key) {
      const c = await runCli(["run"], pioDir, "compiling", `Compile ${pioDir}`);
      if (c !== 0) {
        setLastCompiledKey(null);
        setBuildState("err");
        log(`✗ Compile failed (exit ${c}) — not uploading.`);
        return;
      }
      setLastCompiledKey(key);
      log("✓ Compiled. Uploading…");
    } else {
      log("✓ Using cached build. Uploading…");
    }
    const u = await runCli(
      ["run", "-t", "upload", "--upload-port", port],
      pioDir,
      "uploading",
      `Upload → ${port}`
    );
    setBuildState(u === 0 ? "ok" : "err");
    log(u === 0 ? "✓ Upload OK — the board is running." : `✗ Upload failed (exit ${u})`);
  }

  async function identify() {
    if (!port || busy) return;
    if (serialOpen) await stopSerial();
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

  function renderNodes(nodes: FileNode[], depth: number) {
    return nodes.map((n) => {
      const kids = expanded[n.path];
      const isActive = activePath === n.path;
      const activeBuf = buffers.find((b) => b.path === n.path);
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
    panel === "files" ? "Project" : panel === "outline" ? "Outline" : "Serial";

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
                <button onClick={newProject}>
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
          <select value={port} onChange={(e) => setPort(e.target.value)}>
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
          <button onClick={verify} disabled={!!busy}>
            {busy === "compiling" ? "compiling…" : "✓ Verify"}
          </button>
          <button onClick={upload} disabled={!port || !!busy}>
            {busy === "uploading" || busy === "compiling" ? "working…" : "↑ Upload"}
          </button>
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
                      <button onClick={toggleSerial} disabled={!port || !!busy}>
                        {serialOpen ? "■ Stop" : "▷ Start"}
                      </button>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>
                        {serialOpen ? `● ${port}` : "○ stopped"}
                      </span>
                    </div>
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
                  path={active.path}
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
      {termOpen && (
        <div className="bottom-dock terminal-dock">
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
      )}

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
          {buildState === "idle" ? "○ ready" : buildState === "ok" ? "✓ ok" : "✗ failed"}
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
        <span className="sb-item">openplatform-ide</span>
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
