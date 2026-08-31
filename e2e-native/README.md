# Native WebView E2E

`pnpm test:e2e:native` builds a debug Instant executable with the test-only
`native-e2e` Cargo feature, launches that executable, and drives its macOS
WKWebView through WebdriverIO's maintained embedded Tauri provider.

The native tier has three provenance checks that the Playwright browser tier
cannot satisfy:

- the loaded origin is `tauri://localhost`, which comes from bundled `dist/`
- `window.__TAURI_INTERNALS__` exists
- the WebView user agent is AppleWebKit and has no Chromium `window.chrome`

The run writes WebdriverIO logs under `.native-e2e-results/` and refreshes the
tracked screenshot receipt at
`artifacts/native-e2e/instant-native-smoke.png`.

## Test tiers

- `pnpm test` runs Vitest source and DOM tests.
- `pnpm test:e2e:web` runs the Vite-hosted Playwright suite in Chromium.
- `pnpm test:live` runs Playwright against live external shell and tmux state.
- `pnpm test:e2e:native` builds and drives the compiled Tauri application.

The native build uses `INSTANT_NO_GLOBALS=1` and the
`instant-native-e2e` tmux socket. It does not register the tray icon, summon
shortcut, or input event tap owned by the active Instant process.
`src-tauri/tauri.native-e2e.conf.json` also assigns the test binary its own
application identifier, isolating its Tauri state directory and WebKit storage.

The WebDriver HTTP server is absent from normal debug and release builds. It is
compiled and registered only when both debug assertions and the Cargo
`native-e2e` feature are active.
