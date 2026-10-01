/** Browser destinations bypass filesystem resolution and content search. */
export function clickUrl(token: string): string | null {
  const text = token.trim();
  if (/^https?:\/\//i.test(text)) {
    try { return new URL(text).href; } catch { return null; }
  }
  if (/^www\./i.test(text)) {
    try { return new URL(`https://${text}`).href; } catch { return null; }
  }
  const match = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#]\S*)?$/i.exec(text);
  if (!match) return null;
  if (/^\d/.test(match[1]) && match[1].split(".").some((part) => Number(part) > 255)) return null;
  try { return new URL(`http://${text}`).href; } catch { return null; }
}
