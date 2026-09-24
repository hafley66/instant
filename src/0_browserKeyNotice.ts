// Browser mode (instant-serve): notices for $mod bindings that override a browser
// default, and for bound combos Chrome never delivers to the page.
import type { Command, KeymapFire } from "./keymap";

// Combos Chrome keeps for itself; the page never sees the keydown.
export const BROWSER_RESERVED = ["$mod+w", "$mod+t", "$mod+n", "$mod+Shift+t"];

// Browser actions a $mod binding displaces. Keys in tinykeys syntax, compared
// case-insensitively against the command table's bindings.
export const BROWSER_DEFAULTS: Record<string, string> = {
  "$mod+r": "reload",
  "$mod+Shift+r": "hard reload",
  "$mod+Equal": "zoom in",
  "$mod+Shift+Equal": "zoom in",
  "$mod+Minus": "zoom out",
  "$mod+Digit0": "zoom reset",
  "$mod+Shift+BracketRight": "next tab",
  "$mod+Shift+BracketLeft": "previous tab",
  "$mod+Shift+o": "bookmark manager",
  "$mod+Shift+d": "bookmark all tabs",
  "$mod+Shift+m": "profile switcher",
  "$mod+Shift+j": "downloads",
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`$mod+${i + 1}`, `tab ${i + 1}`])),
};

const norm = (key: string) => key.toLowerCase();
const RESERVED = new Set(BROWSER_RESERVED.map(norm));
const DEFAULTS = new Map(Object.entries(BROWSER_DEFAULTS).map(([k, v]) => [norm(k), v]));

const MAC_GLYPH: Record<string, string> = { $mod: "⌘", meta: "⌘", shift: "⇧", control: "⌃", alt: "⌥" };
const PC_GLYPH: Record<string, string> = { $mod: "Ctrl+", meta: "Win+", shift: "Shift+", control: "Ctrl+", alt: "Alt+" };
const KEY_GLYPH: Record<string, string> = {
  bracketright: "]",
  bracketleft: "[",
  equal: "=",
  minus: "-",
  backslash: "\\",
  tab: "Tab",
};

// "$mod+Shift+t" -> "⌘⇧T" on mac, "Ctrl+Shift+T" elsewhere.
export function comboLabel(key: string, mac: boolean): string {
  const parts = key.split("+");
  const last = parts.pop() ?? "";
  const glyphs = mac ? MAC_GLYPH : PC_GLYPH;
  const mods = parts.map((m) => glyphs[m.toLowerCase()] ?? `${m}+`).join("");
  const k = last.toLowerCase();
  const name = KEY_GLYPH[k] ?? (/^digit\d$/.test(k) ? k.slice(5) : last.length === 1 ? last.toUpperCase() : last);
  return mods + name;
}

const commandName = (c: Command) => c.title ?? c.id;

export function overrideNotice(command: Command, key: string, mac: boolean): string | null {
  const action = DEFAULTS.get(norm(key));
  return action ? `${comboLabel(key, mac)} → instant: ${commandName(command)} (browser ${action} overridden)` : null;
}

export function reservedNotice(commands: Command[], mac: boolean): string | null {
  const blocked = commands.flatMap((c) =>
    c.keys.filter((k) => RESERVED.has(norm(k))).map((k) => `${comboLabel(k, mac)} (${commandName(c)})`),
  );
  if (!blocked.length) return null;
  const paletteKey = commands.find((c) => c.id === "palette.open")?.keys[0];
  const palette = paletteKey ? `the palette (${comboLabel(paletteKey, mac)})` : "the palette";
  return `The browser keeps ${blocked.join(", ")} for itself — run them from ${palette}`;
}

export interface NoticeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const NOTICE_STORE_KEY = "instant.browserKeyNotices";
export const STARTUP_NOTICE_MS = 8000;

// One notice per combo (and one startup notice) per session; the seen set lives
// in sessionStorage so a ⌘R reload does not repeat it.
export function browserKeyNotices(
  commands: Command[],
  flash: (msg: string, ms?: number) => void,
  store: NoticeStore | undefined,
  mac: boolean,
): { onFire: KeymapFire; startup: () => void } {
  const seen = new Set<string>(JSON.parse(store?.getItem(NOTICE_STORE_KEY) ?? "[]") as string[]);
  const once = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    store?.setItem(NOTICE_STORE_KEY, JSON.stringify([...seen]));
    return true;
  };
  return {
    onFire: (command, key) => {
      const msg = overrideNotice(command, key, mac);
      if (msg && once(norm(key))) flash(msg);
    },
    startup: () => {
      if (!once("startup")) return;
      const msg = reservedNotice(commands, mac);
      if (msg) flash(msg, STARTUP_NOTICE_MS);
    },
  };
}
