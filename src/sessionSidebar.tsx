import { useCallback, useEffect, useState } from "react";
import { FileExplorer } from "./plugins/files/2_FileExplorer";

type Placement = "right" | "bottom";

export function SessionSidebar(props: {
  sid: string;
  getCwd: () => string | null;
  width: number;
  placement: Placement;
  onWidth: (px: number) => void;
  onResizeEnd: () => void;
}) {
  const { getCwd, width, placement, onWidth, onResizeEnd } = props;
  const [root, setRoot] = useState(() => getCwd() ?? "");

  useEffect(() => {
    const next = getCwd();
    if (next) setRoot(next);
  }, [getCwd]);

  const beginResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const start = placement === "right" ? event.clientX : event.clientY;
    const startWidth = width;
    const move = (next: PointerEvent) => {
      const point = placement === "right" ? next.clientX : next.clientY;
      onWidth(Math.max(160, Math.min(560, startWidth + start - point)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onResizeEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [onResizeEnd, onWidth, placement, width]);

  return (
    <aside
      className="term-sidebar"
      data-placement={placement}
      style={placement === "right" ? { width } : { height: width }}
    >
      <div className="term-sidebar-resize" onPointerDown={beginResize} />
      <div className="term-sidebar-body">
        {root ? (
          <FileExplorer root={root} onRootChange={setRoot} />
        ) : (
          <div className="term-sidebar-empty">waiting for session cwd…</div>
        )}
      </div>
    </aside>
  );
}
