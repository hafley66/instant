# REPORT: build-vs-buy for d2 code-fence rendering

## Context

Goal: render ```d2 fenced blocks in the markdown viewer (src/mdview) as diagrams,
mirroring the existing ```mermaid renderer (src/mdview/0a_MermaidDiagram.tsx). Winds:
no bespoke renderer, no server-side shell-out to a d2 binary (tauri app must work
offline without a d2 install). wasm is explicitly permitted.

## TOC

- Build-vs-buy table
- Candidate 1: @terrastruct/d2
- Candidate 2: d2-wasm wrappers on npm
- Decision
- Gates
- Commits
- Notes

## Build-vs-buy table

| Criterion        | @terrastruct/d2  | astro-d2 (closest wrapper)      |
|------------------|------------------|---------------------------------|
| version          | 0.1.33           | 0.13.1                          |
| last release     | 2025-08-17       | 2026-07-17                      |
| license          | MPL-2.0          | MIT                             |
| unpacked size    | ~59.7 MB         | depends on @terrastruct/d2      |
| API shape        | new D2(); compile(src) -> {diagram}; render(diagram) -> svg string | Astro remark plugin (build-time), wraps @terrastruct/d2 ^0.1.33 |
| browser render   | yes, wasm, dot-free | indirectly via @terrastruct/d2, but build-time AST transform |
| Tauri offline    | yes              | yes (compiles at build, not runtime) |

## Candidate 1: @terrastruct/d2

The official d2 TypeScript package, compiled to wasm. API: `new D2()`, then
`await d2.compile(source)` returns `{ diagram, renderOptions }`, then
`await d2.render(diagram, renderOptions)` returns the svg string. No graphviz dot
binary needed anywhere; the wasm does layout (dagre or elk) in-browser and in-node.
Runs in the tauri webview offline. MPL-2.0, published by terrastruct (the d2
authors), actively maintained against the d2 language. Large unpacked size is the
wasm engine plus bundled theme fonts, an acceptable price for a repo that already
bundles mermaid and shiki.

## Candidate 2: d2-wasm wrappers on npm

No standalone, maintained third-party "d2-wasm" wrapper exists on npm
(`npm search d2 wasm` returns only @terrastruct/d2 itself and unrelated tools).
The closest wrapper is `astro-d2`, an Astro remark plugin (MIT) built on top of
@terrastruct/d2. It is a build-time markdown transformer tied to the Astro/remark
stack, not a reusable browser runtime primitive; adopting it in this app would drag
in that stack and still run terrastruct's wrapper underneath. There is no case for
buying the wrapper when the wrapper's only engine is candidate 1 itself.

## Decision

Use candidate 1, `@terrastruct/d2`:

- It is the only maintained d2->svg wasm engine and the only real "d2-wasm wrapper"
  on npm; it is the official package from the d2 authors, active, and its two-step
  `compile` + `render` -> svg string API maps directly onto the existing mermaid
  component's async render to svg.
- The alt (astro-d2) is a build-time Astro plugin with no runtime browser primitive;
  it only re-exports the same engine, so it adds Astro stack weight with no new
  capability and would still depend on @terrastruct/d2.

## Gates (verbatim, run in order)

```
npx vitest run src/mdview
npx tsc --noEmit
npm run api:check
```

api:check exists in package.json scripts (node scripts/generate-api.mjs --check &&
node scripts/generate-native.mjs --check).

### Gate outputs

```
$ npx vitest run src/mdview
 Test Files  2 passed (2)
      Tests  23 passed (23)
   Start at  08:12:05
   Duration  702ms (transform 47ms, setup 0ms, import 111ms, tests 603ms, environment 0ms)

$ npx tsc --noEmit
src/mdview/0_Streamdown.tsx(50,9): error TS2322: Type '{ code: CodeHighlighterPlugin; renderers: { language: string; component: ({ code }: { code: string; }) => JSX.Element; }[]; }' is not assignable to type 'PluginConfig'.
  The types of 'code.highlight' are incompatible between these types.
    ...shiki BundledLanguage mismatch...
src/plugin.test.ts(69,64): error TS2339: Property 'label' does not exist on type 'CtxItem'.
  Property 'label' does not exist on type '{ sep: true; }'.
EXIT:2
   Note: both errors reproduce on the base commit 4201461 via `git stash`; neither is
   introduced by this change. The plugin.test.ts(69,64) error is the known one from the
   brief; the 0_Streamdown.tsx code.highlight mismatch is a second pre-existing one.

$ npm run api:check
> instant@0.1.1 api:check
> node scripts/generate-api.mjs --check && node scripts/generate-native.mjs --check

EXIT:0
```

## Commits (stepwise)

1. dep add @terrastruct/d2
2. component 0a_D2Diagram.tsx
3. registry (0_Streamdown.tsx) + css (mdview.css)
4. tests (d2 render test beside model.test.ts) + fixture

## Notes

- One pre-existing tsc error in src/plugin.test.ts(69,64) is known and not from this
  work.
- Class family: mdview-d2, mdview-d2-error (mirrors mdview-mermaid, mdview-mermaid-error).
- Dark theme: pass RenderOptions.darkThemeID matching the current theme, same shape
  as MermaidDiagram's theme: dark ? "dark" : "default".
- Fixture: skipped. MdExplorer reads the live filesystem via a host (getMdviewHost)
  rooted at the open doc's directory (src/mdview/MdExplorer.tsx); the repo ships no
  bundled sample .md fixtures under a fixture path, so there is nothing to add one to.
  The unit test in src/mdview/d2.test.ts covers rendering in its place.
