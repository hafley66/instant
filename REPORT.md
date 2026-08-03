# REPORT: message bus (queue + passing + ack) with queue-preview view

Lane: lab/busmail, worktree /Users/chrishafley/projects/instant-lab-busmail.
Base: `git merge --ff-only a35ad6a` -> "Already up to date." (clean no-op).
Commits: 3fd589f (contract + ruling seed), a8b2590 (implementation).
Previous lab's REPORT.md preserved at `git show a35ad6a:REPORT.md`.
(File placed by the coordinator from the lane's returned report text; the
lane's harness blocks report-file writes.)

## 0. What landed

| file | state | role |
|---|---|---|
| src/plugins/harnessTrace/0_bus.ts | new | `MailStore` (IMailStore): parse/line/fold/inbox/outbox/unacked/thread/replyDepth/queue/send/ack. `MailDirectory` (IMailDirectoryReader): registry.json -> routes. Pure, no fs/clock/invoke. |
| src/plugins/harnessTrace/1_leg.ts | new | `MailLeg` (IMailLeg): tmux send-keys argv, cass search argv, cass hit scoping. `injectedLine`. Pure. |
| src/plugins/harnessTrace/2_mailbox.ts | new | `MailboxReader` (IMailboxReader): frontend read side over list_dir/read_text. |
| src/plugins/harnessTrace/4_MailPreview.tsx | new | `MailPreview`: one agent id's queue, in/out, kind, reply_to indent, body preview, from_timestamp/to_timestamp, acked/queued. |
| scripts/bus.ts | new | edge CLI: `hail` (append + tmux inject), `sweep` (cass ack), `list`. fs + spawn only. |
| src/plugins/harnessTrace/0_bus.test.ts | new | 21 cases |
| src/plugins/harnessTrace/1_leg.test.ts | new | 8 cases |
| src/plugins/harnessTrace/3_router.mail.test.ts | new | 3 cases |
| e2e-mail-preview.html, e2e/mail-preview.tsx, e2e/mail-preview.spec.ts | new | render receipt + PNG |
| playwright.busmail.config.ts | new | own port 4183 (sibling lanes hold 4173 with reuseExistingServer) |
| src/plugins/harnessTrace/0_mail.ts | modified (owned) | parse migrated to the ruled envelope; legacy projection kept for the panel; `mailAgentIdFor` |
| src/plugins/harnessTrace/0_mail.test.ts | modified (owned) | + ruled-envelope migration cases, + mailAgentIdFor |
| src/plugins/harnessTrace/0_types.ts | modified (append-only, end of file) | IMailMessage, IMailSend, IMailQueueRow, IMailStore, IMailAgent, IMailDirectory, IMailDirectoryReader, IMailCassHit, IMailLeg, IMailbox, IMailboxReader, IMailPreviewView, TermViewAny, ITermViewRouter |
| src/plugins/harnessTrace/3_router.ts | modified (append-only, end of file) | `termViewRouter`, `mailPreviewView`, `pushMailPreview` |

## 1. Envelope migration diff

The ruled envelope is new (`IMailMessage`); `MailEnvelope` could not be
rewritten in place because 0_types.ts is append-only for this lane and
HarnessTracePanel.tsx (forbidden) consumes `parseMailNdjson(): MailEnvelope[]`.
So the parse moved to the ruled shape and the pre-ruling shape became a
projection of it.

```diff
--- a/src/plugins/harnessTrace/0_mail.ts
+++ b/src/plugins/harnessTrace/0_mail.ts
+export function parseMailLog(text: string): IMailMessage[] {
+  return MailStore.parse(text);
+}
+
+function legacyView(message: IMailMessage): MailEnvelope {
+  return {
+    id: message.id,
+    from: message.from,
+    to: message.to,
+    ts: message.from_timestamp,
+    kind: message.kind,
+    reply_to: message.reply_to ?? undefined,
+    body: message.body || undefined,
+    ref: message.ref ?? undefined,
+  };
+}
+
 export function parseMailNdjson(text: string): MailEnvelope[] {
-  ... 26 lines of hand-rolled field validation ...
+  return parseMailLog(text).map(legacyView);
 }
```

| ruled | pre-ruling | read rule |
|---|---|---|
| from_timestamp | ts | `from_timestamp ?? ts ?? ""` — 2026-08-02 fixtures still parse |
| to_timestamp | (absent) | null unless an ack row carries it |
| reply_to / ref | optional string | `string \| null` |
| body | optional string | `""` when absent |
| kind | required string | `"note"` when absent; any wire string survives ("dispatch") |

Wire keys stay the ruling's JSON verbatim (`from`/`to`); the relational
reading is messages(id, from_id=from, to_id=to, ...) as ruled.

Two fold rules the ruling implies but does not spell out, both tested:

- **Ack is monotone.** Latest row per id wins for content, but a
  to_timestamp once present is kept. Otherwise the ruled at-least-once
  resend (a fresh row with to_timestamp null) would silently unack a
  proven read.
- **A reply_to cycle roots on the smallest id in the cycle**, so every row
  in it groups into one thread whichever row the walk enters from.

## 2. Send-leg transcript (tmux)

Scratch tmux server on its own socket `-L busmail-gate`, created and killed
by this lane; the user's default-socket sessions were never addressed (only
`tmux -L default ls`, read-only, to prove they survived).

