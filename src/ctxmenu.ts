// Windows-XP-style right-click menu. The webview's native context menu is
// suppressed; we render our own #ctx-menu, styled per skin via tokens (XP =
// classic raised white menu, blue hover). The contextual item list is built by
// the caller (main.ts owns the actions), so this module stays action-agnostic.

export type CtxItem =
  | { label: string; action: () => void; disabled?: boolean }
  | { sep: true };

let openMenu: HTMLElement | null = null;

function dismiss() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener("pointerdown", onOutside, true);
  window.removeEventListener("blur", dismiss);
  window.removeEventListener("resize", dismiss);
  document.removeEventListener("scroll", dismiss, true);
}

function onOutside(e: PointerEvent) {
  if (openMenu && !openMenu.contains(e.target as Node)) dismiss();
}

// Render the menu at (x,y), flipping near the right/bottom edge so it stays
// on-screen. Dismisses on outside click, Esc, scroll, blur, or resize.
export function showContextMenu(x: number, y: number, items: CtxItem[]): void {
  dismiss();
  if (items.length === 0) return;

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const item of items) {
    if ("sep" in item) {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      menu.appendChild(s);
      continue;
    }
    const row = document.createElement("div");
    row.className = "ctx-item" + (item.disabled ? " ctx-disabled" : "");
    row.textContent = item.label;
    if (!item.disabled) {
      row.onclick = () => {
        dismiss();
        item.action();
      };
    }
    menu.appendChild(row);
  }

  // Off-screen measure, then clamp/flip into the viewport.
  menu.style.visibility = "hidden";
  document.body.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  const left = x + width > window.innerWidth ? Math.max(0, x - width) : x;
  const top = y + height > window.innerHeight ? Math.max(0, y - height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "visible";

  openMenu = menu;
  document.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);
  document.addEventListener("scroll", dismiss, true);
}

// Suppress the native menu and render ours; `itemsFor` maps the event target to
// the contextual item list. Esc also dismisses.
export function wireContextMenu(itemsFor: (target: HTMLElement) => CtxItem[]): void {
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, itemsFor(e.target as HTMLElement));
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss();
  });
}
