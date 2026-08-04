export function htmlFileUrl(path: string): string | null {
  if (!/\.html?$/i.test(path)) return null;
  const url = new URL("file:///");
  url.pathname = path;
  return url.href;
}
