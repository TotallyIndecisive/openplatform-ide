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

export function GitPanel({
  projectDir,
  onChange,
}: {
  projectDir: string;
  onChange: () => void;
}) {
  const [status, setStatus] = useState("");
  const [history, setHistory] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [remotes, setRemotes] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [remote, setRemote] = useState("");
  const [remoteName, setRemoteName] = useState("origin");
  const [repo, setRepo] = useState("");
  const [privateRepo, setPrivateRepo] = useState(true);
  const refresh = useCallback(async () => {
    if (!projectDir) return;
    const [s, h, b, r] = await Promise.all([
      invoke<Result>("git_status", { projectDir }),
      invoke<Result>("git_log", { projectDir, limit: 20 }),
      invoke<Result>("git_branches", { projectDir }),
      invoke<Result>("git_remote_list", { projectDir }),
    ]);
    setStatus(s.success ? (s.output ?? "") : "");
    setHistory(h.success ? (h.output ?? "") : "");
    setBranches(
      b.success
        ? (b.output ?? "")
            .split("\n")
            .map((x) => x.replace(/^\*?\s*/, ""))
            .filter(Boolean)
        : [],
    );
    setRemotes(r.success ? (r.output ?? "") : "");
    if (!s.success)
      setNotice(
        s.error || "Initialize a repository to start tracking changes.",
      );
  }, [projectDir]);
  useEffect(() => {
    void refresh().catch((e) => setNotice(String(e)));
  }, [refresh]);
  async function run(command: string, args = {}) {
    setBusy(true);
    try {
      const result = await invoke<Result>(command, { projectDir, ...args });
      setNotice(message(result));
      if (result.success) {
        await refresh();
        onChange();
        if (command === "git_commit") setCommitMessage("");
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  const changes = status
    .split("\n")
    .filter((line) => line && !line.startsWith("##"));
  return (
    <div className="panel-content">
      <div className="panel-intro">
        <Icon name="github" />
        <div>
          <h2>Source control</h2>
          <p>{projectDir.split("/").pop() || "No project open"}</p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh Git"
          onClick={() => void refresh().catch((e) => setNotice(String(e)))}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <fieldset disabled={busy || !projectDir}>
        <div className="button-row">
          <button onClick={() => run("git_pull")}>Pull</button>
          <button onClick={() => run("git_push")}>Push</button>
          <button onClick={() => run("git_init")}>Initialize</button>
        </div>
        <label>
          Branch
          <select
            aria-label="Git branch"
            value={status.replace(/^## (?:No commits yet on |Initial commit on )/, "## ").match(/^## (.+?)(?:\.\.\.|\n|$)/)?.[1] ?? ""}
            onChange={(e) =>
              run("git_checkout", { branch: e.target.value, create: false })
            }
          >
            <option value="" disabled>
              Select branch
            </option>
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <div className="section-heading">
          Changes <span className="count">{changes.length}</span>
          <button onClick={() => run("git_add", { paths: ["."] })}>
            Stage all
          </button>
        </div>
        {changes.length ? (
          changes.map((line, i) => (
            <div className="change-row" key={i}>
              <Icon name="file" />
              <span>{line.slice(3)}</span>
              <small>{line.slice(0, 2).trim()}</small>
            </div>
          ))
        ) : (
          <div className="quiet-empty">
            <Icon name="check" /> Working tree clean
          </div>
        )}
        <label>
          Commit message
          <textarea
            rows={3}
            placeholder="Describe your changes…"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
          />
        </label>
        <button
          className="primary full-width"
          disabled={!commitMessage.trim()}
          onClick={() => run("git_commit", { message: commitMessage })}
        >
          <Icon name="check" /> Commit staged changes
        </button>
        <details>
          <summary>GitHub & remotes</summary>
          <button onClick={() => run("gh_auth_status")}>
            Check GitHub connection
          </button>
          <label>
            Repository name
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="my-project"
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={privateRepo}
              onChange={(e) => setPrivateRepo(e.target.checked)}
            />
            Private repository
          </label>
          <div className="button-row">
            <button
              disabled={!repo.trim()}
              onClick={() =>
                run("gh_repo_create", { name: repo, private: privateRepo })
              }
            >
              Publish to GitHub
            </button>
            <button
              disabled={!repo.trim()}
              onClick={() =>
                run("gh_repo_create_remote", {
                  name: repo,
                  private: privateRepo,
                })
              }
            >
              Create remote only
            </button>
          </div>
          <pre className="subtle-log">{remotes || "No remotes configured"}</pre>
          <label>
            Remote name
            <input
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
            />
          </label>
          <label>
            Remote URL
            <input
              value={remote}
              onChange={(e) => setRemote(e.target.value)}
              placeholder="https://github.com/…"
            />
          </label>
          <button
            disabled={!remote.trim() || !remoteName.trim()}
            onClick={() =>
              run("git_remote_add", { name: remoteName, url: remote })
            }
          >
            Add remote
          </button>
        </details>
        <details>
          <summary>Commit history</summary>
          {history
            .split("\n")
            .filter(Boolean)
            .map((line) => (
              <div className="history-row" key={line}>
                <code>{line.split(" ")[0]}</code>
                <span>{line.slice(line.indexOf(" ") + 1)}</span>
              </div>
            ))}
        </details>
      </fieldset>
      <Notice text={busy ? "Working…" : notice} />
    </div>
  );
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
