import { describe, expect, it } from "vitest";
import { d2ThemeId, diagramPalette, mermaidTheme } from "./0_diagramTheme";

describe("diagram themes", () => {
  it("keeps text, surfaces, and renderer selections paired by mode", () => {
    expect({
      light: {
        palette: diagramPalette.light,
        mermaid: mermaidTheme(false),
        d2: d2ThemeId(false),
      },
      dark: {
        palette: diagramPalette.dark,
        mermaid: mermaidTheme(true),
        d2: d2ThemeId(true),
      },
    }).toMatchInlineSnapshot(`
      {
        "dark": {
          "d2": 200,
          "mermaid": {
            "theme": "base",
            "themeVariables": {
              "background": "#0f172a",
              "clusterBkg": "#0f172a",
              "clusterBorder": "#94a3b8",
              "edgeLabelBackground": "#0f172a",
              "lineColor": "#cbd5e1",
              "mainBkg": "#1e293b",
              "nodeBorder": "#94a3b8",
              "primaryBorderColor": "#94a3b8",
              "primaryColor": "#1e293b",
              "primaryTextColor": "#f8fafc",
              "secondaryBorderColor": "#94a3b8",
              "secondaryColor": "#172554",
              "secondaryTextColor": "#f8fafc",
              "tertiaryBorderColor": "#94a3b8",
              "tertiaryColor": "#3f1d2e",
              "tertiaryTextColor": "#f8fafc",
              "textColor": "#f8fafc",
            },
          },
          "palette": {
            "background": "#0f172a",
            "border": "#94a3b8",
            "line": "#cbd5e1",
            "surface": "#1e293b",
            "surfaceAlt": "#172554",
            "surfaceMuted": "#3f1d2e",
            "text": "#f8fafc",
          },
        },
        "light": {
          "d2": 8,
          "mermaid": {
            "theme": "base",
            "themeVariables": {
              "background": "#f8fafc",
              "clusterBkg": "#f8fafc",
              "clusterBorder": "#475569",
              "edgeLabelBackground": "#f8fafc",
              "lineColor": "#334155",
              "mainBkg": "#e0e7ff",
              "nodeBorder": "#475569",
              "primaryBorderColor": "#475569",
              "primaryColor": "#e0e7ff",
              "primaryTextColor": "#111827",
              "secondaryBorderColor": "#475569",
              "secondaryColor": "#dcfce7",
              "secondaryTextColor": "#111827",
              "tertiaryBorderColor": "#475569",
              "tertiaryColor": "#fef3c7",
              "tertiaryTextColor": "#111827",
              "textColor": "#111827",
            },
          },
          "palette": {
            "background": "#f8fafc",
            "border": "#475569",
            "line": "#334155",
            "surface": "#e0e7ff",
            "surfaceAlt": "#dcfce7",
            "surfaceMuted": "#fef3c7",
            "text": "#111827",
          },
        },
      }
    `);
  });
});
