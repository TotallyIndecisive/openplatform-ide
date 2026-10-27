import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./Icons";

type Result = {
  success: boolean;
  output?: string;
  error?: string;
  message?: string;
};
const message = (r: Result) =>
  r.output?.trim() ||
  r.message ||
  r.error?.trim() ||
  (r.success ? "Done." : "The operation failed.");
function Notice({ text }: { text: string }) {
  return text ? (
    <div className="panel-notice" role="status">
      {text}
    </div>
  ) : null;
}

type Library = {
  name: string;
  description?: string;
  owner?: { username?: string } | string;
  version?: { name?: string } | string;
};
export function LibrariesPanel({ projectDir }: { projectDir: string }) {
  const [query, setQuery] = useState("");
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [packageName, setPackageName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function search() {
    if (!query.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const r = await invoke<Result>("pio_library_search", { query });
      if (!r.success) throw new Error(message(r));
      const data = JSON.parse(r.output || "[]");
      const items = Array.isArray(data)
        ? data
        : (data.items ?? data.result?.items ?? []);
      setLibraries(items);
      if (!items.length)
        setNotice("No libraries found. Try a different search.");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function install(lib: string) {
    if (!projectDir || !lib.trim()) return;
    setBusy(true);
    try {
      setNotice(
        message(
          await invoke<Result>("pio_library_install", { projectDir, lib }),
        ),
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel-content">
      <div className="panel-intro">
        <Icon name="library" />
        <div>
          <h2>Libraries</h2>
          <p>Find the building blocks for your project.</p>
        </div>
      </div>
      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Icon name="search" />
        <input
          aria-label="Search libraries"
          placeholder="Search PlatformIO libraries…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button disabled={busy || !query.trim()}>Search</button>
      </form>
      <Notice text={busy ? "Working…" : notice} />
      {libraries.map((lib, i) => {
        const owner =
          typeof lib.owner === "string" ? lib.owner : lib.owner?.username;
        const id = owner ? `${owner}/${lib.name}` : lib.name;
        return (
          <article className="package-card" key={`${id}-${i}`}>
            <div>
              <h3>{lib.name}</h3>
              <small>{owner}</small>
            </div>
            <p>{lib.description}</p>
            <button disabled={busy || !projectDir} onClick={() => install(id)}>
              <Icon name="plus" /> Install
            </button>
          </article>
        );
      })}
      {!libraries.length && !notice && (
        <div className="illustrated-empty">
          <Icon name="library" />
          <h3>A library for every idea</h3>
          <p>Search for sensors, displays, connectivity and more.</p>
        </div>
      )}
      <details>
        <summary>Install by package name</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void install(packageName);
          }}
        >
          <label>
            Package
            <input
              placeholder="owner/library@version"
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
            />
          </label>
          <button disabled={busy || !projectDir || !packageName.trim()}>
            Install library
          </button>
        </form>
      </details>
    </div>
  );
}

type Board = {
  id: string;
  name: string;
  platform?: string;
  mcu?: string;
  ram?: number;
  rom?: number;
  frameworks?: string[];
};
export function BoardsPanel() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = useCallback(async () => {
    setNotice("Loading boards…");
    try {
      const r = await invoke<Result>("pio_boards_list");
      if (!r.success) throw new Error(message(r));
      setBoards(JSON.parse(r.output || "[]"));
      setNotice("");
    } catch (e) {
      setNotice(String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const filtered = boards.filter((b) =>
    `${b.name} ${b.id} ${b.platform}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="panel-content">
      <div className="panel-intro">
        <Icon name="chip" />
        <div>
          <h2>Board catalogue</h2>
          <p>Explore supported hardware.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh boards"
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div className="search-box">
        <Icon name="search" />
        <input
          aria-label="Filter boards"
          placeholder="Search boards, chips, platforms…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <Notice text={notice} />
      <p className="muted">Choose your board in platformio.ini.</p>
      <div className="section-heading">
        Boards <span className="count">{filtered.length}</span>
      </div>
      {filtered.slice(0, 100).map((b) => (
        <article className="package-card" key={`${b.platform}-${b.id}`}>
          <h3>{b.name}</h3>
          <code>{b.id}</code>
          <div className="tag-row">
            <span>{b.platform}</span>
            {b.mcu && <span>{b.mcu}</span>}
            {b.ram && <span>{Math.round(b.ram / 1024)} KB RAM</span>}
          </div>
        </article>
      ))}
      {filtered.length > 100 && (
        <p className="muted">
          Showing the first 100. Search to narrow the list.
        </p>
      )}
    </div>
  );
}

export function DebugPanel({ projectDir }: { projectDir: string }) {
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(command: string) {
    setBusy(true);
    try {
      setNotice(message(await invoke<Result>(command, { projectDir })));
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel-content">
      <div className="panel-intro">
        <Icon name="bug" />
        <div>
          <h2>Debug hardware</h2>
          <p>Connect to your ESP32 with OpenOCD.</p>
        </div>
      </div>
      <div className="info-card">
        <Icon name="chip" />
        <h3>JTAG connection</h3>
        <p>
          Connect a compatible JTAG probe before starting. This opens the
          existing OpenOCD session with the ESP32 DevKit configuration.
        </p>
      </div>
      <div className="button-row">
        <button
          className="primary"
          disabled={!projectDir || busy}
          onClick={() => run("debug_start")}
        >
          <Icon name="play" /> Start OpenOCD
        </button>
        <button disabled={busy} onClick={() => run("debug_stop")}>
          <Icon name="stop" /> Stop
        </button>
      </div>
      <Notice text={notice} />
    </div>
  );
}
