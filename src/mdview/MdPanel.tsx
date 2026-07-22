// The markdown viewer panel body: file explorer (shared FileTree on the
// canonical TreeTable) | rendered sections, split with react-resizable-panels
// (AGENTS "Split panes"). All state lives in the signals module; signal reads
// happen here at the top (SignalReact tracks them) and flow down as props.
import { Children, createContext, lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { StreamdownProps } from "streamdown";
import { SignalReact } from "@hafley66/signals/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "../generated/native";
import { useApp } from "../useStore";
import { baseName } from "../core";
import {
  expandChain,
  resolveMdLink,
  sectionDisplayTitle,
  sliceOwn,
  type ListFolds,
  type MdSection,
} from "./model";
import {
  blockFoldsFor,
  collapsedFor,
  expandIds,
  initCollapsedForReadyDoc,
  layoutFor,
  loadMdDoc,
  reloadMdDoc,
  mdDocs,
  mdUi,
  setAllCollapsed,
  setLayoutFor,
  setMdUi,
  toggleBlockFold,
  toggleCollapsed,
  toggleExplorer,
  type StrSignal,
} from "./signals";
import { setPendingFrag, takePendingFrag } from "./open";
import { resetPanelZoom } from "../panelZoom";
import { MdExplorer } from "./MdExplorer";
import { useFsWatch } from "./0_watch";
import "./mdview.css";

const StreamdownBody = lazy(() => import("./0_Streamdown"));

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

// Offsets inside a rendered section slice are relative to the slice start;
// the fold model keys on absolute source offsets, so each section provides
// its ownStart and the list/item renderers re-base. Sections render their
// slices UNTRIMMED (leading newlines are harmless markdown) precisely so
// these offsets stay aligned.
const SliceBaseContext = createContext(0);

function FoldTwisty({
  folded,
  title,
  onToggle,
}: {
  folded: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <span
      className="md-twisty"
      role="button"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
    >
      {folded ? "▸" : "▾"}
    </span>
  );
}

interface SectionProps {
  sec: MdSection;
  siblingIndex: number;
  text: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  components: StreamdownProps["components"];
  dark: boolean;
}

function MarkdownBody({ children, components, dark }: { children: string; components: SectionProps["components"]; dark: boolean }) {
  return (
    <Suspense fallback={<pre><code>{children}</code></pre>}>
      <StreamdownBody components={components} dark={dark}>{children}</StreamdownBody>
    </Suspense>
  );
}

function SectionView({ sec, siblingIndex, text, collapsed, onToggle, components, dark }: SectionProps) {
  const isCollapsed = collapsed.has(sec.id);
  // Untrimmed for rendering (offset alignment, see SliceBaseContext); the trim
  // is only the emptiness check.
  const ownRaw = isCollapsed ? "" : sliceOwn(text, sec);
  const hasOwn = ownRaw.trim().length > 0;
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
        <span className="mdview-title">{sectionDisplayTitle(sec.title, siblingIndex)}</span>
      </div>
      {!isCollapsed && (
        <div className="mdview-body">
          {hasOwn ? (
            <div className="md-body">
              <SliceBaseContext.Provider value={sec.ownStart}>
                <MarkdownBody components={components} dark={dark}>
                  {ownRaw}
                </MarkdownBody>
              </SliceBaseContext.Provider>
            </div>
          ) : null}
          {sec.children.map((c, index) => (
            <SectionView
              key={c.id}
              sec={c}
              siblingIndex={index}
              text={text}
              collapsed={collapsed}
              onToggle={onToggle}
              components={components}
              dark={dark}
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
  const dark = app.mode === "dark";
  const path = pathSig.$();
  const state = mdDocs.$()[path];
  const ui = mdUi.$();
  const collapsed = collapsedFor(path).$();
  // Per-tab content zoom (generic panelZoom registry; ⌘+/-/0 when active).
  // Applied to the reading pane only — the explorer is UI chrome, and a CSS
  // zoom on the PanelGroup would skew its sash pointer math.
  const zoom = app.panelZoom[pid] ?? 1;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadMdDoc(path);
  }, [path]);
  useFsWatch(path, () => void reloadMdDoc(path));
  useEffect(() => {
    if (state?.status === "ready") initCollapsedForReadyDoc(path);
  }, [path, state?.status]);

  const doc = state?.status === "ready" ? state.doc : null;
  const blockFolds = blockFoldsFor(path).$();
  const folds: ListFolds = useMemo(
    () =>
      doc?.folds ?? { lists: new Map(), firstItemToList: new Map(), items: new Set(), all: [] },
    [doc],
  );

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

  const components = useMemo<StreamdownProps["components"]>(
    () => ({
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
      // VSCode-style list folding: a list collapses to its first item (plus a
      // "… N more" row); a multi-block item collapses to its first block. The
      // list's twisty lives at the start of its first item (folds.firstItemToList
      // is the lookup); item twisties sit on the item itself. Node positions
      // come from react-markdown's hast nodes and are re-based per section
      // (SliceBaseContext).
      ul({ node, children, ...rest }) {
        const abs = (node?.position?.start.offset ?? -1) + useContext(SliceBaseContext);
        const count = folds.lists.get(abs);
        if (count == null) return <ul {...rest}>{children}</ul>;
        const folded = blockFolds.has(abs);
        const kids = Children.toArray(children);
        return (
          <ul {...rest} className={folded ? "md-folded-list" : undefined}>
            {folded ? kids.slice(0, 1) : kids}
            {folded ? (
              <li className="md-fold-more" onClick={() => toggleBlockFold(path, abs)}>
                … {count - 1} more item{count - 1 === 1 ? "" : "s"}
              </li>
            ) : null}
          </ul>
        );
      },
      ol({ node, children, ...rest }) {
        const abs = (node?.position?.start.offset ?? -1) + useContext(SliceBaseContext);
        const count = folds.lists.get(abs);
        if (count == null) return <ol {...rest}>{children}</ol>;
        const folded = blockFolds.has(abs);
        const kids = Children.toArray(children);
        return (
          <ol {...rest} className={folded ? "md-folded-list" : undefined}>
            {folded ? kids.slice(0, 1) : kids}
            {folded ? (
              <li className="md-fold-more" onClick={() => toggleBlockFold(path, abs)}>
                … {count - 1} more item{count - 1 === 1 ? "" : "s"}
              </li>
            ) : null}
          </ol>
        );
      },
      li({ node, children, className, ...rest }) {
        const abs = (node?.position?.start.offset ?? -1) + useContext(SliceBaseContext);
        const listStart = folds.firstItemToList.get(abs);
        const itemFoldable = folds.items.has(abs);
        if (listStart == null && !itemFoldable) return <li {...rest} className={className}>{children}</li>;
        const listFolded = listStart != null && blockFolds.has(listStart);
        const itemFolded = itemFoldable && blockFolds.has(abs);
        const kids = Children.toArray(children);
        const cls = [className, itemFolded ? "md-folded-item" : ""].filter(Boolean).join(" ");
        return (
          <li {...rest} className={cls || undefined}>
            {listStart != null ? (
              <FoldTwisty folded={listFolded} title="fold list" onToggle={() => toggleBlockFold(path, listStart)} />
            ) : null}
            {itemFoldable ? (
              <FoldTwisty folded={itemFolded} title="fold item" onToggle={() => toggleBlockFold(path, abs)} />
            ) : null}
            {itemFolded ? (
              <span className="md-item-folded-body">
                {kids.slice(0, 1)}
                <span className="md-item-more">…</span>
              </span>
            ) : (
              kids
            )}
          </li>
        );
      },
    }),
    // jumpTo is stable enough for the memo's purpose (reads latest via signals).
    [path, onNavigate, folds, blockFolds],
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
      <div className="mdview-content" ref={rootRef} style={{ zoom }}>
        {state.doc.preamble ? (
          <div className="md-body">
            <SliceBaseContext.Provider value={0}>
              <MarkdownBody components={components} dark={dark}>
                {state.doc.preamble}
              </MarkdownBody>
            </SliceBaseContext.Provider>
          </div>
        ) : null}
        {state.doc.tree.map((s, index) => (
          <SectionView
            key={s.id}
            sec={s}
            siblingIndex={index}
            text={text}
            collapsed={collapsed}
            onToggle={onToggle}
            components={components}
            dark={dark}
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
        {zoom !== 1 ? (
          <button type="button" onClick={() => resetPanelZoom(pid)} title="content zoom — reset (⌘0)">
            {Math.round(zoom * 100)}%
          </button>
        ) : null}
        <span className="spy-spacer" />
        <button type="button" onClick={() => void openPath(path).catch(console.error)} title="open in the OS default app">
          ↗ external
        </button>
      </div>
      {body}
    </div>
  );
});
