// Frozen CONTRACT2 state model plus the seam types shared by the two panels of
// the harness-trace plugin (the flat trace panel and the dock strip tree).
export type Harness = "claude" | "opencode" | "codex" | "kimi" | "shell";
export type ParentKind = "subagent" | "dispatch";
export type SessionStatus = "live" | "idle" | "done" | "dead";

// Frozen CONTRACT2 row model: what the dock strip renders as a tree.
// parentId points at the session that caused this one (null = top-level);
// parentKind says how: "subagent" (claude nested store, from rust) or
// "dispatch" (cross-harness, attached on the frontend from the mail ledger).
export interface AgentSessionNode {
  id: string;                 // session id
  harness: Harness;
  parentId: string | null;
  parentKind: ParentKind | null;
  from: string;               // dispatcher agent name ("user" when none)
  why: string;                // envelope body first line ("" when none)
  ts: string;                 // start time, ISO
  lastActivity: string;       // ISO, from session store mtime/db
  status: SessionStatus;
  cwd: string;                // tildified, display-ready
  // The instant tmux session this agent runs in, joined by cwd/chip-path match
  // against the store's tmux rows (null = none; row is dimmed, click is a no-op).
  tmuxSession: string | null;
  // Every tmux session whose join row matched this node's cwd. A repo hosts
  // several tmux sessions sharing one cwd, so the related scope matches on the
  // full list (includes the sid) while display still shows the single tmuxSession.
  // Optional (absent = no matches) so join-free fixtures keep compiling.
  tmuxMatches?: string[];
  // Current token usage stamped by the bus sweep from the session's own
  // harness artifact; absent when the source is unreadable or not yet swept.
  tokens?: MailTokens | null;
}

// The flat trace panel's row: the frozen model plus the display session id
// (the harness-trace panel keys on it; the strip dedupes on AgentSessionNode.id).
export interface HarnessTraceRow {
  id: string; // session id (or dispatch envelope id when known)
  harness: Harness;
  sessionId: string;
  parentId: string | null;
  parentKind: ParentKind | null;
  from: string; // who dispatched it ("user" when unknown)
  why: string; // dispatch reason / brief first line ("" when unknown)
  ts: string;
  lastActivity: string;
  status: SessionStatus;
  cwd: string;
  inputTokens?: number | null;
  // The bus sweep's token stamp for this lane (see MailTokens/AgentSessionNode).
  tokens?: MailTokens | null;
}

// The rust command harness_trace_rows returns HarnessTraceRow minus from/why;
// the mail-ledger join (0_mail.ts) fills those two in. parentId/parentKind ride
// the seam from rust (subagent children); "dispatch" is attached later.
export type HarnessTraceSeed = Omit<HarnessTraceRow, "from" | "why">;

// Parent -> children adjacency over the frozen node set, built once per load.
// The trace panel materializes only the expanded branches from it, so a row's
// children cost nothing until its twisty opens.
export interface IAgentTreeIndex {
  // Nodes with no parent, plus orphans whose parentId is absent from the set.
  roots: AgentSessionNode[];
  // Direct children of a node id; empty array when it has none.
  childrenOf(id: string): AgentSessionNode[];
  // Whether a node has at least one child (drives the twisty before load).
  hasChildren(id: string): boolean;
  // Every node in the index, roots and descendants (for the row count).
  size: number;
}

// One dispatch-bus envelope (~/.agent/mail/*.ndjson). The bus is designed, not
// built yet, so every field is validated on the wire.
export interface MailEnvelope {
  id: string;
  from: string;
  to: string;
  ts: string;
  kind: string;
  reply_to?: string;
  body?: string;
  ref?: string;
}

// registry.json beside the mail files: envelope name -> session id.
export type MailRegistry = Record<string, string>;

// Per-tab internal router view (CONTRACT3). One kind today (agent-session); the
// union exists so more kinds (a file, a diff) can join later with no call-site
// churn.
export type TermView = {
  kind: "agent-session";
  agentSessionId: string;
};

