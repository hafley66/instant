// Actionable "install ImageMagick" affordance for the meme panel. Shown when
// the Slack-emoji export fails because magick/convert isn't on PATH (see
// src-tauri/src/meme.rs make_slack_emoji) or the magick_available() probe
// says it's missing. Split out of meme.tsx (already over AGENTS.md's 500-line
// cap) so wiring this in doesn't grow that file.
import { sessionId, baseName, tmuxName } from "./core";
import { openTab, sendTextToTab, tabs } from "./terminal";
import { probeMagickAvailable } from "./memeExport";

export const BREW_INSTALL_CMD = "brew install imagemagick";

const HINT_ID = "meme-magick-hint";
// Anchor: the hint is inserted directly above the workspace, inside the
// panel that's already rendered by meme.tsx's JSX — no new DOM nodes need to
// come from that file.
const ANCHOR_SELECTOR = "#meme-workspace";

export function showMagickInstallHint() {
  if (document.getElementById(HINT_ID)) return;
  const host = document.querySelector(ANCHOR_SELECTOR);
  if (!host) return;
  const el = document.createElement("div");
  el.id = HINT_ID;
  el.className = "meme-magick-hint";
  el.innerHTML =
    `<span>Slack emoji export needs ImageMagick &mdash; </span>` +
    `<code>${BREW_INSTALL_CMD}</code>` +
    `<button type="button" data-act="install">Install in terminal</button>` +
    `<button type="button" data-act="copy">Copy</button>` +
    `<button type="button" data-act="recheck">Check again</button>`;
  el.querySelector('[data-act="install"]')?.addEventListener("click", installInNewTerminalTab);
  el.querySelector('[data-act="copy"]')?.addEventListener("click", () => {
    void navigator.clipboard.writeText(BREW_INSTALL_CMD);
  });
  el.querySelector('[data-act="recheck"]')?.addEventListener("click", () => void recheckMagick());
  host.insertAdjacentElement("beforebegin", el);
}

export function hideMagickInstallHint() {
  document.getElementById(HINT_ID)?.remove();
}

// Probe once (panel mount, or the hint's own "Check again" button) and
// show/hide the hint to match. Returns availability so a caller can also
// decide whether to bother attempting the export.
export async function recheckMagick(): Promise<boolean> {
  const ok = await probeMagickAvailable();
  if (ok) hideMagickInstallHint();
  else showMagickInstallHint();
  return ok;
}

// Open a fresh terminal tab and type (not run) the brew install command, so
// the user reviews it and hits Enter themselves rather than a package install
// firing unattended. Naming mirrors openTabAtPwd's collision-free scheme
// (src/tabs.ts).
function installInNewTerminalTab() {
  const taken = new Set([...tabs.values()].map((t) => t.name));
  const base = tmuxName(baseName("imagemagick-install"));
  let name = base;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  openTab(name);
  // openTab's pty spawn (src/terminal.ts) is fire-and-forget over
  // invoke("open_session") with no "ready" signal to await, so give the new
  // session a beat before writing into it.
  setTimeout(() => void sendTextToTab(sessionId(name), BREW_INSTALL_CMD), 400);
}
