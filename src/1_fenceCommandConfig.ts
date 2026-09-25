import type { MdFenceCommand } from "@hafley66/md/plugins";
import { settings } from "./0_settings";
import { DEFAULT_FENCE_COMMANDS } from "./state";
import { addPreviewPanel } from "./reactdock";

const key = "config:fenceCommands";
let panel: HTMLElement | null = null;

export function openFenceCommandConfigPanel() {
  panel ??= document.createElement("div");
  panel.className = "rg-panel";
  const el = panel;
  el.innerHTML =
    `<div class="rg-head">fence commands <span class="rg-count">Markdown code blocks</span></div>` +
    `<div class="rg-body rg-cfg-body">` +
    `<div class="rg-cfg-help">Rules match the fence <b>language</b> with a JS regex. ` +
    `<code>$1</code> is the quoted temporary file path, <code>$WIDTH</code> is the column count, ` +
    `and <code>$LANG</code> is the language. <b>replace</b> uses stdout as the code block; ` +
    `<b>annotate</b> adds stdout below it.</div>` +
    `<textarea class="rg-cfg-ta" spellcheck="false"></textarea>` +
    `<div class="rg-cfg-row"><button class="rg-cfg-save">save</button>` +
    `<button class="rg-cfg-reset">reset</button><span class="rg-cfg-msg"></span></div>` +
    `</div>`;
  const ta = el.querySelector<HTMLTextAreaElement>(".rg-cfg-ta")!;
  const msg = el.querySelector<HTMLElement>(".rg-cfg-msg")!;
  ta.value = JSON.stringify(settings.fenceCommands.$() ?? DEFAULT_FENCE_COMMANDS, null, 2);
  el.querySelector<HTMLElement>(".rg-cfg-save")?.addEventListener("click", () => {
    try {
      const parsed: unknown = JSON.parse(ta.value);
      if (!Array.isArray(parsed) || !parsed.every((rule) =>
        rule !== null && typeof rule === "object" &&
        typeof rule.match === "string" && typeof rule.command === "string" &&
        (rule.as === "replace" || rule.as === "annotate"))) {
        throw new Error("expected [{match, command, as: replace|annotate}, …]");
      }
      for (const rule of parsed) new RegExp(rule.match);
      settings.fenceCommands.$(parsed as MdFenceCommand[]);
      msg.textContent = "saved";
    } catch (error) {
      msg.textContent = String(error);
    }
  });
  el.querySelector<HTMLElement>(".rg-cfg-reset")?.addEventListener("click", () => {
    settings.fenceCommands.$(null);
    ta.value = JSON.stringify(DEFAULT_FENCE_COMMANDS, null, 2);
    msg.textContent = "reset";
  });
  addPreviewPanel(key, "fence commands", el, "right");
}
