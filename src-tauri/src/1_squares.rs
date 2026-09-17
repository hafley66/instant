// The strip's feed. The pane the server already streams decides when, the
// server computes, the socket carries: nothing here is asked for on scroll and
// nothing is asked for per square.
//
//   pty output  ->  one dirty bit  ->  capture-pane -p -J  ->  boop-turnvis
//               ->  one tags_for_many  ->  host.emit("squares-update")
//
// The frame lands on the events channel every other push uses, so the client
// side is `listenNativeEvent("squares-update")` and nothing new (see
// src/1_agentSquaresFeed.ts). One reconcile in flight, one dirty bit: a pane
// that writes faster than a projection is worth still costs one capture per
// FLUSH_INTERVAL, and a quiet pane costs none.
use std::collections::{BTreeMap, HashMap};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use boop_turnvis::locate_visible_turns;
use serde::{Deserialize, Serialize};

use crate::boop::{
    from_visible, input_region, now_ms, open_store_ro, read_turns, to_turnvis, BoopTurn, LocatedTurn,
};
use crate::boop_tmux::tmux_command;
use crate::host::Host;

/// The event the strip listens on.
pub const SQUARES_EVENT: &str = "squares-update";
/// History one capture asks tmux for: enough rows for a window of turns.
const CAPTURE_LINES: u32 = 400;
/// One reconcile per window at most. The pane can outrun a projection.
const FLUSH_INTERVAL: Duration = Duration::from_millis(120);
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
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquaresUnwatchArgs {
    pub pty: String,
}

/// One push: every turn the pane holds with the matcher's spans, plus the tags
/// the visible turns carry. `at` is the projection's own stamp, so a client can
/// drop a frame that arrived out of order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Strip {
    pub session: String,
    pub at: i64,
    pub rows: usize,
    pub turns: Vec<LocatedTurn>,
    pub tags: BTreeMap<String, Vec<String>>,
}

/// The pane's own lines. `-J` joins a wrapped row onto the line it continues,
/// so one entry is one logical line and its row number is its own index.
pub fn capture_lines(target: &str, socket: Option<&str>) -> Result<Vec<String>, String> {
    let start = format!("-{CAPTURE_LINES}");
    let output = tmux_command(socket)
        .args(["capture-pane", "-p", "-J", "-S", &start, "-t", target])
        .output()
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

/// The projection itself: rows in, spans and marks out. Pure, so the test pins
/// it without tmux and the watcher only supplies what it read.
pub fn project_rows(
    session: &str,
    rows: &[String],
    turns: Vec<BoopTurn>,
    tags: BTreeMap<String, Vec<String>>,
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
    let turns: Vec<boop_turnvis::BoopTurn> = turns.into_iter().map(to_turnvis).collect();
    Strip {
        session: session.to_owned(),
        at: now_ms() as i64,
        rows: rows.len(),
        turns: locate_visible_turns(&lines, &turns)
            .into_iter()
            .map(from_visible)
            .collect(),
        tags,
    }
}

/// One source per pushed turn, so the marks ride on the same frame.
pub fn sources_of(turns: &[LocatedTurn]) -> Vec<String> {
    turns
        .iter()
        .map(|turn| format!("turn:{}:{}", turn.session, turn.turn))
        .collect()
}

/// Read the pane and the store, once, and build the frame the socket carries.
pub fn project(session: &str, target: &str, socket: Option<&str>) -> Result<Strip, String> {
    let rows = capture_lines(target, socket)?;
    let turns = read_turns(session)?;
    let strip = project_rows(session, &rows, turns, BTreeMap::new());
    let tags = open_store_ro()?
        .tags_for_many(&sources_of(&strip.turns))
        .map_err(|error| error.to_string())?;
    Ok(Strip { tags, ..strip })
}

/// Push one frame. The same call serves the Tauri window and the serve binary:
/// `Host::emit` is the only difference between them.
pub fn publish(host: &Arc<dyn Host>, strip: &Strip) -> Result<(), String> {
    host.emit(
        SQUARES_EVENT,
        serde_json::to_value(strip).map_err(|error| error.to_string())?,
    )
}

type Feeds = Mutex<HashMap<String, SyncSender<()>>>;

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
        .insert(args.pty.clone(), dirty);
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
    if let Some(dirty) = feeds.get(pty) {
        let _ = dirty.try_send(());
    }
}

fn run(host: Arc<dyn Host>, args: SquaresWatchArgs, listener: Receiver<()>) {
    loop {
        match listener.recv_timeout(IDLE_WAIT) {
            Ok(()) => {}
            // A quiet pane projects nothing: only a write wakes this.
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let started = Instant::now();
        match project(&args.session, &args.target, args.socket.as_deref()) {
            Ok(strip) => {
                let _ = publish(&host, &strip);
            }
            Err(why) => eprintln!("squares feed for {}: {why}", args.session),
        }
        let spent = started.elapsed();
        if spent < FLUSH_INTERVAL {
            std::thread::sleep(FLUSH_INTERVAL - spent);
            // Everything that landed during the flush is one more projection,
            // not one per write.
            while listener.try_recv().is_ok() {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let strip = project_rows("s1", &rows, turns, tags.clone());

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
    }

    #[test]
    fn an_empty_capture_is_one_frame_with_nothing_in_it() {
        let strip = project_rows("s1", &[], Vec::new(), BTreeMap::new());
        assert_eq!(strip.rows, 0);
        assert!(strip.turns.is_empty());
        assert!(strip.tags.is_empty());
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
        let strip = project_rows("s1", &rows, turns, BTreeMap::new());
        for found in &strip.turns {
            assert!(
                found.buffer_end < 5,
                "no span may reach the composer: {found:?}"
            );
        }
    }
}
