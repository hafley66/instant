//! Emits the same logical-line shape as xterm.js `readVisibleLogicalLines()`
//! (wrapped rows joined, `start`/`end` spanning them), with no frontend.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const BSU: &[u8] = b"\x1b[?2026h";
const ESU: &[u8] = b"\x1b[?2026l";

#[derive(Serialize)]
struct LogicalLine {
    text: String,
    start: usize,
    end: usize,
}

#[derive(Serialize)]
struct Settle {
    requested: &'static str,
    fired: &'static str,
    elapsed_ms: u128,
    sync_open: usize,
    sync_close: usize,
    hash_changes: usize,
}

#[derive(Serialize)]
struct Capture {
    session: String,
    cols: usize,
    rows: usize,
    bytes: usize,
    settle: Settle,
    lines: Vec<LogicalLine>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Requested {
    Sync,
    Hash,
    Idle,
}

impl Requested {
    fn parse(raw: &str) -> Self {
        match raw {
            "sync" => Requested::Sync,
            "hash" | "grid" => Requested::Hash,
            "idle" => Requested::Idle,
            other => panic!("--signal must be sync|grid|idle, got {other}"),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Requested::Sync => "sync",
            Requested::Hash => "hash",
            Requested::Idle => "idle",
        }
    }
}

#[derive(Clone, Copy)]
enum Fired {
    Sync,
    Hash,
    Idle,
    Ceiling,
    Eof,
}

impl Fired {
    fn name(self) -> &'static str {
        match self {
            Fired::Sync => "sync",
            Fired::Hash => "hash",
            Fired::Idle => "idle",
            Fired::Ceiling => "ceiling",
            Fired::Eof => "eof",
        }
    }
}

/// `alacritty_terminal` swallows `?2026` inside its own sync buffer and only
/// re-reports the close, so the markers are counted off the raw stream instead.
#[derive(Default)]
struct SyncScanner {
    tail: Vec<u8>,
    opens: usize,
    closes: usize,
    depth: usize,
}

impl SyncScanner {
    /// Returns how many frames closed in this chunk. The trailing seven bytes
    /// are carried because a marker can straddle a read boundary.
    fn feed(&mut self, chunk: &[u8]) -> usize {
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(chunk);
        let mut closed = 0usize;
        for window in buf.windows(BSU.len()) {
            if window == BSU {
                self.opens += 1;
                self.depth += 1;
            } else if window == ESU {
                self.closes += 1;
                closed += 1;
                self.depth = self.depth.saturating_sub(1);
            }
        }
        let keep = buf.len().min(BSU.len() - 1);
        self.tail = buf[buf.len() - keep..].to_vec();
        closed
    }
}

