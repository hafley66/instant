// A path shown relative to the pane cwd when it sits under it, else to $HOME.
// Pure, so the jump palette's label rule is testable without the DOM.
export function jumpLabel(path: string, cwd: string, home: string): string {
  const base = cwd.replace(/\/$/, "");
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  const h = home.replace(/\/$/, "");
  if (h && path.startsWith(`${h}/`)) return `~/${path.slice(h.length + 1)}`;
  return path;
}
