import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Diff, Hunk, parseDiff, tokenize, type FileData, type ViewType } from "react-diff-view";
import type { RefractorLike } from "./shikiTokens";

export interface PatchsetDiffProps {
  /** Unified diff text, e.g. from `jj interdiff --git`. */
  diffText: string;
  viewType?: ViewType;
  refractor?: RefractorLike;
  /** Anchored below a line; key with getChangeKey(change). */
  widgets?: Record<string, ReactNode>;
  /** Rendered when the diff text is empty, i.e. a pure rebase. */
  empty?: ReactNode;
}

const LANG_OF: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", rs: "rust",
  py: "python", go: "go", rb: "ruby", sh: "bash", json: "json", md: "markdown",
  css: "css", html: "html", toml: "toml", yml: "yaml", yaml: "yaml",
};

const languageOf = (path: string): string =>
  LANG_OF[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

export function PatchsetDiff({
  diffText,
  viewType = "split",
  refractor,
  widgets,
  empty = null,
}: PatchsetDiffProps) {
  const files = useMemo(
    () => (diffText.trim() ? parseDiff(diffText) : []),
    [diffText],
  );
  if (files.length === 0) return <>{empty}</>;
  return (
    <div className="patchset-diff">
      {files.map((file) => (
        <LazyFile
          key={file.newPath || file.oldPath}
          file={file}
          viewType={viewType}
          refractor={refractor}
          widgets={widgets}
        />
      ))}
    </div>
  );
}

interface LazyFileProps extends Omit<PatchsetDiffProps, "diffText" | "empty"> {
  file: FileData;
}

/** Mounting every file at once is what makes large diffs slow, so defer. */
function LazyFile({ file, viewType, refractor, widgets }: LazyFileProps) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const lines = file.hunks.reduce((n, h) => n + h.changes.length + 1, 0);

  useEffect(() => {
    const node = host.current;
    if (!node || visible) return;
    const io = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setVisible(true),
      { rootMargin: "400px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [visible]);

  const path = file.newPath || file.oldPath;
  const tokens = useMemo(() => {
    if (!visible || !refractor) return undefined;
    try {
      return tokenize(file.hunks, {
        highlight: true,
        refractor,
        language: languageOf(path),
      });
    } catch {
      return undefined;
    }
  }, [visible, refractor, file.hunks, path]);

  return (
    <div ref={host} className="patchset-diff-file" style={{ minHeight: visible ? undefined : lines * 20 }}>
      <div className="patchset-diff-path">{path}</div>
      {visible && (
        <Diff
          viewType={viewType}
          diffType={file.type}
          hunks={file.hunks}
          tokens={tokens}
          widgets={widgets}
        >
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      )}
    </div>
  );
}
