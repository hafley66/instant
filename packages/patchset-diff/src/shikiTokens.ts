import type { HighlighterGeneric } from "shiki";

/** Shape react-diff-view's `tokenize({highlight: true, refractor})` calls. */
export interface RefractorLike {
  highlight(value: string, language: string): TokenNode[];
  /** `highlight` is sync, so a grammar must be resident before it runs.
   *  False = no such grammar. Callers re-render on true. */
  ensure?(language: string): Promise<boolean>;
}

export interface TokenNode {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: TokenNode[];
}

export interface ShikiRefractor {
  refractor: RefractorLike;
  /** Current rules. Colours are minted lazily, so this grows as files render. */
  css(): string;
  /** Keeps a <style> in sync as new colours appear. Returns a remover. */
  install(target?: Document): () => void;
}

type AnyHighlighter = HighlighterGeneric<string, string>;

const CLASS_PREFIX = "pds";

// defaultRenderToken reads properties.className and drops properties.style,
// which is where shiki writes color, so colors are remapped onto classes.
export function shikiRefractor(
  highlighter: AnyHighlighter,
  theme: string,
): ShikiRefractor {
  const classOf = new Map<string, string>();

  const className = (color: string): string => {
    let name = classOf.get(color);
    if (name === undefined) {
      name = `${CLASS_PREFIX}${classOf.size.toString(36)}`;
      classOf.set(color, name);
    }
    return name;
  };

  const convert = (node: any): TokenNode => {
    if (node.type === "text") return { type: "text", value: node.value };
    const color = readColor(node.properties?.style);
    return {
      type: "element",
      properties: color ? { className: [className(color)] } : {},
      children: (node.children ?? []).map(convert),
    };
  };

  let sheet: HTMLStyleElement | null = null;
  const paint = () => {
    if (sheet) sheet.textContent = rules();
  };
  const rules = () =>
    [...classOf].map(([color, name]) => `.${name}{color:${color}}`).join("\n");

  const loading = new Map<string, Promise<boolean>>();
  const resident = (language: string) =>
    language === "text" || highlighter.getLoadedLanguages().includes(language);

  return {
    refractor: {
      ensure(language) {
        if (resident(language)) return Promise.resolve(true);
        let pending = loading.get(language);
        if (!pending) {
          pending = highlighter
            .loadLanguage(language as never)
            .then(() => true)
            .catch(() => false);
          loading.set(language, pending);
        }
        return pending;
      },
      highlight(value, language) {
        // An unloaded grammar throws, so fall back rather than losing the file.
        const lang = resident(language) ? language : "text";
        const hast = highlighter.codeToHast(value, { lang, theme });
        const lines = codeLines(hast);
        const out: TokenNode[] = [];
        lines.forEach((line, i) => {
          if (i > 0) out.push({ type: "text", value: "\n" });
          for (const child of line.children ?? []) out.push(convert(child));
        });
        paint();
        return out;
      },
    },
    css: rules,
    install(target = document) {
      sheet ??= target.createElement("style");
      sheet.dataset.patchsetDiff = "shiki";
      target.head.append(sheet);
      paint();
      return () => sheet?.remove();
    },
  };
}

function readColor(style: unknown): string | undefined {
  if (typeof style !== "string") return undefined;
  return /(?:^|;)\s*color\s*:\s*([^;]+)/.exec(style)?.[1]?.trim();
}

/** codeToHast nests root > pre > code > one element per line. */
function codeLines(hast: any): any[] {
  const pre = hast.children?.find((n: any) => n.tagName === "pre");
  const code = pre?.children?.find((n: any) => n.tagName === "code");
  return (code?.children ?? []).filter((n: any) => n.type === "element");
}
