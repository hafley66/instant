// VSCode-style command palette. A centered overlay with a fuzzy-filtered list of
// every titled Command (see keymap.ts). Open with ⌘P/⌘⇧K; type to filter, ↑/↓ to
// move, Enter to run the highlighted command, Esc to dismiss. Mirrors ctxmenu.ts'
// lifecycle (single open instance, dismiss on outside click / blur).
import { fuzzyFilter } from "./fuzzy";
import { paletteCommands, type Command } from "./keymap";

let openEl: HTMLElement | null = null;

// Most-recently-used command ids, newest first. Persisted so the palette opens
// with your recent commands on top (VSCode-style) across sessions.
const MRU_KEY = "cmdp.mru";
const MRU_CAP = 50;

function loadMru(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MRU_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function pushMru(id: string) {
  const next = [id, ...loadMru().filter((x) => x !== id)].slice(0, MRU_CAP);
  try {
    localStorage.setItem(MRU_KEY, JSON.stringify(next));
  } catch {
    // ignore quota / disabled storage
  }
}

// Stable-sort commands so recently-used ones lead, original order otherwise.
function byRecency(all: Command[]): Command[] {
  const rank = new Map(loadMru().map((id, i) => [id, i] as const));
  return [...all].sort(
    (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity),
  );
}

export function isPaletteOpen(): boolean {
  return openEl !== null;
}

function dismiss() {
  openEl?.remove();
  openEl = null;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("blur", dismiss);
  window.removeEventListener("resize", dismiss);
}

function onOutside(e: PointerEvent) {
  if (openEl && !openEl.contains(e.target as Node)) dismiss();
}

// The pretty label: "Group: Title" when grouped, else the title.
function label(c: Command): string {
  return c.group ? `${c.group}: ${c.title}` : c.title!;
}

// Render the first binding of a command as a small hint (⌘⇧P style). Best-effort:
// strips $mod -> ⌘ and joins the chord with the platform separator.
function keyHint(c: Command): string {
  const k = c.keys[0];
  if (!k) return "";
  return k
    .replace(/\$mod/gi, "⌘")
    .replace(/\bControl\b/gi, "⌃")
    .replace(/\bShift\b/gi, "⇧")
    .replace(/\bAlt\b/gi, "⌥")
    .replace(/\bMeta\b/gi, "⌘")
    .replace(/\bBracketRight\b/g, "]")
    .replace(/\bBracketLeft\b/g, "[")
    .replace(/\bEqual\b/g, "=")
    .replace(/\bMinus\b/g, "-")
    .replace(/Digit(\d)/g, "$1")
    .replace(/Key([A-Z])/g, "$1")
    .replace(/\+/g, "");
}

export function openPalette(): void {
  if (openEl) {
    dismiss();
    return;
  }
  const all = paletteCommands();
  if (all.length === 0) return;

  const root = document.createElement("div");
  root.className = "cmdp-root";
  // Click on the dimmed backdrop (the root itself, not the box) closes it. The
  // window-level onOutside can't catch this: the backdrop IS openEl, so it reads
  // as an inside click.
  root.addEventListener("pointerdown", (e) => {
    if (e.target === root) dismiss();
  });

  const box = document.createElement("div");
  box.className = "cmdp-box";
  root.appendChild(box);

  const input = document.createElement("input");
  input.className = "cmdp-input";
  input.type = "text";
  input.placeholder = "Type a command…";
  input.spellcheck = false;
  box.appendChild(input);

  const list = document.createElement("div");
  list.className = "cmdp-list";
  box.appendChild(list);

  let shown: Command[] = all;
  let active = 0;

  function render() {
    // Empty query: recently-used first, then a divider, then the rest. Typed
    // query: fuzzy rank by match (no divider — recency isn't the order).
    const q = input.value.trim();
    let dividerAfter = -1; // index of last recent command; -1 = no divider
    if (q) {
      shown = fuzzyFilter(q, all, label);
    } else {
      shown = byRecency(all);
      const recent = new Set(loadMru());
      const n = shown.filter((c) => recent.has(c.id)).length;
      if (n > 0 && n < shown.length) dividerAfter = n - 1;
    }
    if (active >= shown.length) active = Math.max(0, shown.length - 1);
    list.replaceChildren();
    const rows: HTMLElement[] = [];
    shown.forEach((c, i) => {
      const row = document.createElement("div");
      row.className = "cmdp-item" + (i === active ? " cmdp-active" : "");
      const name = document.createElement("span");
      name.className = "cmdp-label";
      name.textContent = label(c);
      row.appendChild(name);
      const hint = keyHint(c);
      if (hint) {
        const kb = document.createElement("span");
        kb.className = "cmdp-key";
        kb.textContent = hint;
        row.appendChild(kb);
      }
      row.onmousemove = () => {
        if (active === i) return;
        active = i;
        render();
      };
      row.onclick = () => choose(i);
      list.appendChild(row);
      rows.push(row);
      if (i === dividerAfter) {
        const sep = document.createElement("div");
        sep.className = "cmdp-divider";
        list.appendChild(sep);
      }
    });
    rows[active]?.scrollIntoView({ block: "nearest" });
  }

  function choose(i: number) {
    const cmd = shown[i];
    if (!cmd) return;
    pushMru(cmd.id);
    dismiss();
    cmd.run();
  }

  // Keydown on the input. Esc/Enter/arrows handled here; stopPropagation keeps
  // them off the window listeners (which would hide the overlay window on Esc).
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
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

  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);
}
