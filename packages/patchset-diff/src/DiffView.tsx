import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Diff, Hunk, markEdits, parseDiff, tokenize, type FileData, type ViewType } from "react-diff-view";
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
  /** Data URL for a binary file on one side, used when git reports no hunks. */
  image?: (path: string, side: "a" | "b") => Promise<string | undefined>;
  /** Pixel difference of the two sides, plus how many pixels moved. */
  imageDiff?: (path: string) => Promise<{ src: string; changed: number } | undefined>;
}

const LANG_OF: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", rs: "rust",
  py: "python", go: "go", rb: "ruby", sh: "bash", json: "json", md: "markdown",
  css: "css", html: "html", toml: "toml", yml: "yaml", yaml: "yaml",
};

const languageOf = (path: string): string =>
  LANG_OF[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const isImage = (path: string) => IMAGE_EXT.has(path.split(".").pop()?.toLowerCase() ?? "");

export function PatchsetDiff({
  diffText,
  viewType = "split",
  refractor,
  widgets,
  empty = null,
  image,
  imageDiff,
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
          image={image}
          imageDiff={imageDiff}
        />
      ))}
    </div>
  );
}

interface LazyFileProps extends Omit<PatchsetDiffProps, "diffText" | "empty"> {
  file: FileData;
}

/** GitHub's five-block diffstat: filled blocks are proportional to the change. */
function StatBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const filled = total === 0 ? 0 : Math.max(1, Math.min(5, Math.round(total / 12)));
  const greens = total === 0 ? 0 : Math.round((added / total) * filled);
  return (
    <span className="patchset-diff-bar" aria-label={`${added} added, ${removed} removed`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < greens ? "add" : i < filled ? "del" : "none"} />
      ))}
    </span>
  );
}

/** Mounting every file at once is what makes large diffs slow, so defer. */
type ImagePairProps = {
  path: string;
  load: NonNullable<PatchsetDiffProps["image"]>;
  diff?: PatchsetDiffProps["imageDiff"];
};

function ImagePair({ path, load, diff }: ImagePairProps) {
  const [pair, setPair] = useState<[string | undefined, string | undefined]>([undefined, undefined]);
  const [delta, setDelta] = useState<{ src: string; changed: number } | undefined>();
  const [mode, setMode] = useState<"pair" | "delta">("pair");

  useEffect(() => {
    let live = true;
    Promise.all([load(path, "a"), load(path, "b")]).then(
      ([before, after]) => live && setPair([before, after]),
    );
    return () => {
      live = false;
    };
  }, [path, load]);

  useEffect(() => {
    if (!diff) return;
    let live = true;
    diff(path).then((found) => live && setDelta(found));
    return () => {
      live = false;
    };
  }, [path, diff]);

  const both = pair[0] && pair[1];
  return (
    <div className="patchset-diff-imagewrap">
      {both && delta && (
        <div className="patchset-diff-imagebar">
          <button type="button" aria-pressed={mode === "pair"} onClick={() => setMode("pair")}>
            side by side
          </button>
          <button type="button" aria-pressed={mode === "delta"} onClick={() => setMode("delta")}>
            difference
          </button>
          <span className="patchset-diff-changed">{delta.changed.toLocaleString()} px changed</span>
        </div>
      )}
      {mode === "delta" && delta ? (
        <div className="patchset-diff-images one">
          <figure className="delta">
            <img src={delta.src} alt={`${path} difference`} />
          </figure>
        </div>
      ) : (
        <div className="patchset-diff-images">
          {(["a", "b"] as const).map((side, index) => (
            <figure key={side} className={side === "a" ? "before" : "after"}>
              {pair[index] ? <img src={pair[index]} alt={`${path} ${side}`} /> : <span>absent</span>}
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

function LazyFile({ file, viewType, refractor, widgets, image, imageDiff }: LazyFileProps) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(true);
  const lines = file.hunks.reduce((n, h) => n + h.changes.length + 1, 0);
  const { added, removed } = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const hunk of file.hunks) {
      for (const change of hunk.changes) {
        if (change.type === "insert") added += 1;
        if (change.type === "delete") removed += 1;
      }
    }
    return { added, removed };
  }, [file.hunks]);

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
  const language = languageOf(path);

  // Grammars load per language, so paint once more when this file's arrives.
  const [grammar, setGrammar] = useState(0);
  useEffect(() => {
    if (!visible || !refractor?.ensure) return;
    let live = true;
    refractor.ensure(language).then((ok) => ok && live && setGrammar((n) => n + 1));
    return () => {
      live = false;
    };
  }, [visible, refractor, language]);

  // markEdits narrows the paint to the changed words; without it a one-token
  // edit lights the whole line.
  const tokens = useMemo(() => {
    if (!visible) return undefined;
    const enhancers = [markEdits(file.hunks, { type: "block" })];
    try {
      return refractor
        ? tokenize(file.hunks, { highlight: true, refractor, language, enhancers })
        : tokenize(file.hunks, { highlight: false, enhancers });
    } catch (failure) {
      console.warn(`patchset-diff: tokenize failed for ${path}`, failure);
      return undefined;
    }
  }, [visible, refractor, file.hunks, path, language, grammar]);

  return (
    <div ref={host} className="patchset-diff-file" style={{ minHeight: visible ? undefined : lines * 20 }}>
      <button
        type="button"
        className="patchset-diff-head"
        aria-expanded={open}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        <span className="patchset-diff-caret" aria-hidden="true">{open ? "\u25be" : "\u25b8"}</span>
        <span className="patchset-diff-path">{path}</span>
        <span className="patchset-diff-adds">+{added}</span>
        <span className="patchset-diff-dels">&minus;{removed}</span>
        <StatBar added={added} removed={removed} />
      </button>
      {visible && open && file.hunks.length === 0 && image && isImage(path) && (
        <ImagePair path={path} load={image} diff={imageDiff} />
      )}
      {visible && open && file.hunks.length > 0 && (
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
