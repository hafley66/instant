import "./src/style.css";
import "./src/element";
import { createHighlighter } from "shiki";
import { shikiRefractor } from "./src/shikiTokens";
import * as fixture from "./src/fixture";

const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: ["text", "typescript"],
});
const { refractor, css } = shikiRefractor(highlighter, "github-dark");

const panels: Array<[string, string]> = [
  ["patch set 1 of sum.ts (jj diff --git)", fixture.typescriptPatchset],
  ["patch set 1 -> 2, real edit (jj interdiff --git)", fixture.typescriptInterdiff],
  ["patch set N -> N+1, pure rebase", fixture.pureRebase],
];

const app = document.querySelector("#app")!;
for (const [title, diffText] of panels) {
  const section = document.createElement("section");
  const h = document.createElement("h2");
  h.textContent = title;
  const el = document.createElement("patchset-diff");
  el.setAttribute("view-type", "split");
  el.refractor = refractor;
  el.diffText = diffText;
  section.append(h, el);
  app.append(section);
}

const sheet = document.createElement("style");
sheet.textContent = css();
document.head.append(sheet);
document.body.dataset.ready = "1";
