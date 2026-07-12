import { codeToHtml } from "shiki";
import { escapeHtml, SHIKI_LANG } from "./core";

const htmlCache = new Map<string, string>();

export async function inlineSnippetHtml(path: string, text: string, dark: boolean): Promise<string> {
  const key = `${path}:${dark ? "dark" : "light"}:${text.length}:${text.slice(0, 128)}`;
  const cached = htmlCache.get(key);
  if (cached) return cached;
  const lines = text.split("\n");
  const snippet = lines.slice(0, 10).join("\n");
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const lang = SHIKI_LANG[ext] || SHIKI_LANG[name.toLowerCase()] || "text";
  const tail = lines.length > 10 ? "\n…" : "";
  try {
    const html = await codeToHtml(snippet, {
      lang,
      theme: dark ? "github-dark" : "github-light",
    });
    const result = `<div class="term-inspector-code">${html}</div>${tail ? `<small>${tail}</small>` : ""}`;
    htmlCache.set(key, result);
    return result;
  } catch {
    return `<pre>${escapeHtml(snippet)}${tail}</pre>`;
  }
}