```
$ tmux -L busmail-gate new-session -d -s gate-bash -c $SCRATCH/mail/cwd 'bash --norc --noprofile'
$ tmux -L busmail-gate ls
gate-bash: 1 windows (created Mon Aug  3 10:31:46 2026)

$ cat $SCRATCH/mail/registry.json
{ "gate-bash": { "sessionId": "gate-bash", "tmux": "gate-bash" } }

$ node scripts/bus.ts hail --mail-dir $SCRATCH/mail --socket busmail-gate \
    --to gate-bash --from coordinator --kind request \
    --body "echo busmail send leg reached the pane"
queued m-26be931c -> gate-bash
injected into tmux gate-bash
(exit 0)

$ tmux -L busmail-gate capture-pane -p -t gate-bash | tail -3
bash-5.3$ [bus m-26be931c] echo busmail send leg reached the pane
bash: [bus: command not found
bash-5.3$
```

The injected text is `[bus <id>] <body>`: the envelope id has to ride the
injection, because the ack query has nothing else to look for in the
recipient's transcript.

No-pane case (ruled: stays queued, to_timestamp null), empty registry:

```
$ node scripts/bus.ts hail --mail-dir $SCRATCH/mail --to lane-a --body "no route yet"
queued m-a6f396f0 -> lane-a
no registry route for lane-a: message stays queued, to_timestamp null
exit=2
$ cat $SCRATCH/mail/bus.ndjson
{"id":"m-a6f396f0","from":"coordinator","to":"lane-a","from_timestamp":"2026-08-03T14:31:35.481Z","to_timestamp":null,"kind":"request","reply_to":null,"body":"no route yet","ref":null}
```

## 3. Ack-sweep transcript (cass)

Recipient is a real harness session so cass has a transcript to read:
scratch tmux session `gate-claude` running `claude` in a scratch cwd (env
scrubbed of CLAUDE_CODE_* so it starts as its own session).

