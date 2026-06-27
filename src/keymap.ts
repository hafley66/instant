// Central keybinding table. One list of Commands drives BOTH the window-level
// listener (tinykeys) and the per-event matcher the xterm key handler uses to
// decide whether a combo is an app command (and so must NOT be typed into the
// pty). Keys use tinykeys syntax: "$mod" = Cmd on mac / Ctrl elsewhere; prefer
// KeyboardEvent.code names (BracketRight, Digit1) over characters so Shifted
// combos still match regardless of layout remapping (Shift+] -> "}").
import {
  tinykeys,
  parseKeybinding,
  matchKeybindingPress,
  type KeybindingPress,
} from "tinykeys";

export interface Command {
  id: string;
  keys: string[]; // one or more bindings, tinykeys syntax
  run: () => void;
  // Human label shown in the command palette. Optional so a binding can stay
  // palette-hidden (e.g. tab.goto1..9); only titled commands are listed.
  title?: string;
  // Optional grouping label for the palette ("Tabs", "Overlay", …).
  group?: string;
}

// The commands the palette should list (those with a title). Stashed by
// installKeymap so the palette and keymap share one source.
let registered: Command[] = [];
export function paletteCommands(): Command[] {
  return registered.filter((c) => c.title);
}

let unbind: (() => void) | null = null;
// Single-press bindings flattened for the per-event matcher (xterm passthrough).
// Sequences (multi-press) are window-only and skipped here.
let presses: { press: KeybindingPress; run: () => void }[] = [];

// Bind every command on `target` (default window). ignore:() => false so combos
// fire even while a form/terminal element is focused — the xterm handler then
// stops propagation for matched combos so they don't double-run.
export function installKeymap(commands: Command[], target: Window = window): void {
  unbind?.();
  registered = commands;
  const map: Record<string, (e: KeyboardEvent) => void> = {};
  presses = [];
  for (const c of commands) {
    for (const k of c.keys) {
      map[k] = (e) => {
        e.preventDefault();
        c.run();
      };
      const seq = parseKeybinding(k);
      if (seq.length === 1) presses.push({ press: seq[0], run: c.run });
    }
  }
  unbind = tinykeys(target, map, { ignore: () => false });
}

// For xterm's attachCustomKeyEventHandler: if this event is a bound command,
// run it and return true so the caller swallows the key (no pty write) and
// stops it bubbling to the window listener (no double-run).
export function runMatchingCommand(e: KeyboardEvent): boolean {
  for (const { press, run } of presses) {
    if (matchKeybindingPress(e, press)) {
      e.preventDefault();
      run();
      return true;
    }
  }
  return false;
}
