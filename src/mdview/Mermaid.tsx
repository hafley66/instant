// Mermaid diagram block for the mdview panel: renders fenced ```mermaid code
// to SVG with the mermaid package and gives it normal zoom + pan with
// svg-pan-zoom (wheel zoom, drag pan, on-screen +/- / reset controls).
// Both libs are lazy-loaded: mermaid + d3 weigh ~1MB, so they only land when
// a document actually contains a diagram.
import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";

type Mermaid = typeof import("mermaid")["default"];
let mermaidP: Promise<Mermaid> | null = null;
const loadMermaid = () => (mermaidP ??= import("mermaid").then((m) => m.default));

// Rendered-SVG cache (mermaid.render does DOM measurement — skip it when a
// section re-expands). Keyed by theme+code; svg-pan-zoom re-attaches per mount.
const svgCache = new Map<string, string>();
let renderSeq = 0;
let initializedTheme: string | null = null;

function MermaidDiagram({ code, dark, onError }: { code: string; dark: boolean; onError: (msg: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const themeName = dark ? "dark" : "default";
  const [svg, setSvg] = useState<string | null>(() => svgCache.get(`${themeName}|${code}`) ?? null);

  useEffect(() => {
    const key = `${themeName}|${code}`;
    const hit = svgCache.get(key);
    if (hit != null) {
      setSvg(hit);
      return;
    }
    let dead = false;
    loadMermaid()
      .then(async (mermaid) => {
        if (initializedTheme !== themeName) {
          mermaid.initialize({ startOnLoad: false, theme: themeName, securityLevel: "strict" });
          initializedTheme = themeName;
        }
        const { svg: raw } = await mermaid.render(`mdview-mmd-${++renderSeq}`, code);
        // strict mode already escapes labels; sanitize the generated markup
        // anyway (repo posture: no unsanitized HTML into the DOM, see preview.ts).
        const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { svg: true, svgFilters: true } });
        if (svgCache.size > 60) svgCache.clear();
        svgCache.set(key, clean);
        if (!dead) setSvg(clean);
      })
      .catch((e) => {
        if (!dead) onError(String((e as Error)?.message ?? e));
      });
    return () => {
      dead = true;
    };
  }, [code, themeName, onError]);

  // (Re)attach pan/zoom whenever the svg mounts. Mermaid emits width styled to
  // max-width + a fixed height attr; normalize to fill the box so fit/center work.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !svg) return;
    const el = host.querySelector("svg");
    if (!el) return;
    el.removeAttribute("height");
    el.style.maxWidth = "none";
    el.style.width = "100%";
    el.style.height = "100%";
    let zp: { destroy(): void } | null = null;
    let dead = false;
    import("svg-pan-zoom")
      .then((m) => {
        if (dead) return;
        zp = m.default(el, {
          zoomEnabled: true,
          controlIconsEnabled: true, // the little +/- / reset buttons, top-left
          fit: true,
          center: true,
          minZoom: 0.2,
          maxZoom: 20,
          dblClickZoomEnabled: true,
        });
      })
      .catch(() => {});
    return () => {
      dead = true;
      zp?.destroy();
    };
  }, [svg]);

  if (!svg) return <div className="mdview-mmd-loading">rendering diagram…</div>;
  return <div className="mdview-mmd" ref={hostRef} dangerouslySetInnerHTML={{ __html: svg }} />;
}

// Wrapper that falls back to the source text (plus the parse error) when the
// diagram doesn't compile — a broken fence shouldn't swallow the content.
export function MermaidBlock({ code, dark }: { code: string; dark: boolean }) {
  const [error, setError] = useState<string | null>(null);
  if (error) {
    return (
      <div className="mdview-mmd-error">
        <div className="mdview-mmd-error-msg">mermaid: {error}</div>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return <MermaidDiagram code={code} dark={dark} onError={setError} />;
}
