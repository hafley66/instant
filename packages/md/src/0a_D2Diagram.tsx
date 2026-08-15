import { useEffect, useState, type KeyboardEvent } from "react";
import { DiagramLightbox, diagramSvgMarkup } from "./0_DiagramLightbox";
import { renderD2 } from "./d2";
import { getMdviewHost } from "./ports";

export function D2Diagram({ code, dark }: { code: string; dark: boolean }) {
  const host = getMdviewHost();
  host.useRenderProbe("D2Diagram", undefined, { dark, sourceBytes: code.length });
  host.useLifecycleProbe("D2Diagram");
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    const started = typeof performance === "undefined" ? Date.now() : performance.now();
    void renderD2(code, dark)
      .then((rendered) => {
        host.recordOperation("mdview.renderD2", { dark, sourceBytes: code.length, svgBytes: rendered.length, elapsedMs: Math.round((typeof performance === "undefined" ? Date.now() : performance.now()) - started) });
        if (!disposed) {
          setError("");
          setSvg(rendered);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setSvg("");
          setError(reason instanceof Error ? reason.message : "Failed to render d2 diagram");
        }
      });
    return () => {
      disposed = true;
    };
  }, [code, dark]);

  if (error) return <pre className="mdview-d2-error">{error}</pre>;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="mdview-d2"
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
      {open && <DiagramLightbox svg={svg} label="d2 diagram" language="d2" dark={dark} onClose={() => setOpen(false)} />}
    </>
  );
}
