import { defineConfig, devices } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Rustdoc tier: Chromium drives the built bundle served by instant-serve with a
// real generated cargo doc tree mounted at /rustdoc/. The crate is built from
// scratch (cargo doc --no-deps) into a private directory whose path contains a
// space, so the resolver is exercised on a real path, not a synthetic one.
//
// Isolation, same shape as the boop-network tier:
//   BOOP_DB / BOOP_MAIL_DIR  scratch sqlite store + mailbox
//   TMUX_TMPDIR              private socket dir; TMUX cleared
//   INSTANT_NO_GLOBALS       no tray, global shortcut, or summon gesture
//   data dir / boop / tmux   all under the scratch root
// The embedded Chrome is kept off the owner's real profile without product
// changes: cdp.rs:ensure_profile returns early when <state_dir>/cdp-chrome/
// Default exists, so the tier precreates it. A debug instant-serve uses the
// data dir itself as state_dir, so both that and the release `prod/` nesting are
// created.
const port = Number(process.env.INSTANT_RUSTDOC_PORT ?? 47816);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const serve =
  process.env.INSTANT_RUSTDOC_SERVE ??
  path.join(
    process.env.CARGO_TARGET_DIR ?? path.join(root, "src-tauri/target"),
    "debug/instant-serve",
  );
const scratchRoot = process.env.INSTANT_RUSTDOC_TMP ?? `/private/tmp/instant-rustdoc-${port}`;
const dataDir = path.join(scratchRoot, "serve");
const boopDir = path.join(scratchRoot, "boop");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDb = path.join(boopDir, "boop.db");

// A space in the crate directory, and in the doc root below it.
const crateDir = path.join(scratchRoot, "krate with spaces", "docprobe");
const crateTarget = path.join(scratchRoot, "krate with spaces", "target");
const docRoot = path.join(crateTarget, "doc");

fs.mkdirSync(path.join(crateDir, "src"), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(boopDir, { recursive: true });
fs.mkdirSync(tmuxDir, { recursive: true });
for (const nested of [path.join(dataDir, "cdp-chrome"), path.join(dataDir, "prod/cdp-chrome")]) {
  fs.mkdirSync(path.join(nested, "Default"), { recursive: true });
}
fs.writeFileSync(
  path.join(crateDir, "Cargo.toml"),
  ['[package]', 'name = "docprobe"', 'version = "0.1.0"', 'edition = "2021"', "", '[lib]', 'path = "src/lib.rs"', ""].join("\n"),
);
fs.writeFileSync(
  path.join(crateDir, "src/lib.rs"),
  [
    "//! Probe crate for rustdoc browsing.",
    "",
    "/// Adds two integers.",
    "pub fn add(a: i32, b: i32) -> i32 { a + b }",
    "",
    "/// A named pair.",
    "pub struct Pair {",
    "    /// First element.",
    "    pub left: i32,",
    "    /// Second element.",
    "    pub right: i32,",
    "}",
    "",
  ].join("\n"),
);
const doc = spawnSync("cargo", ["doc", "--no-deps"], {
  cwd: crateDir,
  encoding: "utf8",
  env: { ...process.env, CARGO_TARGET_DIR: crateTarget },
});
if (doc.status !== 0) {
  throw new Error(`cargo doc failed:\n${doc.stdout}\n${doc.stderr}`);
}
if (!fs.existsSync(path.join(docRoot, "docprobe/index.html"))) {
  throw new Error(`cargo doc produced no docprobe/index.html under ${docRoot}`);
}

export default defineConfig({
  testDir: "./e2e-real",
  testMatch: "**/rustdoc.spec.ts",
  workers: 1,
  timeout: 180_000,
  outputDir: "test-results/rustdoc",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: ["--renderer-process-limit=1", "--disable-gpu", "--in-process-gpu", "--disable-dev-shm-usage", "--js-flags=--max-old-space-size=384"],
    },
  },
  webServer: {
    command: `env -u TMUX TMUX_TMPDIR=${tmuxDir} INSTANT_NO_GLOBALS=1 INSTANT_TMUX_SOCKET= BOOP_DB=${boopDb} BOOP_MAIL_DIR=${boopDir} BOOP_NO_SYNC=1 ${serve} --port ${port} --data-dir ${dataDir} --dist ${path.join(root, "dist")} --doc-root "${docRoot}"`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !!process.env.INSTANT_RUSTDOC_REUSE,
    timeout: 30_000,
  },
  metadata: { scratchRoot, docRoot, dataDir, boopDb, boopDir, tmuxDir, root },
});
