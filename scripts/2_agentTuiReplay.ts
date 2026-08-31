import { accessSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export const liveAgentPrompt = "render the terminal flow";
export const liveAgentReplyMarker = "FIXED_TERMINAL_REPLY";
export type LiveAgentHarness = "codex" | "claude" | "opencode" | "kimi";

export type AgentTuiDriver = Readonly<{
  waitText: (text: string, options?: { timeout?: number }) => Promise<void>;
  type: (text: string) => Promise<void>;
  keyboard: { press: (...keys: string[]) => Promise<void> };
  startRecording: (path: string) => Promise<void>;
}>;

export type AgentReplayTurn = Readonly<{
  session: string;
  harness: LiveAgentHarness;
  turn: number;
  ts: number;
  role: "user" | "assistant";
  said: string;
}>;

export type AgentTuiLaunch = Readonly<{
  harness: LiveAgentHarness;
  executable: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  configPaths: readonly string[];
  turns: readonly AgentReplayTurn[];
  beginReplay: (terminal: AgentTuiDriver, castPath: string) => Promise<void>;
  replyMarker: string;
}>;

export type AgentTuiAdapter = Readonly<{
  harness: LiveAgentHarness;
  displayName: string;
  executableName: string;
  executableOverride: string;
  writeLaunch: (
    executable: string,
    home: string,
    workspace: string,
    port: number,
  ) => AgentTuiLaunch;
}>;

type LaunchContext = Readonly<{
  harness: LiveAgentHarness;
  displayName: string;
  executable: string;
  home: string;
  workspace: string;
  port: number;
  common: Readonly<Record<string, string>>;
}>;

function executableOnPath(name: string, pathValue: string): string | null {
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function inheritedTerminalEnvironment() {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "COLORTERM"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

async function waitForText(text: string, terminal: AgentTuiDriver) {
  await terminal.waitText(text, { timeout: 30_000 });
}

async function submitWithEnter(terminal: AgentTuiDriver, prompt: string) {
  await terminal.type(prompt);
  await terminal.waitText(prompt, { timeout: 10_000 });
  await terminal.keyboard.press("Enter");
}

function interactiveReplay(
  ready: (terminal: AgentTuiDriver) => Promise<void>,
  submit: (terminal: AgentTuiDriver, prompt: string) => Promise<void>,
) {
  return async (terminal: AgentTuiDriver, castPath: string) => {
    await ready(terminal);
    await terminal.startRecording(castPath);
    await submit(terminal, liveAgentPrompt);
  };
}

async function launchPromptReplay(terminal: AgentTuiDriver, castPath: string) {
  await terminal.startRecording(castPath);
}

function replayTurns(harness: LiveAgentHarness, displayName: string): readonly AgentReplayTurn[] {
  const session = `e2e-${harness}-live-1`;
  const answer = [
    `${displayName} response:`,
    liveAgentReplyMarker,
    "```mermaid",
    "flowchart LR",
    "  PTY --> tmux",
    "  tmux --> xterm",
    "  xterm --> Markdown",
    "```",
  ].join("\n");
  return [
    { session, harness, turn: 1, ts: 1, role: "user", said: liveAgentPrompt },
    { session, harness, turn: 2, ts: 2, role: "assistant", said: answer },
  ];
}

function launchContext(
  harness: LiveAgentHarness,
  displayName: string,
  executable: string,
  home: string,
  workspace: string,
  port: number,
): LaunchContext {
  mkdirSync(home, { recursive: true });
  return {
    harness,
    displayName,
    executable,
    home,
    workspace: realpathSync(workspace),
    port,
    common: {
      ...inheritedTerminalEnvironment(),
      HOME: home,
      TERM: "xterm-256color",
    },
  };
}

function codexLaunch(context: LaunchContext): AgentTuiLaunch {
  const codexHome = join(context.home, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), [
    'model = "mock-model"',
    'model_provider = "llmock"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'disable_response_storage = true',
    `[projects.${JSON.stringify(context.workspace)}]`,
    'trust_level = "trusted"',
    '[model_providers.llmock]',
    'name = "llmock"',
    `base_url = "http://127.0.0.1:${context.port}/openai/v1"`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'requires_openai_auth = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'supports_websockets = false',
    "",
  ].join("\n"));
  return {
    harness: context.harness,
    executable: context.executable,
    args: ["--no-alt-screen", "-C", context.workspace, liveAgentPrompt],
    env: { ...context.common, CODEX_HOME: codexHome, OPENAI_API_KEY: "test" },
    configPaths: [join(codexHome, "config.toml")],
    turns: replayTurns(context.harness, context.displayName),
    beginReplay: launchPromptReplay,
    replyMarker: liveAgentReplyMarker,
  };
}

function claudeLaunch(context: LaunchContext): AgentTuiLaunch {
  const claudeConfig = join(context.home, ".claude");
  mkdirSync(claudeConfig, { recursive: true });
  writeFileSync(join(claudeConfig, ".claude.json"), JSON.stringify({
    firstStartTime: "2026-01-01T00:00:00.000Z",
    firstStartVersion: "2",
    hasCompletedOnboarding: true,
    projects: { [context.workspace]: { hasTrustDialogAccepted: true } },
  }, null, 2));
  writeFileSync(join(claudeConfig, "settings.json"), JSON.stringify({ theme: "dark" }, null, 2));
  return {
    harness: context.harness,
    executable: context.executable,
    args: [
      "--bare",
      "--safe-mode",
      "--model", "claude-sonnet-4-5",
      "--permission-mode", "dontAsk",
      "--tools", "",
    ],
    env: {
      ...context.common,
      CLAUDE_CONFIG_DIR: claudeConfig,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${context.port}/anthropic`,
      ANTHROPIC_AUTH_TOKEN: "test",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    configPaths: [join(claudeConfig, ".claude.json"), join(claudeConfig, "settings.json")],
    turns: replayTurns(context.harness, context.displayName),
    beginReplay: interactiveReplay(
      (terminal) => waitForText("Claude Code v", terminal),
      submitWithEnter,
    ),
    replyMarker: liveAgentReplyMarker,
  };
}

function opencodeLaunch(context: LaunchContext): AgentTuiLaunch {
  const config = join(context.home, "opencode.json");
  writeFileSync(config, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: "llmock/mock-model",
    provider: {
      llmock: {
        npm: "@ai-sdk/openai-compatible",
        name: "llmock",
        options: {
          baseURL: `http://127.0.0.1:${context.port}/openai/v1`,
          apiKey: "test",
        },
        models: { "mock-model": { name: "Mock Model" } },
      },
    },
  }, null, 2));
  return {
    harness: context.harness,
    executable: context.executable,
    args: [
      "run",
      "--pure",
      "--interactive",
      "--auto",
      "--model", "llmock/mock-model",
      liveAgentPrompt,
    ],
    env: {
      ...context.common,
      OPENCODE_CONFIG: config,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
    configPaths: [config],
    turns: replayTurns(context.harness, context.displayName),
    beginReplay: launchPromptReplay,
    replyMarker: liveAgentReplyMarker,
  };
}

