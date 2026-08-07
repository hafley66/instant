import { useEffect, useRef } from "react";
import { Signal, SignalCreator } from "@hafley66/signals";
import { SignalReact } from "@hafley66/signals/react";
import { Observable, scan } from "rxjs";
import { invoke } from "./generated/native";

type EditorEvent =
  | { type: "opening"; id: string; path: string }
  | { type: "ready"; id: string }
  | { type: "changed"; id: string; version: number }
  | { type: "saved"; id: string; version: number }
  | { type: "error"; id: string; error: string }
  | { type: "closed"; id: string };

export type EditorState = Record<string, {
  path: string;
  status: "opening" | "ready" | "error";
  version: number;
  savedVersion: number;
  error?: string;
}>;

export const editorEvents = SignalCreator<EditorEvent>({ event: true });
export const editorState = Signal(
  editorEvents.$.pipe(scan((state: EditorState, event): EditorState => {
    if (event.type === "opening") return { ...state, [event.id]: { path: event.path, status: "opening", version: 0, savedVersion: 0 } };
    if (event.type === "closed") {
      const next = { ...state };
      delete next[event.id];
      return next;
    }
    const current = state[event.id];
    if (!current) return state;
    if (event.type === "ready") return { ...state, [event.id]: { ...current, status: "ready" } };
    if (event.type === "changed") return { ...state, [event.id]: { ...current, version: event.version } };
    if (event.type === "saved") return { ...state, [event.id]: { ...current, savedVersion: event.version } };
    return { ...state, [event.id]: { ...current, status: "error", error: event.error } };
  }, {})),
  {},
);

const languageByExtension: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", css: "css", go: "go", html: "html",
  java: "java", js: "javascript", json: "json", jsx: "javascript", md: "markdown",
  py: "python", rs: "rust", sh: "shell", sql: "sql", ts: "typescript",
  tsx: "typescript", yaml: "yaml", yml: "yaml",
};

export function monacoLanguage(path: string): string {
  return languageByExtension[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}

export interface MonacoCodeViewerProps {
  id: string;
  path: string;
  text: string;
  dark: boolean;
  line?: number;
  onText?: (text: string) => void;
}

function editorLifetime(host: HTMLElement, props: MonacoCodeViewerProps): Observable<never> {
  return new Observable((subscriber) => {
    editorEvents.$({ type: "opening", id: props.id, path: props.path });
    let cancelled = false;
    let dispose = () => {};

    void Promise.all([
      import("monaco-editor/editor"),
      import("monaco-editor/features/find/register"),
      import("monaco-editor/languages/definitions/register.all"),
    ]).then(([monaco]) => {
      const model = monaco.editor.createModel(props.text, monacoLanguage(props.path), monaco.Uri.file(props.path));
      const editor = monaco.editor.create(host, {
        model,
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        theme: props.dark ? "vs-dark" : "vs",
      });
      const resize = new ResizeObserver(() => editor.layout());
      resize.observe(host);
      let version = 0;
      const changed = editor.onDidChangeModelContent(() => {
        version += 1;
        props.onText?.(model.getValue());
        editorEvents.$({ type: "changed", id: props.id, version });
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        void invoke("save_text", { path: props.path, text: model.getValue() })
          .then(() => editorEvents.$({ type: "saved", id: props.id, version }))
          .catch((error) => editorEvents.$({ type: "error", id: props.id, error: String(error) }));
      });
      if (props.line) {
        editor.revealLineInCenter(props.line);
        editor.setPosition({ lineNumber: props.line, column: 1 });
      }
      dispose = () => {
        changed.dispose();
        resize.disconnect();
        editor.dispose();
        model.dispose();
      };
      if (cancelled) dispose();
      else editorEvents.$({ type: "ready", id: props.id });
    }).catch((error) => {
      if (!cancelled) editorEvents.$({ type: "error", id: props.id, error: String(error) });
    });

    return () => {
      cancelled = true;
      dispose();
      editorEvents.$({ type: "closed", id: props.id });
      subscriber.complete();
    };
  });
}

export const MonacoCodeViewer = SignalReact(function MonacoCodeViewer(props: MonacoCodeViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const state = editorState[props.id].$();
  useEffect(() => {
    if (!host.current) return;
    const life = editorLifetime(host.current, props).subscribe();
    return () => life.unsubscribe();
  }, [props.id, props.path, props.text, props.dark, props.line]);
  return <div className="monaco-code-viewer" data-status={state?.status ?? "opening"} ref={host} />;
});
