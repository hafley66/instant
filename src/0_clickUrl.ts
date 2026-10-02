import { parse } from "tldts";

/** Browser destinations bypass filesystem resolution and content search. */
export function clickUrl(token: string): string | null {
  const text = token.trim();
  if (/\s|[\\<>"`]/.test(text)) return null;
  if (/^https?:\/\//i.test(text)) {
    try { return new URL(text).href; } catch { return null; }
  }
  if (/^www\./i.test(text)) {
    try { return new URL(`https://${text}`).href; } catch { return null; }
  }
  const match = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(text);
  if (match) {
    if (/^\d/.test(match[1]) && match[1].split(".").some((part) => Number(part) > 255)) return null;
    try { return new URL(`http://${text}`).href; } catch { return null; }
  }
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?(?::\d{1,5})?(?:[/?#]\S*)?$/u.test(text)) return null;
  try {
    const explicitPort = /^[^/?#]+:\d+(?:[/?#]|$)/.test(text);
    const url = new URL(`${explicitPort ? "http" : "https"}://${text}`);
    const { domain, isIcann } = parse(url.hostname);
    const local = /\.(?:localhost|local|lan|internal|test)$/i.test(url.hostname);
    // These source-file extensions also happen to be public country suffixes.
    if (/\.(?:md|rs|sh|pl)$/i.test(url.hostname)) return null;
    if (!local && !(domain && isIcann) && !(explicitPort && !url.hostname.includes("."))) return null;
    if (local || url.port) url.protocol = "http:";
    return url.href;
  } catch { return null; }
}