function kimiLaunch(context: LaunchContext): AgentTuiLaunch {
  const kimiConfig = join(context.home, ".kimi-code");
  mkdirSync(kimiConfig, { recursive: true });
  writeFileSync(join(kimiConfig, "config.toml"), [
    'default_model = "llmock/mock-model"',
    'telemetry = false',
    '[providers.llmock]',
    'type = "openai"',
    'api_key = "test"',
    `base_url = "http://127.0.0.1:${context.port}/openai/v1"`,
    '[models."llmock/mock-model"]',
    'provider = "llmock"',
    'model = "mock-model"',
    'max_context_size = 100000',
    'capabilities = ["tool_call"]',
    'display_name = "Mock Model"',
    "",
  ].join("\n"));
  return {
    harness: context.harness,
    executable: context.executable,
    args: [
      "--model", "llmock/mock-model",
      "--prompt", liveAgentPrompt,
      "--output-format", "text",
    ],
    env: { ...context.common },
    configPaths: [join(kimiConfig, "config.toml")],
    turns: replayTurns(context.harness, context.displayName),
    beginReplay: launchPromptReplay,
    replyMarker: liveAgentReplyMarker,
  };
}

function adapter(
  harness: LiveAgentHarness,
  displayName: string,
  executableName: string,
  executableOverride: string,
  build: (context: LaunchContext) => AgentTuiLaunch,
): AgentTuiAdapter {
  return {
    harness,
    displayName,
    executableName,
    executableOverride,
    writeLaunch(executable, home, workspace, port) {
      return build(launchContext(harness, displayName, executable, home, workspace, port));
    },
  };
}

export const liveAgentAdapters: readonly AgentTuiAdapter[] = [
  adapter("codex", "Codex", "codex", "CODEX_BIN", codexLaunch),
  adapter("claude", "Claude Code", "claude", "CLAUDE_BIN", claudeLaunch),
  adapter("opencode", "OpenCode", "opencode", "OPENCODE_BIN", opencodeLaunch),
  adapter("kimi", "Kimi Code", "kimi", "KIMI_BIN", kimiLaunch),
];

export function resolveAgentExecutable(adapter: AgentTuiAdapter): string | null {
  const override = process.env[adapter.executableOverride];
  if (override) return override;
  return executableOnPath(adapter.executableName, process.env.PATH ?? "");
}

export function resolveLlmockExecutable(repo: string): string | null {
  if (process.env.LLMOCK_BIN) return process.env.LLMOCK_BIN;
  const local = join(repo, ".replay-tools", "llmock", "bin", "llmock");
  try {
    accessSync(local, constants.X_OK);
    return local;
  } catch {
    return executableOnPath("llmock", process.env.PATH ?? "");
  }
}
