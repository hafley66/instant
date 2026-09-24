// The strip's feed. The pane the server already streams decides when, the
// server computes, the socket carries: nothing here is asked for on scroll and
// nothing is asked for per square.
//
//   pty output  ->  one dirty bit  ->  capture-pane -p  ->  boop-turnvis
//               ->  boop-turnstrip (rows, placement, geometry)
//               ->  one tags_for_many  ->  host.emit("squares-update")
//
// The frame lands on the events channel every other push uses, so the client
// side is `listenNativeEvent("squares-update")` and nothing new (see
// src/1_agentSquaresFeed.ts). One reconcile in flight, one dirty bit: a pane
// that writes faster than a projection is worth still costs one capture per
// FLUSH_INTERVAL, and a quiet pane costs none.
//
// The viewport is not a client fact. Scrolling parks the pane in tmux copy-mode
// (`pty::scroll_session`), so the window is the capture's tail shifted by
// `#{scroll_position}` inside `#{pane_height}` rows — read here, pushed with
// everything else, which is why a client that only draws asks for nothing.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, LazyLock, Mutex};
#[path = "0a_squaresTiming.rs"]
mod timing;
use std::time::{Duration, Instant};

use boop_store::ident::Store;
use boop_turnstrip::{
    drawn_at_all, kind_of, Layout, ListedTurn, Mode, Options, TurnKind, TurnRow, Viewport,
};
use boop_harness::harness::claude_summary::locate_visible_turns;
use serde::{Deserialize, Serialize};

use crate::boop::{
    from_visible, input_region, now_ms, open_store_ro, to_turnvis, turns_from, BoopTurn, LocatedTurn,
};
use crate::boop_tmux::{pane_window, tmux_command, PaneWindow};
use crate::host::Host;

/// The event the strip listens on.
pub const SQUARES_EVENT: &str = "squares-update";
/// History one capture asks tmux for, least. A scrolled pane reads deeper — see
/// `capture_depth` — because the reader's window is the capture's tail shifted
/// up by the scroll: a fixed depth would pin the window to the capture's top and
/// leave the strip behind on a long scroll.
const CAPTURE_LINES: u32 = 400;

/// How deep one capture reads: the short history for a live pane, and the
/// reader's own scroll plus a pane's rows for a scrolled one.
fn capture_depth(window: Option<&PaneWindow>) -> u32 {
    let Some(window) = window else {
        return CAPTURE_LINES;
    };
    let wanted = window.scroll.saturating_add(window.height);
    CAPTURE_LINES.max(u32::try_from(wanted).unwrap_or(u32::MAX))
}
/// One reconcile per window at most. The pane can outrun a projection, and a
/// projection is not cheap: each one spawns `tmux capture-pane` (~30ms measured
/// on this machine), reads the session's window out of the store and matches it
/// against the pane, so the interval is what a reader pays while a pane writes.
/// A quarter second is under the eye's threshold for a square that moves with a
/// 260ms transition (`--asq-move`), and it halves the work of the 120ms this
/// started at. The loop's own rate is reported once a second — see [`FeedStat`].
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// Idle wait between polls of the dirty bit. A timeout is not a flush.
const IDLE_WAIT: Duration = Duration::from_millis(1000);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquaresWatchArgs {
    /// The pane's own id: the key the pty stream wakes the feed on, so the
    /// writer never has to know a boop session.
    pub pty: String,
    pub session: String,
    pub target: String,
    #[serde(default)]
    pub socket: Option<String>,
    /// What the reader asked the strip to draw. Every field is optional and
    /// falls back to the crate's measured default, so a client that sends
    /// nothing gets the same strip as before the modes existed.
    #[serde(default)]
    pub options: SquaresOptions,
}

/// The reader's own choices, as the client spells them. The crate's `Options`
/// carries more than a client should have to send (the flex, the gap, the
/// budget), so only the three a reader can actually change cross the wire.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquaresOptions {
    #[serde(default)]
    pub mode: Option<Mode>,
    #[serde(default)]
    pub user_keep: Option<usize>,
}

