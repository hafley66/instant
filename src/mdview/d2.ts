import { D2 } from "@terrastruct/d2";
import { d2ThemeId } from "./0_diagramTheme";

let instance: D2 | null = null;
let renderQueue = Promise.resolve();

function getInstance(): D2 {
  if (!instance) instance = new D2();
  return instance;
}

export async function renderD2(code: string, dark: boolean): Promise<string> {
  const rendering = renderQueue.then(async () => {
    const d2 = getInstance();
    const compiled = await d2.compile(code);
    return d2.render(compiled.diagram, {
      ...compiled.renderOptions,
      themeID: d2ThemeId(dark),
    });
  });
  renderQueue = rendering.then(() => undefined, () => undefined);
  return rendering;
}
