#!/usr/bin/env node
// Secret scan for committed fixtures. Run after `capture-transcripts.mjs`:
//
//   node scripts/scan-secrets.mjs fixtures/transcripts
//
// Exits 1 on any hit, printing file, line, pattern name, and surrounding text.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "fixtures/transcripts";

const PATTERNS = [
  ["anthropic", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai", /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g],
  ["github", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ["aws-key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google-api", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["stripe", /\b[sr]k_(live|test)_[A-Za-z0-9]{20,}\b/g],
  ["npm", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["ssh-key", /\bssh-(rsa|ed25519) [A-Za-z0-9+/]{100,}/g],
  ["bearer", /\b(Bearer|Authorization:)\s+[A-Za-z0-9._~+/-]{20,}=*/gi],
  [
    "assignment",
    /\b[A-Z_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)\b\s*[=:]\s*["']?[A-Za-z0-9._~+/-]{12,}/g,
  ],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["home", /\/Users\/(?!dev\b)[A-Za-z0-9_.-]+/g],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"]+:[^/\s@"]+@/gi],
];

// A long unbroken mixed-case run is the shape a leaked blob takes even when no
// named pattern matches. Paths are the common false positive, so a run holding
// a separator is prose as far as this check is concerned.
function entropyHits(line) {
  const out = [];
  for (const m of line.matchAll(/[A-Za-z0-9+/=_-]{40,}/g)) {
    const s = m[0];
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(s)).length;
    if (classes >= 3 && new Set(s).size >= 20) out.push(["high-entropy", m.index, s]);
  }
  return out;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

let hits = 0;
for (const file of walk(ROOT)) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const found = [...entropyHits(line)];
      for (const [name, re] of PATTERNS) {
        for (const m of line.matchAll(re)) found.push([name, m.index, m[0]]);
      }
      for (const [name, at, s] of found) {
        if (name === "high-entropy" && s.includes("/")) continue;
        hits++;
        const ctx = line.slice(Math.max(0, at - 40), at + s.length + 40).replace(/\s+/g, " ");
        console.log(`${file}:${i + 1} [${name}] ${JSON.stringify(s.slice(0, 60))}\n    …${ctx}…`);
      }
    });
}
console.log(hits ? `\n${hits} hits` : `clean: no secret-shaped strings under ${ROOT}`);
process.exit(hits ? 1 : 0);
