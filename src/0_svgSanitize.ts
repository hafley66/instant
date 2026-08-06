import DOMPurify from "dompurify";
import { normalizeSvgEntities } from "./0_svgViewport";

const FOREIGN_OBJECT = /<foreignObject\b[^>]*>([\s\S]*?)<\/foreignObject>/gi;
const EMPTY_FOREIGN_OBJECT = /(<foreignObject\b[^>]*>)[\s\S]*?(<\/foreignObject>)/gi;
const DOCUMENT_URI = /^(?:(?:https?|file|vscode):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i;

export function sanitizeSvgDocument(source: string): string {
  const normalized = normalizeSvgEntities(source);
  const serializer = new XMLSerializer();
  const foreignHtml = Array.from(normalized.matchAll(FOREIGN_OBJECT), (match) => {
    const fragment = DOMPurify.sanitize(match[1], {
      USE_PROFILES: { html: true },
      RETURN_DOM_FRAGMENT: true,
      ADD_ATTR: ["d"],
      ADD_URI_SAFE_ATTR: ["d"],
      ALLOWED_URI_REGEXP: DOCUMENT_URI,
    }) as unknown as DocumentFragment;
    return Array.from(fragment.childNodes, (node) => serializer.serializeToString(node)).join("");
  });
  const svg = DOMPurify.sanitize(normalized, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["foreignObject"],
    ADD_ATTR: ["d", "requiredFeatures"],
    ADD_URI_SAFE_ATTR: ["d"],
    ALLOWED_URI_REGEXP: DOCUMENT_URI,
  });
  let index = 0;
  return normalizeSvgEntities(svg.replace(
    EMPTY_FOREIGN_OBJECT,
    (_match, open: string, close: string) => {
      const visible = /\boverflow\s*=/i.test(open)
        ? open
        : open.replace(/<foreignObject\b/i, '<foreignObject overflow="visible"');
      return `${visible}${foreignHtml[index++] ?? ""}${close}`;
    },
  ));
}
