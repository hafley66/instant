/** A change is one unit of work; a patch set is one commit it has pointed at. */
export interface Patchset {
  readonly index: number;
  readonly commitId: string;
  readonly description: string;
}

export interface PatchsetSource {
  listPatchsets(changeId: string): Promise<Patchset[]>;
  /** Unified diff of what the author did between two patch sets. */
  interdiff(from: string, to: string): Promise<string>;
  /** Unified diff of one patch set against its own base. */
  diff(commitId: string): Promise<string>;
}

/** Supply exec, Tauri invoke, or a stub. */
export type Run = (bin: string, args: string[]) => Promise<string>;

const SEP = " ";

export function jjSource(run: Run): PatchsetSource {
  const jj = (args: string[]) => run("jj", ["--no-pager", ...args]);

  return {
    async listPatchsets(changeId) {
      const raw = await jj([
        "evolog",
        "-r",
        changeId,
        "--no-graph",
        "-T",
        `commit.commit_id() ++ "${SEP}" ++ commit.description().first_line() ++ "${SEP}${SEP}"`,
      ]);
      // evolog is newest first; patch set 1 is the oldest.
      const rows = raw
        .split(SEP + SEP)
        .map((row) => row.split(SEP))
        .filter(([commitId]) => commitId?.length === 40)
        .reverse();
      return rows.map(([commitId, description], i) => ({
        index: i + 1,
        commitId,
        description: description ?? "",
      }));
    },

    // jj rebases `from` onto `to`'s parents first, so pure-rebase pairs give "".
    interdiff: (from, to) =>
      jj(["interdiff", "--from", from, "--to", to, "--git"]),

    diff: (commitId) => jj(["diff", "-r", commitId, "--git"]),
  };
}

/** Patch sets live in a ref namespace, e.g. `refs/patchsets/<branch>`. */
// `interdiff` compares trees here, so a rebased pair carries upstream noise.
export function gitSource(run: Run, upstream = "main"): PatchsetSource {
  const git = (args: string[]) => run("git", ["--no-pager", ...args]);
  const DIFF = ["diff", "--histogram", "-M"];

  return {
    async listPatchsets(changeId) {
      const raw = await git([
        "for-each-ref",
        "--sort=refname",
        `--format=%(objectname)${SEP}%(contents:subject)`,
        `${changeId}/`,
      ]);
      return raw
        .split("\n")
        .filter(Boolean)
        .map((row, i) => {
          const [commitId, description = ""] = row.split(SEP);
          return { index: i + 1, commitId, description };
        });
    },

    interdiff: (from, to) => git([...DIFF, from, to]),

    async diff(commitId) {
      const base = (await git(["merge-base", upstream, commitId])).trim();
      return git([...DIFF, base, commitId]);
    },
  };
}
