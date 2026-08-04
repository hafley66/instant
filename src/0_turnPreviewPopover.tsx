import { useEffect, useRef, type CSSProperties } from "react";

export function TurnPreviewPopover({
  text,
  anchored,
  style,
  onPointerEnter,
  onPointerLeave,
}: {
  text: string;
  anchored: boolean;
  style?: CSSProperties;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.showPopover();
    return () => {
      try { ref.current?.hidePopover(); } catch { /* already detached */ }
    };
  }, []);
  return <div ref={ref} popover="manual" className="turn-preview-popover" data-testid="turn-preview-popover" data-anchor-positioned={anchored || undefined} role="tooltip" style={style} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>{text}</div>;
}
