import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { countDomNodes, liveProbe, selectProbeRoot, type LiveProbeDetail, type LiveProbeKind } from "./0_liveProbe";

export function useLiveProbeRender(name: string, scope?: string, detail?: LiveProbeDetail): void {
  liveProbe.record({ kind: "render", name, scope, detail });
}

export function useLiveProbeLifecycle(name: string, scope?: string, detail?: LiveProbeDetail): void {
  useEffect(() => {
    liveProbe.record({ kind: "mount", name, scope, detail });
    return () => {
      liveProbe.record({ kind: "unmount", name, scope, detail });
    };
  }, [name, scope]);
}

export function LiveProbePanel({
  rootRef,
  root,
  scope,
}: {
  rootRef?: RefObject<HTMLElement | null>;
  root?: HTMLElement;
  scope?: string;
}) {
  const snapshot = useSyncExternalStore(liveProbe.subscribe, liveProbe.snapshot, liveProbe.snapshot);
  const domNodes = useStateDomCount(rootRef, root, snapshot.eventCount);
  const rows = Object.entries(snapshot.renderCounts).sort(([left], [right]) => left.localeCompare(right));
  const latest = snapshot.recentEvents.slice(-4).reverse();

  return (
    <section className="live-probe" aria-label="live render probe">
      <div className="live-probe-head">
        <strong>probe</strong>
        <span>{scope ?? "app"}</span>
        <span data-testid="live-probe-dom-count">DOM {domNodes}</span>
        <span>events {snapshot.eventCount}</span>
      </div>
      <div className="live-probe-renders" data-testid="live-probe-renders">
        {rows.length === 0 ? <span>renders 0</span> : rows.map(([name, count]) => <span key={name}>{name} {count}</span>)}
      </div>
      <div className="live-probe-events" data-testid="live-probe-events">
        {latest.map((event) => (
          <span key={event.sequence}>{event.sequence} {event.kind}:{event.name}</span>
        ))}
      </div>
    </section>
  );
}

function useStateDomCount(rootRef: RefObject<HTMLElement | null> | undefined, root: HTMLElement | undefined, eventCount: number) {
  const [domNodes, setDomNodes] = useState(0);
  useLayoutEffect(() => {
    const next = countDomNodes(selectProbeRoot(root ?? null, rootRef?.current ?? null));
    setDomNodes((current) => current === next ? current : next);
  }, [eventCount, root, rootRef]);
  return domNodes;
}

export function useLiveProbeOperation(name: string, kind: LiveProbeKind = "operation", scope?: string, detail?: LiveProbeDetail): void {
  liveProbe.record({ kind, name, scope, detail });
}
