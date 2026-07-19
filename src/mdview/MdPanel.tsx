// The markdown viewer panel body: file explorer (shared FileTree on the
// canonical TreeTable) | rendered sections, split with react-resizable-panels
// (AGENTS "Split panes"). All state lives in the signals module; signal reads
// happen here at the top (SignalReact tracks them) and flow down as props.
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SignalReact } from "@hafley66/signals/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { codeToHtml } from "shiki";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "../generated/native";
import { useApp } from "../useStore";
import { baseName } from "../core";
import { expandChain, resolveMdLink, sliceOwn, type MdSection } from "./model";
import {
  collapsedFor,
  expandIds,
  initCollapsedForReadyDoc,
  layoutFor,
  loadMdDoc,
  mdDocs,
  mdUi,
  setAllCollapsed,
  setLayoutFor,
  setMdUi,
  toggleCollapsed,
  toggleExplorer,
  type StrSignal,
} from "./signals";
import { setPendingFrag, takePendingFrag } from "./open";
import { MdExplorer } from "./MdExplorer";
import { MermaidBlock } from "./Mermaid";
import "./mdview.css";

// ---- fenced code: shiki (same highlighter + themes as preview.ts) ----

const shikiCache = new Map<string, string>();

function ShikiCode({ lang, code, theme }: { lang: string; code: string; theme: string }) {
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
      .then((h) => {
        // Take only the <code> contents: the surrounding <pre> comes from
        // react-markdown, and .md-body styles it; the spans carry the colors.
        const inner = new DOMParser().parseFromString(h, "text/html").querySelector("code")
          ?.innerHTML;
        if (inner == null) return;
        if (shikiCache.size > 300) shikiCache.clear();
        shikiCache.set(key, inner);
        if (!dead) setHtml(inner);
      })
      .catch(() => {}); // unknown language etc: stay on the plain fallback
    return () => {
      dead = true;
    };
  }, [key, lang, code, theme]);
  if (html == null) return <code>{code}</code>;
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---- images: local files load via read_image (data URL), like preview.ts ----

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}

function MdImg({ src, alt, base }: { src?: string; alt?: string; base: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const s = src ?? "";
    if (!s) return;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(s) || s.startsWith("data:") || s.startsWith("blob:")) {
      setUrl(s);
      return;
    }
    let dead = false;
    const abs = s.startsWith("/") || s.startsWith("~") ? s : `${dirOf(base)}/${s}`;
    invoke<string>("read_image", { path: abs })
      .then((u) => {
        if (!dead) setUrl(u);
      })
      .catch(() => {
        if (!dead) setUrl(null);
      });
    return () => {
      dead = true;
    };
  }, [src, base]);
  if (!url) return <span className="mdview-img-alt">{alt || "image"}</span>;
  return <img src={url} alt={alt ?? ""} />;
}

// ---- sections ----

interface SectionProps {
  sec: MdSection;
  text: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  components: React.ComponentProps<typeof ReactMarkdown>["components"];
}