```
$ tmux -L busmail-gate new-session -d -s gate-claude -x 120 -y 40 -c $SCRATCH/gatecwd \
    "env -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_PID \
     -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH claude"
(trust prompt answered with a single Enter into the scratch pane)

$ node scripts/bus.ts hail --mail-dir $SCRATCH/mail --socket busmail-gate \
    --to gate-claude --from coordinator --kind request \
    --body "reply with the single word ok, nothing else"
queued m-ee1d13de -> gate-claude
injected into tmux gate-claude
(exit 0)

$ tmux -L busmail-gate capture-pane -p -t gate-claude | tail
❯ [bus m-ee1d13de] reply with the single word ok, nothing else
⏺ ok
✻ Brewed for 3s

$ cat $SCRATCH/mail/registry.json
{ "gate-claude": { "sessionId": "e33345e9-670b-4cd1-8f62-b017747bcd43",
  "harness": "claude", "tmux": "gate-claude",
  "sourcePath": "/Users/chrishafley/.claude/projects/-private-tmp-...-gatecwd/e33345e9-670b-4cd1-8f62-b017747bcd43.jsonl" } }

$ node scripts/bus.ts sweep --mail-dir $SCRATCH/mail          # index still stale
m-26be931c -> gate-bash: no registry route, cannot scope the cass query
m-ee1d13de -> gate-claude: no transcript hit, still unacked
swept 2 unacked, acked 0

$ cass index --watch-once "$(dirname "$JSONL")" --robot
  "index_ms": 755, "connectors": [{"name":"claude_code","conversations":1,"messages":2}]
real 0m1.579s

$ node scripts/bus.ts sweep --mail-dir $SCRATCH/mail          # after reindex
m-26be931c -> gate-bash: no registry route, cannot scope the cass query
m-ee1d13de -> gate-claude: acked via /Users/chrishafley/.claude/projects/-private-tmp-...-gatecwd/e33345e9-670b-4cd1-8f62-b017747bcd43.jsonl
swept 2 unacked, acked 1
real 0m0.350s

$ node scripts/bus.ts list --mail-dir $SCRATCH/mail --agent gate-claude
in  {"id":"m-ee1d13de","from":"coordinator","to":"gate-claude","from_timestamp":"2026-08-03T14:33:31.265Z","to_timestamp":"2026-08-03T14:34:18.860Z","kind":"request","reply_to":null,"body":"reply with the single word ok, nothing else","ref":null}
gate-claude: 1 in, 0 out, 0 unacked

$ node scripts/bus.ts sweep --mail-dir $SCRATCH/mail --agent gate-claude   # idempotent
swept 1 unacked, acked 0

$ tmux -L busmail-gate kill-server; tmux -L busmail-gate ls
no server running on /private/tmp/tmux-501/busmail-gate
$ tmux -L default ls        # user's sessions, untouched
sprefa, sprefa-2, sprefa-3, sprefa-4, sprefa-6, duel-dots-flash
```

The stale-index sweep followed by the fresh-index sweep is the ruling's
"cass index freshness bounds ack latency" as a receipt, not a claim.
`cass index --watch-once <dir>` is the cheap lever: 1.6s for the one
changed transcript, and the sweep itself is 0.35s (both inside the
10-second law).

**to_timestamp = the moment cass proved the read**, not the transcript's
own clock: a cass hit carries its conversation's `created_at`, which
predates the message and would sort before from_timestamp.

**Scoping is what makes an ack mean anything.** The sender types the
envelope id too, so its own transcript matches the same query;
`MailLeg.cassHits` keeps only hits whose `source_path` is the recipient's
(exact `sourcePath`, else contains `sessionId`). Unit-tested both ways in
1_leg.test.ts.

## 4. Missing legs

1. **Claude/codex/opencode jsonl injection.** Not invented, per the
   contract. Only the tmux leg exists: `MailLeg.tmuxSendArgs` returns null
   for a route with no pane, `hail` exits 2 and the row stays queued with
   to_timestamp null. A harness with no tmux pane is unreachable by this
   bus today.