impl SquaresOptions {
    /// The crate's options with the reader's choices laid over the defaults.
    pub fn merged(self) -> Options {
        let defaults = Options::default();
        Options {
            mode: self.mode.unwrap_or(defaults.mode),
            user_keep: self.user_keep.unwrap_or(defaults.user_keep),
            ..defaults
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquaresUnwatchArgs {
    pub pty: String,
}

/// One push: every turn the pane holds with the matcher's spans, the tags the
/// visible turns carry, and the strip's own geometry. `at` is the projection's
/// own stamp, so a client can drop a frame that arrived out of order.
///
/// The layout rides the frame because the viewport is already a fact this side
/// holds: the window is the last `#{pane_height}` rows of the capture
/// (`boop_tmux::pane_height`), since a scrolled pane is a tmux copy-mode view
/// rather than xterm scrollback. A client that only draws asks for nothing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Strip {
    pub session: String,
    pub at: i64,
    pub rows: usize,
    pub turns: Vec<LocatedTurn>,
    /// The reader's own turns the window does not hold — the prompts above the
    /// capture. They carry no rows (nothing matched them) and they are what the
    /// strip's band draws, so a reader can always see their own last prompts.
    pub pinned: Vec<LocatedTurn>,
    pub tags: BTreeMap<String, Vec<String>>,
    /// `None` only when the pane's height could not be read, so the client can
    /// tell "no strip" from "an empty strip".
    pub layout: Option<Layout>,
}

/// The pane's own physical rows, without `-J`: a wrapped line stays one entry
/// per screen row, so an entry's index is the row the pane draws it on and the
/// strip's squares line up with the pane's rows (bb6c4ed3).
pub fn capture_lines(target: &str, socket: Option<&str>, depth: u32) -> Result<Vec<String>, String> {
    let output = tmux_command(socket)
        .args(capture_args(target, depth))
        .run()
        .map_err(|error| format!("capture {target}: {error}"))?;
    if !output.status.success() {
        let why = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(format!("capture {target}: {why}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_owned)
        .collect())
}

fn capture_args(target: &str, depth: u32) -> [String; 6] {
    [
        "capture-pane".into(),
        "-p".into(),
        "-S".into(),
        format!("-{depth}"),
        "-t".into(),
        target.into(),
    ]
}

/// The projection itself: rows in, spans, marks and the strip's geometry out.
/// Pure, so the test pins it without tmux and the watcher only supplies what it
/// read. `window` is the only thing the caller reads outside the capture; with
/// `None` the frame carries spans and marks but no layout.
pub fn project_rows(
    session: &str,
    rows: &[String],
    turns: Vec<BoopTurn>,
    tags: BTreeMap<String, Vec<String>>,
    window: Option<PaneWindow>,
    options: &Options,
) -> Strip {
    let harness = turns
        .iter()
        .max_by_key(|turn| turn.ts)
        .map(|turn| turn.harness.as_str());
    let composer = input_region(rows, harness);
    let skip = composer.map(|region| (region.start, region.end));
    let lines: Vec<boop_turnvis::LogicalLine> = rows
        .iter()
        .enumerate()
        .filter(|(index, _)| match skip {
            Some((from, through)) => *index < from || *index > through,
            None => true,
        })
        .map(|(index, text)| boop_turnvis::LogicalLine {
            text: text.clone(),
            start: index,
            end: index,
        })
        .collect();
    let located = locate_visible_turns(&lines, &turns.iter().cloned().map(to_turnvis).collect::<Vec<_>>());
    let pins = pinned_of(&turns, options);
    let pin_ids: Vec<String> = pins.iter().map(|turn| turn_id(turn)).collect();
    let listed = listed_of(&turns);
    let layout = window.and_then(|window| {
        window_layout(&lines, &located, &pin_ids, &listed, rows.len(), window, options)
    });
    // Only the pins the strip actually drew are worth carrying: the crate drops
    // a pin the mode placed a square for, and a frame that shipped the rest
    // would ask the client to look up turns nothing draws.
    let band: HashSet<&str> = match &layout {
        Some(layout) => layout.squares()[..layout.band()]
            .iter()
            .map(|square| square.id.as_str())
            .collect(),
        None => HashSet::new(),
    };
    let pinned: Vec<LocatedTurn> = pins
        .iter()
        .filter(|turn| band.contains(turn_id(turn).as_str()))
        .map(|turn| pinned_turn(turn))
        .collect();
    let mut shipped: Vec<LocatedTurn> = located.into_iter().map(from_visible).collect();
    // The recency list draws turns the window lost, so the frame carries them:
    // a square whose turn the frame does not hold has nothing to show on hover,
    // and the client drops a placed turn it cannot name. Relative mode reads the
    // window alone, so its frame is already exactly the turns it placed — and a
    // band square belongs to `pinned`, not here.
    if options.mode == Mode::Recent {
        if let Some(layout) = &layout {
            let carried: HashSet<String> = shipped.iter().map(|turn| turn.id.clone()).collect();
            for turn in &turns {
                let id = turn_id(turn);
                let placed = layout.squares().iter().any(|square| square.id == id);
                if placed && !carried.contains(&id) {
                    shipped.push(listed_turn(turn));
                }
            }
        }
    }
    Strip {
        session: session.to_owned(),
        at: now_ms() as i64,
        rows: rows.len(),
        turns: shipped,
        pinned,
        tags,
        layout,
    }
}

/// The id every turn read is addressed by: the matcher's own spelling, so a pin
/// and a located turn are the same key to the client.
fn turn_id(turn: &BoopTurn) -> String {
    format!("{}:{}", turn.session, turn.turn)
}

/// The reader's own turns, newest `user_keep` of them, oldest first. Whether
/// the mode places a square for one is not this function's business: a prompt
/// the matcher found above the window and a prompt the capture never held are
/// both turns the reader wants back, and the crate drops the ones it drew.
///
/// The store hands the turns back in transcript order, but the band's end is
/// what a reader wants kept when it is too short, so the order is stated here
/// rather than assumed.
fn pinned_of<'a>(turns: &'a [BoopTurn], options: &Options) -> Vec<&'a BoopTurn> {
    if options.user_keep == 0 {
        return Vec::new();
    }
    let mut kept: Vec<&BoopTurn> = turns
        .iter()
        .filter(|turn| kind_of(&turn.role) == TurnKind::User)
        .collect();
    kept.sort_by_key(|turn| (turn.ts, turn.turn));
    if kept.len() > options.user_keep {
        kept.drain(..kept.len() - options.user_keep);
    }
    kept
}

/// How deep the recency list reads into the store. The list drops the oldest
/// turns it cannot show anyway, so the pool only has to be deeper than any
/// block; the conversation kinds are filtered out of it first, so a long stretch
/// of tool turns costs the reader nothing.
const RECENT_POOL: usize = 200;

/// The session's own turns as the recency list needs them: the newest
/// `RECENT_POOL` of the conversation kinds, oldest first, each named by the
/// matcher's own key. Read from the store rather than from the pane, because a
/// turn the window lost is a member of the list like any other.
fn listed_of(turns: &[BoopTurn]) -> Vec<ListedTurn> {
    let mut drawn: Vec<&BoopTurn> = turns
        .iter()
        .filter(|turn| drawn_at_all(kind_of(&turn.role)))
        .collect();
    drawn.sort_by_key(|turn| (turn.ts, turn.turn));
    if drawn.len() > RECENT_POOL {
        drawn.drain(..drawn.len() - RECENT_POOL);
    }
    drawn
        .into_iter()
        .map(|turn| ListedTurn {
            id: turn_id(turn),
            kind: kind_of(&turn.role),
        })
        .collect()
}

/// A pinned turn as the frame carries it. It has no rows: the matcher did not
/// find it on the pane at all, so its span is the zero it never had, and the
/// confidence says so rather than claiming an anchor it does not have.
fn pinned_turn(turn: &BoopTurn) -> LocatedTurn {
    LocatedTurn {
        session: turn.session.clone(),
        harness: turn.harness.clone(),
        turn: turn.turn,
        ts: turn.ts,
        role: turn.role.clone(),
        said: turn.said.clone(),
        id: turn_id(turn),
        buffer_start: 0,
        buffer_end: 0,
        anchor_start: 0,
        anchor_end: 0,
        confidence: "pinned",
    }
}

/// A turn the recency list placed but the matcher never saw: the list is the
/// session's own history, so a turn scrolled out of the capture — or one the
/// pane never drew — is a member like any other. Same zeros as a pin, and its
/// own confidence, because the client draws its row from neither.
fn listed_turn(turn: &BoopTurn) -> LocatedTurn {
    LocatedTurn {
        confidence: "listed",
        ..pinned_turn(turn)
    }
}
/// The strip's geometry for the window a client is looking at.
///
/// The capture's tail holds the pane's live rows, and a scrolled pane is a
/// copy-mode view of the same rows shifted up by `window.scroll`, so the window
/// is `[rows - height - scroll, rows - 1 - scroll]` and the reader's top row is
/// its first row. Everything the estimator needs is the capture plus those two
/// numbers, which is why the client sends nothing.
fn window_layout(
    lines: &[boop_turnvis::LogicalLine],
    located: &[boop_turnvis::VisibleTurn],
    pins: &[String],
    listed: &[ListedTurn],
    rows: usize,
    window: PaneWindow,
    options: &Options,
) -> Option<Layout> {
    let height = window.height.min(rows);
    if height == 0 {
        return None;
    }
    let scroll = window.scroll.min(rows - height);
    let bottom = (rows - 1 - scroll) as i64;
    let viewport = Viewport {
        top: bottom - height as i64 + 1,
        bottom,
    };
    let turn_rows: Vec<TurnRow> = located
        .iter()
        .map(|turn| boop_turnstrip::rows_of(lines, turn, viewport))
        .collect();
    Some(boop_turnstrip::layout_pinned(
        &turn_rows,
        pins,
        listed,
        viewport,
        viewport.top,
        options,
    ))
}

/// One source per pushed turn, so the marks ride on the same frame.
pub fn sources_of(turns: &[LocatedTurn]) -> Vec<String> {
    turns
        .iter()
        .map(|turn| format!("turn:{}:{}", turn.session, turn.turn))
        .collect()
}

/// The store's own answer to when this session's conversation was last dropped,
/// in the same milliseconds a turn carries. `None` when the harness never wrote
/// one. Read through a handle the caller already holds, for the same reason the
/// turns are.
fn reset_from(store: &Store, session: &str) -> Result<Option<i64>, String> {
    Ok(store
        .session_attr(session, boop_store::RESET_ATTR_KEY)
        .map_err(|error| error.to_string())?
        .and_then(|value| value.parse::<i64>().ok()))
}

/// The turns of the conversation the reader is in: everything after the newest
/// boundary, when the harness wrote one. A harness can drop a conversation in
/// place — omp's `/clear` keeps the session, its file and its turns — and the
/// store keeps both sides as history, so the boundary is what separates the
/// conversation from what came before it. A turn stamped exactly at the boundary
/// belongs to the dropped side: the boundary precedes the next turn.
fn current_conversation(turns: Vec<BoopTurn>, boundary: Option<i64>) -> Vec<BoopTurn> {
    match boundary {
        Some(boundary) => turns.into_iter().filter(|turn| turn.ts > boundary).collect(),
        None => turns,
    }
}

/// Read the pane and the store, once, and build the frame the socket carries.
pub fn project(
    session: &str,
    target: &str,
    socket: Option<&str>,
    options: &Options,
) -> Result<Strip, String> {
    project_timed(session, target, socket, options).map(|(strip, _)| strip)
}

fn project_timed(session: &str, target: &str, socket: Option<&str>, options: &Options)
    -> Result<(Strip, timing::ProjectionTiming), String> {
    let mut clock = Instant::now();
    let mut timing = timing::ProjectionTiming::default();
    // The window is read first: it decides how deep the capture has to go. A
    // pane that predates this process's tmux still captures; only the window
    // read can come back empty, and then the frame carries spans without a
    // layout rather than no frame at all.
    let window = pane_window(target, socket).ok();
    timing.window_ms = timing::elapsed_ms(&mut clock);
    let rows = capture_lines(target, socket, capture_depth(window.as_ref()))?;
    timing.capture_ms = timing::elapsed_ms(&mut clock);
    let store = open_store_ro()?;
    timing.store_ms = timing::elapsed_ms(&mut clock);
    let turns = current_conversation(turns_from(&store, session)?, reset_from(&store, session)?);
    timing.turns_ms = timing::elapsed_ms(&mut clock);
    let strip = project_rows(session, &rows, turns, BTreeMap::new(), window, options);
    timing.match_ms = timing::elapsed_ms(&mut clock);
    // The band's turns carry marks too: a pinned prompt is exactly the square a
    // reader hovers to see what they asked, so its tags ride the same read.
    let mut sources = sources_of(&strip.turns);
    sources.extend(sources_of(&strip.pinned));
    let tags = store
        .tags_for_many(&sources)
        .map_err(|error| error.to_string())?;
    timing.tags_ms = timing::elapsed_ms(&mut clock);
    Ok((Strip { tags, ..strip }, timing))
}

/// Push one frame. The same call serves the Tauri window and the serve binary:
/// `Host::emit` is the only difference between them.
pub fn publish(host: &Arc<dyn Host>, strip: &Strip) -> Result<(), String> {
    host.emit(
        SQUARES_EVENT,
        serde_json::to_value(strip).map_err(|error| error.to_string())?,
    )
}

/// One watcher's wake-up: the session it projects and its dirty bit. The
/// session is what a store write names, so an ingest can wake the strip of a
/// pane that has stopped writing.
struct Feed {
    session: String,
    dirty: SyncSender<()>,
}

type Feeds = Mutex<HashMap<String, Feed>>;

/// One registry per process: registering a feed twice replaces it, and the
/// dropped sender stops the older thread.
static FEEDS: LazyLock<Feeds> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Start watching a pane for one session. Registering twice replaces the feed,
/// which drops the older sender and stops its thread.
pub fn squares_watch_impl(host: Arc<dyn Host>, args: SquaresWatchArgs) -> Result<(), String> {
    let (dirty, listener) = mpsc::sync_channel::<()>(1);
    FEEDS
        .lock()
        .map_err(|_| "squares feed lock poisoned".to_string())?
        .insert(
            args.pty.clone(),
            Feed {
                session: args.session.clone(),
                dirty,
            },
        );
    std::thread::spawn(move || run(host, args, listener));
    Ok(())
}

pub fn squares_unwatch_impl(pty: &str) -> Result<(), String> {
    FEEDS
        .lock()
        .map_err(|_| "squares feed lock poisoned".to_string())?
        .remove(pty);
    Ok(())
}

/// The pane wrote something. One bit, never a queue, and no read here: the
/// writer's thread must not wait on a capture.
pub fn note_output(pty: &str) {
    let Ok(feeds) = FEEDS.lock() else {
        return;
    };
    if let Some(feed) = feeds.get(pty) {
        let _ = feed.dirty.try_send(());
    }
}

/// The store gained or lost turns for `session`. A projection reads the
/// store fresh, so the same dirty bit a write sets is the whole signal; a
/// quiet pane whose transcript landed after its last write re-projects once.
pub fn note_session(session: &str) {
    let Ok(feeds) = FEEDS.lock() else {
        return;
    };
    for feed in feeds.values().filter(|feed| feed.session == session) {
        let _ = feed.dirty.try_send(());
    }
}

/// What one watcher's loop has done in the last second. The strip is a poll, so
/// its cost is how often it runs — the rate a slow terminal has to be read
/// against, and the number nothing else in the app reports. Counted here and
/// logged once a second by [`FeedStat::report`].
#[derive(Default)]
struct FeedStat {
    flushes: u64,
    pushed: u64,
    unchanged: u64,
    failed: u64,
    project_ms: u64,
    worst_ms: u64,
    rows: u64,
    turns: u64,
    text_bytes: u64,
    since: Option<Instant>,
}

impl FeedStat {
    /// One line a second: how many projections the loop ran, how many of them
    /// were worth sending, how long each took, and how much turn text they read.
    /// The pane is named, because the number that matters is per pane: a reader
    /// with several terminals open pays this once for each.
    fn report(&mut self, pty: &str, session: &str) {
        let now = Instant::now();
        let elapsed = match self.since {
            Some(at) => at.elapsed().as_secs_f64(),
            None => 0.0,
        };
        if elapsed < 1.0 {
            return;
        }
        self.since = Some(now);
        let flushes = std::mem::take(&mut self.flushes);
        if flushes == 0 && self.pushed == 0 {
            return;
        }
        tracing::info!(
            pty,
            session,
            seconds = (elapsed * 100.0).round() / 100.0,
            flushes,
            per_second = ((flushes as f64 / elapsed) * 10.0).round() / 10.0,
            pushed = std::mem::take(&mut self.pushed),
            unchanged = std::mem::take(&mut self.unchanged),
            failed = std::mem::take(&mut self.failed),
            project_ms = std::mem::take(&mut self.project_ms),
            worst_ms = std::mem::take(&mut self.worst_ms),
            rows = std::mem::take(&mut self.rows),
            turns = std::mem::take(&mut self.turns),
            text_bytes = std::mem::take(&mut self.text_bytes),
            "squares_feed"
        );
    }
}

/// What the client draws from one frame, as one string: the fields a square is
/// placed, sized and labelled by, the tags it wears, and the *length* of each
/// turn's text rather than the text itself. Hashing the whole payload would cost
/// as much as sending it — a session's window is hundreds of turns of prose —
/// and a streaming turn's text only grows, so its length already changes on
/// every frame its content does.
fn frame_fingerprint(strip: &Strip) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str(&strip.session);
    out.push_str(&format!("|rows={}|", strip.rows));
    if let Some(layout) = &strip.layout {
        out.push_str(&serde_json::to_string(layout).unwrap_or_default());
    }
    out.push('|');
    for turn in strip.turns.iter().chain(strip.pinned.iter()) {
        out.push_str(&format!(
            "{}:{}:{}:{}:{}:{}:{}:{};",
            turn.id,
            turn.role,
            turn.ts,
            turn.said.len(),
            turn.buffer_start,
            turn.anchor_start,
            turn.anchor_end,
            turn.confidence,
        ));
    }
    out.push('|');
    for (source, tags) in &strip.tags {
        out.push_str(source);
        out.push('=');
        out.push_str(&tags.join(","));
        out.push(';');
    }
    out
}

fn run(host: Arc<dyn Host>, args: SquaresWatchArgs, listener: Receiver<()>) {
    // The first projection does not wait for a write. A pane that is already
    // idle when its strip attaches — a finished turn, a viewer onto a quiet
    // session — would otherwise show nothing until it next wrote, which on a
    // settled pane is never.
    let options = args.options.merged();
    tracing::info!(
        pty = args.pty,
        session = args.session,
        target = args.target,
        mode = format!("{:?}", options.mode).to_lowercase(),
        "squares_feed_started"
    );
    let mut stat = FeedStat {
        since: Some(Instant::now()),
        ..FeedStat::default()
    };
    let mut wait_for_a_write = false;
    // The last frame's fingerprint: a projection identical to it is not sent, so
    // a pane that redraws without moving a square costs the client nothing.
    let mut last: Option<String> = None;
    loop {
        if wait_for_a_write {
            match listener.recv_timeout(IDLE_WAIT) {
                Ok(()) => {}
                // A quiet pane projects nothing: only a write wakes this.
                Err(RecvTimeoutError::Timeout) => {
                    stat.report(&args.pty, &args.session);
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        wait_for_a_write = true;
        let started = Instant::now();
        match project_timed(&args.session, &args.target, args.socket.as_deref(), &options) {
            Ok((strip, timing)) => {
                if std::env::var_os("INSTANT_SQUARES_PROFILE").is_some() {
                    tracing::info!(
                        session = args.session,
                        rows = strip.rows,
                        stages = %serde_json::json!(timing),
                        "squares_projection"
                    );
                }
                stat.rows += strip.rows as u64;
                stat.turns += (strip.turns.len() + strip.pinned.len()) as u64;
                stat.text_bytes += strip
                    .turns
                    .iter()
                    .chain(strip.pinned.iter())
                    .map(|turn| turn.said.len() as u64)
                    .sum::<u64>();
                let fingerprint = frame_fingerprint(&strip);
                if last.as_deref() == Some(fingerprint.as_str()) {
                    stat.unchanged += 1;
                } else {
                    last = Some(fingerprint);
                    stat.pushed += 1;
                    if let Err(why) = publish(&host, &strip) {
                        stat.failed += 1;
                        eprintln!("squares feed for {}: {why}", args.session);
                    }
                }
            }
            Err(why) => {
                stat.failed += 1;
                eprintln!("squares feed for {}: {why}", args.session);
            }
        }
        let spent = started.elapsed();
        stat.flushes += 1;
        stat.project_ms += spent.as_millis() as u64;
        stat.worst_ms = stat.worst_ms.max(spent.as_millis() as u64);
        stat.report(&args.pty, &args.session);
        if spent < FLUSH_INTERVAL {
            std::thread::sleep(FLUSH_INTERVAL - spent);
            // Everything that landed during the flush is one more projection,
            // not one per write.
            while listener.try_recv().is_ok() {
                wait_for_a_write = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// bb6c4ed3 dropped `-J` so a capture entry is one physical pane row; a
    /// joined capture would shift every square below a wrapped line.
    #[test]
    fn capture_reads_physical_rows_without_joining_wraps() {
        assert_eq!(
            capture_args("instant:1.0", 120),
            ["capture-pane", "-p", "-S", "-120", "-t", "instant:1.0"].map(String::from),
        );
    }

    /// An ingest names a session, not a pty: every feed projecting that
    /// session gets one dirty bit, and a feed for another session gets none.
    #[test]
    fn a_session_ingest_wakes_only_that_sessions_feeds() {
        let (a_dirty, a_listener) = mpsc::sync_channel::<()>(1);
        let (b_dirty, b_listener) = mpsc::sync_channel::<()>(1);
        {
            let mut feeds = FEEDS.lock().unwrap();
            feeds.insert("test-wake-a".into(), Feed { session: "wake-session-a".into(), dirty: a_dirty });
            feeds.insert("test-wake-b".into(), Feed { session: "wake-session-b".into(), dirty: b_dirty });
        }
        note_session("wake-session-a");
        note_session("wake-session-a");
        let woke = (
            a_listener.try_recv().is_ok(),
            a_listener.try_recv().is_ok(),
            b_listener.try_recv().is_ok(),
        );
        {
            let mut feeds = FEEDS.lock().unwrap();
            feeds.remove("test-wake-a");
            feeds.remove("test-wake-b");
        }
        assert_eq!(woke, (true, false, false));
    }

    fn turn(session: &str, index: i64, role: &str, said: &str) -> BoopTurn {
        BoopTurn {
            session: session.to_owned(),
            harness: "claude".to_owned(),
            turn: index,
            ts: 1_700_000_000_000 + index,
            role: role.to_owned(),
            said: said.to_owned(),
            session_scope: "root".to_owned(),
            parent_session: None,
        }
    }

    /// A live pane reads the short history; a scrolled one reads deep enough to
    /// hold the reader's window, since the window is the capture's tail shifted
    /// up by the scroll.
    #[test]
    fn a_scrolled_pane_reads_as_deep_as_the_reader_scrolled() {
        assert_eq!(capture_depth(None), CAPTURE_LINES);
        assert_eq!(
            capture_depth(Some(&PaneWindow { height: 39, scroll: 0 })),
            CAPTURE_LINES
        );
        assert_eq!(
            capture_depth(Some(&PaneWindow { height: 39, scroll: 900 })),
            939
        );
    }

    /// The frame a client draws from: the pane's own rows in, spans and marks
    /// out, with the source spelled the way every other tag read spells it.
    #[test]
    fn a_capture_becomes_spans_and_marks_in_one_frame() {
        let rows: Vec<String> = [
            "❯ add the batch verb",
            "",
            "⏺ Reading the store",
            "",
            "  crates/boop-store/src/tags.rs",
        ]
        .iter()
        .map(|row| (*row).to_owned())
        .collect();
        let turns = vec![
            turn("s1", 1, "user", "add the batch verb"),
            turn("s1", 2, "assistant", "Reading the store"),
        ];
        let tags = BTreeMap::from([("turn:s1:2".to_owned(), vec!["rust".to_owned()])]);

        let strip = project_rows(
            "s1",
            &rows,
            turns,
            tags.clone(),
            Some(PaneWindow { height: 3, scroll: 0 }),
            &Options::default(),
        );

        assert_eq!(strip.session, "s1");
        assert_eq!(strip.rows, 5);
        assert_eq!(strip.tags, tags, "the marks ride on the same frame");
        assert_eq!(sources_of(&strip.turns), ["turn:s1:1", "turn:s1:2"]);
        for found in &strip.turns {
            assert!(
                found.buffer_start < strip.rows && found.buffer_end < strip.rows,
                "a span must stay inside the capture: {found:?}"
            );
            assert!(found.buffer_start <= found.buffer_end);
        }
        let layout = strip.layout.expect("a pane height in means a layout out");
        assert_eq!(
            layout.squares().iter().filter(|square| square.active).count(),
            1,
            "exactly one square is the one being read: {:?}",
            layout.squares()
        );
        // Three rows of a five-row capture: the prompt on row 0 is above the
        // window, so it is the band's, not a row's, and only the turn the
        // matcher saw on these rows draws on a row of its own.
        assert_eq!(layout.band(), 1, "squares: {:?}", layout.squares());
        assert_eq!(layout.squares()[0].id, "s1:1");
        assert_eq!(sources_of(&strip.pinned), ["turn:s1:1"]);
        let drawn: Vec<&str> = layout.squares()[layout.band()..]
            .iter()
            .map(|square| square.id.as_str())
            .collect();
        assert_eq!(drawn, ["s1:2"]);
        let Layout::Relative(relative) = layout else {
            panic!("a relative strip unless the reader asked otherwise");
        };
        assert_eq!(relative.rows, 3.0, "the window's own height, in rows");
    }

    #[test]
    fn an_empty_capture_is_one_frame_with_nothing_in_it() {
        let strip = project_rows(
            "s1",
            &[],
            Vec::new(),
            BTreeMap::new(),
            Some(PaneWindow { height: 10, scroll: 0 }),
            &Options::default(),
        );
        assert_eq!(strip.rows, 0);
        assert!(strip.turns.is_empty());
        assert!(strip.pinned.is_empty());
        assert!(strip.tags.is_empty());
        assert!(strip.layout.is_none(), "an empty capture has no first row to measure from");
    }

    /// A prompt that scrolled out of the capture is still the reader's, so it
    /// rides the frame and the band draws it: the strip never loses the turns a
    /// reader navigates by.
    #[test]
    fn a_prompt_above_the_capture_rides_the_frame_as_a_pin() {
        let rows: Vec<String> = ["⏺ done", "", "❯ and again", "", "⏺ working"]
            .iter()
            .map(|row| (*row).to_owned())
            .collect();
        let turns = vec![
            turn("s1", 1, "user", "the prompt nobody can see any more"),
            turn("s1", 2, "assistant", "done"),
            turn("s1", 3, "user", "and again"),
            turn("s1", 4, "assistant", "working"),
        ];
        let strip = project_rows(
            "s1",
            &rows,
            turns,
            BTreeMap::new(),
            Some(PaneWindow { height: 5, scroll: 0 }),
            &Options::default(),
        );

        assert_eq!(
            sources_of(&strip.pinned),
            ["turn:s1:1"],
            "the first prompt is above the capture: {:?}",
            strip.pinned
        );
        assert_eq!(strip.pinned[0].confidence, "pinned");
        assert_eq!(strip.pinned[0].buffer_start, 0);
        let layout = strip.layout.expect("layout");
        assert_eq!(layout.band(), 1);
        assert_eq!(layout.squares()[0].id, "s1:1");
        assert_eq!(layout.squares()[0].y, 0.0, "a band square counts places, not rows");
        assert!(!layout.squares()[0].active);
        assert!(
            !layout.squares()[1..].iter().any(|square| square.id == "s1:1"),
            "a pinned turn is not drawn twice"
        );
    }

    /// The composer is the harness's own row range, not a turn: the projection
    /// drops it before matching, the same way the client path does.
    #[test]
    fn the_composer_is_not_a_turn() {
        let rows: Vec<String> = ["❯ hi", "", "⏺ done", "", "╭──────╮", "│ ❯    │", "╰──────╯"]
            .iter()
            .map(|row| (*row).to_owned())
            .collect();
        let turns = vec![turn("s1", 1, "assistant", "done")];
        let strip = project_rows(
            "s1",
            &rows,
            turns,
            BTreeMap::new(),
            Some(PaneWindow { height: 4, scroll: 0 }),
            &Options::default(),
        );
        for found in &strip.turns {
            assert!(
                found.buffer_end < 5,
                "no span may reach the composer: {found:?}"
            );
        }
    }

    /// The window is the pane's own rows shifted up by its copy-mode scroll,
    /// with nothing sent from the client: the active square and the block both
    /// follow the two numbers the server read off tmux.
    #[test]
    fn the_window_follows_the_pane_height_and_its_scroll() {
        let rows: Vec<String> = [
            "alpha one",
            "alpha two",
            "alpha three",
            "alpha four",
            "beta one",
            "beta two",
            "beta three",
            "beta four",
        ]
        .iter()
        .map(|row| (*row).to_owned())
        .collect();
        let turns = vec![
            turn("s1", 1, "user", "alpha one\nalpha two\nalpha three\nalpha four"),
            turn("s1", 2, "assistant", "beta one\nbeta two\nbeta three\nbeta four"),
            // Never on the pane and never in the capture: only the recency list
            // knows it, which is the case the frame has to carry.
            turn("s1", 3, "assistant", "a reply the capture never held"),
        ];
        let at = |height: usize, scroll: usize, options: &Options| {
            project_rows(
                "s1",
                &rows,
                turns.clone(),
                BTreeMap::new(),
                Some(PaneWindow { height, scroll }),
                options,
            )
        };
        let ids = |strip: &Strip| -> Vec<String> {
            let layout = strip.layout.as_ref().expect("layout");
            layout.squares()[layout.band()..]
                .iter()
                .map(|square| square.id.clone())
                .collect()
        };
        let active_id = |strip: &Strip| -> Option<String> {
            strip
                .layout
                .as_ref()
                .expect("layout")
                .squares()
                .iter()
                .find(|square| square.active)
                .map(|square| square.id.clone())
        };
        let relative = Options::default();

        let whole = at(8, 0, &relative);
        let tail = at(4, 0, &relative);
        let scrolled = at(4, 4, &relative);

        assert_eq!(whole.turns.len(), 2, "both turns matched: {:?}", whole.turns);
        // The window is the rows the reader is looking at, so the squares on
        // rows are the turns the matcher found on them and nothing else: the
        // tail holds the newer turn, four rows up holds the older one, and the
        // whole pane holds both. The older turn is still on the strip either
        // way, in the band, because it is the reader's own prompt.
        assert_eq!(ids(&whole), ["s1:1", "s1:2"]);
        assert_eq!(ids(&tail), ["s1:2"]);
        assert_eq!(ids(&scrolled), ["s1:1"]);
        assert_eq!(active_id(&whole).as_deref(), Some("s1:1"));
        assert_eq!(active_id(&tail).as_deref(), Some("s1:2"));
        assert_eq!(active_id(&scrolled).as_deref(), Some("s1:1"));
        assert_eq!(
            tail.layout.as_ref().unwrap().band(),
            1,
            "the prompt above the tail is the band's"
        );

        // The recency list is the session's own turns, not the window's: the
        // same four squares on their own places, whatever the reader is looking
        // at. A scroll moves the mark, never a square.
        let recent = Options {
            mode: Mode::Recent,
            ..Options::default()
        };
        let whole = at(8, 0, &recent);
        let tail = at(4, 0, &recent);
        let scrolled = at(4, 4, &recent);
        let places = |strip: &Strip| -> Vec<(String, f64)> {
            let layout = strip.layout.as_ref().expect("layout");
            let Layout::Recent(recent) = layout else {
                panic!("recent mode asked for, {:?} came back", layout);
            };
            recent
                .squares
                .iter()
                .map(|square| (square.id.clone(), square.y))
                .collect()
        };
        assert_eq!(
            places(&whole),
            [
                ("s1:1".to_owned(), 0.0),
                ("s1:2".to_owned(), 1.0),
                ("s1:3".to_owned(), 2.0),
            ],
            "the list is the session's turns, including the one off the pane"
        );
        assert_eq!(places(&tail), places(&whole), "a scroll moves no square");
        assert_eq!(places(&scrolled), places(&whole));
        assert_eq!(
            scrolled.layout.as_ref().unwrap().band(),
            0,
            "the block is a list of turns, so it has no band to hold the rest"
        );
        // The list draws turns the window lost, so the frame has to carry them:
        // the client drops a placed square whose turn it cannot name.
        let shipped: Vec<(&str, &str)> = scrolled
            .turns
            .iter()
            .map(|turn| (turn.id.as_str(), turn.confidence))
            .collect();
        assert_eq!(
            shipped.iter().map(|(id, _)| *id).collect::<Vec<_>>(),
            ["s1:1", "s1:2", "s1:3"],
            "every square the list placed is on the frame"
        );
        assert_eq!(
            shipped[2].1, "listed",
            "the turn the pane never held rides without a span: {:?}",
            shipped
        );
    }

    /// A conversation the reader cleared is not the conversation the strip draws.
    /// A harness that drops one in place keeps the session, its file and its
    /// turns; the boundary is what separates the live conversation from the
    /// history behind it, and a turn stamped at the boundary is on that side.
    #[test]
    fn a_cleared_conversation_stops_at_its_boundary() {
        let turns = vec![
            turn("s1", 1, "user", "the cleared prompt"),
            turn("s1", 2, "assistant", "the cleared answer"),
            turn("s1", 3, "user", "after the clear"),
        ];
        assert_eq!(
            current_conversation(turns.clone(), Some(1_700_000_000_000 + 2))
                .iter()
                .map(|turn| turn.turn)
                .collect::<Vec<_>>(),
            [3],
            "the boundary is the first turn of the new conversation"
        );
        assert_eq!(
            current_conversation(turns, None).len(),
            3,
            "a session with no boundary is one conversation"
        );
    }
    /// The fingerprint decides whether a projection is worth sending: the frame
    /// the reader already has is not, and a frame whose turn text grew is. The
    /// stamp is not part of it — every frame carries a fresh one, and it is the
    /// one field a client never draws.
    #[test]
    fn a_frame_is_unchanged_only_when_what_the_client_draws_is() {
        let rows: Vec<String> = ["❯ hi", "", "⏺ done"].iter().map(|row| (*row).to_owned()).collect();
        let frame = |said: &str| {
            project_rows(
                "s1",
                &rows,
                vec![turn("s1", 1, "user", "hi"), turn("s1", 2, "assistant", said)],
                BTreeMap::new(),
                Some(PaneWindow { height: 3, scroll: 0 }),
                &Options::default(),
            )
        };
        let one = frame("done");
        assert_eq!(
            frame_fingerprint(&one),
            frame_fingerprint(&frame("done")),
            "the same projection is the same frame"
        );
        assert_ne!(
            frame_fingerprint(&one),
            frame_fingerprint(&frame("done, and then some more")),
            "a turn that grew is a frame to send"
        );
        let mut later = frame("done");
        later.at += 5_000;
        assert_eq!(
            frame_fingerprint(&one),
            frame_fingerprint(&later),
            "the stamp is not a reason to redraw"
        );
        let mut resized = frame("done");
        resized.rows += 1;
        assert_ne!(
            frame_fingerprint(&one),
            frame_fingerprint(&resized),
            "the pane's own height moved the squares"
        );
    }
}
