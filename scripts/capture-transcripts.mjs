// Capture real harness transcripts into small, sanitized fixtures under
// fixtures/transcripts/, so the ledger parsers are tested against the shapes
// the harnesses actually write rather than shapes we imagined.
//
// Session discovery goes through CASS (`cass search --agent <slug>`), which
// already indexes every connector and knows where each harness stores its
// history. Without CASS installed the script falls back to the same on-disk
// layout ledger.rs reads, so a checkout with no index still captures.
//
// Each fixture keeps at most `--per-kind` records of every record kind found
// (roles, tool calls by name, tool results, thinking, subagent lines, task and
// skill activations), in the file's original order. Every string is scrubbed
// for secrets and home paths, then trimmed, so what lands in git is small and
// safe to read.
//
//   node scripts/capture-transcripts.mjs             # capture all harnesses
//   node scripts/capture-transcripts.mjs --check     # verify coverage, write nothing
//   node scripts/capture-transcripts.mjs --harness claude --per-kind 3
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const OUT = join(REPO, "fixtures", "transcripts");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : fallback;
};
const CHECK = args.includes("--check");
const PER_KIND = Number(flag("per-kind", 2));
const MAX_CHARS = Number(flag("max-chars", 600));
const MAX_ITEMS = Number(flag("max-items", 8));
const ONLY = flag("harness", null);

// ---- sanitizing ----------------------------------------------------------
// Ordered: the wider patterns run last so a token inside a path is still hit.
const SCRUB = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "user@example.com"],
  [/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "REDACTED_TOKEN"],
  [/\b(Bearer|Authorization:)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 REDACTED_TOKEN"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "REDACTED_PRIVATE_KEY"],
  // Anything that reads as a long opaque blob (base64 payloads, image data).
  [/\b[A-Za-z0-9+/]{120,}={0,2}\b/g, "REDACTED_BLOB"],
];

// Values that are opaque by construction, so redacting inside them would leave
// a half-scrubbed blob and keeping them buys no test coverage. Codex stores its
// reasoning as Fernet ciphertext under `encrypted_content`; the rest are the
// field names credentials arrive under.
const DROP_KEYS = /^(encrypted_\w+|\w*(token|secret|password|passwd|api_?key|access_key|credential|cookie|authorization)\w*)$/i;

// The capturing machine's identity, replaced before anything else so a home
// path inside a longer string still collapses.
function deIdentify(s) {
  const user = basename(HOME);
  let out = s.split(HOME).join("/Users/dev");
  if (user && user !== "dev") out = out.split(user).join("dev");
  for (const [re, to] of SCRUB) out = out.replace(re, to);
  return out;
}

function trim(s) {
  if (s.length <= MAX_CHARS) return s;
  return `${s.slice(0, MAX_CHARS)}…[trimmed ${s.length - MAX_CHARS} chars]`;
}

function sanitize(value) {
  if (typeof value === "string") return trim(deIdentify(value));
  // Bulk lists (kimi's `llm.tools_snapshot` carries every tool schema, 36KB of
  // it) get the same treatment strings do: keep the head, note the cut.
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ITEMS).map(sanitize);
    if (value.length > MAX_ITEMS) kept.push(`…[trimmed ${value.length - MAX_ITEMS} items]`);
    return kept;
  }
  if (value && typeof value === "object") {
    // Keys carry paths too: Codex `turn_diff.changes` is keyed by absolute
    // file path, so de-identify the key without trimming it.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        deIdentify(k),
        DROP_KEYS.test(k) && v !== null ? "[dropped]" : sanitize(v),
      ]),
    );
  }
  return value;
}

