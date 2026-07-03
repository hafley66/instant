// Screen capture (region screenshot → active terminal), the recording toggle,
// the "send to terminal" picker, and the deferred blur-to-hide timer (shared
// with the OS-drop machinery, since showing a catcher/crosshair blurs us).
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { store } from "./state";
import { activeId } from "./core";
import { tabs, sendTextToTab, recentTabs } from "./terminal";

// While true, the blur-to-hide handler stands down (the screenshot crosshair
// steals focus, which would otherwise hide us mid-capture).
let capturing = false;
export const isCapturing = () => capturing;

// Blur-to-hide is deferred, not immediate: dragging a file in from Finder blurs
// us (the source app goes active), and an immediate hide would vanish the window
// before the drop lands. The pending hide is cancelled when a drag enters or
// focus returns.
let hideTimer: number | undefined;
export function cancelHide() {
  if (hideTimer !== undefined) {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}
// Schedule the deferred window hide (main's onFocusChanged owns the policy).
export function scheduleHide(fn: () => void, ms: number) {
  hideTimer = window.setTimeout(fn, ms);
}

// Hide the popover, let the user crosshair-select a region, return the saved PNG
// path (null on Esc / missing Screen Recording permission). Window is restored
// before returning; the blur guard stays up briefly so the focus settling after
// show() doesn't trip click-outside-to-hide.
async function captureRegion(): Promise<string | null> {
  const win = getCurrentWindow();
  capturing = true;
  await win.hide();
  let path: string | null = null;
  try {
    path = await invoke<string>("screenshot");
  } catch (e) {
    console.error("screenshot:", e);
  }
  await win.show();
  await win.setFocus();
  setTimeout(() => (capturing = false), 300);
  return path;
}

// Flip screen-capture recording on/off. Front owns the persisted flag; the
// backend mirrors it (and swaps the menu-bar icon) via capture_set_enabled.
// Shared by the Activity panel button and the tray menu item.
export function toggleRecording() {
  const on = !store.get().captureEnabled;
  store.set({ captureEnabled: on });
  invoke("capture_set_enabled", { on }).catch(console.error);
}

// Main Shot button: capture a region and send its path to the active terminal.
export async function captureToPrompt() {
  const id = activeId();
  const path = await captureRegion();
  if (path && id) await sendTextToTab(id, path + " ");
}

// "Send to" picker: a popover table of open terminals (recent first). Each row
// can receive a fresh screenshot or the active terminal's current selection.
export function openSendPicker(anchor: HTMLElement) {
  document.querySelector("#send-picker")?.remove();
  const list = recentTabs();
  const pop = document.createElement("div");
  pop.id = "send-picker";
  pop.className = "send-picker";

  const sel = tabs.get(activeId() ?? "")?.term.getSelection() ?? "";
  const head = document.createElement("div");
  head.className = "send-picker-head";
  head.textContent = list.length ? "send to terminal" : "no open terminals";
  pop.appendChild(head);

  const close = () => pop.remove();
  for (const t of list) {
    const row = document.createElement("div");
    row.className = "send-row";
    const name = document.createElement("span");
    name.className = "send-name";
    name.textContent = t.name + (t.id === activeId() ? " ·" : "");
    row.appendChild(name);

    const shot = document.createElement("button");
    shot.className = "send-act";
    shot.textContent = "📷 shot";
    shot.title = "screenshot a region and send it here";
    shot.onclick = async () => {
      close();
      const path = await captureRegion();
      if (path) await sendTextToTab(t.id, path + " ");
    };
    row.appendChild(shot);

    const sendSel = document.createElement("button");
    sendSel.className = "send-act";
    sendSel.textContent = "✎ selection";
    sendSel.title = sel ? "send the highlighted text here" : "no text selected";
    sendSel.disabled = !sel;
    sendSel.onclick = () => {
      close();
      if (sel) sendTextToTab(t.id, sel + " ");
    };
    row.appendChild(sendSel);
    pop.appendChild(row);
  }

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${r.bottom + 2}px`;

  const onOutside = (e: PointerEvent) => {
    if (!pop.contains(e.target as Node)) {
      close();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
}
