// Generic "unsaved changes" signaling from panel content up to the dock tab
// wrapper (mirrors panelZoom.ts's registry pattern). A plugin registers a
// probe for its panel id; the close paths (tab ✕, ⌘W closeActivePanel, rail
// togglePanel) consult it and confirm before discarding. Probes are keyed by
// FULL panel id ("paint", "md:/x.md", "term:s:main") so per-file panels work.
const probes = new Map<string, () => string | null>();

// Register (and later auto-unregister via the returned disposer) the dirty
// probe for a panel. The probe returns the warning message when dirty, null
// when clean — evaluated at close time, not on state changes, so it costs
// nothing while the user works.
export function setDirtyProbe(pid: string, probe: () => string | null): () => void {
  probes.set(pid, probe);
  return () => {
    if (probes.get(pid) === probe) probes.delete(pid);
  };
}

export function dirtyMessage(pid: string): string | null {
  try {
    return probes.get(pid)?.() ?? null;
  } catch {
    return null; // a broken probe must never block closing
  }
}

// Gate every panel-close path through this: true = proceed, false = keep the
// panel. Native confirm() — WKWebView renders it fine, and the Esc-hide /
// reload paths intentionally bypass it (sessions survive both).
export function confirmClose(pid: string): boolean {
  const msg = dirtyMessage(pid);
  if (!msg) return true;
  return window.confirm(`${msg}\n\nClose anyway and discard the changes?`);
}

// Teardown hook for reactdock's onDidRemovePanel.
export function dropDirtyProbe(pid: string): void {
  probes.delete(pid);
}
