export type LiveProbeKind = "render" | "operation" | "mount" | "unmount";

export type LiveProbeDetail = Readonly<Record<string, boolean | number | string>>;

export type LiveProbeEvent = {
  sequence: number;
  at: number;
  kind: LiveProbeKind;
  name: string;
  scope?: string;
  detail?: LiveProbeDetail;
};

export type LiveProbeSnapshot = {
  eventCount: number;
  renderCounts: Readonly<Record<string, number>>;
  operationCounts: Readonly<Record<string, number>>;
  recentEvents: readonly LiveProbeEvent[];
};

export type LiveProbe = {
  record(event: { kind: LiveProbeKind; name: string; scope?: string; detail?: LiveProbeDetail }): LiveProbeEvent;
  snapshot(): LiveProbeSnapshot;
  subscribe(listener: () => void): () => void;
  reset(): void;
};

export type ProbeDomRoot = Pick<ParentNode, "querySelectorAll">;

const now = (): number => typeof performance === "undefined" ? Date.now() : performance.now();

export function selectProbeRoot(explicitRoot: ProbeDomRoot | null, fallbackRoot: ProbeDomRoot | null): ProbeDomRoot | null {
  return explicitRoot ?? fallbackRoot;
}

export function countDomNodes(root: ProbeDomRoot | null): number {
  if (!root) return 0;
  return 1 + root.querySelectorAll("*").length;
}

export function createLiveProbe(historyLimit = 64): LiveProbe {
  let sequence = 0;
  let snapshot: LiveProbeSnapshot = {
    eventCount: 0,
    renderCounts: {},
    operationCounts: {},
    recentEvents: [],
  };
  const listeners = new Set<() => void>();
  let notificationQueued = false;

  const notify = () => {
    if (notificationQueued) return;
    notificationQueued = true;
    queueMicrotask(() => {
      notificationQueued = false;
      for (const listener of listeners) listener();
    });
  };

  return {
    record(input) {
      const event: LiveProbeEvent = { ...input, sequence: ++sequence, at: now() };
      const counts = input.kind === "render" ? snapshot.renderCounts : input.kind === "operation" ? snapshot.operationCounts : null;
      const nextCounts = counts ? { ...counts, [input.name]: (counts[input.name] ?? 0) + 1 } : snapshot.renderCounts;
      snapshot = {
        eventCount: snapshot.eventCount + 1,
        renderCounts: input.kind === "render" ? nextCounts : snapshot.renderCounts,
        operationCounts: input.kind === "operation" ? nextCounts : snapshot.operationCounts,
        recentEvents: [...snapshot.recentEvents, event].slice(-historyLimit),
      };
      notify();
      return event;
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      sequence = 0;
      snapshot = { eventCount: 0, renderCounts: {}, operationCounts: {}, recentEvents: [] };
      notify();
    },
  };
}

export const liveProbe = createLiveProbe();
