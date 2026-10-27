import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Icon } from "./Icons";
import "./SourceControl.css";
import { readGitAuthor } from "./accountAuthor";

type Change = {
  path: string;
  originalPath: string | null;
  index: string;
  worktree: string;
  conflict: boolean;
};
type Status = {
  initialized: boolean;
  root?: string;
  branch?: string;
  branches?: string[];
  upstream?: string;
  hasCommit?: boolean;
  remote?: string;
  name?: string;
  email?: string;
  changes?: Change[];
  history?: string[];
  ahead?: number;
  behind?: number;
};
export type Account = {
  available: boolean;
  authenticated?: boolean;
  login?: string;
  error?: string;
};
type Result = { success: boolean; output?: string; error?: string };
type ActionArgs = {
  value?: string;
  path?: string;
  originalPath?: string | null;
  private?: boolean;
  staged?: boolean;
  description?: string;
};
const details = (r: Result) =>
  r.success
    ? r.output?.trim() || r.error?.trim() || "Done."
    : r.error?.trim() || r.output?.trim() || "The command failed.";

/** GitHub CLI performs its own interactive device flow and stores credentials. */
export function GitHubSignIn({
  done,
  close,
}: {
  done: (successful: boolean) => void;
  close: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    let disposed = false;
    let started = false;
    const sessionId = crypto.randomUUID();
    const terminal = new Terminal({
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 500,
      theme: {
        background: "#f7fafb",
        foreground: "#26364d",
        cursor: "#008b87",
        selectionBackground: "#d6eeec",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    if (host.current) {
      terminal.open(host.current);
      try {
        fit.fit();
      } catch {}
    }
    const input = terminal.onData((data) => {
      void invoke("sc_auth_write", { sessionId, data }).catch((e) =>
        setError(String(e)),
      );
    });
    let offData: (() => void) | undefined;
    let offExit: (() => void) | undefined;
    const setup = async () => {
      offData = await listen<{ sessionId: string; data: string }>(
        "sc-auth-data",
        (e) => {
          if (e.payload.sessionId === sessionId) terminal.write(e.payload.data);
        },
      );
      offExit = await listen<{ sessionId: string; success: boolean }>(
        "sc-auth-exit",
        (e) => {
          if (e.payload.sessionId !== sessionId) return;
          setEnded(true);
          void invoke("sc_auth_stop", { sessionId });
          done(e.payload.success);
        },
      );
      if (disposed) {
        offData();
        offExit();
        return;
      }
      try {
        await invoke("sc_auth_start", { sessionId });
        started = true;
        if (disposed) void invoke("sc_auth_stop", { sessionId });
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };
    void setup();
    return () => {
      disposed = true;
      offData?.();
      offExit?.();
      input.dispose();
      terminal.dispose();
      if (started) void invoke("sc_auth_stop", { sessionId });
    };
  }, [done]);
  return (
    <div className="sc-signin">
      <div className="sc-subheading">Sign in to GitHub</div>
      <p>
        Follow the prompts below. GitHub CLI opens your browser and handles
        credential storage; return here when sign-in is complete.
      </p>
      <div
        className="sc-auth-terminal"
        ref={host}
        aria-label="GitHub sign-in terminal"
      />
      {error && (
        <div className="panel-notice" role="alert">
          {error}
        </div>
      )}
      <div className="button-row">
        <button onClick={close}>{ended ? "Done" : "Cancel sign-in"}</button>
        {ended && <button onClick={() => done(false)}>Refresh account</button>}
      </div>
    </div>
  );
}

export function GitPanel({
  projectDir,
  onChange,
  onSettings,
}: {
  projectDir: string;
  onChange: () => void;
  onSettings: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [message, setMessage] = useState("");
  const [repo, setRepo] = useState("");
  const [privateRepo, setPrivateRepo] = useState(true);
  const [description, setDescription] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [remote, setRemote] = useState("");
  const [diff, setDiff] = useState<{ label: string; text: string } | null>(
    null,
  );
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    if (!projectDir) {
      setStatus(null);
      return;
    }
    try {
      const s = await invoke<Status>("sc_status", { projectDir });
      if (id === generation.current) {
        setStatus(s);
      }
    } catch (e) {
      if (id === generation.current) setNotice(String(e));
    }
  }, [projectDir]);
  const refreshAccount = useCallback(async () => {
    try {
      setAccount(await invoke<Account>("sc_account"));
    } catch (e) {
      setAccount({ available: false, error: String(e) });
    }
  }, []);
  useEffect(() => {
    setStatus(null);
    setDiff(null);
    setNotice("");
    setRepo(projectDir.split("/").pop() || "");
    void refresh();
    return () => {
      generation.current++;
    };
  }, [projectDir, refresh]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);
  const run = async (action: string, args: ActionArgs = {}) => {
    setBusy(action);
    setNotice("");
    try {
      const author = action === "commit" ? readGitAuthor() : null;
      const r = await invoke<Result>("sc_action", {
        projectDir,
        action,
        ...args,
        ...(author
          ? { authorName: author.name, authorEmail: author.email }
          : {}),
      });
      setNotice(details(r));
      await refresh();
      onChange();
      return r;
    } catch (e) {
      setNotice(String(e));
      return { success: false, error: String(e) };
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    setBusy("publish");
    setNotice("");
    try {
      const created = await invoke<Result>("sc_action", {
        projectDir,
        action: "publish",
        value: repo,
        private: privateRepo,
        description,
      });
      if (!created.success) {
        setNotice(details(created));
        return;
      }
      const pushed = await invoke<Result>("sc_action", {
        projectDir,
        action: "push",
      });
      setNotice(
        pushed.success
          ? `Repository created and branch published.\n${details(created)}`
          : `Repository created and origin added, but the first push failed. Your work is safe locally; use Push to retry.\n${details(pushed)}`,
      );
      await refresh();
      onChange();
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy("");
    }
  };
  const showDiff = async (c: Change, staged: boolean) => {
    setBusy("diff");
    try {
      const r = await invoke<Result>("sc_action", {
        projectDir,
        action: "diff",
        path: c.path,
        originalPath: c.originalPath,
        staged,
      });
      setDiff({
        label: `${staged ? "Staged" : "Changes"} · ${c.path}`,
        text: details(r),
      });
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy("");
    }
  };
  const changed = status?.changes || [];
  const stagedChanges = changed.filter(
    (c) => c.index !== " " && c.index !== "?" && !c.conflict,
  );
  const workingChanges = changed.filter(
    (c) => c.worktree !== " " || c.index === "?" || c.conflict,
  );
  const actionProps = (c: Change): ActionArgs => ({
    path: c.path,
    originalPath: c.originalPath,
  });
  const fileRows = (items: Change[], staged: boolean) =>
    items.map((c) => (
      <div className="sc-file" key={`${staged}-${c.path}`}>
        <button
          className="sc-file-name"
          title={`View ${staged ? "staged" : "working"} changes`}
          onClick={() => showDiff(c, staged)}
        >
          <Icon name="file" />
          <span>{c.path}</span>
          <small className={c.conflict ? "sc-conflict" : ""}>
            {c.conflict
              ? "!"
              : staged
                ? c.index
                : c.index === "?"
                  ? "U"
                  : c.worktree}
          </small>
        </button>
        <button
          className="icon-button sc-file-action"
          title={staged ? `Unstage ${c.path}` : `Stage ${c.path}`}
          aria-label={staged ? `Unstage ${c.path}` : `Stage ${c.path}`}
          disabled={!!busy}
          onClick={() => run(staged ? "unstage" : "stage", actionProps(c))}
        >
          {staged ? "−" : "+"}
        </button>
      </div>
    ));
  return (
    <div className="panel-content source-control">
      <div className="panel-intro">
        <Icon name="github" />
        <div>
          <h2>Source control</h2>
          <p>
            {projectDir.split("/").pop() || "Open a project to get started"}
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh source control"
          title="Refresh"
          disabled={!!busy}
          onClick={() => {
            void refresh();
            void refreshAccount();
          }}
        >
          <Icon name="refresh" />
        </button>
      </div>
      <div className="sc-account">
        <div>
          <strong>GitHub</strong>
          <span>
            {!account
              ? "Checking connection…"
              : !account.available
                ? "GitHub CLI unavailable"
                : account.authenticated
                  ? "Account connected"
                  : "Not signed in"}
          </span>
        </div>
        <button onClick={onSettings}>Manage account</button>
      </div>
      {notice && (
        <div className="panel-notice" role="status">
          {notice}
        </div>
      )}
      {!projectDir ? (
        <div className="quiet-empty">Open a project to use source control.</div>
      ) : status === null ? (
        <div className="quiet-empty">Loading source control…</div>
      ) : !status.initialized ? (
        <div className="sc-start">
          <Icon name="branch" />
          <h3>Start tracking your project</h3>
          <p>
            Initialize a local Git repository, then commit and publish when
            you’re ready.
          </p>
          <button
            className="primary full-width"
            disabled={!!busy}
            onClick={() => run("init")}
          >
            Initialize Repository
          </button>
        </div>
      ) : (
        <>
          <div className="sc-branch">
            <Icon name="branch" />
            <select
              aria-label="Current branch"
              value={status.branch || ""}
              disabled={!!busy}
              onChange={(e) => run("checkout", { value: e.target.value })}
            >
              {!status.branch && <option value="">Detached HEAD</option>}
              {status.branch && !status.branches?.includes(status.branch) && (
                <option>{status.branch}</option>
              )}
              {status.branches?.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
            <button
              className="icon-button"
              title="Refresh changes"
              aria-label="Refresh changes"
              disabled={!!busy}
              onClick={() => void refresh()}
            >
              <Icon name="refresh" />
            </button>
          </div>
          <textarea
            className="sc-commit-message"
            rows={3}
            aria-label="Commit message"
            placeholder="Message (describe your changes)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          {(!status.name || !status.email) && !readGitAuthor() && (
            <p className="sc-hint">
              Set your Git author name and email in Accounts settings before
              committing.
            </p>
          )}
          <button
            className="primary full-width"
            disabled={
              !!busy ||
              !message.trim() ||
              !stagedChanges.length ||
              changed.some((c) => c.conflict)
            }
            onClick={async () => {
              const r = await run("commit", { value: message });
              if (r.success) setMessage("");
            }}
          >
            <Icon name="check" />
            Commit staged changes
          </button>
          <div className="button-row sc-sync">
            <button
              disabled={!!busy || !status.remote}
              onClick={() => run("pull")}
            >
              Pull{status.behind ? ` ↓${status.behind}` : ""}
            </button>
            <button
              disabled={!!busy || !status.remote || !status.hasCommit}
              onClick={() => run("push")}
            >
              Push{status.ahead ? ` ↑${status.ahead}` : ""}
            </button>
            <button
              disabled={!!busy || !status.remote}
              onClick={() => run("fetch")}
            >
              Fetch
            </button>
          </div>
          {!status.remote && (
            <details className="sc-details" open>
              <summary>Publish to GitHub</summary>
              <p className="sc-hint">
                Commit your project first. Publishing creates a repository in
                the signed-in account, adds origin and pushes the current
                branch.
              </p>
              <label>
                Repository name
                <input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="my-project"
                />
              </label>
              <label>
                Description <span className="muted">(optional)</span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What are you building?"
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
              <button
                className="full-width"
                disabled={
                  !!busy ||
                  !repo.trim() ||
                  !status.hasCommit ||
                  !account?.authenticated
                }
                onClick={publish}
              >
                Publish to GitHub
              </button>
              <details className="sc-details">
                <summary>Connect an existing remote</summary>
                <label>
                  Origin URL
                  <input
                    value={remote}
                    onChange={(e) => setRemote(e.target.value)}
                    placeholder="https://github.com/owner/repo.git"
                  />
                </label>
                <button
                  disabled={!!busy || !remote.trim()}
                  onClick={() => run("remote_add", { value: remote })}
                >
                  Add origin
                </button>
              </details>
            </details>
          )}
          {status.root && status.root !== projectDir && (
            <p className="sc-hint">
              Repository: {status.root}. Changes and staging cover the entire
              repository.
            </p>
          )}
          {status.remote && (
            <div className="sc-remote" title={status.remote}>
              <span>origin</span> {status.remote}
            </div>
          )}
          <div className="section-heading">
            Staged Changes <span className="count">{stagedChanges.length}</span>
            <button
              disabled={!!busy || !stagedChanges.length}
              onClick={() => run("unstage_all")}
            >
              Unstage all
            </button>
          </div>
          {stagedChanges.length ? (
            fileRows(stagedChanges, true)
          ) : (
            <p className="sc-hint">No staged changes.</p>
          )}
          <div className="section-heading">
            Changes <span className="count">{workingChanges.length}</span>
            <button
              disabled={!!busy || !workingChanges.length}
              onClick={() => run("stage_all")}
            >
              Stage all
            </button>
          </div>
          {workingChanges.length ? (
            fileRows(workingChanges, false)
          ) : (
            <p className="sc-hint">No working changes.</p>
          )}
          {changed.some((c) => c.conflict) && (
            <p className="sc-hint sc-error">
              Resolve conflicts in the affected files before staging and
              committing.
            </p>
          )}
          <details className="sc-details">
            <summary>Create branch</summary>
            <label>
              Branch name
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="feature/my-change"
              />
            </label>
            <button
              disabled={!!busy || !newBranch.trim()}
              onClick={async () => {
                const r = await run("create_branch", {
                  value: newBranch.trim(),
                });
                if (r.success) setNewBranch("");
              }}
            >
              Create and switch
            </button>
          </details>
          <details className="sc-details">
            <summary>Commit history</summary>
            {status.history?.length ? (
              status.history.map((line, i) => {
                const [id, ...rest] = line.split("\t");
                return (
                  <div className="history-row" key={`${id}-${i}`}>
                    <code>{id}</code>
                    <span>{rest.join("\t")}</span>
                  </div>
                );
              })
            ) : (
              <p className="sc-hint">No commits yet.</p>
            )}
          </details>
        </>
      )}
      {!!busy && (
        <div className="sc-busy" role="status">
          {busy === "publish"
            ? "Publishing repository…"
            : `Running ${busy.replace(/_/g, " ")}…`}
        </div>
      )}
      {diff && (
        <div className="sc-diff">
          <div className="sc-diff-head">
            <strong>{diff.label}</strong>
            <button
              className="icon-button"
              aria-label="Close diff"
              onClick={() => setDiff(null)}
            >
              <Icon name="close" />
            </button>
          </div>
          <pre>{diff.text}</pre>
        </div>
      )}
    </div>
  );
}