// ---- record classification ----------------------------------------------
// One classifier per harness, mirroring what ledger.rs keys on, so fixture
// coverage is stated in the same vocabulary the parser branches on.
const CLASSIFY = {
  claude(v) {
    const kinds = [];
    if (v.isSidechain) kinds.push("subagent-line");
    const type = v.type;
    if (type === "assistant") {
      for (const b of v.message?.content ?? []) {
        if (b?.type === "tool_use") kinds.push(`tool:${b.name}`);
        else if (b?.type) kinds.push(`assistant:${b.type}`);
      }
      if (!kinds.length) kinds.push("assistant:empty");
    } else if (type === "user") {
      // Same order ledger.rs classifies in, so a kind names the branch it hits.
      const content = v.message?.content;
      const blocks = Array.isArray(content) ? [...new Set(content.map((b) => b?.type))].sort() : null;
      const shape = blocks ? blocks.join("+") : typeof content === "string" ? "string" : "empty";
      if (blocks?.includes("tool_result")) kinds.push("user:tool_result");
      else if (v.promptSource === "system") kinds.push(`user:system-${v.origin?.kind ?? "system"}`);
      else if (v.isCompactSummary) kinds.push("user:compact-summary");
      else if (v.isMeta) kinds.push(`user:meta-${shape}`);
      else kinds.push(`user:${shape}`);
    } else if (type) {
      kinds.push(`line:${type}`);
    }
    return kinds;
  },
  codex(v) {
    const p = v.payload;
    if (!p?.type) return [];
    if (p.type === "message") return [`message:${p.role}`];
    if (p.type === "custom_tool_call" || p.type === "function_call") return [`call:${p.name}`];
    return [`payload:${p.type}`];
  },
  kimi(v) {
    if (v.type !== "context.append_loop_event") return [`line:${v.type}`];
    const e = v.event ?? {};
    if (e.type === "content.part") return [`part:${e.part?.type}`];
    if (e.type === "tool.call") return [`tool:${e.name}`];
    return [`event:${e.type}`];
  },
};

// Kinds a fixture must contain to be worth committing. Missing ones are
// reported (and fail --check) instead of being silently absent.
const REQUIRED = {
  claude: ["user:string", "assistant:text", "user:tool_result", "tool:Read", "tool:Bash"],
  codex: ["message:user", "message:assistant", "call:exec", "payload:custom_tool_call_output"],
  kimi: ["line:turn.prompt", "part:text", "tool:Bash", "event:tool.result"],
};

// Kinds worth capturing when present, called out in the manifest so a reader
// can see which of the interesting features this corpus actually covers.
const FEATURES = {
  claude: {
    files: ["tool:Read", "tool:Edit", "tool:Write"],
    tasks: ["tool:TaskCreate", "tool:TaskUpdate", "tool:TodoWrite"],
    subagents: ["tool:Agent", "tool:SendMessage", "subagent-line"],
    skills: ["tool:Skill", "user:meta-string", "user:meta-text"],
    thinking: ["assistant:thinking"],
    roles: ["user:string", "assistant:text", "user:tool_result"],
    injections: [
      "user:system-task-notification",
      "user:system-peer",
      "user:compact-summary",
      "user:meta-string",
      "user:meta-text",
    ],
  },
  codex: {
    files: ["call:apply_patch", "payload:patch_apply_end"],
    tasks: ["payload:task_started", "payload:task_complete"],
    subagents: ["call:wait"],
    skills: ["message:developer"],
    thinking: ["payload:reasoning"],
    roles: ["message:user", "message:assistant"],
  },
  kimi: {
    files: ["tool:Read", "tool:Edit", "tool:Write"],
    tasks: ["tool:TodoList"],
    subagents: ["tool:Task"],
    skills: ["line:tools.update_store"],
    thinking: ["part:think"],
    roles: ["line:turn.prompt", "part:text"],
  },
};

// ---- session discovery ---------------------------------------------------
const CASS_AGENT = { claude: "claude_code", codex: "codex", kimi: "kimi" };

