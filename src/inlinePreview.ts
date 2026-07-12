import { codeToHtml } from "shiki";
import { escapeHtml, SHIKI_LANG } from "./core";

export async function inlineSnippetHtml(path: string, text: string, dark: boolean): Promise<string> {
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
    return `<div class="term-inspector-code">${html}</div>${tail ? `<small>${tail}</small>` : ""}`;
  } catch {
    return `<pre>${escapeHtml(snippet)}${tail}</pre>`;
  }
}
