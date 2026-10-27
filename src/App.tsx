import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { installNativeMenu } from "./nativeMenu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { connectLanguage } from "./language";
import { parseDiagnostic, type BuildDiagnostic } from "./diagnostics";
import { listen } from "@tauri-apps/api/event";
import { loader, Editor } from "@monaco-editor/react";
import {
  open as openDialog,
  save as saveDialog,
  confirm,
} from "@tauri-apps/plugin-dialog";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./App.css";
import { Icon } from "./Icons";
import {
  DebugPanel,
  LibrariesPanel,
  BoardsPanel,
} from "./WorkspacePanels";
import { dockItems, usePreferences } from "./preferences";
import { GitPanel } from "./SourceControl";
import { AccountsSettings } from "./AccountsSettings";

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
  path: string; // workspace-relative, e.g. "src/main.cpp"
  abs: string; // absolute path on disk
  language: string;
  value: string;
  saved: string; // last value written to disk (drives the dirty dot)
  preview?: boolean; // Zed's preview tab: replaced on the next single click
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");
const MAX_SERIAL = 20000;

/** Extension → Monaco language. Only what a PlatformIO project needs. */
function languageFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "c":
    case "cc":
    case "cpp":
    case "cxx":
    case "h":
    case "hh":
    case "hpp":
    case "hxx":
    case "ino":
    case "s":
      return "cpp";
    case "py":
      return "python";
    case "json":
      return "json";
    case "ini":
    case "cfg":
    case "conf":
      return "ini";
    case "md":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "xml":
      return "xml";
    case "js":
      return "javascript";
    case "ts":
      return "typescript";
    case "sh":
      return "shell";
    default:
      return "plaintext";
  }
}

