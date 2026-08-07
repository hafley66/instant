import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_FONTS, terminalFontCss } from "./0_terminalFonts";

describe("terminalFontCss", () => {
  it("serializes configured names and leaves CSS generic families bare", () => {
    expect({
      defaults: terminalFontCss(DEFAULT_TERMINAL_FONTS),
      configured: terminalFontCss(["MesloLGS Nerd Font Mono", "monospace"]),
      empty: terminalFontCss([]),
    }).toMatchInlineSnapshot(`
      {
        "configured": "\"MesloLGS Nerd Font Mono\", monospace",
        "defaults": "\"Menlo\", \"Hack Nerd Font Mono\", \"MesloLGS NF\", \"DejaVu Sans Mono for Powerline\", monospace",
        "empty": "\"Menlo\", \"Hack Nerd Font Mono\", \"MesloLGS NF\", \"DejaVu Sans Mono for Powerline\", monospace",
      }
    `);
  });
});
