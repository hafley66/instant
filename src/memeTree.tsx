// Meme panel's thumbs tree: FileTree (src/fileTree.tsx) specialized for image
// files. Kept as its own module with the original props so meme.tsx's import
// and render sites are untouched.
import { FileTree, type FileTreeRow } from "./fileTree";
import type { FsEntry } from "./state";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
]);

function memeGlyph(r: FileTreeRow): string {
  if (r.kind === "dir") return "📁";
  switch (r.ext.toLowerCase()) {
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
    case "avif":
      return "🖼";
    case "gif":
      return "🎞";
    case "svg":
      return "🎨";
    default:
      return "📄";
  }
}

export function MemeTree(props: {
  rootPath: string;
  rootEntries: FsEntry[];
  activePath?: string;
  onSelect: (path: string) => void;
}) {
  return (
    <FileTree
      {...props}
      filterExts={IMAGE_EXTS}
      listCommand="list_dir_meme"
      glyphFor={memeGlyph}
      searchPlaceholder="filter files…"
    />
  );
}
