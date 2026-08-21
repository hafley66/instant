export const diagramPalette = {
  light: {
    background: "#f8fafc",
    surface: "#e0e7ff",
    surfaceAlt: "#dcfce7",
    surfaceMuted: "#fef3c7",
    text: "#111827",
    border: "#475569",
    line: "#334155",
  },
  dark: {
    background: "#0f172a",
    surface: "#1e293b",
    surfaceAlt: "#172554",
    surfaceMuted: "#3f1d2e",
    text: "#f8fafc",
    border: "#94a3b8",
    line: "#cbd5e1",
  },
} as const;

export function mermaidTheme(dark: boolean) {
  const palette = dark ? diagramPalette.dark : diagramPalette.light;
  return {
    theme: "base" as const,
    themeVariables: {
      background: palette.background,
      primaryColor: palette.surface,
      primaryTextColor: palette.text,
      primaryBorderColor: palette.border,
      secondaryColor: palette.surfaceAlt,
      secondaryTextColor: palette.text,
      secondaryBorderColor: palette.border,
      tertiaryColor: palette.surfaceMuted,
      tertiaryTextColor: palette.text,
      tertiaryBorderColor: palette.border,
      lineColor: palette.line,
      textColor: palette.text,
      mainBkg: palette.surface,
      nodeBorder: palette.border,
      clusterBkg: palette.background,
      clusterBorder: palette.border,
      edgeLabelBackground: palette.background,
      // Sequence diagrams derive their own colours from the surface variables
      // rather than from textColor, which lands actor and note text within a
      // few points of the background (measured: rgb(30,41,59) text on a
      // rgb(15,23,42) background). Name every one of them.
      actorBkg: palette.surface,
      actorBorder: palette.border,
      actorTextColor: palette.text,
      actorLineColor: palette.line,
      signalColor: palette.line,
      signalTextColor: palette.text,
      labelBoxBkgColor: palette.surfaceAlt,
      labelBoxBorderColor: palette.border,
      labelTextColor: palette.text,
      loopTextColor: palette.text,
      noteBkgColor: palette.surfaceMuted,
      noteBorderColor: palette.border,
      noteTextColor: palette.text,
      activationBkgColor: palette.surfaceAlt,
      activationBorderColor: palette.border,
      sequenceNumberColor: palette.background,
      // State, class, and ER diagrams reach for the same kind of derived slots.
      labelColor: palette.text,
      altBackground: palette.surfaceAlt,
      classText: palette.text,
      attributeBackgroundColorOdd: palette.surface,
      attributeBackgroundColorEven: palette.surfaceAlt,
    },
  };
}

// D2 built-in themes: Colorblind Clear for light surfaces, Dark Mauve for dark.
export function d2ThemeId(dark: boolean): number {
  return dark ? 200 : 8;
}
