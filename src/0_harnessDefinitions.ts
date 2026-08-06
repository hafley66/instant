import type { HarnessId } from "./harnessTypes";

export type HarnessLaneLaunch = {
  command: string;
  model: string | null;
  mode: string;
  body: string;
  ref: string;
};

export type HarnessDefinition = {
  id: HarnessId;
  label: string;
  matchesCommand(command: string): boolean;
  matchesProcess(process: string): boolean;
  matchesOutput(output: string): boolean;
  isAgentProcess(process: string): boolean;
  resumeFlag: string;
  stableSessionIdFlag?: string;
  hasExplicitSession(command: string): boolean;
  resume(sessionId: string): string;
  lane(brief: string, requestedModel?: string): HarnessLaneLaunch;
};

function shellWord(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function interactiveLane(command: string, mode: string, brief: string, model?: string): HarnessLaneLaunch {
  const selectedModel = model ?? null;
  const modelArg = selectedModel ? ` -m ${shellWord(selectedModel)}` : "";
  return {
    command: `${command}${modelArg}`,
    model: selectedModel,
    mode,
    body: `Read and execute the lane brief at ${brief}`,
    ref: brief,
  };
}

export const harnessDefinitions: HarnessDefinition[] = [
  {
    id: "claude", label: "Claude Code",
    matchesCommand: (s) => /(?:^|[\\/\s])(?:claude|ccz)(?:\s|$)/i.test(s),
    matchesProcess: (s) => /^(?:claude|\d+(?:\.\d+){1,3})$/.test(s),
    isAgentProcess: (s) => /^(?:claude|\d+(?:\.\d+){1,3})$/.test(s),
    resumeFlag: "--resume", stableSessionIdFlag: "--session-id",
    hasExplicitSession: (s) => /\s--(?:resume|session-id|continue|from-pr)\b/.test(s),
    matchesOutput: (s) => /(?:^|\n)\s*╭─[^\n]*Claude|(?:^|\n)\s*⏺\s+(?:I'll|I|Let|We)\b/.test(s),
    resume: (sessionId) => `claude --resume ${sessionId}`,
    lane: (brief, model) => interactiveLane("claude", "interactive", brief, model),
  },
  {
    id: "opencode", label: "OpenCode",
    matchesCommand: (s) => /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/i.test(s),
    matchesProcess: (s) => /^opencode(?:\.exe)?$/.test(s),
    isAgentProcess: (s) => /^(?:opencode(?:\.exe)?|node|bun)$/.test(s),
    resumeFlag: "--session",
    hasExplicitSession: (s) => /\s--session\b/.test(s),
    matchesOutput: (s) => /(?:^|\n)\s*╭─[^\n]*(?:OpenCode|Open Code)|(?:^|\n)\s*┃[^\n]*(?:OpenCode|Open Code)/.test(s),
    resume: (sessionId) => `opencode --session ${sessionId}`,
    lane: (brief, requestedModel) => {
      const model = requestedModel ?? "openrouter/deepseek/deepseek-v4-flash-0731";
      return {
        command: `opencode run -m ${shellWord(model)} --auto "$(cat ${shellWord(brief)})"`,
        model,
        mode: "auto",
        body: `Read and execute the lane brief at ${brief}`,
        ref: brief,
      };
    },
  },
  {
    id: "codex", label: "Codex",
    matchesCommand: (s) => /(?:^|[\\/\s])codex(?:\.exe)?(?:\s|$)/i.test(s),
    matchesProcess: (s) => /^codex(?:\.exe)?$/.test(s),
    isAgentProcess: (s) => /^(?:codex(?:\.exe)?|node|bun)$/.test(s),
    resumeFlag: "resume",
    hasExplicitSession: (s) => /\s+resume(?:\s|$)/.test(s),
    matchesOutput: (s) => /(?:^|\n)\s*(?:OpenAI Codex|╭─[^\n]*Codex)/.test(s),
    resume: (sessionId) => `codex resume ${sessionId}`,
    lane: (brief, model) => interactiveLane("codex", "interactive", brief, model),
  },
  {
    id: "kimi", label: "Kimi Code",
    matchesCommand: (s) => /(?:^|[\\/\s])kimi(?:\.exe)?(?:\s|$)/i.test(s),
    matchesProcess: (s) => /^kimi(?:\.exe)?$/.test(s),
    isAgentProcess: (s) => /^(?:kimi(?:\.exe)?|node|bun)$/.test(s),
    resumeFlag: "--session",
    hasExplicitSession: (s) => /\s--session\b/.test(s),
    matchesOutput: (s) => /(?:^|\n)\s*(?:Kimi Code|Moonshot AI)/.test(s),
    resume: (sessionId) => `kimi --session ${sessionId}`,
    lane: (brief, model) => interactiveLane("kimi", "interactive", brief, model),
  },
];

export const harnessDefinitionById = Object.fromEntries(
  harnessDefinitions.map((definition) => [definition.id, definition]),
) as Record<HarnessId, HarnessDefinition>;

export const harnessIds = harnessDefinitions.map((definition) => definition.id) as HarnessId[];
