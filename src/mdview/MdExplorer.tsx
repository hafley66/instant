// The mdview sidebar: a file explorer rooted at the current document's
// directory (↑ walks the root up), showing folders + markdown files only.
// Selecting a doc navigates the panel in place; folders toggle on double-click
// (FileTree, the shared lazy TreeTable explorer).
import { useEffect, useState } from "react";
import { invoke } from "../generated/native";
import { FileTree } from "../plugins/files/1_FileTree";
import { MD_EXTS } from "../core";
import type { FsEntry } from "../state";
import { useFsWatch } from "./0_watch";

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

export function MdExplorer({
  docPath,
  onNavigate,
}: {
  docPath: string;
  onNavigate: (path: string) => void;
}) {
  const [root, setRoot] = useState(() => dirOf(docPath));
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [revision, setRevision] = useState(0);

  // Follow the document: navigating resets the root to the new doc's folder.
  useEffect(() => {
    setRoot(dirOf(docPath));
  }, [docPath]);

  useEffect(() => {
    let dead = false;
    invoke<{ entries: FsEntry[] }>("list_dir", { path: root })
      .then((l) => {
        if (dead) return;
        setEntries(
          l.entries.filter((e) => e.is_dir || MD_EXTS.has(e.ext.toLowerCase())),
        );
      })
      .catch(() => {
        if (!dead) setEntries([]);
      });
    return () => {
      dead = true;
    };
  }, [root, revision]);

  useFsWatch(root, () => setRevision((value) => value + 1));

  return (
    <div className="mdview-explorer">
      <div className="mdview-explorer-head">
        <button
          type="button"
          title="up to parent folder"
          disabled={root === "/"}
          onClick={() => setRoot(dirOf(root))}
        >
          ↑
        </button>
        <span className="mdview-explorer-root" title={root}>
          {root}
        </span>
      </div>
      <FileTree
        rootPath={root}
        rootEntries={entries}
        activePath={docPath}
        filterExts={MD_EXTS}
        listCommand="list_dir"
        onSelect={onNavigate}
        searchPlaceholder="filter docs…"
      />
    </div>
  );
}
