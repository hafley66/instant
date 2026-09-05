// ⌘⇧J: jump to a file the focused pane's agent touched. The rows come from
// boop's ledger (agent_touch), newest first, so the list is "where the agent
// is" rather than the whole repo. Typing filters; Enter opens the row in
// Instant; a query that matches no row runs the ⌘-click ladder on the text,
// and ⌘Enter greps the text from the pane cwd.
import { invoke } from "./generated/native";
import { fuzzyFilter } from "./fuzzy";
import { getHomeDir } from "./core";
import { jumpLabel } from "./0_jumpLabel";
import { dispatchClick, runClickRule } from "./clickrules";
import { openPathInInstant } from "./preview";
import { getFocusedTermId, tabMetaById, tabSessionIds } from "./terminal";

export type AgentTouchRow = { path: string; session: string; turn: number; ts: number; verb: string };

let openEl: HTMLElement | null = null;
let onOutside: ((e: Event) => void) | null = null;

export function isJumpOpen(): boolean {
  return openEl !== null;
}

function dismiss() {
  openEl?.remove();
  openEl = null;
  if (onOutside) {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("mousedown", onOutside, true);
    onOutside = null;
  }
  window.removeEventListener("blur", dismiss);
  window.removeEventListener("resize", dismiss);
}

export async function openJumpPalette(): Promise<void> {
  if (openEl) {
    dismiss();
    return;
  }
  const id = getFocusedTermId();
  const cwd = id ? tabMetaById(id)?.cwd ?? "" : "";
  const sessions = id ? await tabSessionIds(id) : [];
  const home = getHomeDir();
  let rows: AgentTouchRow[] = [];
  try {
    rows = sessions.length ? await invoke<AgentTouchRow[]>("boop_agent_touches", { sessions, limit: 2000 }) : [];
  } catch {
    rows = [];
  }

  const root = document.createElement("div");
  root.className = "cmdp-root";
  const box = document.createElement("div");
  box.className = "cmdp-box";
  root.appendChild(box);
  const input = document.createElement("input");
  input.className = "cmdp-input";
  input.type = "text";
  input.placeholder = rows.length
    ? `${rows.length} files the agent touched · Enter opens · ⌘Enter greps`
    : sessions.length
      ? "no touched files recorded for this pane · Enter resolves the text · ⌘Enter greps"
      : "no agent session on this pane · Enter resolves the text · ⌘Enter greps";
  input.spellcheck = false;
  box.appendChild(input);
  const list = document.createElement("div");
  list.className = "cmdp-list";
  box.appendChild(list);

  let shown: AgentTouchRow[] = rows;
  let active = 0;
  const labelOf = (row: AgentTouchRow) => jumpLabel(row.path, cwd, home);

  function render() {
    const q = input.value.trim();
    shown = q ? fuzzyFilter(q, rows, labelOf) : rows;
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    list.replaceChildren();
    const els: HTMLElement[] = [];
    shown.slice(0, 200).forEach((row, i) => {
      const el = document.createElement("div");
      el.className = "cmdp-item" + (i === active ? " cmdp-active" : "");
      const name = document.createElement("span");
      name.className = "cmdp-label";
      name.textContent = labelOf(row);
      el.appendChild(name);
      const hint = document.createElement("span");
      hint.className = "cmdp-key";
      hint.textContent = `${row.verb || "touch"} · turn ${row.turn}`;
      el.appendChild(hint);
      el.onmousemove = () => {
        if (active === i) return;
        active = i;
        render();
      };
      el.onclick = () => void choose(i);
      list.appendChild(el);
      els.push(el);
    });
    els[active]?.scrollIntoView({ block: "nearest" });
  }

  async function choose(i: number) {
    const q = input.value.trim();
    const row = shown[i];
    dismiss();
    if (row) {
      await openPathInInstant(row.path);
      return;
    }
    if (q) await dispatchClick(q, cwd, "terminal", sessions);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    } else if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const q = input.value.trim();
      dismiss();
      if (q) void runClickRule(q, cwd);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void choose(active);
    } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey) || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (shown.length) active = (active + 1) % shown.length;
      render();
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey) || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (shown.length) active = (active - 1 + shown.length) % shown.length;
      render();
    }
  });
  input.addEventListener("input", () => {
    active = 0;
    render();
  });

  document.body.appendChild(root);
  openEl = root;
  render();
  input.focus();
  onOutside = (e: Event) => {
    if (!box.contains(e.target as Node)) dismiss();
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);
}
