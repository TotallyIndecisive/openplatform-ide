/** A non-secret author preference used only by OpenPlatform commits. */
export type GitAuthor = { name: string; email: string };
const authorKey = "openplatform:git-author";
export function readGitAuthor(): GitAuthor | null {
  try {
    const value = JSON.parse(localStorage.getItem(authorKey) || "null");
    if (
      typeof value?.name === "string" &&
      typeof value?.email === "string" &&
      value.name.trim() &&
      value.email.trim()
    )
      return { name: value.name.trim(), email: value.email.trim() };
  } catch {
    /* Invalid or unavailable local preferences leave Git's own configuration in charge. */
  }
  return null;
}
export function saveGitAuthor(author: GitAuthor | null) {
  if (author) localStorage.setItem(authorKey, JSON.stringify(author));
  else localStorage.removeItem(authorKey);
}
