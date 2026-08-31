import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const terminalHarnesses = ["codex", "claude", "opencode"] as const;
export type TerminalHarness = typeof terminalHarnesses[number];

export type TerminalCastEvent = readonly [
  time: number,
  code: "o" | "i" | "m" | "r",
  data: string,
];

export type TerminalReplayTurn = Readonly<{
  session: string;
  harness: TerminalHarness;
  turn: number;
  ts: number;
  role: "user" | "assistant";
  said: string;
}>;

export type TerminalCastReplay = Readonly<{
  harness: TerminalHarness;
  artifact: string;
  executable: "asciinema";
  args: readonly ["play", "--quiet", "--idle-time-limit", "0.25", "--speed", "1", string];
  session: string;
  readiness: string;
  input: string;
  turns: readonly TerminalReplayTurn[];
}>;

export type ParsedTerminalCast = Readonly<{
  header: Readonly<{
    version: 2;
    width: number;
    height: number;
    title: string;
    env: Readonly<Record<string, string>>;
  }>;
  events: readonly TerminalCastEvent[];
  inputEvents: readonly TerminalCastEvent[];
  outputEvents: readonly TerminalCastEvent[];
}>;

export type AsciinemaAvailability = Readonly<{
  available: boolean;
  command: "asciinema";
  version: string | null;
  detail: string;
}>;

const artifactByHarness: Record<TerminalHarness, URL> = {
  codex: new URL("../fixtures/transcripts/terminal/codex-markdown.cast", import.meta.url),
  claude: new URL("../fixtures/transcripts/terminal/claude-markdown.cast", import.meta.url),
  opencode: new URL("../fixtures/transcripts/terminal/opencode-markdown.cast", import.meta.url),
};

const displayNameByHarness: Record<TerminalHarness, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

const readinessByHarness: Record<TerminalHarness, string> = {
  codex: "Codex ready",
  claude: "Claude Code ready",
  opencode: "OpenCode ready",
};

const userRequest = "render the terminal flow";
const assistantAnswer = [
  "```mermaid",
  "flowchart LR",
  "  PTY --> tmux",
  "  tmux --> xterm",
  "  xterm --> Markdown",
  "```",
].join("\n");

export function terminalCastReplay(harness: TerminalHarness): TerminalCastReplay {
  const artifact = fileURLToPath(artifactByHarness[harness]);
  const session = `e2e-${harness}-1`;
  return {
    harness,
    artifact,
    executable: "asciinema",
    args: ["play", "--quiet", "--idle-time-limit", "0.25", "--speed", "1", artifact],
    session,
    readiness: readinessByHarness[harness],
    input: userRequest,
    turns: [
      { session, harness, turn: 1, ts: 1, role: "user", said: userRequest },
      {
        session,
        harness,
        turn: 2,
        ts: 2,
        role: "assistant",
        said: `${displayNameByHarness[harness]} response:\n${assistantAnswer}`,
      },
    ],
  };
}

export function parseTerminalCast(artifact: string): ParsedTerminalCast {
  const [headerLine, ...eventLines] = readFileSync(artifact, "utf8").trimEnd().split("\n");
  const header = JSON.parse(headerLine) as ParsedTerminalCast["header"];
  const events = eventLines.map((line) => JSON.parse(line) as TerminalCastEvent);
  return {
    header,
    events,
    inputEvents: events.filter((event) => event[1] === "i"),
    outputEvents: events.filter((event) => event[1] === "o"),
  };
}

export function asciinemaAvailability(): AsciinemaAvailability {
  const result = spawnSync("asciinema", ["--version"], { encoding: "utf8" });
  const version = result.status === 0 ? result.stdout.trim() : null;
  return version
    ? {
        available: true,
        command: "asciinema",
        version,
        detail: version,
      }
    : {
        available: false,
        command: "asciinema",
        version: null,
        detail: "asciinema is required for terminal cast replay; install it and rerun the terminal substrate tier",
      };
}