// Per-terminal stack of views. A terminal's in-tab strip pushes when a row is
// clicked and pops on the back button; the top is what the tab is "viewing".
export interface ITermRouter {
  // Push a view onto a terminal's stack.
  push(sid: string, view: TermView): void;
  // Pop the top view off a terminal's stack; null when the stack is empty.
  back(sid: string): TermView | null;
  // The top of a terminal's stack (the view being shown); null when empty.
  current(sid: string): TermView | null;
  // Whether a terminal's stack has anything to pop.
  canGoBack(sid: string): boolean;
  // React subscription: fires after any push/back mutates a stack.
  subscribe(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Message bus (2026-08-03 bus ruling). MailEnvelope above predates it: its
// single `ts` field is read as a from_timestamp fallback for pre-ruling
// fixtures, and 0_mail.ts still projects that shape for the trace panel.
// ---------------------------------------------------------------------------

// The kinds `hail` can mint. The parser accepts any string on the wire, so
// pre-ruling rows ("dispatch") survive a read.
export type MailKind = "request" | "result" | "note";

// One ruled envelope. Wire keys are the ruling's JSON verbatim; the relational
// reading of the same row is messages(id, from_id=from, to_id=to,
// from_timestamp, to_timestamp, kind, reply_to, body, ref).
// to_timestamp null = unacked; it is filled only by a cass hit in the
// recipient's transcript, never by the sender.
export interface IMailMessage {
  id: string;
  from: string;
  to: string;
  from_timestamp: string;
  to_timestamp: string | null;
  kind: string;
  reply_to: string | null;
  body: string;
  ref: string | null;
}

// What `hail` hands the store to mint a row: the clock and the id generator are
// the caller's (edge) business, so the store stays pure and vitest-deterministic.
export interface IMailSend {
  id: string;
  from: string;
  to: string;
  from_timestamp: string;
  kind: MailKind;
  body: string;
  reply_to?: string | null;
  ref?: string | null;
}

// One line of an agent's queue: the message, which way it went for that agent,
// and its indent in the reply_to thread.
export interface IMailQueueRow {
  message: IMailMessage;
  direction: "in" | "out";
  depth: number;
}

// Pure fold surface over the mailbox log. Every method takes the parsed rows;
// file IO (append/read) and cass live at the edges (scripts/bus.ts).
export interface IMailStore {
  // Parse NDJSON; malformed lines and rows without id/to are skipped.
  parse(text: string): IMailMessage[];
  // One NDJSON line, ruled key order, no trailing newline.
  line(message: IMailMessage): string;
  // Append-only fold: latest row per id wins for content, but to_timestamp is
  // monotone (first non-null kept) so an at-least-once resend cannot unack.
  // Result keeps first-appearance order.
  fold(rows: IMailMessage[]): IMailMessage[];
  inbox(rows: IMailMessage[], agentId: string): IMailMessage[];
  outbox(rows: IMailMessage[], agentId: string): IMailMessage[];
  unacked(rows: IMailMessage[]): IMailMessage[];
  // Every message sharing a reply_to root with `id`, oldest first.
  thread(rows: IMailMessage[], id: string): IMailMessage[];
  // Hops from this message up to its reply_to root (0 = a root).
  replyDepth(rows: IMailMessage[], id: string): number;
  // One agent's whole queue, both directions interleaved oldest first: what
  // MailPreview renders, so the view holds no fold of its own.
  queue(rows: IMailMessage[], agentId: string): IMailQueueRow[];
  send(input: IMailSend): IMailMessage;
  ack(message: IMailMessage, toTimestamp: string): IMailMessage;
}

// One routable agent in registry.json beside the mail files: which harness
// session receives its mail (cass ack scope) and which tmux session the send
// leg types into. tmux null = no pane; the message stays queued.
export interface IMailAgent {
  id: string;
  sessionId: string;
  harness: Harness | null;
  tmux: string | null;
  cwd: string | null;
  sourcePath: string | null;
  // The bus sweep's stamp of current input-token usage, with the sweep time.
  tokens?: MailTokens | null;
}

// Token stamp the bus sweep writes into a live route: current input-token
// usage `in` at ISO time `at`. Absent when the host artifact is unreadable.
export interface MailTokens {
  in: number;
  at: string;
}

// registry.json parsed: agent id -> route. The legacy string form
// ("lane-a": "sess-9") reads as a sessionId with no tmux/source path.
export type IMailDirectory = Record<string, IMailAgent>;

export interface IMailDirectoryReader {
  parse(text: string): IMailDirectory;
  agent(directory: IMailDirectory, agentId: string): IMailAgent | null;
}

// One cass search hit, the fields the ack sweep reads.
export interface IMailCassHit {
  source_path: string;
  workspace: string;
  agent: string;
  line_number: number;
}

// Transport arg builders for the two legs, kept pure so the CLI shell is a
// spawn and nothing else.
export interface IMailLeg {
  // argv vectors (after "tmux") that type the body into the agent's pane:
  // a literal write then Enter. null = the agent has no pane.
  tmuxSendArgs(agent: IMailAgent, body: string, socket: string | null): string[][] | null;
  // argv (after "cass") proving the message reached a transcript.
  cassSearchArgs(message: IMailMessage): string[];
  // Hits scoped to this agent's session/source path.
  cassHits(agent: IMailAgent, robotJson: string): IMailCassHit[];
}

// The frontend's read side of the mailbox: list_dir + read_text over the mail
// dir, parsed by MailStore/MailDirectory. Read-only by construction — the send
// and ack legs are out-of-process (scripts/bus.ts).
export interface IMailbox {
  messages: IMailMessage[];
  directory: IMailDirectory;
}

export interface IMailboxReader {
  read(dir: string): Promise<IMailbox>;
}

// A mail-preview view: one agent id's queue. Append-only companion to TermView
// (another lane owns that union's lines); 3_router.ts widens the shared router.
export interface IMailPreviewView {
  kind: "mail-preview";
  agentId: string;
}

export type TermViewAny = TermView | IMailPreviewView;

// The shared router seen through the wider view union.
export interface ITermViewRouter {
  push(sid: string, view: TermViewAny): void;
  back(sid: string): TermViewAny | null;
  current(sid: string): TermViewAny | null;
  canGoBack(sid: string): boolean;
  subscribe(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// In-tab strip policy. state.ts persists TermStripState with the same shape;
// this module-local reading keeps the pure rules free of the store import.
// ---------------------------------------------------------------------------

// A terminal's persisted strip entry. Absent (null) = never toggled on this
// terminal; present = the user summoned or dismissed it explicitly.
// showActive absent = default true (today's going-on view); false = history
// waterfall, and the strip keeps the checkbox state while the entry survives.
export interface ITermStripEntry {
  open: boolean;
  showActive?: boolean;
  network?: boolean;
}

// How wide the strip casts. "related" = trees joined to this terminal's tmux
// session; "all" = every external session, for when the cwd join misses the
// lane the user is looking for.
export type StripScope = "related" | "all";

export interface IStripPolicy {
  // The entry a toggle press writes. Absent means the strip is not on screen,
  // so the first press summons instead of closing.
  toggle(entry: ITermStripEntry | null): ITermStripEntry;
  // The tmux session name behind a terminal id. Terminal ids carry the "s:"
  // tab prefix (core.ts sessionId) while every join row and node holds the
  // raw tmux name; comparing across that unit mismatch matches nothing.
  tmuxNameOf(sid: string): string;
  // Whether the strip's shell renders. An explicit open entry always renders
  // (zero rows shows the empty state); an absent entry auto-appears only when
  // there is something to show.
  visible(entry: ITermStripEntry | null, rowCount: number, hasCurrent: boolean): boolean;
  // The sessions claude code's own agent list already shows at the bottom of
  // this tab: the claude session joined to this terminal plus its claude-native
  // subagent descendants. The strip must not duplicate them.
  nativeIds(nodes: AgentSessionNode[], sid: string, nativeSessionId?: string | null): Set<string>;
  // The strip's row set: everything in scope minus nativeIds. Dropping a native
  // parent promotes its external children to roots (indexAgentTree's orphan
  // law), which is how a dispatched lane surfaces as a top-level shell.
  external(
    nodes: AgentSessionNode[],
    sid: string,
    scope: StripScope,
    nativeSessionId?: string | null,
  ): AgentSessionNode[];
  // The checkbox write: flip the strip between today's going-on table and the
  // history waterfall, keeping whatever open state the entry holds (an absent
  // entry that is on screen by auto-appear stays open).
  setActivation(entry: ITermStripEntry | null, showActive: boolean): ITermStripEntry;
  // "open" only when the row's tmux is in the live list: opening a dead lane
  // would mint an empty shell under its name (tmux new-session -A).
  openAction(row: { tmuxSession: string | null }, liveTmux: Set<string>): "open" | "ignore";
  // The scope the strip renders. An explicit choice wins; untouched (null),
  // a "related" that matches nothing widens to "all" (m-36e96eb8).
  effectiveScope(
    nodes: AgentSessionNode[],
    sid: string,
    chosen: StripScope | null,
    nativeSessionId?: string | null,
  ): StripScope;
  // History mode's node set: external's scope + native subtraction, keeping
  // done/dead and subagent threads (the waterfall draws history).
  history(
    nodes: AgentSessionNode[],
    sid: string,
    scope: StripScope,
    nativeSessionId?: string | null,
  ): AgentSessionNode[];
}

// ---------------------------------------------------------------------------
// Viewer tabs. A strip row click opens someone else's lane in a tab to WATCH
// it; that tab's close must not end the lane the way closing your own agent
// tab does.
// ---------------------------------------------------------------------------

// "detach" = drop the pty, the tmux session keeps running. "kill" = end the
// tmux session (what an agent tab does, so claude/opencode stops burning RAM).
export type TabCloseAction = "detach" | "kill";

export interface IViewerTabPolicy {
  // viewer = this tab was opened by a strip/panel row, not launched by the
  // user here. agent = an agent process is running in it (terminal.ts's probe).
  closeAction(tab: { viewer: boolean; agent: boolean }): TabCloseAction;
}

// ---------------------------------------------------------------------------
// Live-spawn gate (scripts/livespawn.ts): a wall-clock run in which one claude
// session spawns an opencode one, sampled every few seconds. On demand only —
// never a default battery (10-second law, user-named exception).
// ---------------------------------------------------------------------------

// One poll instant. `rows` is what the harness stores held when the driver read
// them (the harness_trace_rows seam's shape, scoped to the gate cwd); `files`
// is the mail dir verbatim, entry name -> bytes, so a replay of a sample feeds
// the page exactly what was on disk. Every field is recorded, never derived at
// assert time: the gate reasons about the run after it ends.
export interface ILiveSample {
  index: number;
  at: string;
  atMs: number;
  rows: HarnessTraceSeed[];
  files: Record<string, string>;
  png: string;
}

// One sample projected into the e2e native-invoke table
// (__instantE2eNativeResults). Serializable end to end: list_dir/read_text are
// rebuilt inside the page from `files`, since a function cannot cross
// addInitScript.
export interface ILivePageSeed {
  mailDir: string;
  rows: HarnessTraceSeed[];
  files: Record<string, string>;
}

// The structural reading of one sample: session identity, link kind, status
// bucket and ack counts. Prompt and body text are deliberately absent — the
// gate asserts on structure and transitions, never on prompt equality.
export interface ILiveSampleState {
  at: string;
  parentId: string | null;
  parentStatus: SessionStatus | null;
  parentFrom: string | null;
  childId: string | null;
  childStatus: SessionStatus | null;
  childParentId: string | null;
  childParentKind: ParentKind | null;
  rootCount: number;
  sessionCount: number;
  acked: number;
  unacked: number;
}

// The pure half of the driver: a leaf (type-only imports) so scripts run it
// under node's type stripping without an extensionless-import resolution.
export interface ILiveGate {
  // Same buckets as the rust reader (src-tauri/src/harness.rs trace_status):
  // a vanished cwd is dead, else live <= 2m, idle <= 1h, done beyond.
  status(cwdExists: boolean, lastMs: number, nowMs: number): SessionStatus;
  // Unix ms -> ISO-8601 UTC; 0 (unknown mtime) is the empty string, as rust's
  // ms_to_iso returns.
  iso(ms: number): string;
  seed(sample: ILiveSample): ILivePageSeed;
  // Has the session finished its turn and gone back to waiting on a human? True
  // when the last conversational record of a claude jsonl is an assistant
  // message carrying no tool_use block. A pending tool call never reads as
  // finished, which is what separates "it refused and is asking" from "the
  // command it was given is still running".
  turnEnded(transcript: string): boolean;
}

// Replays one sample through the panel's own join + tree so the assertions
// compare what the page would draw, not a second model of it.
export interface ILiveState {
  read(sample: ILiveSample): ILiveSampleState;
}

// ---------------------------------------------------------------------------
// Session waterfall (history mode). The strip's "Show active" checkbox flips
// today's going-on table to a devtools-network-style waterfall: a brush
// overview on top, one bar per session below with a tick per message, and the
// table constrained to the brushed range. All times are unix ms.
// ---------------------------------------------------------------------------

// One session's bar in the waterfall: start -> last activity (or now for live).
export interface ISessionSpan {
  id: string; // session id (== AgentSessionNode.id)
  harness: Harness;
  start: number; // unix ms
  end: number; // unix ms (lastActivity; now for live/dead-present)
}

// One message/event tick on a session's bar, colored/shaped by type.
export type TickType = "user" | "assistant" | "tool" | "reasoning" | "dispatch";

export interface ISessionTick {
  sessionId: string;
  ts: number; // unix ms
  type: TickType;
  preview: string; // short text for the title tooltip
}

// The brush window. Both unix ms. start <= end. A range is always within the
// overview domain; the table keeps only sessions whose span intersects it.
export interface IWaterfallRange {
  start: number;
  end: number;
}

// The full domain the overview strip spans (min session start .. max activity
// or now), padded so the brush has breathing room.
export interface IWaterfallDomain {
  start: number;
  end: number;
}

// The lazy per-session message tick cache the waterfall reads: filled on first
// range intersection, never all history up front.
export type IWaterfallEvents = ReadonlyMap<string, ISessionTick[]>;

// One column of the overview's density strip. The overview draws a fixed number
// of these instead of one rect per session, so its node count is set by the bin
// count and never by how much history exists.
export interface IWaterfallBin {
  start: number; // unix ms, left edge
  end: number;   // unix ms, right edge
  count: number; // sessions whose span overlaps [start,end]
}
