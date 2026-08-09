import { useEffect, useState, type KeyboardEvent } from "react";
import mermaid from "mermaid";
import { DiagramLightbox, diagramSvgMarkup } from "./0_DiagramLightbox";
import { mermaidTheme } from "./0_diagramTheme";
import { useLiveProbeLifecycle, useLiveProbeRender } from "../1_LiveProbe";
import { liveProbe } from "../0_liveProbe";

let nextDiagramId = 0;

export function MermaidDiagram({ code, dark }: { code: string; dark: boolean }) {
  useLiveProbeRender("MermaidDiagram", undefined, { dark, sourceBytes: code.length });
  useLiveProbeLifecycle("MermaidDiagram");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    const id = `instant-mermaid-${nextDiagramId++}`;
    mermaid.initialize({
      startOnLoad: false,
      ...mermaidTheme(dark),
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Arial, sans-serif",
      flowchart: { htmlLabels: false },
      securityLevel: "strict",
      suppressErrorRendering: true,
    });
    void mermaid.render(id, code)
      .then(({ svg: rendered }) => {
        liveProbe.record({ kind: "operation", name: "mdview.renderMermaid", detail: { dark, sourceBytes: code.length, svgBytes: rendered.length } });
        if (!disposed) {
          setError("");
          setSvg(rendered);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setSvg("");
          setError(reason instanceof Error ? reason.message : "Failed to render Mermaid diagram");
        }
      });
    return () => {
      disposed = true;
    };
  }, [code, dark]);

  if (error) return <pre className="mdview-mermaid-error">{error}</pre>;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="mdview-mermaid"
        data-diagram-theme={dark ? "dark" : "light"}
        title="Open diagram"
        onClick={() => setOpen(true)}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: diagramSvgMarkup(svg) }}
      />
      {open && <DiagramLightbox svg={svg} label="Mermaid diagram" language="mermaid" dark={dark} onClose={() => setOpen(false)} />}
    </>
  );
}
