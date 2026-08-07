export const DEFAULT_TERMINAL_FONTS = [
  "Menlo",
  "Hack Nerd Font Mono",
  "MesloLGS NF",
  "DejaVu Sans Mono for Powerline",
  "monospace",
];

const CSS_GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace",
]);

export function terminalFontCss(fonts: string[]): string {
  const names = fonts.map((font) => font.trim()).filter(Boolean);
  const configured = names.length ? names : DEFAULT_TERMINAL_FONTS;
  return configured
    .map((font) => CSS_GENERIC_FAMILIES.has(font.toLowerCase())
      ? font
      : JSON.stringify(font.replace(/^['"]|['"]$/g, "")))
    .join(", ");
}