// Ask CASS where a harness keeps sessions that mention `probe`. CASS owns
// connector discovery, so this stays correct as harnesses move their files.
function cassSessions(harness, probes) {
  const paths = [];
  for (const probe of probes) {
    let stdout;
    try {
      stdout = execFileSync(
        "cass",
        ["search", probe, "--agent", CASS_AGENT[harness], "--limit", "12", "--json", "--fields", "source_path,line_number,agent"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 },
      );
    } catch {
      return []; // no cass, or no index yet: the caller falls back to the disk layout
    }
    for (const hit of JSON.parse(stdout).hits ?? []) {
      if (hit.source_path && !paths.includes(hit.source_path)) paths.push(hit.source_path);
    }
  }
  return paths;
}

function walkFiles(dir, match, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) walkFiles(path, match, out);
    else if (match(path)) out.push(path);
  }
  return out;
}

// The same on-disk layouts ledger.rs reads, newest first.
const DISK = {
  claude: () => walkFiles(join(HOME, ".claude", "projects"), (p) => p.endsWith(".jsonl")),
  codex: () => walkFiles(join(HOME, ".codex", "sessions"), (p) => p.endsWith(".jsonl")),
  kimi: () => walkFiles(join(HOME, ".kimi-code", "sessions"), (p) => p.endsWith("wire.jsonl")),
};

function candidates(harness, probes) {
  const fromCass = cassSessions(harness, probes).filter((p) => existsSync(p));
  const fromDisk = DISK[harness]();
  const all = [...fromCass, ...fromDisk.filter((p) => !fromCass.includes(p))];
  return { paths: all, usedCass: fromCass.length > 0 };
}

// ---- capture -------------------------------------------------------------
// Keep up to PER_KIND records of each kind, in file order. Records that add no
// new coverage are dropped, which is what keeps a 200MB transcript under a
// hundred kilobytes.
function selectRecords(lines, classify) {
  const seen = new Map();
  const kept = [];
  for (const { raw, value } of lines) {
    const kinds = classify(value);
    if (!kinds.length) continue;
    const novel = kinds.some((k) => (seen.get(k) ?? 0) < PER_KIND);
    if (!novel) continue;
    for (const k of kinds) seen.set(k, (seen.get(k) ?? 0) + 1);
    kept.push({ raw, value });
  }
  return { kept, kinds: seen };
}

function parseLines(path) {
  const out = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      out.push({ raw, value: JSON.parse(raw) });
    } catch {
      /* a partially written tail line: skip it */
    }
  }
  return out;
}

function captureOne(harness, path) {
  const classify = CLASSIFY[harness];
  const lines = parseLines(path);
  if (!lines.length) return null;
  const { kept, kinds } = selectRecords(lines, classify);
  if (!kept.length) return null;
  const jsonl = kept.map((k) => JSON.stringify(sanitize(k.value))).join("\n") + "\n";
  return {
    jsonl,
    kinds: Object.fromEntries([...kinds.entries()].sort()),
    records: kept.length,
    sourceLines: lines.length,
    // The real session id stays out of the repo; this is enough to recapture
    // from the same file if it is still on disk.
    sourceHash: createHash("sha256").update(path).digest("hex").slice(0, 12),
  };
}

function coverage(harness, kindsSeen) {
  const has = (k) => kindsSeen[k] > 0;
  const features = {};
  for (const [feature, keys] of Object.entries(FEATURES[harness])) {
    features[feature] = keys.filter(has);
  }
  const missing = REQUIRED[harness].filter((k) => !has(k));
  return { features, missing };
}

