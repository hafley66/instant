import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const classify = {
  claude(value) {
    const kinds = [];
    if (value.isSidechain) kinds.push("subagent-line");
    if (value.type === "assistant") {
      for (const block of value.message?.content ?? []) {
        if (block?.type === "tool_use") kinds.push(`tool:${block.name}`);
        else if (block?.type) kinds.push(`assistant:${block.type}`);
      }
      if (!kinds.length) kinds.push("assistant:empty");
    } else if (value.type === "user") {
      const content = value.message?.content;
      const blocks = Array.isArray(content)
        ? [...new Set(content.map((block) => block?.type))].sort()
        : null;
      const shape = blocks ? blocks.join("+") : typeof content === "string" ? "string" : "empty";
      if (blocks?.includes("tool_result")) kinds.push("user:tool_result");
      else if (value.promptSource === "system") kinds.push(`user:system-${value.origin?.kind ?? "system"}`);
      else if (value.isCompactSummary) kinds.push("user:compact-summary");
      else if (value.isMeta) kinds.push(`user:meta-${shape}`);
      else kinds.push(`user:${shape}`);
    } else if (value.type) {
      kinds.push(`line:${value.type}`);
    }
    return kinds;
  },
  codex(value) {
    const payload = value.payload;
    if (!payload?.type) return [];
    if (payload.type === "message") return [`message:${payload.role}`];
    if (payload.type === "custom_tool_call" || payload.type === "function_call") {
      return [`call:${payload.name}`];
    }
    return [`payload:${payload.type}`];
  },
  kimi(value) {
    if (value.type !== "context.append_loop_event") return [`line:${value.type}`];
    const event = value.event ?? {};
    if (event.type === "content.part") return [`part:${event.part?.type}`];
    if (event.type === "tool.call") return [`tool:${event.name}`];
    return [`event:${event.type}`];
  },
};

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${error.message}`);
      }
    });
}

export function inspectTranscriptCorpus(
  manifestPath = join(repo, "fixtures", "transcripts", "manifest.json"),
) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const fixtures = manifest.fixtures.map((fixture) => {
    const harness = fixture.harness === "claude-subagent" ? "claude" : fixture.harness;
    const classifyRecord = classify[harness];
    if (!classifyRecord) throw new Error(`No transcript classifier for ${fixture.harness}`);

    const records = readJsonLines(join(repo, fixture.file));
    const actualKinds = {};
    for (const record of records) {
      for (const kind of classifyRecord(record)) {
        actualKinds[kind] = (actualKinds[kind] ?? 0) + 1;
      }
    }

    const declaredKinds = Object.keys(fixture.kinds);
    const absentKinds = declaredKinds.filter((kind) => (actualKinds[kind] ?? 0) < 1);
    const undeclaredKinds = Object.keys(actualKinds).filter((kind) => !(kind in fixture.kinds));
    if (records.length !== fixture.records) {
      throw new Error(`${fixture.file}: manifest records=${fixture.records}, actual=${records.length}`);
    }
    if (fixture.missing.length || absentKinds.length || undeclaredKinds.length) {
      throw new Error(JSON.stringify({
        file: fixture.file,
        manifestMissing: fixture.missing,
        absentKinds,
        undeclaredKinds,
      }));
    }

    return {
      harness: fixture.harness,
      records: records.length,
      kinds: declaredKinds.length,
      minimumPerKind: Math.min(...declaredKinds.map((kind) => actualKinds[kind])),
    };
  });

  return {
    perKind: manifest.perKind,
    fixtures,
    records: fixtures.reduce((sum, fixture) => sum + fixture.records, 0),
    kinds: fixtures.reduce((sum, fixture) => sum + fixture.kinds, 0),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(inspectTranscriptCorpus(), null, 2)}\n`);
}
