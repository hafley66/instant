import { D2 } from "@terrastruct/d2";

const LIGHT_THEME_ID = 0;
const DARK_THEME_ID = 200;

let instance: D2 | null = null;

function getInstance(): D2 {
  if (!instance) instance = new D2();
  return instance;
}

export async function renderD2(code: string, dark: boolean): Promise<string> {
  const d2 = getInstance();
  const compiled = await d2.compile(code);
  return d2.render(compiled.diagram, {
    ...compiled.renderOptions,
    themeID: dark ? DARK_THEME_ID : LIGHT_THEME_ID,
  });
}
