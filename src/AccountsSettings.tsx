import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitHubSignIn, type Account } from "./SourceControl";
import { lastSignedIn } from "./accountTime";
import { readGitAuthor, saveGitAuthor } from "./accountAuthor";
import "./AccountsSettings.css";

type Identity = {
  initialized: boolean;
  root?: string;
  name?: string;
  email?: string;
};
type Result = { success: boolean; output?: string; error?: string };
const key = (login: string) =>
  `openplatform:github:last-sign-in:${login.toLowerCase()}`;
function readLast(login: string): number | null {
  if (!login) return null;
  try {
    const raw = localStorage.getItem(key(login));
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
export function AccountsSettings({ projectDir }: { projectDir: string }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [login, setLogin] = useState("");
  const [editing, setEditing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [last, setLast] = useState<number | null>(null);
  const refreshAccount = useCallback(async (successful = false) => {
    try {
      const next = await invoke<Account>("sc_account");
      setAccount(next);
      setLogin(next.login || "");
      if (successful && next.authenticated && next.login) {
        const at = Date.now();
        try {
          localStorage.setItem(key(next.login), String(at));
        } catch {}
        setLast(at);
        setClock(at);
      } else setLast(readLast(next.login || ""));
      if (successful && !next.authenticated)
        setNotice(
          "Sign-in ended, but GitHub CLI did not report an active account. Refresh or try again.",
        );
    } catch (e) {
      setAccount({ available: false, error: String(e) });
    }
  }, []);
  const refreshIdentity = useCallback(async () => {
    if (!projectDir) {
      const saved = readGitAuthor();
      setName(saved?.name || "");
      setEmail(saved?.email || "");
      return;
    }
    try {
      const next = await invoke<Identity>("sc_status", { projectDir });
      const saved = readGitAuthor();
      setName(saved?.name || next.name || "");
      setEmail(saved?.email || next.email || "");
    } catch (e) {
      setNotice(String(e));
    }
  }, [projectDir]);
  useEffect(() => {
    setEditing(false);
    setNotice("");
    void refreshIdentity();
  }, [refreshIdentity]);
  useEffect(() => {
    void refreshAccount();
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshAccount]);
  async function save() {
    setBusy(true);
    setNotice("");
    try {
      const desired = login.trim().replace(/^@/, "");
      if (!!name.trim() !== !!email.trim()) {
        setNotice(
          "Enter both an author name and email, or leave both empty to use Git's configuration.",
        );
        return;
      }
      if (account?.authenticated && !desired) {
        setNotice(
          "Enter an account username, or sign in to another account. Clearing the field does not sign out.",
        );
        return;
      }
      if (
        desired &&
        desired.toLowerCase() !== (account?.login || "").toLowerCase()
      ) {
        const switched = await invoke<Result>("sc_switch_account", {
          login: desired,
        });
        if (!switched.success) {
          setNotice(
            switched.error ||
              switched.output ||
              "Could not switch account. Sign in to that account first.",
          );
          return;
        }
        await refreshAccount();
      }
      saveGitAuthor(
        name.trim() && email.trim()
          ? { name: name.trim(), email: email.trim() }
          : null,
      );
      setEditing(false);
      setNotice("Account settings saved.");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="accounts-settings" aria-label="Accounts settings">
      <div className="accounts-heading">
        <div>
          <h3>Accounts</h3>
          <p>Manage your Git author and GitHub connection.</p>
        </div>
        <button
          disabled={busy}
          onClick={() => {
            if (editing) {
              void refreshIdentity();
              void refreshAccount();
              setNotice("");
            }
            setEditing(!editing);
          }}
        >
          {editing ? "Cancel" : "Edit"}
        </button>
      </div>
      <div className="accounts-card">
        <div className="accounts-state">
          <span
            className={`accounts-dot ${account?.authenticated ? "connected" : ""}`}
          />
          <strong>
            {!account
              ? "Checking GitHub…"
              : !account.available
                ? "GitHub CLI unavailable"
                : account.authenticated
                  ? "GitHub connected"
                  : "GitHub not connected"}
          </strong>
        </div>
        <label>
          Name
          <input
            aria-label="Git author name"
            value={name}
            disabled={!editing || busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="Not configured"
          />
        </label>
        <label>
          Email
          <input
            aria-label="Git author email"
            value={email}
            disabled={!editing || busy}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Not configured"
          />
        </label>
        <label>
          GitHub profile
          <input
            aria-label="GitHub profile"
            value={login}
            disabled={!editing || busy}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="Not signed in"
          />
        </label>
        <div className="accounts-last">
          <span>Last signed in</span>
          <strong>
            {!account
              ? "Checking…"
              : account.authenticated
                ? lastSignedIn(last, clock)
                : "Not signed in"}
          </strong>
        </div>
        {editing && (
          <>
            <p className="accounts-note">
              Name and email are saved in OpenPlatform and used for its commits.
              To change profiles, enter a username already signed in with GitHub
              CLI, or sign in to another account below.
            </p>
            <div className="button-row">
              <button className="primary" disabled={busy} onClick={save}>
                Save changes
              </button>
              <button
                disabled={busy || signingIn || !account?.available}
                onClick={() => setSigningIn(true)}
              >
                {account?.authenticated
                  ? "Sign in another account"
                  : "Sign in to GitHub"}
              </button>
            </div>
          </>
        )}
        {account?.error && <p className="accounts-note">{account.error}</p>}
        {notice && (
          <div className="accounts-notice" role="status">
            {notice}
          </div>
        )}
      </div>
      {signingIn && (
        <div className="source-control">
          <GitHubSignIn
            done={refreshAccount}
            close={() => {
              setSigningIn(false);
              void refreshAccount();
            }}
          />
        </div>
      )}
    </section>
  );
}
