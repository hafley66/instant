import * as monaco from "monaco-editor/editor";
import "monaco-editor/languages/definitions/javascript/register";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { codeToHtml } from "shiki";

type Renderer = "monaco" | "codemirror" | "shiki";
type Sample = { name: string; text: string; bytes: number; lines: number };
type Result = {
  renderer: Renderer;
  sample: string;
  run: "cold" | number;
  mountMs: number;
  scrollMs: number;
  domNodes: number;
};

const line = "export const value_000000 = ({ alpha: 1, beta: [2, 3, 5] }).beta.map((n) => n * 2);\n";

function sample(name: string, targetBytes: number): Sample {
  const count = Math.ceil(targetBytes / line.length);
  const text = Array.from({ length: count }, (_, index) =>
    line.replace("000000", String(index).padStart(6, "0")),
  ).join("");
  return { name, text, bytes: new Blob([text]).size, lines: count };
}

const samples = [
  sample("4 KiB", 4 * 1024),
  sample("256 KiB", 256 * 1024),
  sample("1 MiB", 1024 * 1024),
];

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function twoFrames() {
  await nextFrame();
  await nextFrame();
}

async function mount(renderer: Renderer, text: string): Promise<Omit<Result, "renderer" | "sample" | "run">> {
  const host = document.createElement("div");
  host.className = "bench-host";
  document.body.append(host);
  let dispose = () => {};
  const started = performance.now();

  if (renderer === "monaco") {
    const model = monaco.editor.createModel(text, "javascript");
    const editor = monaco.editor.create(host, {
      model,
      automaticLayout: false,
      minimap: { enabled: false },
      readOnly: true,
      scrollBeyondLastLine: false,
      wordWrap: "off",
    });
    editor.layout({ width: 960, height: 540 });
    dispose = () => {
      editor.dispose();
      model.dispose();
    };
  } else if (renderer === "codemirror") {
    const state = EditorState.create({ doc: text, extensions: [lineNumbers(), javascript(), EditorView.editable.of(false)] });
    const editor = new EditorView({ state, parent: host });
    dispose = () => editor.destroy();
  } else {
    host.innerHTML = await codeToHtml(text, { lang: "javascript", theme: "github-dark" });
  }

  await twoFrames();
  const mountMs = performance.now() - started;
  const domNodes = host.querySelectorAll("*").length;
  const scroller = renderer === "monaco"
    ? host.querySelector<HTMLElement>(".monaco-scrollable-element")
    : renderer === "codemirror"
      ? host.querySelector<HTMLElement>(".cm-scroller")
      : host;
  const scrollStarted = performance.now();
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  await nextFrame();
  const scrollMs = performance.now() - scrollStarted;
  dispose();
  host.remove();
  await nextFrame();
  return { mountMs, scrollMs, domNodes };
}

async function run() {
  const results: Result[] = [];
  for (const renderer of ["monaco", "codemirror", "shiki"] as const) {
    for (const current of samples) {
      results.push({ renderer, sample: current.name, run: "cold", ...await mount(renderer, current.text) });
      for (let run = 1; run <= 2; run += 1) {
        results.push({ renderer, sample: current.name, run, ...await mount(renderer, current.text) });
      }
    }
  }

  const warm = results.filter((result) => result.run !== "cold");
  const summary = samples.flatMap((current) =>
    (["monaco", "codemirror", "shiki"] as const).map((renderer) => {
      const rows = warm.filter((result) => result.renderer === renderer && result.sample === current.name);
      const median = (key: "mountMs" | "scrollMs" | "domNodes") => {
        const values = rows.map((row) => row[key]).sort((a, b) => a - b);
        const upper = Math.floor(values.length / 2);
        return values.length % 2 ? values[upper] : (values[upper - 1] + values[upper]) / 2;
      };
      return {
        renderer,
        sample: current.name,
        bytes: current.bytes,
        lines: current.lines,
        mountMs: Number(median("mountMs").toFixed(1)),
        scrollMs: Number(median("scrollMs").toFixed(1)),
        domNodes: median("domNodes"),
        coldMountMs: Number(results.find((result) => result.renderer === renderer && result.sample === current.name && result.run === "cold")!.mountMs.toFixed(1)),
      };
    }),
  );

  const output = document.createElement("pre");
  output.id = "results";
  output.textContent = JSON.stringify({
    samples: samples.map(({ text: _text, ...current }) => current),
    summary,
    raw: results,
  }, null, 2);
  document.body.append(output);
  document.documentElement.dataset.done = "true";
}

void run();
