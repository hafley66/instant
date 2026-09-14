// A leading `~/` expands against a home dir supplied by the caller, so the
// browser URL and the backend doc-root probe agree on the absolute path.
export function expandHome(path: string, home = ""): string {
  if (!home || !path.startsWith("~/")) return path;
  return `${home.replace(/\/$/, "")}/${path.slice(2)}`;
}

export function browserFileUrl(path: string, home = ""): string | null {
  if (!/\.html?$/i.test(path)) return null;
  const resolved = expandHome(path, home);
  if (!resolved.startsWith("/")) return null;
  const url = new URL("file:///");
  url.pathname = resolved;
  return url.href;
}

export const htmlFileUrl = browserFileUrl;
