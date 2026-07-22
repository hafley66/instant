import { useEffect, useState } from "react";
import { invoke } from "../../generated/native";
import { openPreviewPanel } from "../../preview";
import type { FsEntry } from "../../state";
import { FileTree } from "./1_FileTree";
import "./2_FileExplorer.css";

function parentOf(path: string): string {
  const end = path.replace(/\/$/, "");
  const index = end.lastIndexOf("/");
  return index > 0 ? end.slice(0, index) : "/";
}

export interface FileExplorerProps {
  root: string;
  onRootChange: (path: string) => void;
  onSelect?: (path: string) => void;
}

// Rooted filesystem UI shared by the dock panel and any caller that renders it
// inside a popover. FileTree owns lazy nested listings; this component owns the
// root listing and root navigation.
export function FileExplorer({ root, onRootChange, onSelect = openPreviewPanel }: FileExplorerProps) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    invoke<{ path: string; entries: FsEntry[] }>("list_dir", { path: root })
      .then((listing) => {
        if (dead) return;
        setEntries(listing.entries);
        if (listing.path !== root) onRootChange(listing.path);
      })
      .catch(() => {
        if (!dead) setEntries([]);
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [root, revision, onRootChange]);

  return (
    <div className="files-explorer">
      <div className="files-explorer-head">
        <button
          type="button"
          title="up to parent folder"
          disabled={root === "/"}
          onClick={() => onRootChange(parentOf(root))}
        >
          ↑
        </button>
        <input
          aria-label="folder path"
          value={root}
          spellCheck={false}
          onChange={(event) => onRootChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setRevision((value) => value + 1);
          }}
        />
        <button type="button" title="refresh folder" onClick={() => setRevision((value) => value + 1)}>
          ↻
        </button>
      </div>
      <div className="files-explorer-tree">
        {loading && entries.length === 0 ? (
          <div className="session-empty">loading files…</div>
        ) : (
          <FileTree
            rootPath={root}
            rootEntries={entries}
            listCommand="list_dir"
            onSelect={onSelect}
            searchPlaceholder="filter files…"
          />
        )}
      </div>
    </div>
  );
}
