export type BuildDiagnostic = { path: string; line: number; column: number; severity: "error" | "warning" | "note"; message: string };
/** GCC/Clang paths may contain spaces or a Windows drive colon. */
export function parseDiagnostic(text: string, root: string): BuildDiagnostic | null {
  const match = text.match(/^(.+?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.*)$/);
  if (!match) return null;
  const path = /^(\/|[A-Za-z]:[\\/])/.test(match[1]) ? match[1] : `${root}/${match[1]}`;
  return { path, line: Number(match[2]), column: Number(match[3] ?? 1), severity: match[4] === "fatal error" ? "error" : match[4] as BuildDiagnostic["severity"], message: match[5] };
}
