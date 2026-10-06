/**
 * A git remote as host/owner/repo, the same from any worktree or clone:
 * git@github.com:o/r.git, https://github.com/o/r and a cloud sandbox's
 * proxied http://…@127.0.0.1:port/git/o/r all become github.com/o/r.
 */
export function normalizeRemote(remote: string): string {
  const trimmed = remote
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scp = trimmed.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]}`;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const host = url.hostname.toLowerCase();
    const local = host === "localhost" || /^127\./.test(host);
    // A local proxy hides the real host; its last two segments are owner/repo.
    if (local && parts.length >= 2)
      return `github.com/${parts.slice(-2).join("/")}`;
    return `${host}/${parts.join("/")}`;
  } catch {
    return trimmed;
  }
}
