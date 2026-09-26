// The strip's feed: pty output sets a dirty bit, the watcher reads one
// boop_harness::pane::frame per FLUSH_INTERVAL, and pushes it if it changed.
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use boop_harness::pane::{self, Mode, Options, PaneFrame};
use serde::Deserialize;

use crate::boop::open_store_ro;
use crate::host::Host;

/// The event the strip listens on.
pub const SQUARES_EVENT: &str = "squares-update";
/// One projection per window at most; a pane can outrun a projection.
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// Idle wait between polls of the dirty bit. A timeout is not a flush.
const IDLE_WAIT: Duration = Duration::from_millis(1000);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquaresWatchArgs {
    /// The pane's own id: the key the pty stream wakes the feed on.
    pub pty: String,
    pub session: String,
    pub target: String,
    #[serde(default)]
    pub socket: Option<String>,
    #[serde(default)]
    pub options: SquaresOptions,
}

/// The reader's choices; unset fields fall back to the crate's defaults.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SquaresOptions {
    #[serde(default)]
    pub mode: Option<Mode>,
    #[serde(default)]
    pub user_keep: Option<usize>,
}

impl SquaresOptions {
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

/// Read the pane and the store once and build the frame the socket carries.
pub fn project(session: &str, target: &str, socket: Option<&str>, options: &Options) -> Result<PaneFrame, String> {
    let store = open_store_ro()?;
    pane::frame(&boop_mux::Tmux, socket, target, &store, session, options).map_err(|error| error.to_string())
}

/// Push one frame. The same call serves the Tauri window and the serve binary:
/// `Host::emit` is the only difference between them.
pub fn publish(host: &Arc<dyn Host>, strip: &PaneFrame) -> Result<(), String> {
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
        match project(&args.session, &args.target, args.socket.as_deref(), &options) {
            Ok(strip) => {
                stat.rows += strip.rows as u64;
                stat.turns += (strip.turns.len() + strip.pinned.len()) as u64;
                stat.text_bytes += strip
                    .turns
                    .iter()
                    .chain(strip.pinned.iter())
                    .map(|turn| turn.said.len() as u64)
                    .sum::<u64>();
                let fingerprint = pane::fingerprint(&strip);
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
}