function captureHarness(harness) {
  const probes = {
    claude: ["Skill", "Agent", "TodoWrite", "Edit"],
    codex: ["apply_patch", "exec"],
    kimi: ["TodoList", "Edit"],
  }[harness];
  const { paths, usedCass } = candidates(harness, probes);
  if (!paths.length) return { harness, skipped: "no sessions found on this machine" };

  // Newest first, then take the first file that satisfies the required kinds;
  // a short session usually misses half of them.
  const ranked = paths
    .map((p) => {
      try {
        return { p, mtime: statSync(p).mtimeMs, size: statSync(p).size };
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.size > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 40);

  let best = null;
  for (const { p } of ranked) {
    const captured = captureOne(harness, p);
    if (!captured) continue;
    const { features, missing } = coverage(harness, captured.kinds);
    // Breadth first: a session covering five feature groups thinly beats one
    // covering three richly, since the fixture exists to exercise branches.
    const groups = Object.values(features).filter((keys) => keys.length).length;
    const score = groups * 4 + Object.values(features).flat().length - missing.length * 3;
    if (!best || score > best.score) best = { ...captured, features, missing, score, path: p };
    // Stop only once nothing is left to gain.
    if (!missing.length && groups === Object.keys(FEATURES[harness]).length) break;
  }
  if (!best) return { harness, skipped: "no parsable records" };

  const file = join(OUT, harness, "session.jsonl");
  if (!CHECK) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, best.jsonl);
  }
  return {
    harness,
    file: file.slice(REPO.length + 1),
    discovery: usedCass ? "cass" : "disk-layout",
    records: best.records,
    sourceLines: best.sourceLines,
    bytes: Buffer.byteLength(best.jsonl),
    sourceHash: best.sourceHash,
    kinds: best.kinds,
    features: best.features,
    missing: best.missing,
  };
}

// Claude keeps a spawned agent's own transcript beside the parent session, so
// subagent coverage needs one of those files too.
function captureClaudeSubagent() {
  const files = walkFiles(join(HOME, ".claude", "projects"), (p) => p.includes("/subagents/") && p.endsWith(".jsonl"));
  if (!files.length) return null;
  const ranked = files
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20);
  for (const { p } of ranked) {
    const captured = captureOne("claude", p);
    if (!captured || captured.records < 4) continue;
    const file = join(OUT, "claude", "subagent.jsonl");
    if (!CHECK) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, captured.jsonl);
    }
    return {
      harness: "claude-subagent",
      file: file.slice(REPO.length + 1),
      discovery: "disk-layout",
      records: captured.records,
      sourceLines: captured.sourceLines,
      bytes: Buffer.byteLength(captured.jsonl),
      sourceHash: captured.sourceHash,
      kinds: captured.kinds,
      features: { subagents: ["subagent-line"] },
      missing: [],
    };
  }
  return null;
}

const harnesses = (ONLY ? [ONLY] : ["claude", "codex", "kimi"]).filter((h) => CLASSIFY[h]);
const results = harnesses.map(captureHarness);
if (!ONLY || ONLY === "claude") {
  const sub = captureClaudeSubagent();
  if (sub) results.push(sub);
}

const manifest = {
  // Regenerate with: node scripts/capture-transcripts.mjs
  captured: new Date().toISOString().slice(0, 10),
  perKind: PER_KIND,
  maxChars: MAX_CHARS,
  note: "Sanitized slices of real harness sessions. Home paths, emails, and tokens are scrubbed; every string is trimmed. Kinds mirror what src-tauri/src/ledger.rs branches on.",
  fixtures: results,
};
if (!CHECK) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

let bad = 0;
for (const r of results) {
  if (r.skipped) {
    console.log(`${r.harness.padEnd(16)} skipped: ${r.skipped}`);
    continue;
  }
  const feat = Object.entries(r.features)
    .filter(([, keys]) => keys.length)
    .map(([name]) => name)
    .join(",");
  console.log(
    `${r.harness.padEnd(16)} ${String(r.records).padStart(4)} records  ${String(Math.round(r.bytes / 1024)).padStart(4)}KB  via ${r.discovery.padEnd(12)} covers: ${feat}`,
  );
  if (r.missing.length) {
    bad += 1;
    console.log(`${" ".repeat(16)} missing required kinds: ${r.missing.join(", ")}`);
  }
}
if (CHECK && bad) {
  console.error(`\n${bad} fixture(s) missing required record kinds`);
  process.exit(1);
}
