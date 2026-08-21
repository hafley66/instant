import type { D2 as D2Class } from "@terrastruct/d2";
import { d2ThemeId } from "./0_diagramTheme";

let instance: D2Class | null = null;
let loading: Promise<D2Class> | null = null;
let renderQueue = Promise.resolve();

// The d2 bundle is 8.2 MB. A static import puts it in the entry graph, so
// index.html modulepreloads it and every boot pays for it before a single tab
// renders. Load it on the first d2 block instead, and memoise the promise so
// concurrent blocks share one fetch.
async function getInstance(): Promise<D2Class> {
  if (instance) return instance;
  loading ??= import("@terrastruct/d2").then(({ D2 }) => {
    instance = new D2();
    return instance;
  });
  return loading;
}

/** Warm the bundle without rendering, for callers that know a diagram is coming. */
export function preloadD2(): void {
  void getInstance().catch(() => undefined);
}

export async function renderD2(code: string, dark: boolean): Promise<string> {
  const rendering = renderQueue.then(async () => {
    const d2 = await getInstance();
    const compiled = await d2.compile(code);
    return d2.render(compiled.diagram, {
      ...compiled.renderOptions,
      themeID: d2ThemeId(dark),
    });
  });
  renderQueue = rendering.then(() => undefined, () => undefined);
  return rendering;
}
