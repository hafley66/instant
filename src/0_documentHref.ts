export type DocumentHref = { path: string; line?: number };

function lineFrom(value: string): { value: string; line?: number } {
  const match = value.match(/^(.*):(\d+)(?::\d+)?$/);
  return match
    ? { value: match[1], line: Number(match[2]) }
    : { value };
}

export function documentHref(href: string, documentPath: string): DocumentHref | null {
  const base = new URL(`file://${documentPath.slice(0, documentPath.lastIndexOf("/") + 1)}`);
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }

  if (url.protocol === "vscode:" && url.hostname === "file") {
    const parsed = lineFrom(decodeURIComponent(url.pathname));
    return { path: parsed.value, ...(parsed.line ? { line: parsed.line } : {}) };
  }
  if (url.protocol !== "file:") return null;

  const parsed = lineFrom(decodeURIComponent(url.pathname));
  const fragment = url.hash.match(/^#L(\d+)(?:C\d+)?$/i);
  const line = fragment ? Number(fragment[1]) : parsed.line;
  return { path: parsed.value, ...(line ? { line } : {}) };
}
