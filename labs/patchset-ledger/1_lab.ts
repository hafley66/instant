import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hook = join(dirname(fileURLToPath(import.meta.url)), "0_pre-push");
const zero = "0".repeat(40);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function push(cwd: string, eventLog: string, ...args: string[]): string {
  return execFileSync("git", ["push", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, INSTANT_PATCHSET_EVENT_LOG: eventLog },
  }).trim();
}

function refs(repo: string): string[] {
  const output = git(repo, "for-each-ref", "--sort=refname", "--format=%(refname:short) %(subject)", "refs/instant/changes/topic");
  return output ? output.split("\n") : [];
}

function event(line: string, names: Map<string, string>) {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
  return { localRef, localSha: names.get(localSha), remoteRef, remoteSha: remoteSha === zero ? "missing" : names.get(remoteSha) };
}

export function runPatchsetLab() {
  const root = mkdtempSync(join(tmpdir(), "patchset-ledger-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const eventLog = join(root, "events");
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, repo);
  git(repo, "config", "user.name", "Patch Set Lab");
  git(repo, "config", "user.email", "lab@example.invalid");

  git(repo, "switch", "-c", "main");
  writeFileSync(join(repo, "base.txt"), "base one\n");
  git(repo, "add", "base.txt");
  git(repo, "commit", "-m", "base one");
  git(repo, "push", "-u", "origin", "main");
  const installedHook = join(resolve(repo, git(repo, "rev-parse", "--git-dir")), "hooks", "pre-push");
  copyFileSync(hook, installedHook);
  chmodSync(installedHook, 0o755);

  git(repo, "switch", "-c", "topic");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "change A");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-m", "change B");
  const firstTip = git(repo, "rev-parse", "HEAD");
  const firstCommits = git(repo, "log", "--reverse", "--format=%s", "main..topic").split("\n");

  const beforeFirstPush = { remote: "missing", archive: refs(repo) };
  push(repo, eventLog, "-u", "origin", "topic");
  const afterFirstPush = { remote: git(repo, "rev-parse", "refs/remotes/origin/topic"), archive: refs(repo) };

  git(repo, "switch", "main");
  writeFileSync(join(repo, "base.txt"), "base two\n");
  git(repo, "commit", "-am", "base two");
  git(repo, "push", "origin", "main");
  git(repo, "switch", "topic");
  git(repo, "rebase", "main");
  const secondTip = git(repo, "rev-parse", "HEAD");
  const secondCommits = git(repo, "log", "--reverse", "--format=%s", "main..topic").split("\n");

  const beforeForcePush = { remote: git(repo, "rev-parse", "refs/remotes/origin/topic"), local: secondTip, archive: refs(repo) };
  push(repo, eventLog, "--force-with-lease", "origin", "topic");
  const afterForcePush = { remote: git(repo, "rev-parse", "refs/remotes/origin/topic"), archive: refs(repo) };

  git(repo, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all");
  git(repo, "gc", "--prune=now");

  const names = new Map([[firstTip, "patch-set-1"], [secondTip, "patch-set-2"]]);
  const topicEvents = readFileSync(eventLog, "utf8").trim().split("\n")
    .filter((line) => line.includes(" refs/heads/topic "))
    .map((line) => event(line, names));
  const label = (sha: string) => names.get(sha) ?? sha;

  return {
    firstPush: {
      before: beforeFirstPush,
      event: topicEvents[0],
      after: { ...afterFirstPush, remote: label(afterFirstPush.remote) },
      commits: firstCommits,
    },
    forceWithLeaseAfterRebase: {
      before: { ...beforeForcePush, remote: label(beforeForcePush.remote), local: label(beforeForcePush.local) },
      event: topicEvents[1],
      after: { ...afterForcePush, remote: label(afterForcePush.remote) },
      commits: secondCommits,
    },
    afterReflogExpiryAndGc: {
      retainedObjects: [git(repo, "cat-file", "-t", firstTip), git(repo, "cat-file", "-t", secondTip)],
      diff: git(repo, "diff", "--stat", firstTip, secondTip),
    },
  };
}

export type PatchsetLabReceipt = ReturnType<typeof runPatchsetLab>;
