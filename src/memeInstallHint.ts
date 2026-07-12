// Actionable "install ImageMagick" affordance for the meme panel. Shown when
// the Slack-emoji export fails because magick/convert isn't on PATH (see
// src-tauri/src/meme.rs make_slack_emoji) or the magick_available() probe
// says it's missing. Split out of meme.tsx (already over AGENTS.md's 500-line
// cap) so wiring this in doesn't grow that file.
//
// The "Install" button's click is the user's consent to run
// `brew install imagemagick` server-side (install_imagemagick in
// src-tauri/src/meme.rs) — frontend asks, backend runs. No terminal tab, no
// typed-not-executed command.
import { invoke } from "./generated/native";
import { flashStatus, showError } from "./core";
import { probeMagickAvailable } from "./memeExport";

export const BREW_INSTALL_CMD = "brew install imagemagick";

const HINT_ID = "meme-magick-hint";
// Anchor: the hint is inserted directly above the split layout, inside the
// panel that's already rendered by meme.tsx's JSX — no new DOM nodes need to
// come from that file. Must target .meme-split-root, not the #meme-workspace
// PanelGroup inside it: that root is a horizontal flex row, so a sibling of
// the PanelGroup renders as a column beside it instead of a banner above.
const ANCHOR_SELECTOR = ".meme-split-root";

// Guards a double-click from firing invoke() twice; Rust also guards this
// server-side with an AtomicBool (install_imagemagick) in case this flag and
// the button's disabled state ever disagree.
let installing = false;

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
    `<button type="button" data-act="install">Install</button>` +
    `<button type="button" data-act="copy">Copy</button>` +
    `<button type="button" data-act="recheck">Check again</button>`;
  el.querySelector('[data-act="install"]')?.addEventListener("click", () => void installMagick());
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

function installButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`#${HINT_ID} [data-act="install"]`);
}

function setInstallButtonBusy(busy: boolean) {
  const btn = installButton();
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = busy ? "Installing…" : "Install";
}

// Run the install server-side (invoke install_imagemagick, src-tauri/src/meme.rs).
// This can take minutes, so the hint stays visible with the button disabled
// and relabeled rather than the hint disappearing mid-install.
async function installMagick(): Promise<void> {
  if (installing) return;
  installing = true;
  setInstallButtonBusy(true);
  try {
    const result = await invoke<string>("install_imagemagick");
    flashStatus(result);
    const ok = await recheckMagick(); // hides the hint on success
    if (!ok) setInstallButtonBusy(false); // still missing somehow; let the user retry
  } catch (e) {
    setInstallButtonBusy(false);
    showError("meme-install", e);
  } finally {
    installing = false;
  }
}
