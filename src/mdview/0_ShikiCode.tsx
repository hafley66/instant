import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

const shikiCache = new Map<string, string>();

export function ShikiCode({ lang, code, theme }: { lang: string; code: string; theme: string }) {
  const key = `${theme}|${lang}|${code}`;
  const [html, setHtml] = useState<string | null>(() => shikiCache.get(key) ?? null);

  useEffect(() => {
    const hit = shikiCache.get(key);
    if (hit != null) {
      setHtml(hit);
      return;
    }
    let dead = false;
    codeToHtml(code, { lang, theme })
      .then((highlighted) => {
        const inner = new DOMParser().parseFromString(highlighted, "text/html").querySelector("code")
          ?.innerHTML;
        if (inner == null) return;
        if (shikiCache.size > 300) shikiCache.clear();
        shikiCache.set(key, inner);
        if (!dead) setHtml(inner);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [key, lang, code, theme]);

  if (html == null) return <code>{code}</code>;
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}