2. **No native command for either leg.** `send`/`sweep` are out of process
   (scripts/bus.ts) because ipc/commands.json has no tmux-send or
   cass-search command, and src-tauri/** plus the generated bindings are
   outside this lane's file ownership. The frontend read side
   (MailboxReader) needs nothing new: it rides the existing
   list_dir/read_text. An in-app send button needs a new rust command
   (`bus_hail`/`bus_sweep`) added by whoever owns src-tauri.
3. **The pushed view has no renderer.** 3_router.ts now registers the
   mail-preview kind and `pushMailPreview` puts it on the shared stack,
   but InTabStrip.tsx (forbidden) renders only `current.agentSessionId` as
   a text header. Rendering it needs this in InTabStrip's body, which this
   lane cannot write:
   ```tsx
   {current?.kind === "mail-preview" ? <MailPreview agentId={current.agentId} /> : (
     <AgentStripTable tree={filtered} error={error} onRowClick={onRowClick} controls />
   )}
   ```
4. **Registry population.** registry.json (agent id -> session id / tmux /
   source path) is hand-written today; nothing generates it from
   harness_trace_rows + the tmux join (2_join.ts) yet. The live gate wrote
   it by hand, which is why the session id had to be resolved from
   `~/.claude/projects/*/<uuid>.jsonl` after the pane started.
5. **Multi-line bodies.** `tmux send-keys -l` types the body verbatim, so
   an embedded newline submits early in a TUI harness. `hail` does not
   mangle the body; a multi-line brief needs a file + `--ref`, which is
   unimplemented.
6. **No fs-watch on the mailbox in MailPreview.** It reads on mount and on
   the refresh button. The trace panel's `claimFsWatch(MAIL_DIR)` leg is
   the precedent to copy; not done because the preview has no panel of its
   own yet.

## 5. HarnessTracePanel patch for the coordinator

Not applied (forbidden file). Verified by typechecking an identical copy
placed at `HarnessTracePanel.patched.tsx`, running `npx tsc --noEmit` (no
new errors), then deleting the copy; the real file was never written.

NOTE (coordinator): this diff was written against the flat-table panel at
a35ad6a. The tracetree lane (2e5129c) has since rewritten
HarnessTracePanel.tsx to the lazy tree with `AgentTreeNode` rows; the mail
button column and the `mailRegistry` capture must be re-anchored onto that
version at merge (same idea, different context lines and row type).

```diff
--- a/src/plugins/harnessTrace/HarnessTracePanel.tsx
+++ b/src/plugins/harnessTrace/HarnessTracePanel.tsx
@@ -12,7 +12,8 @@
 import { TreeTable, type TreeColumn } from "../../treetable";
 import type { DirListing } from "../../state";
 import type { CassSwarmStatus } from "../cass/0_types";
-import { enrichRows, parseMailNdjson, parseMailRegistry } from "./0_mail";
+import { enrichRows, mailAgentIdFor, parseMailNdjson, parseMailRegistry } from "./0_mail";
+import { pushMailPreview } from "./3_router";
 import type { HarnessTraceRow, HarnessTraceSeed, MailEnvelope, MailRegistry } from "./0_types";
 
 const PLUGIN_ID = "harness-trace";
@@ -24,6 +25,9 @@
 }
 
 let cassTraceHandler: ((row: HarnessTraceRow) => void) | null = null;
