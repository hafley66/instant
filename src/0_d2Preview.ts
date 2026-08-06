export function d2SiblingPaths(path: string): [string, string] {
  const stem = path.toLowerCase().endsWith(".d2") ? path.slice(0, -3) : path;
  return [`${stem}.svg`, `${stem}.png`];
}

export type D2Preview = {
  format: "svg-sibling" | "svg-rendered" | "png-fallback";
  path: string;
  source?: string;
  svg?: string;
  url?: string;
};

export async function resolveD2Preview(
  path: string,
  readSvg: (path: string) => Promise<string>,
  readImage: (path: string) => Promise<string>,
  renderSource: (path: string) => Promise<{ source: string; svg: string }>,
): Promise<D2Preview> {
  const [svgPath, pngPath] = d2SiblingPaths(path);
  try {
    return { format: "svg-sibling", path: svgPath, svg: await readSvg(svgPath) };
  } catch {
    // Compile the D2 source before accepting a raster sibling.
  }

  let renderError: unknown;
  try {
    const rendered = await renderSource(path);
    return {
      format: "svg-rendered",
      path,
      source: rendered.source,
      svg: rendered.svg,
    };
  } catch (error) {
    renderError = error;
  }

  try {
    return { format: "png-fallback", path: pngPath, url: await readImage(pngPath) };
  } catch {
    throw renderError;
  }
}