function SectionView({ sec, text, collapsed, onToggle, components }: SectionProps) {
  const isCollapsed = collapsed.has(sec.id);
  const own = isCollapsed ? "" : sliceOwn(text, sec).trim();
  return (
    <div className="mdview-sec">
      <div
        className={`mdview-head mdview-h${sec.depth}`}
        id={sec.id}
        data-mdsec={sec.id}
        role="button"
        tabIndex={0}
        onClick={() => onToggle(sec.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(sec.id);
          }
        }}
      >
        <span className="mdview-twisty">{isCollapsed ? "▸" : "▾"}</span>
        <span className="mdview-title">{sec.title}</span>
      </div>
      {!isCollapsed && (
        <div className="mdview-body">
          {own ? (
            <div className="md-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {own}
              </ReactMarkdown>
            </div>
          ) : null}
          {sec.children.map((c) => (
            <SectionView
              key={c.id}
              sec={c}
              text={text}
              collapsed={collapsed}
              onToggle={onToggle}
              components={components}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const MdPanel = SignalReact(function MdPanel({
  pid,
  pathSig,
  onNavigate,
}: {
  pid: string;
  pathSig: StrSignal;
  onNavigate: (path: string) => void;
}) {
  const app = useApp();
  const theme = app.mode === "dark" ? "github-dark" : "github-light";
  const path = pathSig.$();
  const state = mdDocs.$()[path];
  const ui = mdUi.$();
  const collapsed = collapsedFor(path).$();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadMdDoc(path);
  }, [path]);
  useEffect(() => {
    if (state?.status === "ready") initCollapsedForReadyDoc(path);
  }, [path, state?.status]);

  const doc = state?.status === "ready" ? state.doc : null;

  // Expand the chain to a section, then scroll it into view (the row exists
  // only after the expand re-render, hence the rAF defer).
  const jumpTo = (id: string) => {
    if (!doc) return;
    expandIds(path, expandChain(doc, id));
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-mdsec="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "start" });
    });
  };

  // Consume a #frag requested with the open/navigation, once the doc is ready.
  // jumpTo is intentionally not a dep: it reads the latest doc via signals.
  useEffect(() => {
    if (state?.status !== "ready") return;
    const frag = takePendingFrag(path);
    if (frag && doc?.byId.has(frag)) jumpTo(frag);
  }, [path, state?.status]);

  const components = useMemo<React.ComponentProps<typeof ReactMarkdown>["components"]>(
    () => ({
      code({ className, children }) {
        const raw = String(children ?? "").replace(/\n$/, "");
        const lang = /language-(\S+)/.exec(className ?? "")?.[1];
        if (lang === "mermaid") return <MermaidBlock code={raw} dark={theme === "github-dark"} />;
        if (!lang && !raw.includes("\n")) return <code>{raw}</code>;
        return <ShikiCode lang={lang ?? "text"} code={raw} theme={theme} />;
      },
      a({ href, children }) {
        const onClick = (e: MouseEvent) => {
          if (!href) return;
          e.preventDefault();
          if (href.startsWith("#")) {
            jumpTo(decodeURIComponent(href.slice(1)));
            return;
          }
          const md = resolveMdLink(path, href);
          if (md) {
            // In-place navigation (docs-browser style): the explorer follows
            // the new doc's folder; external opens still get their own tabs.
            setPendingFrag(md.path, md.frag);
            onNavigate(md.path);
            return;
          }
          if (/^https?:\/\//i.test(href)) void openPath(href).catch(console.error);
        };
        return (
          <a href={href} onClick={onClick}>
            {children}
          </a>
        );
      },
      img({ src, alt }) {
        return <MdImg src={typeof src === "string" ? src : undefined} alt={alt ?? undefined} base={path} />;
      },
    }),
    // jumpTo is stable enough for the memo's purpose (reads latest via signals).
    [theme, path, onNavigate],
  );

  const layout = layoutFor(pid);
  const latestLayout = useRef(layout);
  const flushLayout = () => setLayoutFor(pid, latestLayout.current);

  let body: React.ReactNode;
  if (!state || state.status === "loading") {
    body = <div className="mdview-empty">loading…</div>;
  } else if (state.status === "error") {
    body = <div className="mdview-empty">{state.error}</div>;
  } else {
    const text = state.text;
    const onToggle = (id: string) => toggleCollapsed(path, id);
    const content = (
      <div className="mdview-content" ref={rootRef}>
        {state.doc.preamble ? (
          <div className="md-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {state.doc.preamble}
            </ReactMarkdown>
          </div>
        ) : null}
        {state.doc.tree.map((s) => (
          <SectionView
            key={s.id}
            sec={s}
            text={text}
            collapsed={collapsed}
            onToggle={onToggle}
            components={components}
          />
        ))}
        {!state.doc.tree.length && !state.doc.preamble ? (
          <div className="mdview-empty">empty document</div>
        ) : null}
      </div>
    );
    body = ui.explorerHidden ? (
      content
    ) : (
      <PanelGroup
        key="with-explorer"
        direction="horizontal"
        className="mdview-split"
        onLayout={(l) => {
          latestLayout.current = l;
        }}
      >
        <Panel defaultSize={layout[0]} minSize={14} maxSize={60} className="mdview-explorer-panel">
          <MdExplorer docPath={path} onNavigate={onNavigate} />
        </Panel>
        <PanelResizeHandle
          className="meme-sash meme-sash-vertical"
          onDragging={(dragging) => {
            if (!dragging) flushLayout();
          }}
          onBlur={flushLayout}
        />
        <Panel defaultSize={layout[1]}>{content}</Panel>
      </PanelGroup>
    );
  }

  return (
    <div
      className="v2-panel mdview-root"
      onKeyDown={(e) => {
        // Plain `b` toggles the explorer when the keystroke isn't headed for
        // an editable target (the tree's filter box, buttons, …).
        if (
          e.key === "b" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !(e.target instanceof HTMLInputElement) &&
          !(e.target instanceof HTMLTextAreaElement)
        ) {
          toggleExplorer();
        }
      }}
    >
      <div className="act-bar">
        <button
          type="button"
          onClick={toggleExplorer}
          title="toggle file explorer (b)"
        >
          {ui.explorerHidden ? "▸ explorer" : "◂ explorer"}
        </button>
        <span className="spy-title" title={path}>
          {baseName(path)}
        </span>
        <button type="button" onClick={() => setAllCollapsed(path, true)} title="fold every section">
          fold all
        </button>
        <button type="button" onClick={() => setAllCollapsed(path, false)} title="expand every section">
          unfold all
        </button>
        <label className="mdview-opt" title="new documents open fully folded (outline first)">
          <input
            type="checkbox"
            checked={ui.startFolded}
            onChange={(e) => setMdUi({ startFolded: e.target.checked })}
          />
          fold on open
        </label>
        <span className="spy-spacer" />
        <button type="button" onClick={() => void openPath(path).catch(console.error)} title="open in the OS default app">
          ↗ external
        </button>
      </div>
      {body}
    </div>
  );
});
