import { useCallback, useMemo } from "react";
import { Streamdown, type CustomRendererProps, type StreamdownProps } from "streamdown";
import { code } from "@streamdown/code";
import "streamdown/styles.css";
import { MermaidDiagram } from "./0a_MermaidDiagram";
import { D2Diagram } from "./0a_D2Diagram";

const controls = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
} as const;

export default function StreamdownBody({
  children,
  components,
  dark,
}: {
  children: string;
  components: StreamdownProps["components"];
  dark: boolean;
}) {
  // Streamdown uses renderer identity as part of its tree reconciliation. Keep
  // both values stable across Markdown signal re-renders, otherwise an open
  // MermaidDiagram remounts and its lightbox state returns to false.
  const MermaidRenderer = useCallback(
    ({ code }: CustomRendererProps) => <MermaidDiagram code={code} dark={dark} />,
    [dark],
  );
  const D2Renderer = useCallback(
    ({ code }: CustomRendererProps) => <D2Diagram code={code} dark={dark} />,
    [dark],
  );
  const plugins = useMemo(
    () => ({
      code,
      renderers: [
        { language: "mermaid", component: MermaidRenderer },
        { language: "d2", component: D2Renderer },
      ],
    }),
    [MermaidRenderer, D2Renderer],
  );

  return (
    <div className="mdview-streamdown">
      <Streamdown
        mode="static"
        components={components}
        plugins={plugins}
        controls={controls}
        shikiTheme={["github-light", "github-dark"]}
      >
        {children}
      </Streamdown>
    </div>
  );
}
