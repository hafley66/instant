# Interactive and live SVG rendering research

## Research metadata

- Date: 2026-08-09
- Scope: large D2-generated SVG in Instant, with live pan, zoom, links, text, and possible future node editing.
- Local application: `/Users/chrishafley/projects/instant`
- Fixture: `/Users/chrishafley/projects/hafley-rxjs/packages/grapht/1_app_model.d2`
- Internet sources were checked on 2026-08-09. Release pages below use each repository's `/releases/latest` redirect.

## Local code inventory

The current file is [src/1_SvgDocumentViewer.tsx](../src/1_SvgDocumentViewer.tsx).

| Area | Current behavior | Relevant locations |
|---|---|---|
| SVG preparation | `sanitizeSvgDocument()` runs in `useMemo`; a Blob URL is created for the sanitized string. | `1_SvgDocumentViewer.tsx:20-22`, `0_svgSanitize.ts` |
| Embedded document | `<object type="image/svg+xml">` owns the rendered SVG in an external document. | `1_SvgDocumentViewer.tsx:178-187` |
| Camera writes | `requestAnimationFrame()` coalesces writes, then `contentDocument.documentElement.setAttribute("viewBox", ...)` mutates the embedded SVG root. | `1_SvgDocumentViewer.tsx:33-48` |
| Pointer input | Pointer capture, direct refs, and no React state changes during interaction. | `1_SvgDocumentViewer.tsx:103-132` |
| Wheel input | Non-passive listener calls `preventDefault()`, then schedules pan or zoom. | `1_SvgDocumentViewer.tsx:83-102`, `144-158` |
| Hit testing | The viewer asks the embedded document for `elementFromPoint()` and walks to the nearest `<a>`. | `1_SvgDocumentViewer.tsx:75-81` |
| Object CSS | The object is 100% by 100%; the stage clips overflow; pointer events are disabled on the object so the stage receives gestures. | `src/styles.css:1794-1821` |
| Native pan proof | `0_native_pan_proof.html` uses an overflow scroller and direct scroll offsets as a separate experiment. | `0_native_pan_proof.html` |
| Fixture size | `1_app_model.d2` is 719 lines and 19,428 bytes. A simple source count reports 316 colon-bearing lines and 34 arrow-bearing lines; these are source-shape counts, not rendered SVG element counts. | local fixture |

The important distinction is that React work has already been removed from the camera loop. The remaining unknown is the browser's style, layout, paint, raster, and composite work after changing the SVG root `viewBox`. `viewBox` defines the user-space rectangle mapped to the SVG viewport, so changing it changes the root coordinate transform. See [MDN viewBox](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/viewBox).

## Executive index

