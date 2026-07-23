// Reusable TreeTable preset data for Markdown files. Consumers own the lazy
// read, then use these rows and `openMarkdownPanel(path, id)` for navigation.
import { parseMdSections } from "./mdview/model";

export interface MarkdownHeadingRow {
  kind: "heading";
  id: string;
  path: string;
  headingId: string;
  label: string;
  depth: number;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|mdx)$/i.test(path);
}

export function markdownHeadingRows(path: string, text: string): MarkdownHeadingRow[] {
  const flatten = (sections: ReturnType<typeof parseMdSections>["tree"]): MarkdownHeadingRow[] =>
    sections.flatMap((section) => [
      { kind: "heading" as const, id: `${path}#${section.id}`, path, headingId: section.id, label: section.title, depth: section.depth },
      ...flatten(section.children),
    ]);
  return flatten(parseMdSections(text).tree);
}