fn grid_hash(term: &Term<VoidListener>, cols: usize, rows: usize) -> u64 {
    let mut hasher = DefaultHasher::new();
    let grid = term.grid();
    for row in 0..rows {
        let line = &grid[Line(row as i32)];
        for cell in (0..cols).map(|column| &line[Column(column)]) {
            cell.c.hash(&mut hasher);
            cell.flags.contains(Flags::WRAPLINE).hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn arg(name: &str, fallback: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let session = arg("--session", "");
    let cols: u16 = arg("--cols", "120").parse()?;
    let rows: u16 = arg("--rows", "40").parse()?;
    let settle_ms: u64 = arg("--settle-ms", "6000").parse()?;
    let poll_ms: u64 = arg("--poll-ms", "20").parse()?;
    let idle_ms: u64 = arg("--idle-ms", "750").parse()?;
    let hash_stable_n: usize = arg("--hash-stable-n", "3").parse()?;
    let hash_stable_ms: u64 = arg("--hash-stable-ms", "250").parse()?;
    let sync_quiet_ms: u64 = arg("--sync-quiet-ms", "150").parse()?;
    let requested = Requested::parse(&arg("--signal", "hash"));
    let term_name = arg("--term", "xterm-256color");
    let out = arg("--out", "capture.json");
    assert!(!session.is_empty(), "--session is required");

    let pty = native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut command = CommandBuilder::new("tmux");
    command.args(["attach-session", "-d", "-t", &session]);
    command.env("TERM", &term_name);
    // A private terminfo tree is how a run can hand tmux a `Sync` capability
    // without touching the shared server's terminal-features option.
    if let Ok(dir) = std::env::var("TERMINFO") {
        command.env("TERMINFO", dir);
    }
    let mut child = pty.slave.spawn_command(command)?;
    drop(pty.slave);

    // The reader thread owns the pty handle; the main thread advances the
    // terminal so the grid is never touched from two places.
    let mut reader = pty.master.try_clone_reader()?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let mut term = Term::new(
        Config::default(),
        &TermSize::new(cols as usize, rows as usize),
        VoidListener,
    );
    let mut parser: Processor<StdSyncHandler> = Processor::new();

    let start = Instant::now();
    let ceiling = start + Duration::from_millis(settle_ms);
    let mut bytes = 0usize;
    let mut scanner = SyncScanner::default();
    let mut hash_changes = 0usize;
    let mut last_hash = grid_hash(&term, cols as usize, rows as usize);
    let mut stable_polls = 0usize;
    let mut stable_since = start;
    let mut last_byte_at: Option<Instant> = None;
    let mut last_close_at: Option<Instant> = None;
    let fired = loop {
        if Instant::now() >= ceiling {
            break Fired::Ceiling;
        }
        match rx.recv_timeout(Duration::from_millis(poll_ms)) {
            Ok(chunk) => {
                bytes += chunk.len();
                let closed = scanner.feed(&chunk);
                parser.advance(&mut term, &chunk);
                let now = Instant::now();
                last_byte_at = Some(now);
                if closed > 0 && scanner.depth == 0 {
                    last_close_at = Some(now);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break Fired::Eof,
        }

        let now = Instant::now();
        let hash = grid_hash(&term, cols as usize, rows as usize);
        if hash == last_hash {
            stable_polls += 1;
        } else {
            hash_changes += 1;
            last_hash = hash;
            stable_polls = 0;
            stable_since = now;
        }

        // Each condition needs proof the pane actually produced something,
        // otherwise an empty grid settles before tmux has painted a byte.
        let sync_settled = scanner.closes > 0
            && scanner.depth == 0
            && last_close_at
                .is_some_and(|t| now.duration_since(t) >= Duration::from_millis(sync_quiet_ms));
        let hash_settled = hash_changes > 0
            && stable_polls >= hash_stable_n
            && now.duration_since(stable_since) >= Duration::from_millis(hash_stable_ms);
        let idle_settled = bytes > 0
            && last_byte_at.is_some_and(|t| now.duration_since(t) >= Duration::from_millis(idle_ms));

        match requested {
            Requested::Sync if sync_settled => break Fired::Sync,
            Requested::Hash if hash_settled => break Fired::Hash,
            _ => {}
        }
        if idle_settled {
            break Fired::Idle;
        }
    };
    let elapsed_ms = start.elapsed().as_millis();

    // Join wrapped rows the same way xterm.js does: WRAPLINE on a row's last
    // cell means the next row continues it.
    let grid = term.grid();
    let mut lines: Vec<LogicalLine> = Vec::new();
    let mut carry: Option<LogicalLine> = None;
    for row in 0..rows as usize {
        let line = &grid[Line(row as i32)];
        let text: String = (0..cols as usize)
            .map(|column| line[Column(column)].c)
            .collect();
        let wrapped = line[Column(cols as usize - 1)]
            .flags
            .contains(Flags::WRAPLINE);
        match carry.take() {
            Some(mut open) => {
                open.text.push_str(&text);
                open.end = row;
                carry = Some(open);
            }
            None => {
                carry = Some(LogicalLine {
                    text,
                    start: row,
                    end: row,
                })
            }
        }
        if !wrapped {
            let mut done = carry.take().unwrap();
            done.text = done.text.trim_end().to_string();
            lines.push(done);
        }
    }
    if let Some(mut open) = carry.take() {
        open.text = open.text.trim_end().to_string();
        lines.push(open);
    }

    let capture = Capture {
        session,
        cols: cols as usize,
        rows: rows as usize,
        bytes,
        settle: Settle {
            requested: requested.name(),
            fired: fired.name(),
            elapsed_ms,
            sync_open: scanner.opens,
            sync_close: scanner.closes,
            hash_changes,
        },
        lines,
    };
    std::fs::write(&out, serde_json::to_string_pretty(&capture)?)?;
    eprintln!(
        "settle requested={} fired={} bytes={} elapsed_ms={} bsu={} esu={} hash_changes={} lines={} -> {out}",
        capture.settle.requested,
        capture.settle.fired,
        capture.bytes,
        capture.settle.elapsed_ms,
        capture.settle.sync_open,
        capture.settle.sync_close,
        capture.settle.hash_changes,
        capture.lines.len()
    );
    let _ = child.kill();
    Ok(())
}