function baseName(p: string) {
  return p.split("/").pop() ?? p;
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
  const jobRef = useRef<{ id: string; root: string } | null>(null);
  const eventsReady = useRef<Promise<unknown>>(Promise.resolve());
  const serialOpenRef = useRef(false);
  serialOpenRef.current = serialOpen;

  // --- workspace: buffers (tabs), tree, panel, overlays ---
  const [buffers, setBuffers] = useState<Buffer[]>([]);
  const [activePath, setActivePath] = useState<string>("");
  const [treeRoot, setTreeRoot] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileNode[]>>({});
  const [panel, setPanel] = useState<
    | "home"
    | "files"
    | "outline"
    | "git"
    | "debug"
    | "libraries"
    | "boards"
    | "settings"
  >("files");
  const [panelOpen, setPanelOpen] = useState(false);
  const [outline, setOutline] = useState<Symbol[]>([]);
  const [overlay, setOverlay] = useState<
    null | "palette" | "finder" | "search"
  >(null);
  const [overlayQuery, setOverlayQuery] = useState("");
  const [overlaySel, setOverlaySel] = useState(0);
  const [overlayItems, setOverlayItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [buildState, setBuildState] = useState<
    "idle" | "ok" | "err" | "cancelled"
  >("idle");

  const [termOpen, setTermOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightTab, setRightTab] = useState<"serial" | "output" | "problems">(
    "serial",
  );
  const outOpen = rightOpen && rightTab === "output";
  const [bottomExpanded, setBottomExpanded] = useState(false);
  const [preferences, setPreferences] = usePreferences();
  const [branch, setBranch] = useState("");
  const [shellName, setShellName] = useState("shell");
  const refreshBranch = useCallback(async () => {
    if (!projectDir) {
      setBranch("");
      return;
    }
    try {
      const result = await invoke<{ success: boolean; output: string }>(
        "git_status",
        { projectDir },
      );
      setBranch(
        result.success ? (result.output.replace(/^## (?:No commits yet on |Initial commit on )/, "## ").match(/^## (.+?)(?:\.\.\.|\n|$)/)?.[1] ?? "") : "",
      );
    } catch {
      setBranch("");
    }
  }, [projectDir]);
  useEffect(() => {
    void refreshBranch();
  }, [refreshBranch]);
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
    [],
  );

  function onCliExit(code: number | null) {
    if (exitResolver.current) {
      const r = exitResolver.current;
      exitResolver.current = null;
      r(code);
    }
  }

  function waitExit(): Promise<number | null> {
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
      setPort((cur) =>
        p.some((x) => x.address === cur) ? cur : usb?.address || "",
      );
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
      listen("app-exit-requested", () => {
        void getCurrentWindow().close();
      }),
    );
    offs.push(
      listen<{ jobId: string; stream: string; line: string }>(
        "cli-output",
        (e) => {
          if (e.payload.jobId !== jobRef.current?.id) return;
          const line = stripAnsi(e.payload.line);
          setOut((o) => [...o, line].slice(-3000));
          const diagnostic = parseDiagnostic(line, jobRef.current.root);
          if (diagnostic)
            setDiagnostics((ds) => [...ds, diagnostic].slice(-1000));
          if (line.trim()) setStatus(line.trim().slice(0, 140));
          // esptool reports flashing progress as: `Writing at 0x00010000... (42 %)`
          const m = line.match(/(?:\(|\s)(\d+(?:\.\d+)?)\s*%/);
          if (m) setProgress(Number(m[1]));
          else if (/Hash of data verified/i.test(line)) setProgress(100);
        },
      ),
    );
    offs.push(
      listen<{
        jobId: string;
        code: number | null;
        args: string[];
        cancelled: boolean;
        elapsedMs: number;
      }>("cli-exit", (e) => {
        if (e.payload.jobId !== jobRef.current?.id) return;
        setProgress(null);
        setStatus("");
        setBuildState(
          e.payload.cancelled
            ? "cancelled"
            : e.payload.code === 0
              ? "ok"
              : "err",
        );
        log(
          `\n[${e.payload.cancelled ? "cancelled" : `exit ${e.payload.code}`} · ${(e.payload.elapsedMs / 1000).toFixed(2)}s] pio ${e.payload.args.join(" ")}`,
        );
        onCliExit(e.payload.code);
      }),
    );
    offs.push(
      listen<{ data: string }>("serial-data", (e) => {
        setSerialText((t) => {
          const next = t + e.payload.data;
          return next.length > MAX_SERIAL ? next.slice(-MAX_SERIAL) : next;
        });
      }),
    );
    offs.push(
      listen<{ open: boolean; port: string; message: string }>(
        "serial-status",
        (e) => {
          setSerialOpen(e.payload.open);
          log(`[serial] ${e.payload.message}`);
        },
      ),
    );
    offs.push(
      listen<{ data: string }>("terminal-data", (e) => {
        termRef.current?.write(e.payload.data);
      }),
    );
    offs.push(
      listen<{ open: boolean; cwd: string; shell: string; message: string }>(
        "terminal-status",
        (e) => {
          if (e.payload.open) {
            setTermCwd(e.payload.cwd);
            setShellName(baseName(e.payload.shell));
          }
          log(`[terminal] ${e.payload.message}`);
        },
      ),
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
        background: "#ffffff",
        foreground: "#26364d",
        cursor: "#008b87",
        selectionBackground: "#d6eeec",
        black: "#26364d",
        red: "#c34242",
        green: "#20805b",
        yellow: "#9b701d",
        blue: "#286fc5",
        magenta: "#8952c7",
        cyan: "#008b87",
        white: "#dce2e8",
        brightBlack: "#7f848e",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#e5c07b",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#d7dae0",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Keystrokes go straight to the child's stdin.
    term.onData((d) => {
      invoke("terminal_write", { data: d }).catch(() => {});
    });
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
      try {
        fit?.fit();
      } catch {
        /* host not laid out yet */
      }
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      termStartedRef.current = true;
      try {
        const used = await invoke<string>("terminal_start", {
          cwd: dir,
          cols,
          rows,
        });
        setTermCwd(used);
      } catch (e) {
        term.writeln(`\x1b[31mfailed to start terminal: ${e}\x1b[0m`);
        log(`terminal_start error: ${e}`);
      }
    },
    [ensureTerminal, resolveTerminalCwd, log],
  );
  termStartRef.current = startTerminal;

  const toggleTerminal = useCallback(() => setTermOpen((open) => !open), []);
  const toggleOutput = useCallback(() => {
    setRightOpen((open) => (rightTab === "output" ? !open : true));
    setRightTab("output");
  }, [rightTab]);
  const revealOutput = useCallback(() => {
    setRightTab("output");
    setRightOpen(true);
  }, []);
  useEffect(() => {
    termOpenRef.current = termOpen;
    if (termOpen && projectDir && !termStartedRef.current) {
      termStartedRef.current = true;
      void eventsReady.current.then(() => termStartRef.current?.());
    }
  }, [termOpen, projectDir]);

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
          invoke("terminal_resize", { cols: term.cols, rows: term.rows }).catch(
            () => {},
          );
        }
      } catch {
        /* ignore transient layout */
      }
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
    [log],
  );

  /** Zed's preview tab: a single click opens italic and is replaced by the
   *  next preview; typing (or double-click) promotes it to a pinned tab. */
  const openFile = useCallback(
    async (abs: string, opts: { preview?: boolean; pin?: boolean } = {}) => {
      const rel =
        projectDir && abs.startsWith(projectDir + "/")
          ? abs.slice(projectDir.length + 1)
          : abs;
      const existing = buffersRef.current.find((b) => b.path === rel);
      if (existing) {
        if (opts.pin) {
          setBuffers((bs) =>
            bs.map((b) => (b.path === rel ? { ...b, preview: false } : b)),
          );
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
    [projectDir, log],
  );

  /** Load a PlatformIO project: reset buffers, then open ini + main.cpp. */
  const openProjectDir = useCallback(
    async (dir: string) => {
      if (taskLock.current) {
        log("Wait for the running task before switching projects.");
        return;
      }
      if (
        buffersRef.current.some((b) => b.value !== b.saved) &&
        !(await confirm("Discard unsaved edits and switch projects?", {
          title: "Unsaved files",
          kind: "warning",
        }))
      )
        return;
      try {
        await invoke("read_file", { path: `${dir}/platformio.ini` });
      } catch (e) {
        log(`Open failed: ${e}`);
        return;
      }

      // Read everything before touching state, so the reset and the initial
      // tabs land in one commit instead of racing each other.
      const initial: Buffer[] = [];
      for (const rel of [DEFAULT_SRC_PATH, DEFAULT_INI_PATH]) {
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
        const drafts: Buffer[] = JSON.parse(
          localStorage.getItem(`drafts:${dir}`) ?? "[]",
        );
        for (const draft of drafts) {
          if (!draft.abs?.startsWith(dir + "/") || draft.value === draft.saved)
            continue;
          const index = initial.findIndex((b) => b.abs === draft.abs);
          // Keep the original disk baseline so a concurrent external edit is
          // detected by Save, rather than silently overwritten by recovery.
          if (index >= 0) initial[index] = { ...draft, preview: false };
          else initial.push({ ...draft, preview: false });
        }
        if (drafts.length) log("Recovered unsaved editor drafts.");
      } catch {
        /* A corrupt recovery record must not prevent opening a project. */
      }
      setPanelOpen(false);
      setProjectDir(dir);
      setExpanded({});
      setOutline([]);
      setDiagnostics([]);
      buffersRef.current = initial;
      setBuffers(initial);
      setActivePath(initial.find(b => b.path === DEFAULT_SRC_PATH)?.path ?? initial[0]?.path ?? "");

      try {
        const envs = await invoke<string[]>("project_environments", {
          projectDir: dir,
        });
        setEnvironments(envs);
        const savedEnv = localStorage.getItem(`environment:${dir}`);
        setEnvironment(
          savedEnv && envs.includes(savedEnv) ? savedEnv : (envs[0] ?? ""),
        );
      } catch (e) {
        setEnvironments([]);
        setEnvironment("");
        log(`PlatformIO configuration: ${e}`);
      }
      await refreshTree(dir);
      invoke("add_recent", { projectDir: dir })
        .then(loadRecents)
        .catch(() => {});
      log(`Opened project: ${dir}`);
    },
    [refreshTree, loadRecents, log],
  );

  const updateActive = useCallback((text: string) => {
    setBuffers((bs) =>
      bs.map((b) =>
        b.path === activeRef.current
          ? { ...b, value: text, preview: false } // editing promotes a preview
          : b,
      ),
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
    [expanded, log],
  );

  const closeBuffer = useCallback(async (path: string) => {
    const buffer = buffersRef.current.find((b) => b.path === path);
    if (
      buffer &&
      buffer.value !== buffer.saved &&
      !(await confirm(`Discard unsaved edits in ${baseName(path)}?`, {
        title: "Unsaved file",
        kind: "warning",
      }))
    )
      return;
    setBuffers((bs) => {
      const idx = bs.findIndex((b) => b.path === path);
      const next = bs.filter((b) => b.path !== path);
      if (path === activeRef.current)
        setActivePath(next[Math.min(idx, next.length - 1)]?.path ?? "");
      return next;
    });
  }, []);

  // Recover dirty buffers after a crash and protect native window close.
  useEffect(() => {
    if (!projectDir) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          `drafts:${projectDir}`,
          JSON.stringify(buffers.filter((b) => b.value !== b.saved)),
        );
      } catch {
        log("Draft recovery storage is full. Save your open files.");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [buffers, projectDir, log]);

  useEffect(() => {
    const off = getCurrentWindow().onCloseRequested(async (event) => {
      if (
        taskLock.current ||
        buffersRef.current.some((b) => b.value !== b.saved)
      ) {
        event.preventDefault();
        const close = await confirm(
          "Close the IDE? Unsaved edits remain in local recovery and any running task will be stopped.",
          { title: "Close Openplatform IDE", kind: "warning" },
        );
        if (close) await getCurrentWindow().destroy();
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, []);

  // Reload clean files edited in VS Code. Dirty files retain their original
  // baseline and Save refuses to overwrite conflicting external changes.
  useEffect(() => {
    const reload = async () => {
      for (const b of buffersRef.current) {
        if (b.value !== b.saved) continue;
        try {
          const disk = await invoke<string>("read_file", { path: b.abs });
          if (disk !== b.saved)
            setBuffers((bs) =>
              bs.map((x) =>
                x.abs === b.abs && x.value === b.value && x.saved === b.saved
                  ? { ...x, value: disk, saved: disk }
                  : x,
              ),
            );
        } catch {
          /* Deleted files are reported if the user tries to save. */
        }
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
      connectLanguage(projectDir, log, (status) => {
        if (!stale) setLanguageStatus(status);
      })
        .then((client) => {
          if (stale) client.dispose();
          else connection = client;
        })
        .catch((e) => {
          if (!stale) {
            setLanguageStatus("C++ unavailable");
            log(`[clangd] ${e}`);
          }
        });
    }, 100);
    return () => {
      stale = true;
      clearTimeout(timer);
      connection?.dispose();
    };
  }, [projectDir, languageRevision, log]);

  useEffect(() => {
    const registration = monaco.editor.registerEditorOpener({
      openCodeEditor: async (_source, uri, selection) => {
        if (uri.scheme !== "file") return false;
        await openFile(uri.fsPath, { pin: true });
        setTimeout(() => {
          const ed = editorRef.current;
          if (!ed || !selection) return;
          if ("startLineNumber" in selection) {
            ed.setSelection(selection);
            ed.revealRangeInCenter(selection);
          } else {
            ed.setPosition(selection);
            ed.revealPositionInCenter(selection);
          }
        }, 80);
        return true;
      },
    });
    return () => registration.dispose();
  }, [openFile]);

  useEffect(() => {
    for (const model of monaco.editor.getModels()) {
      const path = model.uri.fsPath;
      monaco.editor.setModelMarkers(
        model,
        "platformio",
        diagnostics
          .filter((d) => d.path === path)
          .map((d) => ({
            startLineNumber: d.line,
            endLineNumber: d.line,
            startColumn: d.column,
            endColumn: d.column + 1,
            message: d.message,
            severity:
              d.severity === "error"
                ? monaco.MarkerSeverity.Error
                : d.severity === "warning"
                  ? monaco.MarkerSeverity.Warning
                  : monaco.MarkerSeverity.Info,
          })),
      );
    }
  }, [diagnostics, activePath]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const openUris = new Set(
        buffersRef.current.map((b) => monaco.Uri.file(b.abs).toString()),
      );
      for (const model of monaco.editor.getModels()) {
        if (
          model.uri.scheme === "file" &&
          !openUris.has(model.uri.toString()) &&
          editorRef.current?.getModel() !== model
        )
          model.dispose();
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
      invoke<Symbol[]>("document_symbols", {
        path: active.abs,
        content: active.value,
      })
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
      await invoke("write_file", {
        path: b.abs,
        content: b.value,
        expected: b.saved,
      });
      setBuffers((bs) =>
        bs.map((x) =>
          x.abs === b.abs ? { ...x, saved: b.value, preview: false } : x,
        ),
      );
      return true;
    } catch (e) {
      log(`save error: ${e}`);
      return false;
    }
  }

  async function saveAll() {
    for (const b of buffersRef.current) {
      if (b.value !== b.saved && !(await saveBuffer(b))) return false;
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
    const dest = await saveDialog({
      title: "Create new PlatformIO project",
      defaultPath: "MyProject",
      canCreateDirectories: true,
    });
    if (!dest) return;
    try {
      const dir = await invoke<string>("create_new_project", {
        projectDir: dest,
        platformioIni:
          template === "esp32"
            ? DEFAULT_PIO_INI
            : `[env:${template}]\nplatform = atmelavr\nboard = ${template === "uno" ? "uno" : "nanoatmega328"}\nframework = arduino\nmonitor_speed = 115200\n`,
        srcContent:
          template === "esp32"
            ? DEFAULT_SRC
            : DEFAULT_SRC.replace(
                "#define LED_PIN 23",
                "#define LED_PIN LED_BUILTIN",
              ),
      });
      await openProjectDir(dir);
      log(`Created project: ${dir}`);
    } catch (e) {
      log(`new project error: ${e}`);
    }
  }

  /** File ▸ Open Project — browse to a folder (or its platformio.ini). */
  async function openProject() {
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

  const pickFolder = useCallback(async (title: string, defaultPath: string) => {
    const dest = await saveDialog({
      title,
      defaultPath,
      canCreateDirectories: true,
    });
    return typeof dest === "string" ? dest : null;
  }, []);

  /** Save As — write the active buffer (or the whole project) elsewhere. */
  async function saveAs() {
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
    const dest = await pickFolder(
      "Save project as (choose target folder)",
      "MyProject",
    );
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
    () =>
      [
        ["Workspace: Home", ""],
        ["Workspace: Settings", ""],
        ["Panel: Show GitHub", ""],
        ["Panel: Show Libraries", ""],
        ["Panel: Show Boards", ""],
        ["Panel: Show Debug", ""],
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
    [],
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
      })),
    );
  }, [commands]);

  // Keep the action table pointing at the newest closures on every render.
  actionsRef.current = {
    "Workspace: Home": () => {
      setPanel("home");
      setPanelOpen(true);
    },
    "Workspace: Settings": () => {
      setPanel("settings");
      setPanelOpen(true);
    },
    "Panel: Show GitHub": () => {
      setPanel("git");
      setPanelOpen(true);
    },
    "Panel: Show Libraries": () => {
      setPanel("libraries");
      setPanelOpen(true);
    },
    "Panel: Show Boards": () => {
      setPanel("boards");
      setPanelOpen(true);
    },
    "Panel: Show Debug": () => {
      setPanel("debug");
      setPanelOpen(true);
    },
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
    "Panel: Show Files": () => {
      setPanel("files");
      setPanelOpen(true);
    },
    "Panel: Show Outline": () => {
      setPanel("outline");
      setPanelOpen(true);
    },
    "Panel: Show Serial Monitor": () => {
      setRightTab("serial");
      setRightOpen(true);
    },
    "Panel: Toggle Sidebar": () => setPanelOpen((v) => !v),
    "Build: Verify": () => verify(),
    "Build: Upload": () => upload(),
    "Build: Cancel": () => cancelTask(),
    "Build: Clean": () => projectTask(["run", "-t", "clean"], "cleaning"),
    "Build: Generate Compilation Database": async () => {
      if ((await projectTask(["run", "-t", "compiledb"], "indexing")) === 0) {
        try {
          await invoke("configure_language", { projectDir });
          setLanguageRevision((n) => n + 1);
        } catch (e) {
          log(`C++ configuration: ${e}`);
        }
      }
    },
    "Build: Static Analysis": () => projectTask(["check"], "analyzing"),
    "Build: Run Tests": () => projectTask(["test"], "testing"),
    "Project: Install Dependencies": () =>
      projectTask(["pkg", "install"], "installing"),
    "Tools: Check Toolchain": async () => {
      revealOutput();
      log(JSON.stringify(await invoke("toolchain_status"), null, 2));
    },
    "C++: Restart Language Server": () => setLanguageRevision((n) => n + 1),
    "Editor: Format Document": () =>
      editorRef.current?.getAction("editor.action.formatDocument")?.run(),
    "Editor: Reload File from Disk": async () => {
      if (
        !active ||
        (active.value !== active.saved &&
          !(await confirm("Discard edits and reload this file?", {
            kind: "warning",
          })))
      )
        return;
      try {
        const value = await invoke<string>("read_file", { path: active.abs });
        setBuffers((bs) =>
          bs.map((b) =>
            b.abs === active.abs ? { ...b, value, saved: value } : b,
          ),
        );
      } catch (e) {
        log(`Reload failed: ${e}`);
      }
    },
    "Panel: Show Problems": () => {
      setRightTab("problems");
      setRightOpen(true);
    },
    "Device: Refresh Ports": () => scan(),
    "Device: Identify Chip": () => identify(),
    "Serial: Toggle Monitor": () => toggleSerial(),
    "Terminal: Toggle": () => toggleTerminal(),
    "Terminal: New": () => {
      setTermOpen(true);
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
        })),
    );
    setOverlaySel(0);
  }, [overlay, overlayQuery, commands]);

  // -- finder / search: debounce a backend query --
  useEffect(() => {
    if (overlay !== "finder" && overlay !== "search") return;
    if (!projectDir) return;
    const q = overlayQuery;
    let stale = false;
    const t = setTimeout(
      async () => {
        try {
          if (overlay === "finder") {
            const files = await invoke<string[]>("search_files", {
              root: projectDir,
              query: q,
            });
            if (stale) return;
            setOverlayItems(
              files.slice(0, 200).map((f) => ({
                label: f.split("/").pop() ?? f,
                detail: f,
                run: () => openFile(`${projectDir}/${f}`, { pin: true }),
              })),
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
              })),
            );
          }
          setOverlaySel(0);
        } catch (e) {
          log(`search error: ${e}`);
        }
      },
      overlay === "finder" ? 60 : 220,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [overlay, overlayQuery, projectDir, openFile, log]);

  useEffect(() => {
    if (overlay) setTimeout(() => overlayInputRef.current?.focus(), 0);
  }, [overlay]);

  // Native macOS menu actions resolve against current editor/project state.
  const nativeActions = useRef<Record<string, () => void>>({});
  nativeActions.current = {
    ...actionsRef.current,
    "Go to File": openFinder,
    "Find in Project": openSearch,
    "Command Palette": openPalette,
    "Close Tab": () => {
      if (activeRef.current) void closeBuffer(activeRef.current);
    },
    ...Object.fromEntries(
      recents.map((path) => [
        `recent:${path}`,
        () => {
          void openProjectDir(path);
        },
      ]),
    ),
  };
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let dispose: (() => Promise<void>) | undefined;
    void installNativeMenu(
      recents,
      (action) => nativeActions.current[action]?.(),
      () => cancelled,
    )
      .then((cleanup) => {
        dispose = cleanup;
        if (cancelled) void cleanup();
      })
      .catch((error) => log(`Application menu: ${error}`));
    return () => {
      cancelled = true;
      void dispose?.();
    };
  }, [recents, log]);

  // -- global keybindings, matching Zed's defaults --
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // The native menu owns these accelerators on macOS.
      if (
        isTauri() &&
        /Mac/.test(navigator.platform) &&
        mod &&
        ["p", "f", "s", "w", "b", "o", "n"].includes(e.key.toLowerCase())
      )
        return;
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
      } else if (e.key === "Escape") {
        setOverlay(null);
        setPanelOpen(false);
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
  async function projectTask(
    args: string[],
    label: string,
    needsPort = false,
  ): Promise<number | null> {
    if (taskLock.current || !projectDir || (needsPort && !port)) return -1;
    taskLock.current = true;
    cancelRequested.current = false;
    const restoreMonitor =
      (needsPort || args[0] === "test") && serialOpenRef.current;
    const monitorPort = port;
    setBusy(label);
    setProgress(null);
    setDiagnostics([]);
    revealOutput();
    const id = crypto.randomUUID();
    try {
      if (!(await saveAll())) {
        log("Task stopped: a file could not be saved.");
        return -1;
      }
      const envs = await invoke<string[]>("project_environments", {
        projectDir,
      });
      setEnvironments(envs);
      if (!envs.length)
        throw new Error("No [env:name] section in platformio.ini");
      const selected = envs.includes(environment) ? environment : envs[0];
      setEnvironment(selected);
      localStorage.setItem(`environment:${projectDir}`, selected);
      if (cancelRequested.current) {
        setBuildState("cancelled");
        log("Task cancelled before starting.");
        return null;
      }
      if (needsPort || args[0] === "test") await stopSerial();
      await eventsReady.current;
      jobRef.current = { id, root: projectDir };
      const done = waitExit();
      const command = [
        ...args,
        "-e",
        selected,
        ...(needsPort ? ["--upload-port", monitorPort] : []),
      ];
      log(`\n--- ${label}: pio ${command.join(" ")} ---`);
      try {
        await invoke("cli_start", {
          cwd: projectDir,
          args: command,
          jobId: id,
        });
        if (cancelRequested.current) await invoke("cli_cancel");
      } catch (e) {
        onCliExit(-1);
        throw e;
      }
      const code = await done;
      setBuildState(code === null ? "cancelled" : code === 0 ? "ok" : "err");
      log(
        code === 0
          ? `✓ ${label} complete`
          : `✗ ${label} ${code === null ? "cancelled" : `failed (exit ${code})`}`,
      );
      return code;
    } catch (e) {
      log(`${label}: ${e}`);
      setBuildState("err");
      return -1;
    } finally {
      jobRef.current = null;
      exitResolver.current = null;
      if (restoreMonitor) {
        try {
          await invoke("serial_start", { port: monitorPort, baud });
          setSerialOpen(true);
        } catch (e) {
          log(`Could not resume serial monitor: ${e}`);
        }
      }
      taskLock.current = false;
      setBusy(null);
      setProgress(null);
      setStatus("");
    }
  }

  function cancelTask() {
    cancelRequested.current = true;
    void invoke("cli_cancel").catch((e) => log(`Cancel: ${e}`));
  }

  async function verify() {
    await projectTask(["run"], "compiling");
  }
  async function upload() {
    await projectTask(["run", "-t", "upload"], "uploading", true);
  }

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
      if (restore) {
        try {
          await invoke("serial_start", { port, baud });
        } catch (e) {
          log(`Serial resume: ${e}`);
        }
      }
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
            onClick={() =>
              n.isDir ? toggleDir(n) : openFile(n.path, { preview: true })
            }
            onDoubleClick={() => !n.isDir && openFile(n.path, { pin: true })}
          >
            <span className="twisty">{n.isDir ? (kids ? "▾" : "▸") : ""}</span>
            <span className="ico"><Icon name={n.isDir ? "folder" : "file"} width={14} height={14} /></span>
            <span className={`nm${activeBuf?.preview ? " preview" : ""}`}>
              {n.name}
            </span>
            {dirty && <span className="dirty">●</span>}
          </div>
          {n.isDir && kids && renderNodes(kids, depth + 1)}
        </div>
      );
    });
  }

  const panelTitle = {
    home: "Workspace",
    files: "Project files",
    outline: "Outline",
    git: "GitHub",
    debug: "Debug",
    libraries: "Libraries",
    boards: "Boards",
    settings: "Settings",
  }[panel];
  const selectPanel = (next: typeof panel) => {
    setPanel(next);
    setPanelOpen((current) => (panel === next ? !current : true));
  };
  const showRight = (next: typeof rightTab) => {
    setRightTab(next);
    setRightOpen(true);
  };
  const activateDock = (id: string) => {
    if (id === "terminal") toggleTerminal();
    else if (id === "serial") {
      setRightTab("serial");
      setRightOpen((open) => (rightTab === "serial" ? !open : true));
    } else selectPanel(id as typeof panel);
  };

  return (
    <div
      style={
        {
          "--bottom-height": bottomExpanded ? "42%" : "23%",
        } as React.CSSProperties
      }
      className={`wrap ${isTauri() && /Mac/.test(navigator.platform) ? "native-mac" : ""}`}
    >
      <header className="titlebar" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          OpenPlatform
        </span>
        <div className="project-identity" data-tauri-drag-region>
          <Icon name="branch" />
          <span data-tauri-drag-region>
            {projectDir ? baseName(projectDir) : "Your workspace"}
          </span>
          {branch && (
            <>
              <i />
              <button onClick={() => selectPanel("git")}>
                {branch}
                <Icon name="chevron" />
              </button>
            </>
          )}
        </div>
        <div className="title-actions">
          <button className="quick-search" onClick={openFinder}>
            <Icon name="search" />
            <span>Go to file…</span>
            <kbd>⌘P</kbd>
          </button>
          <button
            className="icon-button"
            title="Command palette (⇧⌘P)"
            aria-label="Command palette"
            onClick={openPalette}
          >
            <Icon name="command" />
          </button>
          <button
            className="icon-button"
            title="Find in project (⇧⌘F)"
            aria-label="Find in project"
            onClick={openSearch}
          >
            <Icon name="search" />
          </button>
        </div>
      </header>

      <main className="workspace">
        <nav className="activity-bar" aria-label="Workspace dock">
          {dockItems
            .filter((item) => preferences.dock.includes(item.id))
            .map((item) => (
              <button
                key={item.id}
                className={`dock-icon ${item.id === "terminal" ? (termOpen ? "active" : "") : item.id === "serial" ? (rightOpen && rightTab === "serial" ? "active" : "") : panelOpen && panel === item.id ? "active" : ""}`}
                aria-label={item.label}
                data-tooltip={item.label}
                onClick={() => activateDock(item.id)}
              >
                <Icon name={item.icon} />
                {((item.id === "serial" && serialOpen) ||
                  (item.id === "terminal" && termOpen)) && (
                  <span className="activity-dot" />
                )}
              </button>
            ))}
          <div className="dock-divider" />
          <button
            className="dock-icon"
            aria-label="More tools"
            data-tooltip="More tools · ⇧⌘P"
            onClick={openPalette}
          >
            <Icon name="more" />
          </button>
          <button
            className={`dock-icon ${panelOpen && panel === "settings" ? "active" : ""}`}
            aria-label="Settings"
            data-tooltip="Settings"
            onClick={() => selectPanel("settings")}
          >
            <Icon name="settings" />
          </button>
        </nav>

        <section
          className={`workspace-main ${!termOpen && !rightOpen ? "no-bottom" : ""}`}
        >
          <div className="tabs-region">
            <div className="tabbar" role="tablist" aria-label="Open files">
              {buffers.map((b) => (
                <div
                  key={b.path}
                  role="tab"
                  aria-selected={b.path === activePath}
                  tabIndex={0}
                  className={`tab${b.path === activePath ? " active" : ""}${b.preview ? " preview" : ""}`}
                  title={b.path}
                  onClick={() => setActivePath(b.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActivePath(b.path);
                    }
                  }}
                  onDoubleClick={() =>
                    setBuffers((bs) =>
                      bs.map((x) =>
                        x.path === b.path ? { ...x, preview: false } : x,
                      ),
                    )
                  }
                >
                  <span className="tab-name">{baseName(b.path)}</span>
                  {b.value !== b.saved && (
                    <span className="dirty" aria-label="Unsaved changes" />
                  )}
                  <button
                    className="tab-close"
                    aria-label={`Close ${baseName(b.path)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void closeBuffer(b.path);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              {!buffers.length && (
                <span className="tabs-placeholder">No open files</span>
              )}
              <button
                className="icon-button tab-add"
                aria-label="Open a file"
                title="Go to file (⌘P)"
                onClick={openFinder}
              >
                <Icon name="plus" />
              </button>
            </div>
          </div>

          <section className="editor-window surface" aria-label="Code editor">
            <div className="editor-toolbar">
              <div className="breadcrumbs">
                <Icon name="file" />
                <button
                  title="Project files"
                  onClick={() => selectPanel("files")}
                >
                  {projectDir ? baseName(projectDir) : "Open a project"}
                </button>
                {active &&
                  active.path.split("/").map((part, i) => (
                    <span className="breadcrumb-part" key={`${i}-${part}`}>
                      <span className="sep">/</span>
                      {part}
                    </span>
                  ))}
                <button
                  className="icon-button save-button"
                  title="Save (⌘S)"
                  aria-label="Save file"
                  disabled={!active}
                  onClick={() => void saveActive()}
                >
                  <Icon name="save" />
                </button>
              </div>
              <div className="build-actions">
                <select
                  aria-label="Build environment"
                  value={environment}
                  disabled={!!busy || !environments.length}
                  onChange={(e) => {
                    setEnvironment(e.target.value);
                    localStorage.setItem(
                      `environment:${projectDir}`,
                      e.target.value,
                    );
                  }}
                >
                  {!environments.length && (
                    <option value="">Environment</option>
                  )}
                  {environments.map((env) => (
                    <option key={env}>{env}</option>
                  ))}
                </select>
                <select
                  className="port-select"
                  title={port || "Select a serial port"}
                  aria-label="Serial port"
                  value={port}
                  disabled={!!busy || serialOpen}
                  onChange={(e) => setPort(e.target.value)}
                >
                  <option value="">Select port</option>
                  {ports.map((p) => (
                    <option key={p.address} value={p.address}>
                      {p.address.replace(/^\/dev\/cu\./, "")}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  title="Refresh ports"
                  aria-label="Refresh ports"
                  onClick={scan}
                >
                  <Icon name="refresh" />
                </button>
                <button
                  className="identify-button"
                  onClick={identify}
                  disabled={!port || !!busy}
                >
                  Identify
                </button>
                <button onClick={verify} disabled={!!busy || !projectDir}>
                  <Icon name="check" />
                  <span>Verify</span>
                </button>
                <button
                  className="primary"
                  onClick={upload}
                  disabled={!port || !!busy || !projectDir}
                >
                  <Icon name="upload" />
                  <span>Upload</span>
                </button>
                {busy && (
                  <button title="Cancel active task" onClick={cancelTask}>
                    <Icon name="stop" />
                    Stop
                  </button>
                )}
                <button
                  className="icon-button"
                  title="Build tools"
                  aria-label="Build tools"
                  onClick={openPalette}
                >
                  <Icon name="more" />
                </button>
              </div>
            </div>
            {busy && (
              <div className="progress-wrap">
                <div className="progress">
                  <div
                    className={`bar ${progress === null ? "indeterminate" : ""}`}
                    style={
                      progress !== null ? { width: `${progress}%` } : undefined
                    }
                  />
                </div>
                <span>
                  {busy}
                  {progress !== null ? ` · ${progress}%` : ""}
                </span>
              </div>
            )}
            {chip && (
              <div className={`chip-result ${chip.success ? "ok" : "err"}`}>
                <Icon name="chip" />
                <span>
                  {chip.success
                    ? chip.summary
                    : "Could not identify chip. See Build Output for details."}
                </span>
                <button
                  className="icon-button"
                  aria-label="Dismiss chip details"
                  onClick={() => setChip(null)}
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
            {active ? (
              <div className="editor-host">
                <Editor
                  height="100%"
                  language={activeLang}
                  theme="openplatform-light"
                  beforeMount={(m) =>
                    m.editor.defineTheme("openplatform-light", {
                      base: "vs",
                      inherit: true,
                      rules: [
                        { token: "comment", foreground: "8493A8" },
                        { token: "keyword", foreground: "8952C7" },
                        { token: "number", foreground: "008C86" },
                        { token: "string", foreground: "AC4A30" },
                        { token: "type", foreground: "296FA8" },
                      ],
                      colors: {
                        "editor.background": "#FFFFFF",
                        "editor.foreground": "#26364D",
                        "editorLineNumber.foreground": "#94A1B3",
                        "editorLineNumber.activeForeground": "#008A88",
                        "editor.lineHighlightBackground": "#EAF8F6",
                        "editor.lineHighlightBorder": "#00000000",
                        "editor.selectionBackground": "#CFEAE8",
                        "editorCursor.foreground": "#008B87",
                        "editorIndentGuide.background1": "#EDF0F3",
                        "editorIndentGuide.activeBackground1": "#C8D5DB",
                        "editorWidget.background": "#FFFFFF",
                        "editorWidget.border": "#DBE2E9",
                        "editorSuggestWidget.selectedBackground": "#E3F4F2",
                        "editorStickyScroll.background": "#FFFFFF",
                        "minimap.background": "#FFFFFF",
                        "scrollbarSlider.background": "#A4B3C044",
                        "scrollbarSlider.hoverBackground": "#A4B3C077",
                      },
                    })
                  }
                  value={activeValue}
                  path={monaco.Uri.file(active.abs).toString()}
                  keepCurrentModel
                  onChange={(v) => updateActive(v ?? "")}
                  onMount={(ed) => {
                    editorRef.current = ed;
                    ed.onDidChangeCursorPosition((e) =>
                      setCursor({
                        line: e.position.lineNumber,
                        col: e.position.column,
                      }),
                    );
                  }}
                  options={{
                    fontSize: preferences.fontSize,
                    lineHeight: Math.round(preferences.fontSize * 1.55),
                    fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
                    minimap: {
                      enabled: preferences.minimap,
                      renderCharacters: false,
                      maxColumn: 90,
                      scale: 1,
                    },
                    wordWrap: preferences.wordWrap ? "on" : "off",
                    automaticLayout: true,
                    renderLineHighlight: "all",
                    scrollBeyondLastLine: false,
                    fontLigatures: true,
                    smoothScrolling: true,
                    cursorBlinking: "smooth",
                    guides: { indentation: true, bracketPairs: false },
                    bracketPairColorization: { enabled: false },
                    stickyScroll: { enabled: true },
                    renderWhitespace: "selection",
                    padding: { top: 8, bottom: 12 },
                    lineNumbersMinChars: 3,
                    glyphMargin: false,
                    folding: true,
                    overviewRulerBorder: false,
                    scrollbar: {
                      verticalScrollbarSize: 9,
                      horizontalScrollbarSize: 9,
                    },
                  }}
                />
              </div>
            ) : (
              <div className="welcome">
                <div className="welcome-symbol">
                  <Icon name="terminal" />
                </div>
                <span className="eyebrow">OPENPLATFORM</span>
                <h1>
                  A little space.
                  <br />
                  For your next big idea.
                </h1>
                <p>Open a project and make something work.</p>
                <div className="button-row">
                  <button className="primary" onClick={openProject}>
                    <Icon name="folder" />
                    Open project
                  </button>
                  <button onClick={() => newProject()}>
                    <Icon name="plus" />
                    New project
                  </button>
                </div>
                <button
                  className="text-button"
                  onClick={() => selectPanel("home")}
                >
                  Recent projects <span>→</span>
                </button>
              </div>
            )}
          </section>

          <div
            className={`bottom-windows ${!termOpen || !rightOpen ? "single" : ""} ${!termOpen && !rightOpen ? "hidden" : ""}`}
          >
            <section
              className={`terminal-window surface ${termOpen ? "" : "hidden"}`}
              aria-label="Terminal"
            >
              <div className="window-heading">
                <Icon name="terminal" />
                <strong>Terminal</strong>
                <span className="term-cwd" title={termCwd}>
                  {baseName(termCwd)}
                </span>
                <span className="spacer" />
                <span className="shell-label">{shellName}</span>
                <button
                  className="icon-button"
                  title="Restart shell"
                  aria-label="Restart shell"
                  onClick={() => startTerminal()}
                >
                  <Icon name="refresh" />
                </button>
                <button
                  className="icon-button"
                  title="Expand terminal"
                  aria-label="Expand terminal"
                  onClick={() => setBottomExpanded((v) => !v)}
                >
                  <Icon name="expand" />
                </button>
                <button
                  className="icon-button"
                  title="Hide terminal"
                  aria-label="Hide terminal"
                  onClick={() => setTermOpen(false)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <div
                className="terminal-host"
                ref={termHostRef}
                onMouseDown={() => termRef.current?.focus()}
              />
            </section>
            <section
              className={`output-window surface ${rightOpen ? "" : "hidden"}`}
              aria-label="Output panels"
            >
              <div
                className="output-tabs"
                role="tablist"
                aria-label="Output view"
              >
                <button
                  role="tab"
                  aria-selected={rightTab === "serial"}
                  className={rightTab === "serial" ? "active" : ""}
                  onClick={() => showRight("serial")}
                >
                  <Icon name="serial" />
                  Serial Output
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === "output"}
                  className={rightTab === "output" ? "active" : ""}
                  onClick={() => showRight("output")}
                >
                  <Icon name="output" />
                  Build Output{busy && <span className="live-dot" />}
                </button>
                <button
                  role="tab"
                  aria-selected={rightTab === "problems"}
                  className={rightTab === "problems" ? "active" : ""}
                  onClick={() => showRight("problems")}
                >
                  <Icon name="warning" />
                  Problems<span className="count">{diagnostics.length}</span>
                </button>
                <span className="spacer" />
                <button
                  className="icon-button"
                  aria-label="Hide output panels"
                  title="Hide output panels"
                  onClick={() => setRightOpen(false)}
                >
                  <Icon name="close" />
                </button>
              </div>
              {rightTab === "serial" && (
                <div className="serial-panel">
                  <div className="serial-tools">
                    <span
                      className={`connection ${serialOpen ? "connected" : ""}`}
                    >
                      <i />
                      {serialOpen ? "Connected" : "Monitor stopped"}
                    </span>
                    <span className="spacer" />
                    <select
                      aria-label="Serial baud rate"
                      value={baud}
                      onChange={(e) => setBaud(Number(e.target.value))}
                      disabled={serialOpen}
                    >
                      {[9600, 19200, 57600, 115200, 230400].map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </select>
                    <button
                      className="icon-button"
                      aria-label={
                        serialOpen
                          ? "Stop serial monitor"
                          : "Start serial monitor"
                      }
                      title={serialOpen ? "Stop monitor" : "Start monitor"}
                      onClick={toggleSerial}
                      disabled={!serialOpen && (!port || !!busy)}
                    >
                      <Icon name={serialOpen ? "stop" : "play"} />
                    </button>
                    <button
                      className="icon-button"
                      title="Clear serial output"
                      aria-label="Clear serial output"
                      onClick={() => setSerialText("")}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                  <pre
                    ref={serRef}
                    className={`serial ${!serialText ? "muted" : ""}`}
                  >
                    {serialText ||
                      (port
                        ? "Start the monitor to see messages from your board."
                        : "Connect a board and select a serial port to get started.")}
                  </pre>
                  <form
                    className="serial-send"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await invoke("serial_write", {
                          data: serialInput + lineEnding,
                        });
                        setSerialInput("");
                      } catch (error) {
                        log(`Serial send: ${error}`);
                      }
                    }}
                  >
                    <input
                      aria-label="Serial message"
                      placeholder="Send to board…"
                      value={serialInput}
                      onChange={(e) => setSerialInput(e.target.value)}
                      disabled={!serialOpen}
                    />
                    <select
                      aria-label="Line ending"
                      value={lineEnding}
                      onChange={(e) => setLineEnding(e.target.value)}
                    >
                      <option value="">None</option>
                      <option value={"\n"}>LF</option>
                      <option value={"\r\n"}>CRLF</option>
                    </select>
                    <button
                      className="icon-button"
                      title="Send to board"
                      aria-label="Send to board"
                      disabled={!serialOpen}
                      type="submit"
                    >
                      <Icon name="send" />
                    </button>
                  </form>
                </div>
              )}
              {rightTab === "output" && (
                <>
                  <div className="output-tools">
                    <span className={buildState === "err" ? "err" : "muted"}>
                      {busy ||
                        (buildState === "ok"
                          ? "Task completed"
                          : buildState === "err"
                            ? "Task failed"
                            : "Build & upload log")}
                    </span>
                    <span className="spacer" />
                    {busy && (
                      <button onClick={cancelTask}>
                        <Icon name="stop" />
                        Stop
                      </button>
                    )}
                    <button
                      className="icon-button"
                      title="Clear build output"
                      aria-label="Clear build output"
                      onClick={() => setOut([])}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                  <pre ref={logRef} className="out">
                    {out.length
                      ? out.join("\n")
                      : "Ready. Verify or upload your project to view its output."}
                  </pre>
                </>
              )}
              {rightTab === "problems" && (
                <div className="problems-list">
                  {diagnostics.length ? (
                    diagnostics.map((d, i) => (
                      <button
                        className="problem-row"
                        key={i}
                        onClick={async () => {
                          await openFile(d.path, { pin: true });
                          setTimeout(() => gotoLine(d.line), 80);
                        }}
                      >
                        <Icon
                          name="warning"
                          className={d.severity === "error" ? "err" : "warning"}
                        />
                        <div>
                          <strong>{d.message}</strong>
                          <small>
                            {baseName(d.path)} · {d.line}:{d.column}
                          </small>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="quiet-empty">
                      <Icon name="check" />
                      <div>
                        No compiler diagnostics.
                        <small>Verify your project to check for errors.</small>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </section>

        {panelOpen && (
          <>
            <div
              className="panel-dismiss"
              onClick={() => setPanelOpen(false)}
            />
            <aside className="floating-panel surface" aria-label={panelTitle}>
              <div className="window-heading">
                <strong>{panelTitle}</strong>
                <span className="spacer" />
                {panel === "files" && (
                  <>
                    <button
                      className="icon-button"
                      title="New file"
                      aria-label="New file"
                      onClick={newFile}
                    >
                      <Icon name="plus" />
                    </button>
                    <button
                      className="icon-button"
                      title="Refresh files"
                      aria-label="Refresh files"
                      onClick={() => refreshTree(projectDir)}
                    >
                      <Icon name="refresh" />
                    </button>
                  </>
                )}
                <button
                  className="icon-button"
                  title="Close panel"
                  aria-label="Close panel"
                  onClick={() => setPanelOpen(false)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <div className="dock-body">
                {panel === "home" && (
                  <div className="panel-content">
                    <div className="panel-intro">
                      <Icon name="home" />
                      <div>
                        <h2>Your workspace</h2>
                        <p>Pick up where you left off.</p>
                      </div>
                    </div>
                    <div className="button-row">
                      <button className="primary" onClick={openProject}>
                        <Icon name="folder" />
                        Open project
                      </button>
                      <button onClick={() => newProject()}>
                        <Icon name="plus" />
                        New
                      </button>
                    </div>
                    <div className="section-heading">Recent projects</div>
                    {recents.length ? (
                      recents.map((path) => (
                        <button
                          className="recent-project"
                          key={path}
                          onClick={() => void openProjectDir(path)}
                        >
                          <Icon name="folder" />
                          <span>
                            <strong>{baseName(path)}</strong>
                            <small>
                              {path.replace(homeDirRef.current || "~", "~")}
                            </small>
                          </span>
                          <span>↗</span>
                        </button>
                      ))
                    ) : (
                      <p className="muted">
                        Projects you open will appear here.
                      </p>
                    )}
                    <div className="section-heading">Start from a template</div>
                    {(["esp32", "uno", "nano"] as const).map((t) => (
                      <button
                        className="template-row"
                        key={t}
                        onClick={() => newProject(t)}
                      >
                        <Icon name="chip" />
                        <span>
                          {t === "esp32"
                            ? "ESP32"
                            : t === "uno"
                              ? "Arduino Uno"
                              : "Arduino Nano"}
                        </span>
                        <Icon name="plus" />
                      </button>
                    ))}
                  </div>
                )}
                {panel === "files" && (
                  <div className="tree">
                    {treeRoot.length ? (
                      renderNodes(treeRoot, 0)
                    ) : (
                      <div className="illustrated-empty">
                        <Icon name="folder" />
                        <h3>No project open</h3>
                        <button onClick={openProject}>Open project</button>
                      </div>
                    )}
                  </div>
                )}
                {panel === "outline" && (
                  <div className="outline-list">
                    {outline.length ? (
                      outline.map((s, i) => (
                        <button
                          className="outline-row"
                          key={i}
                          onClick={() => gotoLine(s.line)}
                        >
                          <span className="kind">{s.kind}</span>
                          <span className="nm">{s.name}</span>
                          <span className="ln">{s.line}</span>
                        </button>
                      ))
                    ) : (
                      <div className="quiet-empty">
                        No symbols in this file.
                      </div>
                    )}
                  </div>
                )}
                {panel === "git" && (
                  <GitPanel projectDir={projectDir} onChange={refreshBranch} onSettings={() => setPanel("settings")} />
                )}
                {panel === "debug" && <DebugPanel projectDir={projectDir} />}
                {panel === "libraries" && (
                  <LibrariesPanel projectDir={projectDir} />
                )}
                {panel === "boards" && <BoardsPanel />}
                {panel === "settings" && (
                  <div className="panel-content">
                    <div className="panel-intro">
                      <Icon name="settings" />
                      <div>
                        <h2>Make room for your flow</h2>
                        <p>A few small adjustments, a calmer workspace.</p>
                      </div>
                    </div>
                    <AccountsSettings projectDir={projectDir} />
                    <div className="section-heading">Editor</div>
                    <label className="setting-row">
                      Font size
                      <select
                        value={preferences.fontSize}
                        onChange={(e) =>
                          setPreferences((p) => ({
                            ...p,
                            fontSize: Number(e.target.value),
                          }))
                        }
                      >
                        {[11, 12, 13, 14, 15, 16, 18, 20].map((n) => (
                          <option key={n} value={n}>
                            {n} px
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="setting-row">
                      Show minimap
                      <input
                        type="checkbox"
                        checked={preferences.minimap}
                        onChange={(e) =>
                          setPreferences((p) => ({
                            ...p,
                            minimap: e.target.checked,
                          }))
                        }
                      />
                    </label>
                    <label className="setting-row">
                      Wrap long lines
                      <input
                        type="checkbox"
                        checked={preferences.wordWrap}
                        onChange={(e) =>
                          setPreferences((p) => ({
                            ...p,
                            wordWrap: e.target.checked,
                          }))
                        }
                      />
                    </label>
                    <div className="section-heading">Floating dock</div>
                    <p className="muted">
                      Choose your tools. The dock fits what you keep.
                    </p>
                    {dockItems.map((item) => (
                      <label key={item.id} className="setting-row">
                        <span>
                          <Icon name={item.icon} />
                          {item.label}
                        </span>
                        <input
                          type="checkbox"
                          checked={preferences.dock.includes(item.id)}
                          onChange={(e) =>
                            setPreferences((p) => ({
                              ...p,
                              dock: e.target.checked
                                ? [...p.dock, item.id]
                                : p.dock.filter((id) => id !== item.id),
                            }))
                          }
                        />
                      </label>
                    ))}
                    <div className="section-heading">Tools</div>
                    <button
                      className="full-width"
                      onClick={() => {
                        setPanelOpen(false);
                        openPalette();
                      }}
                    >
                      <Icon name="command" />
                      Command palette <kbd>⇧⌘P</kbd>
                    </button>
                    <p className="version-label">OpenPlatform · Version 1.0</p>
                  </div>
                )}
              </div>
            </aside>
          </>
        )}
      </main>
      <footer className="statusbar">
        <button title="Source control" onClick={() => selectPanel("git")}>
          <Icon name="branch" />
          {branch || "No repository"}
          <Icon name="chevron" />
        </button>
        <span className="status-divider" />
        <button
          title="Compiler diagnostics"
          onClick={() => showRight("problems")}
        >
          <Icon
            name={diagnostics.length ? "warning" : "check"}
            className={diagnostics.length ? "warning" : "ok"}
          />
          {diagnostics.length} problems
        </button>
        {(busy || buildState !== "idle") && (
          <button
            className={buildState === "err" ? "err" : "status-task"}
            title={status}
            onClick={() => showRight("output")}
          >
            {busy ||
              (buildState === "ok"
                ? "Task completed"
                : buildState === "cancelled"
                  ? "Task cancelled"
                  : "Task failed")}
          </button>
        )}
        <span className="spacer" />
        <button
          title="Restart C++ language server"
          onClick={() => setLanguageRevision((n) => n + 1)}
        >
          <i
            className={`status-dot ${languageStatus === "C++ ready" ? "ready" : ""}`}
          />
          {languageStatus}
        </button>
        <span className="status-divider" />
        <span>UTF-8</span>
        {active && (
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
        )}
        <span className="status-divider" />
        <button
          title={port || "Select a serial port"}
          onClick={() => showRight("serial")}
        >
          <i className={`status-dot ${serialOpen ? "ready" : ""}`} />
          {serialOpen
            ? "Board connected"
            : port
              ? "Board detected"
              : "No board"}
        </button>
      </footer>
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
                  setOverlaySel((s) =>
                    Math.min(s + 1, overlayItems.length - 1),
                  );
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
