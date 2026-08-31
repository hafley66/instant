# Terminal Agent Replay Prior Art

Research date: 2026-08-30

## Target

The target test has two synchronized data planes:

```text
real Claude Code, Codex, or OpenCode process
  <-> real PTY
  <- deterministic typed input
  -> raw terminal output, resize events, and timing
  -> terminal emulator grid and scrollback

fixed provider-protocol server
  <- the real CLI's model request
  -> a fixed streaming response sequence

mock Boop store
  -> normalized user/assistant turns and harness identity

terminal recording + Boop turns
  -> Instant production intersection and row attribution
  -> native-app or browser-host assertions
```

The closest direct implementation found is Medulla's live E2E harness. It runs the real OpenCode, Claude Code, or Codex CLI, drives its interactive TUI through tmux, and routes all three wire dialects to a deterministic local mock LLM. It does not record an emulator-independent terminal event stream or intersect terminal rows with a Boop-style semantic store.

## Executive Index

| Layer | Existing implementation | Verified release/state | Relevant surface |
| --- | --- | --- | --- |
| Real Claude, Codex, and OpenCode TUI plus fixed responses | [Medulla E2E live harness](https://github.com/tinyhumansai/medulla/blob/main/docs/e2e-live-harness.md) | current main, documented executable suite | Docker, tmux, shell, Python mock LLM |
| PTY drive, grid, scrollback, screenshots, casts | [Microsoft tui-test](https://github.com/microsoft/tui-test) | `0.1.0-beta.2`, released 2026-08-22 | Rust, Python, JavaScript, and CLI |
| Alternative append-only PTY event log | [Coder agent-tty](https://github.com/coder/agent-tty) | `0.5.0` in current README | CLI, `node-pty`, Ghostty renderers |
| OpenAI Responses and Anthropic Messages fixture server | [kagent-dev/mockllm](https://github.com/kagent-dev/mockllm) | current repository, no tagged release listed | Go library and executable |
| Codex-specific queued SSE fixture pattern | [Codex AppServerHarness](https://github.com/openai/codex/blob/main/sdk/python/tests/app_server_harness.py) | current Codex main | isolated `CODEX_HOME`, queued `/v1/responses` SSE |
| Multi-agent semantic adapters | [Agent-Blackbox](https://github.com/TaewoooPark/Agent-Blackbox) | current repository | Claude JSONL, Codex rollout JSONL, OpenCode plugin |
| Portable agent trajectories | [Harbor](https://www.harborframework.com/docs/run-jobs/load-trajectory) | current docs | native Claude/Codex sessions and ATIF |
| Normalized trajectory library | [Hypabolic Trajectory](https://github.com/Hypabolic/Trajectory) | `0.1.3` | TypeScript, Rust, Python, .NET |
| Interchange recording | [asciicast v2](https://docs.asciinema.org/manual/asciicast/v2/) and [v3](https://docs.asciinema.org/manual/asciicast/v3/) | v3 supported by asciinema CLI 3.0+ | NDJSON terminal event stream |

## Capability Matrix

| Capability | tui-test | agent-tty | mockllm | Agent-Blackbox | Harbor |
| --- | ---: | ---: | ---: | ---: | ---: |
| Spawn a real TUI under a PTY | yes | yes | no | no | agent execution, terminal fidelity unspecified |
| Send text and distinct key events | yes | yes | no | no | adapter-specific |
| Maintain a rendered cell grid | yes | yes | no | no | no |
| Configurable scrollback | yes, default 10,000 rows | event-log replay | no | no | no |
| Record asciicast | yes, v2 | yes | no | no | no |
| Capture input and output timing | PTY traffic and cast APIs | append-only event log and cast | no | no | trajectory timing |
| Select xterm.js as the emulator | yes | no | no | no | no |
| Fixed OpenAI Responses SSE | no | no | yes | no | model/provider dependent |
| Fixed Anthropic Messages SSE | no | no | yes | no | model/provider dependent |
| Claude Code semantic transcript | no | no | no | yes | yes |
| Codex semantic transcript | no | no | no | yes | yes |
| OpenCode semantic transcript | no | no | no | yes | agent adapter exists |
| Replay semantic state | no | no | request fixtures only | yes | yes |

## Closest Direct Implementation

### Medulla E2E live harness

Medulla ships an offline deterministic suite with this process graph:

```text
test driver
  -> real Medulla daemon
  -> real Claude Code, Codex, or OpenCode CLI
  -> local mock LLM
  -> fixed response
```

Its interactive test leg opens the real CLI in a tmux window, sends input with `tmux send-keys`, reads the rendered terminal with `tmux capture-pane`, and asserts the deterministic response. `E2E_HARNESS=claude|codex|opencode` selects the installed CLI while the same suite remains unchanged. Harness-specific executable, configuration, environment, and TUI readiness logic are isolated in `e2e/coordination/harness.sh`.

The mock is split by provider wire dialect under `e2e/coordination/mockllm/`:

- OpenAI Chat Completions for OpenCode
- Anthropic Messages for Claude Code
- OpenAI Responses for Codex

The Docker suite runs with `--network none`, uses dummy credentials, creates isolated configuration, waits on observable readiness, disables retries, and guards against OpenCode auto-update behavior. The documented source layout includes `run.sh`, `tests_tui.sh`, `harness.sh`, `mock_llm.py`, and the per-dialect mock modules. [Medulla E2E live harness](https://github.com/tinyhumansai/medulla/blob/main/docs/e2e-live-harness.md)

This covers the real-CLI plus fixed-response subproblem directly for all three harnesses. Its terminal evidence is tmux pane capture. Instant additionally needs a persistent PTY event artifact and a Boop fixture keyed to the same session and logical clock.

## Terminal Driver

### Microsoft tui-test

The current beta runs real shell sessions and full-screen TUIs on macOS, Linux, and Windows. The same engine is published as `@microsoft/tui-test` for Node 20+, `tui-test-rs`, a Python package, and a CLI. The JavaScript API includes:

```ts
import { TuiTest, getRecording } from "@microsoft/tui-test";

const terminal = TuiTest.ephemeral("codex-replay", {
  backend: "xtermjs",
  profile: { scrollback: 10_000 },
});

await terminal.run("codex", args, {
  cwd,
  env,
  cols: 120,
  rows: 40,
});
await terminal.waitIdle();
await terminal.type("render the fixture");
await terminal.keyboard.press("Enter");
await terminal.waitText("fixed response");

const grid = await terminal.text({ full: true });
const cast = await getRecording(terminal.session);
```

The exact binding signature should be taken from the installed `0.1.0-beta.2` types. The published API documents `run`, `type`, `write`, `submit`, keyboard events, mouse events, resize, text, cells, waits, assertions, screenshots, recording lifecycle, and `getRecording()`. It supports Alacritty, Ghostty, Rio, and xterm.js emulation behind one grid contract. Shell semantic prompt tracking reads raw PTY bytes. [README and API](https://github.com/microsoft/tui-test#readme)

Status constraints:

- The project labels `0.1.0-beta.2` as a prerelease and states that it is undergoing a major rewrite.
- The JavaScript package is ESM-only and requires Node 20+.
- The xterm.js backend runs inside QuickJS. This exercises xterm.js terminal semantics without a DOM.
- The recording API emits asciicast v2.

### Coder agent-tty

`agent-tty 0.5.0` uses a real `node-pty` session and an append-only event log as its source of truth. It can regenerate text snapshots, PNG screenshots, `.cast` files, and WebM recordings after the child exits. Its command surface includes create, type, paste, send-keys, batch, resize, wait, snapshot, screenshot, mark, and recording export. [Architecture and command surface](https://github.com/coder/agent-tty#how-it-works)

Its PNG and WebM path uses Playwright Chromium with a Ghostty web renderer. Its semantic renderer can use native `libghostty-vt`. It requires Node 24 through 26. The append-only event-log design is prior art for retaining terminal state independently of tmux.

### Other terminal drivers found

- [tuibot](https://github.com/tui-testing/tuibot): Docker-isolated real headless PTY, deterministic seeded exploration, scripted assertions, resize and mouse actions, raw/SVG/PNG captures, JSONL action sessions, and a browser replay timeline. It uses Microsoft's `shell-use` PTY driver and has optional line and widget coverage through `tuicov`.
- [tui_mcp](https://github.com/Fabian2000/tui_mcp): real PTY, embedded `vt100`, keys, mouse, plain-text screen, PNG, scrollback, and process lifecycle over MCP.
- [terminal-driver-mcp](https://www.npmjs.com/package/terminal-driver-mcp): persistent TUI sessions and asciicast v2 recordings that include input, output, resize, and emulator-query events.
- [VHS](https://github.com/charmbracelet/vhs): tape-scripted terminal demonstrations and recordings.
- [vhs-rs](https://github.com/cbxss/vhs-rs): PTY input, text waits, assertions, and GIF, PNG, text, and cast output.
- [testagent](https://github.com/paultyng/testagent): deterministic fake `claude` and `codex` executables. It covers hook and orchestrator contracts, while its rendered UI is not the installed vendor TUI.

## Fixed Provider Responses

### Shared mock server

`kagent-dev/mockllm` implements all three protocol surfaces needed by the current harness set:

| Endpoint | Streaming | Intended consumer |
| --- | ---: | --- |
| `POST /v1/responses` | SSE | Codex |
| `POST /v1/chat/completions` | SSE | OpenCode with an OpenAI-compatible provider |
| `POST /v1/messages` | SSE | Claude Code |

Fixtures match requests by exact or substring content and optional headers. It uses official OpenAI and Anthropic Go SDK types. It supports text and tool/function outputs. Its documented limits are no hosted-tool mocking, no stateful conversation sequencing, no latency simulation, and no error injection. [MockLLM API coverage](https://github.com/kagent-dev/mockllm#api-coverage)

For a one-turn render fixture, the request matcher is sufficient. Multi-request tool-loop fixtures need a sequence wrapper or a fixture server with explicit scenario state.

### Codex official pattern

Codex's Python SDK tests already use the required deterministic shape. `MockResponsesServer` binds a loopback port, records each `/v1/responses` request, and pops one queued SSE body per request. `AppServerHarness` creates an isolated `CODEX_HOME` and writes a custom provider with:

```toml
model = "mock-model"
approval_policy = "never"
sandbox_mode = "read-only"
model_provider = "mock_provider"

[model_providers.mock_provider]
base_url = "http://127.0.0.1:<port>/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

Source: [Codex `app_server_harness.py`](https://github.com/openai/codex/blob/main/sdk/python/tests/app_server_harness.py).

Codex's own TUI test instructions also require sending text and Enter in separate writes when driving an interactive test. Source: [Codex `test-tui` skill](https://github.com/openai/codex/blob/main/.codex/skills/test-tui/SKILL.md).

### Claude Code routing

Claude Code officially supports `ANTHROPIC_BASE_URL` for an Anthropic-format gateway. A credential variable or `apiKeyHelper` can replace subscription credentials; setting only the base URL keeps the saved login active while routing requests through the gateway. Source: [Claude Code gateway documentation](https://code.claude.com/docs/en/llm-gateway).

The test process should use an isolated settings directory, disable nonessential traffic, and supply a fixture credential so startup and model traffic do not depend on the user's account state.

### OpenCode routing

OpenCode supports per-provider `options.baseURL` and custom providers using `@ai-sdk/openai-compatible` for Chat Completions or `@ai-sdk/openai` for the Responses API. Source: [OpenCode provider documentation](https://opencode.ai/docs/providers/).

An isolated project config can point a test-only provider and model at the fixture server without modifying global OpenCode configuration.

## Semantic Turn Stores

### Agent-Blackbox

Agent-Blackbox has three host adapters matching the target harnesses:

- Claude Code: tails `~/.claude/projects` JSONL.
- Codex: tails `$CODEX_HOME/sessions` rollout JSONL.
- OpenCode: installs a plugin that emits host and tool events.

It normalizes those sources into canonical `TraceEvent` records and stores them in local NDJSON. Its daemon exposes events, replayable graph state, snapshots, and a WebSocket stream. Source: [Agent-Blackbox architecture](https://github.com/TaewoooPark/Agent-Blackbox#project-layout).

This is prior art for the harness adapter boundary and append-only semantic store. Boop remains the production store under test, so an Instant test fixture should seed Boop's schema rather than add Agent-Blackbox as a runtime dependency.

### Harbor and ATIF

Harbor ships adapters for Claude Code, Codex, OpenCode, and other coding agents. It stores native Claude and Codex session files and a portable Agent Trajectory Interchange Format representation. Native and ATIF trajectory loading is currently documented for Claude Code and Codex. Source: [Harbor trajectory loading](https://www.harborframework.com/docs/run-jobs/load-trajectory).

Harbor addresses conversation and tool-event portability. It does not provide the terminal byte stream or terminal row coordinates needed by Instant's renderer.

### Hypabolic Trajectory

Hypabolic Trajectory `0.1.3` normalizes Claude Code and Codex local session files, supports partial append-only input, and publishes TypeScript, Rust, Python, and .NET packages. OpenCode is not listed in its current input matrix. Source: [Trajectory README](https://github.com/Hypabolic/Trajectory#what-you-get).

## Recording Contract

Asciicast v2 and v3 both support:

- `o`: PTY output
- `i`: user input
- `m`: marker
- `r`: resize

Version 3 adds an explicit `x` exit-status event, uses relative intervals instead of v2 absolute timestamps, and permits unknown event codes to be ignored or passed through. Input capture is opt-in because it can contain secrets. Source: [asciicast v3 event specification](https://docs.asciinema.org/manual/asciicast/v3/#supported-event-codes).

For existing Instant fixtures and `tui-test`, v2 is the interoperable baseline. Boop records should remain in a sidecar fixture or test database. This avoids adding application-specific event codes that ordinary asciicast players discard.

```text
fixtures/terminal/codex/basic.cast
fixtures/terminal/codex/basic.boop.json
fixtures/terminal/codex/basic.responses.json

fixtures/terminal/claude/basic.cast
fixtures/terminal/claude/basic.boop.json
fixtures/terminal/claude/basic.messages.json

fixtures/terminal/opencode/basic.cast
fixtures/terminal/opencode/basic.boop.json
fixtures/terminal/opencode/basic.chat-completions.json
```

Each pair needs one shared logical clock. Cast timestamps establish terminal write order. Boop fixture records carry turn identity, role, harness, session identity, and the production fields used to intersect a turn with terminal content.

## Reusable Test Shape

```ts
type HarnessAdapter = {
  id: "claude" | "codex" | "opencode";
  executable: string;
  args(fixture: FixturePaths): string[];
  env(proxy: ProxyAddress, sandbox: SandboxPaths): Record<string, string>;
  ready(terminal: TuiTest): Promise<void>;
  enterPrompt(terminal: TuiTest, prompt: string): Promise<void>;
  settled(terminal: TuiTest, expectedText: string): Promise<void>;
  collectSemanticStore(sandbox: SandboxPaths): Promise<BoopFixture>;
};

type ReplayFixture = {
  harness: HarnessAdapter["id"];
  cols: number;
  rows: number;
  prompt: string;
  providerResponses: readonly ProviderResponse[];
  castPath: string;
  boopPath: string;
};

async function recordFixture(
  harness: HarnessAdapter,
  fixture: ReplayFixture,
): Promise<void> {
  // start protocol-correct fixed-response server
  // start installed vendor TUI through @microsoft/tui-test
  // wait for a harness-specific ready frame
  // send prompt text, then Enter as a separate key event
  // wait for expected fixed response and a stable frame
  // export asciicast v2
  // normalize or seed the corresponding Boop records
  // redact and verify both artifacts
}

async function replayIntoInstant(fixture: ReplayFixture): Promise<void> {
  // seed the isolated Boop store
  // replay cast output and resize events through Instant's terminal input boundary
  // assert turn IDs, roles, row ranges, overlays, Markdown, and diagrams
}
```

## Coverage Boundary

The deterministic suite can be divided without changing fixture formats:

1. Replay tier: stored `.cast` plus mocked Boop store. No vendor CLI or provider server runs. This covers Instant row attribution, scrolling, resizing, Markdown, diagrams, and overlay state.
2. Recording tier: installed vendor TUI plus real PTY plus fixed provider server. It regenerates the cast and Boop sidecar and verifies request matching.
3. Native Instant tier: the replay tier is consumed by a compiled or `tauri dev` Instant window and produces a macOS window screenshot with binary provenance.

## Gaps Remaining After Research

- `@microsoft/tui-test` documentation does not state whether its automatic v2 cast includes input events by default. The PTY traffic log and explicit typed-input fixture remain available even if the exported cast contains output only.
- `kagent-dev/mockllm` has no tagged release in the GitHub release panel and no stateful response queue. Its protocol coverage is documented and its server has integration tests.
- Claude Code performs non-model network requests during startup. The test needs isolated settings and nonessential-traffic flags in addition to `ANTHROPIC_BASE_URL`.
- OpenCode can consume terminal input during startup capability queries when tmux does not answer them. A current open issue reports a 10 to 11 second loss window. Readiness must be based on terminal state before input is sent: [OpenCode issue #42915](https://github.com/anomalyco/opencode/issues/42915).
- The field mapping from a Boop fixture record to Instant's row-intersection calculation is repository-specific and must be taken from the production Boop schema and trait implementations.
