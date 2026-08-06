export function browserFileUrl(path: string, home = ""): string | null {
  if (!/\.html?$/i.test(path)) return null;
  const resolved = path.startsWith("~/") && home
    ? `${home.replace(/\/$/, "")}/${path.slice(2)}`
    : path;
  if (!resolved.startsWith("/")) return null;
  const url = new URL("file:///");
  url.pathname = resolved;
  return url.href;
}

export const htmlFileUrl = browserFileUrl;