1. A CSS transform or native scroll can be compositor-only after content has been painted, but the layer size, raster scale, clipping, and memory cost must be measured. [web.dev rendering performance](https://web.dev/articles/rendering-performance) describes the JS, style, layout, paint, and composite paths; [Chrome RenderingNG data structures](https://developer.chrome.com/docs/chromium/renderingng-data-structures) describes the tradeoff between repaint avoidance and GPU memory.
2. Direct `viewBox` mutation preserves SVG semantics and current link probing, but it is the candidate most likely to invalidate the SVG's internal rendering for every camera frame. This is a hypothesis until a trace separates script, layout, paint, raster, and presentation time.
3. Native overflow scrolling is the smallest zero-SVG-mutation experiment. It requires a world-sized scroll child and a camera model that maps scroll offsets to SVG coordinates. The current 100% object cannot expose a larger world through scrolling without changing its layout contract.
4. A temporary bitmap or compositor wrapper can make a gesture smooth while live SVG is frozen. It moves the cost to one snapshot and introduces scale quality, bitmap memory, and accessibility/hit-test synchronization problems.
5. Canvas2D with OffscreenCanvas can move drawing to a worker. It still requires a separate scene model, manual hit testing, and a DOM or HTML overlay for accessible links and text. [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) documents worker rendering and transferable canvases.
6. WebGL is a practical retained renderer for a large graph when geometry is represented as buffers and the camera is a uniform. WebGPU has stronger GPU and compute APIs but remains limited-availability across browsers and WebViews. [MDN WebGL](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API), [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).
7. Rust `resvg`/`usvg`/`tiny-skia` and CanvasKit can rasterize or draw with a different engine. They do not preserve DOM links, AOM exposure, browser text selection, or native SVG hit testing. `usvg` explicitly describes its supported tree as static and excludes links, events, scripts, views, and animations. [usvg docs](https://doc.servo.org/usvg/index.html), [resvg repository](https://github.com/linebender/resvg).
8. Go WASM adds a Go runtime and `wasm_exec.js`; the Go project documents a smallest practical Wasm output around 2 MB before compression. [Go WebAssembly wiki](https://go.dev/wiki/WebAssembly).

## Capability matrix

Legend: `native` means the browser supplies the behavior; `manual` means application code must build or maintain it; `snapshot` means it can be retained only in a separate DOM/scene layer.

| Strategy | Gesture frame work | Update/diff cost | Retained interactivity | Hit testing | Text and link accessibility | Copies and memory | Worker viability | Browser/Tauri WebView considerations | Expected bottleneck stage |
|---|---|---|---|---|---|---|---|---|---|
| Direct root `viewBox` mutation in current `<object>` | JS event plus root attribute mutation each RAF | Browser recalculates the SVG viewport transform; no application diff for unchanged content | native SVG document remains live | Current `elementFromPoint()` probe | Embedded SVG document and links remain available, subject to assistive technology behavior | SVG display lists/raster tiles remain browser-owned; exact memory is engine-dependent | SVG DOM mutation remains tied to the document context | `<object>` exposes an embedded SVG document through `HTMLObjectElement.getSVGDocument()`; Tauri uses the OS webview | Attribute invalidation, SVG layout/paint/raster, then composite. Verify with trace |
| Compositor wrapper `translate3d` for pan, commit `viewBox` on end | Pointer events update one wrapper transform; one live SVG commit on end | No per-frame SVG camera mutation during the gesture; one commit after release | live SVG after commit; frozen view during gesture | Map pointer through wrapper transform or probe frozen document | live DOM retained, but focused/hovered link state can lag while frozen | Promoted layer consumes GPU memory; transform can enlarge or shrink one painted surface | Pointer processing can stay main-thread; browser compositor can move the layer | `transform` is widely available; layer promotion is a browser decision, not a guarantee | Composite-only if already painted and layerized; otherwise initial paint/raster and layer allocation |
| Native overflow scroll | Scroll offset handled by scroll/compositor machinery when eligible | Zero camera writes; layout must establish a world-sized child | native SVG if the child remains SVG/object | Native SVG hit testing with scroll coordinate mapping | native SVG semantics | Scroll tiles/layers are browser-owned; large scrollable content can increase raster tile coverage | Native scrolling can remain responsive during main-thread work in eligible cases | Current non-passive wheel listener and `touch-action:none` deliberately disable native gesture paths; experiment must remove those for the test | Scroll/composite if eligible; layout or tile raster if world geometry is not already painted |
| `<object>` external SVG | Same as chosen camera strategy, plus embedded-document boundary | DOM is parsed and maintained in a separate document; current code mutates only its root | live embedded SVG, including SVG markup and anchors | Cross-document `elementFromPoint()` as in current code | `aria-label` is on the object; individual embedded content semantics require testing in target AT/browser | separate document, Blob URL, SVG display lists | Worker cannot directly manipulate the DOM document | [MDN object](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/object) and [HTMLObjectElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLObjectElement) document this boundary | Browser SVG pipeline and boundary overhead; profile rather than assume |
| Inline SVG | Same camera strategies; CSS transform can be applied to an inline wrapper or root | Direct DOM updates and styles; no embedded-document boundary; potentially larger host DOM | native SVG DOM, CSS, events, focus, and AOM | native `elementFromPoint()` | Inline SVG markup is available to the AOM; `title`, `desc`, and ARIA can be used. [MDN SVG in HTML](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_in_HTML) | Main document DOM and display lists | DOM remains main-thread; geometry can be parsed elsewhere before insertion | Usually available in all target WebViews; host CSS and style invalidation are shared | Main-document style/layout/paint and SVG raster |
| `<img src=svg>` | CSS transform or scroll of an image surface | Decode/raster happens as an image; no per-element DOM diff | image only | Manual spatial index or overlay | `alt` gives image-level semantics; individual SVG links are unavailable through the image. [MDN img](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img) | Decoded image surface; browser can cache image resource | Decode may be browser-managed; application scene logic still needs a worker if used | SVG-as-image disables scripts and external resources in image contexts. [MDN SVG as image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image) | Image decode/raster at chosen size, then composite |
| Temporary bitmap snapshot | One snapshot before gesture; CSS transform or native scroll of bitmap during gesture | One full rasterization or decode per snapshot; no per-frame scene diff | live SVG must be hidden or layered separately | Manual map or live overlay; snapshot alone has no DOM targets | Bitmap has no individual text/link accessibility; retain a DOM/HTML/SVG accessibility layer | RGBA is `width * height * 4` bytes before browser/GPU copies; DPR multiplies both dimensions | Snapshot production can run in a worker with OffscreenCanvas, but presentation remains a canvas/image | `ImageBitmap`, `OffscreenCanvas`, and `bitmaprenderer` support must be tested in each Tauri target | One-time raster/decode, then composite; memory bandwidth during transfers |
| Canvas2D on main thread | JS pointer loop plus imperative redraw | Application redraws visible primitives; no DOM diff | scene model retained by app, pixels not retained by browser DOM | Manual spatial index, color picking, or geometry tests | DOM/HTML overlay needed for accessible labels and links | Canvas bitmap plus draw-state; full redraw cost depends on primitive count and effects | Main-thread only in this variant | Broad support; browser canvas implementation varies | JS draw calls, Canvas raster, or upload |
| OffscreenCanvas 2D worker | Main thread sends camera/model changes; worker draws; canvas presentation is transferred | Worker can retain parsed geometry and redraw only required layers, but messages and bitmap presentation remain | app-retained scene, not DOM-retained SVG | Manual hit testing on main or worker | DOM/HTML overlay needed | Worker canvas bitmap plus transfer/presentation surfaces; `transferToImageBitmap()` ownership must be managed | Native API explicitly supports workers and transferable control. [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) | Feature is broadly available, but verify WKWebView/WebKitGTK versions used by Tauri | Worker draw/raster, synchronization, or canvas presentation |
| WebGL scene renderer | Camera uniform update plus draw submission; geometry can remain in GPU buffers | Buffer uploads only when model changes; camera updates do not rebuild geometry | app scene graph or graph library; no SVG DOM | Spatial index, offscreen ID/color picking, or library event layer | HTML/SVG overlay for text, links, keyboard focus, and AOM | GPU vertex/index/texture buffers; label canvas/DOM adds another surface | WebGL contexts are available in workers through OffscreenCanvas where supported. [MDN WebGL](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API) | WebGL is broadly deployed in browser engines and Tauri WebViews; context loss and driver differences remain test cases | Draw-call count, shader fill, texture upload, readback for picking |
| WebGPU scene renderer | Camera uniform update plus command encoding; GPU buffers retained | Model changes update buffers; camera is uniform state | app scene graph; no SVG DOM | GPU picking or CPU spatial index | HTML/SVG overlay required | GPU buffers and bind groups; explicit resource lifecycle | Worker viability depends on WebGPU plus worker canvas support | MDN marks WebGPU limited availability and secure-context requirements; test every Tauri engine | Command encoding, pipeline setup, GPU fill, synchronization |
| `resvg` + `usvg` + `tiny-skia` Rust WASM | CPU raster call per requested frame/tile; no browser SVG DOM | Parse/preprocess once, then render full or tiled raster; incremental scene updates require application work | retained parsed static tree only; no native links/events | Manual spatial index from source/model | Raster output has no individual AOM nodes; overlay required | Wasm linear memory plus RGBA output; transferring full frames is costly; tiled output bounds copies | Rust Wasm can run in a worker; browser APIs require message/typed-array boundaries | Wasm works in browser WebViews; SIMD, threads, fonts, and SharedArrayBuffer require target checks | Wasm parse/raster CPU, memory copies, then canvas upload |
| CanvasKit / Skia WASM | Skia draw calls to a hardware-backed canvas; camera can be a matrix | Retain Skia paths/text objects and redraw; application owns invalidation | Skia objects, not DOM SVG | Manual spatial index or overlay | DOM/HTML overlay required; CanvasKit path parsing is not a full accessible SVG DOM | Wasm heap, Skia objects, GPU surface; Skia docs require explicit `.delete()` for many objects | Worker use depends on chosen canvas/context path and target WebView | Official docs describe WebGL-backed hardware surfaces and NPM delivery. [CanvasKit](https://docs.skia.org/docs/user/modules/canvaskit/) | Skia command recording, GPU upload, Wasm bridge, object lifetime |
| Go WASM raster/renderer | Same canvas/WebGL choice, plus Go runtime scheduling and JS calls | App-owned scene diff; runtime and JS boundary costs | app scene only | manual | overlay required | Go Wasm runtime, `wasm_exec.js`, heap, output buffer | Worker possible, but runtime/message startup must be measured | Official Go docs require `GOOS=js GOARCH=wasm` and `wasm_exec.js`; verify binary startup and memory | Go runtime startup, JS bridge, renderer, or output copy |

## Strategy details and constraints

### Direct `viewBox` mutation

The current path has two useful properties: all camera writes are coalesced to one `requestAnimationFrame`, and no React state is changed during pan or wheel input. `writeBox()` still changes the embedded SVG root attribute on every committed frame. Since the root `viewBox` establishes the coordinate mapping, the browser must update the visual result. The exact invalidation path is engine-specific. The trace must determine whether the dominant cost is style/layout, SVG paint, raster, or GPU presentation.

The non-passive wheel handler calls `preventDefault()`. That is required for custom wheel zoom and pan, but it excludes the browser's passive/async scroll path for that event. `touch-action:none` similarly requests application-owned pointer gestures. This makes the current viewer a useful controlled baseline and a poor native-scroll baseline.

### Compositor-only wrapper transform

The smallest controlled experiment is a wrapper with `will-change: transform` set only between pointer down and pointer up. Freeze the SVG camera at pointer down, apply `translate3d()` to the wrapper on pointer move, then commit one `viewBox` update and clear the transform on pointer up. The wrapper must be large enough for the transformed surface and must have a defined transform origin. A wrapper around the current 100% object only moves the already-painted viewport; it does not expose unpainted SVG world coordinates.

The expected benefit is conditional. `transform` is eligible for the compositor path, but layerization is heuristic. [web.dev compositor-only animations](https://web.dev/articles/animations-guide) recommends `transform` and `opacity` for animations and warns that `will-change` should be used sparingly. Chrome documents the tradeoff: too many layers can cost more GPU memory than repainting small regions. [Chrome inside the browser](https://developer.chrome.com/blog/inside-browser-part3).

For zoom, a transformed snapshot has a fixed raster scale. Scaling above one can blur or reveal insufficient pixels; scaling below one can leave unused space unless the retained surface covers the full world. A zoom wrapper should therefore be tested separately from pan.

### Native overflow scrolling

The native proof should use these cases as separate fixtures:

1. An inline SVG whose CSS/layout width and height are the complete SVG world, inside a viewport with `overflow:auto`.
2. An `<object>` whose HTML element is sized to the complete world, inside the same scroll viewport.
3. A fixed-size object with a nested world-sized wrapper, to determine whether the external SVG can be scrolled without changing its root `viewBox`.

Record scroll events and frame traces with no wheel listener, a passive wheel listener, and the current non-passive listener. Native scroll can avoid JS and SVG mutations when the browser has already painted the needed tiles, but a giant SVG world can still cause layout and raster work as new tiles become visible.

### `<object>`, inline SVG, and `<img>`

`<object>` is the current compatibility point because `HTMLObjectElement.getSVGDocument()` exposes the embedded SVG document. [MDN HTMLObjectElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLObjectElement). It also creates a document boundary, so link activation, focus, accessibility-tree exposure, CSS inheritance, and DevTools frame selection should be checked in each browser/WebView.

Inline SVG makes every element part of the host DOM and AOM. It gives direct CSS, event, and accessibility access, but it also makes the large SVG participate in the host document's style and invalidation graph. [MDN SVG in HTML](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_in_HTML).

`<img>` is a decoded image surface. It is suitable for a static background or snapshot and supports image-level `alt` semantics. It cannot expose the SVG's individual links or allow JavaScript to manipulate the image document. SVG image contexts also disable scripts and may block external resources. [MDN SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).

### CSS containment, content visibility, and layer hints

`contain` lets the browser isolate a subtree when its outside effects are bounded. `content-visibility:auto` can skip rendering of offscreen content while retaining it in the DOM and accessibility tree. [MDN containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using), [MDN content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility).

For a single SVG that fills the stage, `content-visibility:auto` has no descendant-level culling model. It can still help if the entire viewer is offscreen or if diagrams are split into independently positioned tiles. `contain: strict` or `contain: paint` can alter sizing and clipping, so apply it only in a benchmark branch and record visual/link regressions.

`will-change: transform` can pre-promote a surface, but it does not make root `viewBox` writes compositor-only. The relevant evidence is paint flashing, layer borders, layer memory, and trace categories. [Chrome rendering performance tools](https://developer.chrome.com/docs/devtools/rendering/performance) documents Paint Flashing, Layer Borders, frame rendering stats, and GPU memory indicators.

### Temporary bitmap snapshot

Snapshot options, ordered by semantic retention:

- Rasterize the sanitized SVG through an SVG image source into a canvas, then transform the canvas during the gesture.
- Use `OffscreenCanvas` in a worker and present its bitmap on a visible canvas.
- Keep the live `<object>` visible but put a bitmap layer above it during the gesture, hiding the bitmap after the one-shot commit.

The live SVG should remain present for link and text semantics, but it must not receive pointer events while the bitmap is active. A hit-test overlay can map screen coordinates to the frozen camera and use the source model or the embedded document. A full RGBA surface uses `w * h * 4` bytes before browser/GPU copies, and device-pixel-ratio multiplies both dimensions. A tile pyramid limits this cost and aligns with large-world navigation, but introduces tile invalidation and seam logic.

### Canvas2D and OffscreenCanvas

Canvas2D is a retained application model plus immediate drawing commands. It avoids DOM element count and browser SVG display-list invalidation, but every changed frame redraws the relevant pixels. An OffscreenCanvas transfers control of a canvas to a worker; the worker can obtain a 2D or WebGL context and can run its own animation loop. [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas).

The correct division is pointer sampling and accessibility overlay on the main thread, geometry/model and draw preparation in the worker, and camera state as a small message. Do not send the full SVG string or a full RGBA frame for every pointer event. Use a typed camera message and a retained worker-side scene. The worker still cannot manipulate the host DOM or make canvas pixels accessible to a screen reader.

### WebGL, WebGPU, and existing graph renderers

WebGL is a hardware-accelerated canvas API and is available in workers when paired with OffscreenCanvas in supporting engines. A retained graph renderer can store edge/node geometry in buffers, update a camera matrix or uniform every frame, and draw visible primitives in batches. Text and links usually need separate Canvas or DOM layers.

WebGPU exposes modern GPU and compute functionality but is marked limited availability by MDN and requires a secure context in supporting browsers. [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API). It should be an optional backend after WebGL or Canvas2D behavior is established.

Existing libraries show the common split:

| Library | Current renderer fact | Semantic architecture |
|---|---|---|
| Sigma.js | Documentation says it targets thousands of nodes and edges with WebGL. Its default layers include WebGL edges/nodes and Canvas labels/hovers. [Sigma introduction](https://www.sigmajs.org/docs/), [Sigma layers](https://www.sigmajs.org/docs/advanced/layers/). | Graphology data model, WebGL programs, Canvas label layers, mouse layer. It requires conversion from arbitrary D2 SVG into graph data and style primitives. |
| Cytoscape.js | Core documentation describes an interactive graph library with gestures including pinch zoom, selection, and panning. Its 3.31 WebGL renderer preview describes the prior Canvas renderer and a new WebGL path. [Cytoscape.js](https://js.cytoscape.org/index.html), [WebGL renderer preview](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/). | Graph model and renderer own the scene. Arbitrary SVG markup, links, and exact D2 styling need an import/adapter. |
| PixiJS | Renderer docs describe a WebGL renderer with batching and an event system. PixiJS 8.19.0 release notes also describe a WebGPU path and HTML-in-canvas texture support. [Pixi renderer](https://api.pixijs.io/%40pixi/core/PIXI/Renderer.html), [Pixi events](https://api.pixijs.io/%40pixi/events.html), [v8.19.0 release](https://github.com/pixijs/pixijs/releases/tag/v8.19.0). | Scene graph and federated events are retained by the library; DOM/AOM semantics for the graph still require an overlay. |

Release pages checked on 2026-08-09: `resvg v0.48.1` ([release](https://github.com/linebender/resvg/releases/tag/v0.48.1), released 2026-08-02), `PixiJS v8.19.0` ([release](https://github.com/pixijs/pixijs/releases/tag/v8.19.0), 2026-06-04), `Cytoscape.js v3.34.0` ([release](https://github.com/cytoscape/cytoscape.js/releases/tag/v3.34.0), 2026-06-02), and `Sigma v3.0.3` ([release](https://github.com/jacomyal/sigma.js/releases/tag/sigma%403.0.3)). These versions are reference points for the research date, not dependency recommendations.

### Rust `resvg`/`usvg`/`tiny-skia` WASM

`resvg` separates SVG preprocessing (`usvg`) from rendering and uses `tiny-skia`; its repository describes reproducible pixel output and a static raster renderer. [resvg README](https://github.com/linebender/resvg), [resvg API](https://docs.rs/resvg/latest/resvg/). `usvg`'s documented tree intentionally covers static SVG and excludes `a`, `view`, `cursor`, `script`, events, and animations. [usvg API](https://doc.servo.org/usvg/index.html).

This stack fits a background raster, export, or tile server. For live interaction it requires a separate scene model, manual hit testing, text/link overlays, and a tile or bitmap upload protocol. Rendering into a Wasm-owned RGBA buffer then copying that buffer into a browser canvas adds a measurable memory-bandwidth stage. A Rust worker can remove CPU raster from the main thread, but it does not make the raster output a DOM document.

### CanvasKit / Skia WASM

CanvasKit is Skia compiled to WebAssembly. The official docs describe a WebGL context encapsulated as an SkSurface, hardware-backed drawing, and a core set of Skia canvas, paint, path, and text APIs. [CanvasKit](https://docs.skia.org/docs/user/modules/canvaskit/), [CanvasKit quickstart](https://skia.org/docs/user/modules/quickstart/). The quickstart notes that many objects created by the API must be explicitly deleted because JavaScript GC does not release Wasm memory automatically.

CanvasKit can parse SVG path mini-language strings through `Path.MakeFromSVGString`, but that API is path parsing, not a browser SVG document with links, styles, AOM, or event targets. [CanvasKit path types](https://chromium.googlesource.com/skia/%2B/8f46ecc84fab83ffccd2977a633006d77ec3c161/modules/canvaskit/canvaskit/types/index.d.ts). An SVG-to-Skia import layer would still need to define supported D2 output features and text/font loading.

### Go WASM

The Go toolchain uses `GOOS=js GOARCH=wasm` and requires `wasm_exec.js` in the host page. [Go WebAssembly](https://go.dev/wiki/WebAssembly). The Go project wiki records a smallest possible Wasm file around 2 MB before compression. [Go WebAssembly wiki history](https://github.com/golang/go/wiki/WebAssembly/c720c7b27094671b6b4b7de6041268421a8d4d). Any Go option should benchmark startup, heap growth, worker initialization, and calls across `syscall/js`; a renderer with a high-frequency JS boundary can erase the benefit of moving geometry code to Go.

## Expected bottleneck stages

These are hypotheses tied to current code and must be validated with traces:

| Observation | Likely stage | Distinguishing evidence |
|---|---|---|
| Pointer events and RAF callbacks consume time before the frame | JS/event | User Timing marks, Event Timing entries, LoAF script details, low paint/raster slices |
| `viewBox` path shows style/layout or SVG update work | style/layout | Main-thread trace slices after `setAttribute`; layout invalidation; forced style/layout duration |
| Main thread is short but frame has paint/raster slices and paint flashing covers the diagram | paint/raster | Chrome Performance panel, Paint Flashing, paint profiler, raster task duration |
| A wrapper transform has low main-thread work but high GPU memory or partial presentation | layer/composite/raster scale | Layer Borders, frame rendering stats, GPU memory, tile raster slices |
| Native scroll stays smooth while JS is blocked | compositor scroll path | Scroll thread/compositor trace and no SVG attribute writes |
| Canvas/WebGL has low JS but high upload/readback | GPU transfer | `bufferSubData`, texture upload, `readPixels`, command queue and GPU trace slices |
| Rust/Go/CanvasKit worker has low main-thread work but poor frame delivery | worker-to-canvas copy/presentation | worker marks, message timings, typed-array byte counts, presentation timestamps |

The browser's rendering pipeline can skip layout or paint only when the changed property permits it. [web.dev rendering performance](https://web.dev/articles/rendering-performance). Layer promotion itself is a memory tradeoff, not a correctness guarantee. [Chrome RenderingNG data structures](https://developer.chrome.com/docs/chromium/renderingng-data-structures).

## Reproducible benchmark plan

### Fixtures and matrix

Use the existing `/Users/chrishafley/projects/hafley-rxjs/packages/grapht/1_app_model.d2` and the exact SVG produced by the current D2 renderer. Preserve the sanitized SVG and record:

- source byte count and line count
- SVG byte count
- counts of `path`, `text`, `rect`, `g`, `a`, `marker`, `foreignObject`, and `image`
- `viewBox`, object CSS size, viewport CSS size, device-pixel ratio
- whether D2 emits filters, masks, clip paths, markers, foreignObject, or embedded fonts

Run each case at viewport sizes 800x600 and 1600x1000, DPR 1 and 2, at fit, 100%, 200%, and a zoomed-out view where the whole graph is visible. Test Chromium, WebKit/WKWebView through the current Tauri build, and one Firefox run if available. Record browser/OS/WebView versions.

Cases:

1. Current `<object>` plus direct root `viewBox` writes.
2. Current `<object>` with pointer move disabled and a synthetic RAF `viewBox` writer, separating event work from SVG invalidation.
3. Frozen `<object>` plus wrapper `translate3d` pan; one commit on pointer up.
4. Frozen `<object>` plus wrapper scale zoom; one commit on pointer up.
5. Native overflow scroll with no wheel listener, passive listener, and current non-passive listener.
6. `<img>` SVG image with CSS transform, measuring decode and bitmap quality as a static control.
7. Canvas2D main-thread redraw of a reduced geometry representation.
8. OffscreenCanvas worker redraw of the same representation.
9. WebGL camera-uniform pan of the same reduced representation.
10. Optional Rust/CanvasKit raster of one snapshot or one tile, not a full editor implementation.

### Instrumentation

Use the browser Performance API and DevTools trace. `PerformanceObserver` supports marks, measures, long tasks, event timing, paint timing, and long animation frames; long tasks are 50 ms or longer. [MDN performance data](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Performance_data), [Long Animation Frame Timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing), [Long Tasks API](https://w3c.github.io/longtasks/).

Minimal harness shape:

```js
const marks = ["pointerdown", "first-update", "pointerup", "commit"];
for (const name of marks) performance.clearMarks(name);

const frameTimes = [];
let rafId = 0;
function sampleFrame(time) {
  frameTimes.push(time);
  rafId = requestAnimationFrame(sampleFrame);
}
rafId = requestAnimationFrame(sampleFrame);

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    console.log(entry.entryType, entry.name, entry.startTime, entry.duration);
  }
}).observe({type: "long-animation-frame", buffered: true});

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) console.log("longtask", entry);
}).observe({type: "longtask", buffered: true});
```

Add `performance.mark()` at pointer down, first input callback, before and after camera scheduling, before and after each live SVG commit, worker message send/receive, draw submission, and pointer up. Stop the RAF sampler after each run and export `performance.getEntriesByType("measure")`, LoAF entries, long tasks, and Event Timing entries. Feature-detect `long-animation-frame` and `event` before observing them, and use the DevTools trace as the cross-engine source of paint/raster/presentation evidence.

In Chrome DevTools, capture a Performance trace with screenshots and the categories needed for rendering. Enable Paint Flashing, Layer Borders, Frame Rendering Stats, and GPU raster diagnostics in the Rendering panel. [Chrome rendering performance tools](https://developer.chrome.com/docs/devtools/rendering/performance). Save traces for each case with the same scripted gesture.

### Scripted gesture

Use Pointer Events with a fixed 2,000 ms duration, 120 samples if the device reports 60 Hz, and a second run at the display's native refresh rate. The gesture should pan 25% of the viewport in each axis, then reverse. Repeat at fit, 100%, 200%, and zoomed-out scale. For wheel, send 120 wheel events over 2 seconds with fixed deltas. Warm up once, then collect 5 measured runs per case after fonts and the SVG resource are loaded.

### Metrics and thresholds

Report medians and p95 values, not only averages:

- input callback duration and input-to-first-update
- camera scheduling duration and camera commit duration
- RAF callback interval and presented-frame interval
- dropped/partial frames from the Chrome overlay and trace
- long-task count and total duration
- LoAF count, duration, `paintTime`, and `presentationTime`
- main-thread JS, style/layout, paint, raster, and composite slices
- GPU memory/layer count where DevTools exposes them
- worker draw duration, message round trip, bytes transferred, and canvas presentation time
- visual quality at 100%, 200%, and zoomed-out views
- link click success, text selection behavior, keyboard focus, and screen-reader tree behavior for live cases

Suggested acceptance gates for an interaction case:

- p95 input callback under 2 ms
- p95 input-to-first-update under one display interval, 16.7 ms at 60 Hz
- median presented interval at or below one display interval, with no run containing more than 1% dropped frames
- no long task caused by the gesture; investigate every LoAF over 50 ms
- one live SVG camera commit per RAF at most for the direct baseline, and one commit after pointer up for the wrapper experiment
- bitmap or GPU memory reported alongside every snapshot/layer result

The thresholds are measurement gates for this fixture, not browser guarantees. The Long Tasks specification identifies 16 ms as the touch-move/scroll target in the RAIL model and 50 ms as the surfaced long-task threshold. [Long Tasks API](https://w3c.github.io/longtasks/).

## Smallest experiments that distinguish the bottleneck

### Experiment A: synthetic `viewBox` versus no-op RAF

Run two identical pointer loops. Case A writes the current `viewBox` value back to the root. Case B only records a mark and does no DOM mutation. If A slows while B stays within the frame budget, the cost is downstream of the attribute write. If both slow, inspect event frequency and handler work.

### Experiment B: wrapper transform versus root `viewBox`

Freeze the SVG at one camera. During the same pointer trace, update only `wrapper.style.transform`. Compare Paint Flashing and raster slices. If paint flashing disappears and frame intervals improve, the direct path is paint/raster-bound. If the wrapper still misses frames with low main-thread work, inspect layer size, GPU memory, and composite/raster scale.

### Experiment C: native scroll versus custom wheel

Use a world-sized child and run with no wheel listener, passive wheel, and current non-passive wheel. If native scroll remains smooth while custom wheel does not, event cancellation and main-thread camera writes are contributors. If both repaint the entire diagram, the scroll surface itself is the expensive surface.

### Experiment D: static `<img>` control

Decode the same SVG as `<img>`, then CSS-transform it without DOM camera writes. This establishes the image decode and compositor behavior without live SVG hit testing. A large improvement isolates the cost to live SVG invalidation or internal hit-testing rather than the stage or pointer loop.

### Experiment E: bitmap snapshot versus live SVG

Take one snapshot at each zoom, then pan the snapshot with a CSS transform. If the snapshot is smooth and memory remains bounded, a temporary bitmap is viable for gesture frames. If snapshot creation or the first transformed frame is expensive, use a lower-resolution gesture bitmap or tiles.

### Experiment F: reduced Canvas/WebGL scene

Use only node rectangles, edge lines, and plain labels generated from the fixture's extracted geometry. If WebGL camera-only motion is smooth while Canvas2D redraw is not, the bottleneck is immediate raster/draw submission. If both are smooth and SVG is not, SVG display-list/raster complexity is the dominant variable. If neither is smooth, inspect event, compositing, and viewport size before selecting a renderer.

## Open gaps

- No rendered `1_app_model.svg` is present beside the D2 fixture in the workspace. The benchmark must capture the exact SVG generated by Instant before element-count conclusions can be made.
- No Chrome or Tauri Performance trace was captured in this research lane, so paint versus raster versus composite is still unclassified.
- Exact target Tauri WebView versions and OS matrix were not available in the requested context. OffscreenCanvas, WebGL, WebGPU, font matching, and accessibility behavior must be tested in each shipped WebView.
- The D2 output feature mix was not enumerated from a generated SVG. Filters, masks, markers, foreignObject, images, fonts, and text count can materially change paint/raster cost.
- WebGPU worker support, SharedArrayBuffer/threaded Wasm, and SIMD support need per-engine feature probes rather than assumptions.
- WebKit issue [316777](https://bugs.webkit.org/show_bug.cgi?id=316777) reports different user-font matching between connected Canvas 2D and detached/OffscreenCanvas contexts in WKWebView. Canvas-based text benchmarks should include the exact fonts used by D2 output and compare connected and worker canvases.
- Accessibility results for an SVG embedded through `<object>` require a real screen-reader/browser matrix. The current code's `aria-label` is on the HTML object, while individual embedded links are discovered manually by pointer probing.
- Current `0_native_pan_proof.html` demonstrates native scrolling but does not yet establish a world-sized embedded SVG child equivalent to the D2 fixture.

## Sources

- [MDN: SVG viewBox](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/viewBox)
- [web.dev: Rendering performance](https://web.dev/articles/rendering-performance)
- [web.dev: Animation performance and compositor-only properties](https://web.dev/articles/animations-guide)
- [Chrome for Developers: RenderingNG](https://developer.chrome.com/docs/chromium/renderingng)
- [Chrome for Developers: RenderingNG data structures](https://developer.chrome.com/docs/chromium/renderingng-data-structures)
- [Chrome DevTools: Discover rendering performance issues](https://developer.chrome.com/docs/devtools/rendering/performance)
- [MDN: CSS containment](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Containment/Using)
- [MDN: content-visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility)
- [MDN: object](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/object)
- [MDN: HTMLObjectElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLObjectElement)
- [MDN: img](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img)
- [MDN: SVG in HTML](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_in_HTML)
- [MDN: SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)
- [MDN: OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- [MDN: WebGL API](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API)
- [MDN: WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
- [MDN: Performance data](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Performance_data)
- [MDN: Long animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing)
- [W3C: Long Tasks API](https://w3c.github.io/longtasks/)
- [Tauri architecture](https://v2.tauri.app/es/concept/architecture/)
- [Sigma.js documentation](https://www.sigmajs.org/docs/)
- [Sigma.js layers](https://www.sigmajs.org/docs/advanced/layers/)
- [Cytoscape.js](https://js.cytoscape.org/index.html)
- [Cytoscape.js WebGL renderer preview](https://blog.js.cytoscape.org/2025/01/13/webgl-preview/)
- [PixiJS renderer](https://api.pixijs.io/%40pixi/core/PIXI/Renderer.html)
- [PixiJS events](https://api.pixijs.io/%40pixi/events.html)
- [resvg repository](https://github.com/linebender/resvg)
- [resvg API](https://docs.rs/resvg/latest/resvg/)
- [usvg API](https://doc.servo.org/usvg/index.html)
- [CanvasKit](https://docs.skia.org/docs/user/modules/canvaskit/)
- [CanvasKit quickstart](https://skia.org/docs/user/modules/quickstart/)
- [Go WebAssembly](https://go.dev/wiki/WebAssembly)
