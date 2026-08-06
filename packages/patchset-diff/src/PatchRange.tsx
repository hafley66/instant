import { useEffect, useMemo, useState } from "react";
import type { Patchset, PatchsetSource } from "./jj";
import { PatchsetDiff, type PatchsetDiffProps } from "./DiffView";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
};

export interface PatchRangeProps extends Omit<PatchsetDiffProps, "diffText" | "empty"> {
  source: PatchsetSource;
  changeId: string;
  /** Passed to the compare route so it runs against the same repo. */
  repoHint?: string;
}

/** Gerrit's patch-range selector: pick two patch sets, read what changed between. */
export function PatchRange({ source, changeId, repoHint, ...view }: PatchRangeProps) {
  const [sets, setSets] = useState<Patchset[]>([]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diffText, setDiffText] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    source
      .listPatchsets(changeId)
      .then((loaded) => {
        if (!live) return;
        setSets(loaded);
        setFrom(loaded.length > 1 ? loaded.length - 1 : null);
        setTo(loaded.length);
      })
      .catch((error: unknown) => live && setFailure(String(error)));
    return () => {
      live = false;
    };
  }, [source, changeId]);

  const byIndex = useMemo(() => new Map(sets.map((set) => [set.index, set])), [sets]);

  useEffect(() => {
    const target = to === null ? undefined : byIndex.get(to);
    if (!target) return;
    let live = true;
    const base = from === null ? undefined : byIndex.get(from);
    const pending = base
      ? source.interdiff(base.commitId, target.commitId)
      : source.diff(target.commitId);
    pending
      .then((text) => live && setDiffText(text))
      .catch((error: unknown) => live && setFailure(String(error)));
    return () => {
      live = false;
    };
  }, [source, from, to, byIndex]);

  // Binary sides come back base64, so the data URL is built here rather than
  // pushing git knowledge into the view.
  const image = useMemo<PatchsetDiffProps["image"]>(() => {
    return async (path, side) => {
      const set = side === "a" ? (from === null ? undefined : byIndex.get(from)) : to === null ? undefined : byIndex.get(to);
      if (!set) return undefined;
      const mime = MIME[path.split(".").pop()?.toLowerCase() ?? ""];
      if (!mime) return undefined;
      try {
        return `data:${mime};base64,${await source.blob(set.commitId, path)}`;
      } catch {
        return undefined;
      }
    };
  }, [source, from, to, byIndex]);

  const imageDiff = useMemo<PatchsetDiffProps["imageDiff"]>(() => {
    return async (path) => {
      const base = from === null ? undefined : byIndex.get(from);
      const target = to === null ? undefined : byIndex.get(to);
      if (!base || !target) return undefined;
      try {
        const [a, b] = await Promise.all([
          source.blob(base.commitId, path),
          source.blob(target.commitId, path),
        ]);
        const response = await fetch("/_compare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ a, b, cwd: repoHint }),
        });
        if (!response.ok) return undefined;
        const payload = await response.json();
        return { src: `data:image/png;base64,${payload.png}`, changed: payload.changedPixels ?? 0 };
      } catch {
        return undefined;
      }
    };
  }, [source, from, to, byIndex, repoHint]);

  if (failure) return <div className="patchset-diff-empty">{failure}</div>;

  return (
    <div className="patchset-range">
      <div className="patchset-range-bar">
        <label>
          Base
          <select
            value={from ?? ""}
            onChange={(event) => setFrom(event.target.value === "" ? null : Number(event.target.value))}
          >
            <option value="">Base</option>
            {sets.map((set) => (
              <option key={set.index} value={set.index}>
                Patch set {set.index}
              </option>
            ))}
          </select>
        </label>
        <span className="patchset-range-arrow">to</span>
        <label>
          <select value={to ?? ""} onChange={(event) => setTo(Number(event.target.value))}>
            {sets.map((set) => (
              <option key={set.index} value={set.index}>
                Patch set {set.index}
              </option>
            ))}
          </select>
        </label>
        <span className="patchset-range-id">{changeId}</span>
      </div>
      <PatchsetDiff
        {...view}
        image={image}
        imageDiff={imageDiff}
        diffText={diffText}
        empty={<div className="patchset-diff-empty">No change between these patch sets.</div>}
      />
    </div>
  );
}