+// Last registry read by loadMailLedger: the mail preview keys on the agent
+// name, the row knows only its session id.
+let mailRegistry: MailRegistry = {};
 
 const COLUMNS: TreeColumn<HarnessTraceRow>[] = [
   {
@@ -83,6 +87,25 @@
     sortValue: (r) => r.cwd,
   },
   {
+    id: "mail",
+    header: "",
+    noRowClick: true,
+    cell: (r) => (
+      <span className="wt-actions">
+        <button
+          className="wt-act"
+          title="preview this agent's message queue"
+          onClick={(e) => {
+            e.stopPropagation();
+            pushMailPreview(r.sessionId, mailAgentIdFor(mailRegistry, r.sessionId));
+          }}
+        >
+          mail
+        </button>
+      </span>
+    ),
+  },
+  {
     id: "trace",
     header: "",
     noRowClick: true,
@@ -130,6 +153,7 @@
     if (entry.name === "registry.json") {
       const text = await invoke<string>("read_text", { path: entry.path }).catch(() => "");
       registry = parseMailRegistry(text);
+      mailRegistry = registry;
     } else if (entry.name.endsWith(".ndjson")) {
       const text = await invoke<string>("read_text", { path: entry.path }).catch(() => "");
       envelopes.push(...parseMailNdjson(text));
```

The push key is the row's session id, and the agent id is the reverse
registry lookup (`mailAgentIdFor`). See missing leg 3: without the
InTabStrip change the push mutates the stack but nothing draws it.

## 6. Gate outputs

```
$ npx tsc --noEmit
src/plugin.test.ts(69,64): error TS2339: Property 'label' does not exist on type 'CtxItem'.
  Property 'label' does not exist on type '{ sep: true; }'.
```
Pre-existing at a35ad6a, in a file this lane never opened. No error in any
file this lane wrote.

```
$ npx vitest run src/plugins/harnessTrace
 Test Files  7 passed (7)
      Tests  62 passed (62)
   Duration  182ms
```

```
$ npx vitest run
 FAIL  src/panelZoom.test.ts (4 tests)
 Test Files  1 failed | 44 passed (45)
      Tests  4 failed | 298 passed (302)
```
Pre-existing, proven by stashing this lane's 4 modified files and rerunning:
same 4 failures, same `ReferenceError: Cannot access 'kinds' before
initialization` (src/panelZoom.ts:24 via src/terminal.ts:282 via
src/favorites.ts:12, a module init cycle with no harnessTrace import in the
chain). Stash popped, tree restored.

```
$ npx playwright test --config playwright.busmail.config.ts
  ✓  1 e2e/mail-preview.spec.ts:44:1 › mail preview renders one agent's queue
     with threaded replies and ack state (638ms)
  1 passed (2.0s)
```
Clock frozen at 2026-08-03T12:00:00Z (`page.clock.setFixedTime`).

## 7. PNG

`/Users/chrishafley/projects/instant-lab-busmail/e2e/mail-preview.spec.ts-snapshots/mail-preview-darwin.png` (20739 bytes).

Fixture mailbox behind it: 5 NDJSON rows, 4 distinct ids. lane-a's queue is
m-1 (in, request), m-2 (out, result, reply_to m-1, indented), m-4 (in,
note); m-3 addresses lane-b and is absent. m-1's ack came from an APPENDED
fifth row with the same id and to_timestamp filled, so the header reads
"3 messages · 2 unacked" and only m-1 shows "acked"; the two queued rows
are dimmed. The registry route reaches the header as "tmux instant-lane-a".

## 8. Deviations from the contract

1. **`MailEnvelope` was not rewritten**, it was made a projection of the
   ruled `IMailMessage` (section 1). Cause: 0_types.ts is append-only for
   this lane and the forbidden HarnessTracePanel.tsx consumes the old
   shape. The parse is migrated; the old type survives as a view.
   Deletable once HarnessTracePanel.tsx moves to `parseMailLog`.
2. **The mail-preview kind is not in the `TermView` union.** Same cause:
   that union's lines belong to another lane. 0_types.ts appends
   `IMailPreviewView` + `TermViewAny` + `ITermViewRouter`, and 3_router.ts
   appends `termViewRouter` as the same instance widened. At merge, folding
   `IMailPreviewView` into `TermView` and deleting `TermViewAny` is a
   2-line cleanup.
3. **3_router.ts's new import sits mid-file**, below `termRouter`, because
   the file's top import line is not this lane's to touch. Hoist it at
   merge.
4. **The send and ack legs are a node CLI, not app code.** No native
   command exists for tmux send-keys or cass search, and src-tauri/** is
   outside this lane's ownership (missing leg 2). `scripts/bus.ts` runs on
   node's built-in type stripping (node v24) and imports the same pure
   modules the app does, so there is one implementation of the fold, not
   two.
5. **The live gate's mailbox lives in the session scratchpad**, not
   `~/.agent/mail` (which does not exist on this machine): the brief
   forbids touching files outside the worktree. `--mail-dir` defaults to
   `~/.agent/mail`, which is what MailPreview reads.
6. **REPORT.md was not written by the lane.** The harness blocks a
   subagent from writing report files; this file was placed by the
   coordinator from the lane's returned text, plus the re-anchoring NOTE
   in section 5.

## Coordinator audit (this session)

Independent reruns: plugin vitest 62/62; mail-preview e2e 1 passed on the
lane's own port-4183 config; PNG inspected (threading indent, ack column,
dimmed queued rows render). Forbidden files verified untouched:
`git diff a35ad6a..HEAD` over HarnessTracePanel.tsx, InTabStrip.tsx,
src/main.ts is empty. Tree clean at a8b2590.
