import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as monaco from "monaco-editor";

const position = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const range = (r: any): monaco.IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });
const contents = (v: any): monaco.IMarkdownString[] => (Array.isArray(v) ? v : [v]).filter(Boolean).map(x => ({ value: typeof x === "string" ? x : x.language ? `\`\`\`${x.language}\n${x.value}\n\`\`\`` : x.value, isTrusted: false }));

/** One project-scoped clangd session. Every request is bounded and every
 * provider/listener/model subscription is disposed when the project changes. */
export async function connectLanguage(root: string, log: (message: string) => void, onStatus: (status: string) => void) {
  const sessionId = crypto.randomUUID();
  let sequence = 0;
  let disposed = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const documents = new Map<string, monaco.IDisposable[]>();
  const disposables: monaco.IDisposable[] = [];
  const owns = (model: monaco.editor.ITextModel) => model.getLanguageId() === "cpp" && model.uri.fsPath.replace(/\\/g, "/").startsWith(root.replace(/\\/g, "/") + "/");
  const send = (message: any) => invoke("language_send", { sessionId, message: { jsonrpc: "2.0", ...message } });
  const notify = (method: string, params: any) => { if (!disposed) void send({ method, params }).catch(e => log(`[clangd] ${e}`)); };
  const request = (method: string, params: any, token?: monaco.CancellationToken): Promise<any> => {
    if (disposed || token?.isCancellationRequested) return Promise.resolve(null);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); cancel?.dispose(); reject(new Error(`${method} timed out`)); }, 15000);
      const cancel = token?.onCancellationRequested(() => { notify("$/cancelRequest", { id }); });
      pending.set(id, { resolve: v => { cancel?.dispose(); resolve(v); }, reject: e => { cancel?.dispose(); reject(e); }, timer });
      send({ id, method, params }).catch(e => { clearTimeout(timer); pending.delete(id); cancel?.dispose(); reject(new Error(String(e))); });
    });
  };
  const off = await listen<any>("language-message", e => {
    if (disposed || e.payload.sessionId !== sessionId) return;
    const message = e.payload.message;
    if (message.method === "textDocument/publishDiagnostics") {
      const model = monaco.editor.getModel(monaco.Uri.parse(message.params.uri));
      if (!model || !owns(model)) return;
      if (message.params.version != null && message.params.version < model.getVersionId()) return;
      monaco.editor.setModelMarkers(model, "clangd", message.params.diagnostics.map((d: any) => ({ ...range(d.range), message: d.message, source: "clangd", severity: d.severity === 1 ? monaco.MarkerSeverity.Error : d.severity === 2 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info })));
    } else if (message.id !== undefined && !message.method) {
      const p = pending.get(message.id);
      if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
    } else if (message.id !== undefined) {
      void send({ id: message.id, result: message.method === "workspace/configuration" ? message.params.items.map(() => null) : null });
    }
  });
  const offStatus = await listen<any>("language-status", e => {
    if (!disposed && e.payload.sessionId === sessionId) {
      onStatus("C++ stopped");
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("clangd stopped")); }
      pending.clear();
    }
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    off(); offStatus();
    for (const d of disposables) d.dispose();
    for (const [uri, listeners] of documents) {
      listeners.forEach(d => d.dispose());
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model) monaco.editor.setModelMarkers(model, "clangd", []);
    }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("Language session closed")); }
    pending.clear();
    void invoke("language_stop", { sessionId }).catch(() => {});
  };
  try {
    onStatus("C++ starting");
    const hasDatabase = await invoke<boolean>("language_start", { cwd: root, sessionId });
    if (!hasDatabase) log("C++: run Build: Generate Compilation Database from the command palette to resolve Arduino headers and board flags.");
    await request("initialize", { processId: null, rootUri: monaco.Uri.file(root).toString(), capabilities: { general: { positionEncodings: ["utf-16"] }, textDocument: { completion: { completionItem: { snippetSupport: true } }, hover: { contentFormat: ["markdown", "plaintext"] } } } });
    notify("initialized", {});
    const attach = (model: monaco.editor.ITextModel) => {
      if (!owns(model)) return;
      const uri = model.uri.toString();
      if (documents.has(uri)) return;
      notify("textDocument/didOpen", { textDocument: { uri, languageId: "cpp", version: model.getVersionId(), text: model.getValue() } });
      const listeners = [model.onDidChangeContent(() => notify("textDocument/didChange", { textDocument: { uri, version: model.getVersionId() }, contentChanges: [{ text: model.getValue() }] })), model.onWillDispose(() => {
        notify("textDocument/didClose", { textDocument: { uri } });
        documents.get(uri)?.forEach(d => d.dispose()); documents.delete(uri);
      })];
      documents.set(uri, listeners);
    };
    monaco.editor.getModels().forEach(attach);
    disposables.push(monaco.editor.onDidCreateModel(attach));
    const params = (m: monaco.editor.ITextModel, p: monaco.Position) => ({ textDocument: { uri: m.uri.toString() }, position: position(p) });
    const call = async (method: string, model: monaco.editor.ITextModel, params: any, token: monaco.CancellationToken) => {
      if (!owns(model)) return null;
      attach(model);
      try { return await request(method, params, token); } catch { return null; }
    };
    disposables.push(monaco.languages.registerCompletionItemProvider("cpp", {
      triggerCharacters: [".", ">", ":"],
      provideCompletionItems: async (m, p, _context, token) => {
        const result = await call("textDocument/completion", m, params(m, p), token);
        const word = m.getWordUntilPosition(p);
        return { suggestions: (Array.isArray(result) ? result : result?.items ?? []).map((item: any) => ({
          label: item.label, detail: item.detail, documentation: item.documentation ? contents(item.documentation)[0] : undefined,
          kind: item.kind ? Math.max(0, item.kind - 1) : monaco.languages.CompletionItemKind.Text,
          insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
          insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: item.textEdit?.range ? range(item.textEdit.range) : { startLineNumber: p.lineNumber, endLineNumber: p.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn },
          sortText: item.sortText, filterText: item.filterText,
          additionalTextEdits: item.additionalTextEdits?.map((e: any) => ({ range: range(e.range), text: e.newText })),
        })), incomplete: result?.isIncomplete ?? false };
      },
    }));
    disposables.push(monaco.languages.registerHoverProvider("cpp", { provideHover: async (m, p, t) => {
      const result = await call("textDocument/hover", m, params(m, p), t);
      return result ? { contents: contents(result.contents), range: result.range ? range(result.range) : undefined } : null;
    } }));
    const locations = (result: any) => (Array.isArray(result) ? result : result ? [result] : []).map((l: any) => ({ uri: monaco.Uri.parse(l.uri ?? l.targetUri), range: range(l.range ?? l.targetSelectionRange) }));
    disposables.push(monaco.languages.registerDefinitionProvider("cpp", { provideDefinition: async (m, p, t) => locations(await call("textDocument/definition", m, params(m, p), t)) }));
    disposables.push(monaco.languages.registerReferenceProvider("cpp", { provideReferences: async (m, p, context, t) => locations(await call("textDocument/references", m, { ...params(m, p), context }, t)) }));
    disposables.push(monaco.languages.registerDocumentFormattingEditProvider("cpp", { provideDocumentFormattingEdits: async (m, options, t) => {
      const result = await call("textDocument/formatting", m, { textDocument: {uri:m.uri.toString()}, options }, t);
      return result?.map((e: any) => ({ range: range(e.range), text: e.newText })) ?? [];
    } }));
    onStatus(hasDatabase ? "C++ ready" : "C++ needs build database");
    return { dispose };
  } catch (e) { dispose(); throw e; }
}
