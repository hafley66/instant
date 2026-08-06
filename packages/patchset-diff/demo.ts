import "./src/style.css";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { createHighlighter } from "shiki";
import { shikiRefractor } from "./src/shikiTokens";
import { gitSource, jjSource, type Run } from "./src/jj";
import { PatchRange } from "./src/PatchRange";

const params = new URLSearchParams(location.search);
const repo = params.get("repo") === "lab" ? "/private/tmp/claude-501/-Users-chrishafley-projects-instant/40bf140a-130c-4bcf-99ed-7959b5287330/scratchpad/ts-lab" : "/Users/chrishafley/projects/instant/.worktrees/patchset-ui";
const useJj = params.get("repo") === "lab";

const run: Run = async (bin, args, encoding) => {
  const response = await fetch("/_run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bin, args, cwd: repo, encoding }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? response.statusText);
  return payload.stdout as string;
};

// Grammars arrive per file via refractor.ensure, so none are preloaded.
const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["text"] });
const { refractor, install } = shikiRefractor(highlighter, "github-dark");
install();

createRoot(document.querySelector("#app")!).render(
  createElement(PatchRange, {
    source: useJj ? jjSource(run) : gitSource(run, "origin/main"),
    changeId: useJj ? "luovuknyzrmu" : "refs/patchsets/feat/patchset-diff",
    repoHint: repo,
    viewType: "split",
    refractor,
  }),
);
