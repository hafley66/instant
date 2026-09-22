//! The only module that names `std::process`. Every exit here reaps; a `Child`
//! dropped without `wait()` is a zombie holding a task port until the parent exits.

use std::ffi::OsStr;
use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

// ---------------------------------------------------------------- labels

/// Closed at compile time so `COUNTS` is a flat array and the spawn path
/// takes no lock.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Label {
    TmuxCapture,
    TmuxControl,
    TmuxPaste,
    TmuxPty,
    Open,
    Shell,
    Git,
    Chrome,
    Screencapture,
    Boop,
    Other,
}

impl Label {
    const ALL: [Label; 11] = [
        Label::TmuxCapture,
        Label::TmuxControl,
        Label::TmuxPaste,
        Label::TmuxPty,
        Label::Open,
        Label::Shell,
        Label::Git,
        Label::Chrome,
        Label::Screencapture,
        Label::Boop,
        Label::Other,
    ];

    fn name(self) -> &'static str {
        match self {
            Label::TmuxCapture => "tmux.capture",
            Label::TmuxControl => "tmux.control",
            Label::TmuxPaste => "tmux.paste",
            Label::TmuxPty => "tmux.pty",
            Label::Open => "open",
            Label::Shell => "shell",
            Label::Git => "git",
            Label::Chrome => "chrome",
            Label::Screencapture => "screencapture",
            Label::Boop => "boop",
            Label::Other => "other",
        }
    }
}

static COUNTS: [AtomicU64; 11] = [
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
    AtomicU64::new(0),
];

/// Spawns per label since process start. Monotonic; never reset.
pub fn spawn_counts() -> Vec<(&'static str, u64)> {
    Label::ALL
        .iter()
        .enumerate()
        .map(|(i, label)| (label.name(), COUNTS[i].load(Ordering::Relaxed)))
        .collect()
}

// ---------------------------------------------------------------- errors

#[derive(Debug)]
pub enum ProcError {
    /// The program could not be started at all.
    Spawn { label: &'static str, program: String, source: std::io::Error },
    /// Started, ran, exited non-zero. Carries stderr so callers stop
    /// re-deriving the message from `Output`.
    Status { label: &'static str, code: Option<i32>, stderr: String },
    /// Started, but reading or writing its pipes failed.
    Io { label: &'static str, source: std::io::Error },
    /// Stdout was not UTF-8 and the caller asked for text.
    Utf8 { label: &'static str },
}

impl std::fmt::Display for ProcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProcError::Spawn { label, program, source } => {
                write!(f, "{label}: launch {program}: {source}")
            }
            ProcError::Status { label, code, stderr } => {
                let code = code.map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
                let tail = stderr.trim();
                if tail.is_empty() {
                    write!(f, "{label}: exit {code}")
                } else {
                    write!(f, "{label}: exit {code}: {tail}")
                }
            }
            ProcError::Io { label, source } => write!(f, "{label}: {source}"),
            ProcError::Utf8 { label } => write!(f, "{label}: output was not utf-8"),
        }
    }
}

impl std::error::Error for ProcError {}

/// Call sites in this crate return `Result<_, String>` to Tauri. This keeps
/// `?` working there without a `.map_err(|e| e.to_string())` at each one.
impl From<ProcError> for String {
    fn from(error: ProcError) -> String {
        error.to_string()
    }
}

// ---------------------------------------------------------------- builder

pub struct Proc {
    cmd: Command,
    label: Label,
    program: String,
}

impl Proc {
    pub fn new(program: impl AsRef<OsStr>, label: Label) -> Self {
        let program = program.as_ref();
        Proc {
            program: program.to_string_lossy().into_owned(),
            cmd: Command::new(program),
            label,
        }
    }

    /// `-u` because a release app is launched by macOS, not a login shell, so its
    /// locale can be non-UTF-8 and tmux underscores wide cells. Release with no
    /// configured socket gets `-L instant-prod` so it cannot clobber dev sessions.
    pub fn tmux(socket: Option<&str>, label: Label) -> Self {
        let mut proc = Proc::new("tmux", label);
        proc.cmd.arg("-u");
        let configured = socket.map(str::to_owned).or_else(configured_tmux_socket);
        match configured {
            Some(socket) => {
                proc.cmd.args(["-L", &socket]);
            }
            None => {
                if !cfg!(debug_assertions) {
                    proc.cmd.args(["-L", "instant-prod"]);
                }
            }
        }
        proc
    }

    /// No `-u`, no implicit prod socket. Distinct from [`Proc::tmux`] because
    /// folding the capture and control paths into it is a behaviour change.
    pub fn tmux_bare(socket: Option<&str>, label: Label) -> Self {
        let mut proc = Proc::new("tmux", label);
        if let Some(socket) = socket {
            proc.cmd.args(["-L", socket]);
        }
        proc
    }

    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.cmd.arg(arg);
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.cmd.args(args);
        self
    }

    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.cmd.env(key, value);
        self
    }

    pub fn env_remove(mut self, key: impl AsRef<OsStr>) -> Self {
        self.cmd.env_remove(key);
        self
    }

    pub fn cwd(mut self, dir: impl AsRef<Path>) -> Self {
        self.cmd.current_dir(dir);
        self
    }

    /// Escape hatch for the handful of callers that need a knob this builder
    /// does not expose. Stays inside the seam: the `Command` never escapes.
    pub fn with(mut self, f: impl FnOnce(&mut Command)) -> Self {
        f(&mut self.cmd);
        self
    }

    fn count(&self) {
        let index = Label::ALL.iter().position(|l| *l == self.label).unwrap_or(0);
        COUNTS[index].fetch_add(1, Ordering::Relaxed);
    }

    // ------------------------------------------------------------ exits

    /// Run to completion, capturing both pipes. The child is reaped before
    /// this returns. A non-zero exit is `Ok`: the caller inspects `status`.
    pub fn run(mut self) -> Result<Output, ProcError> {
        self.count();
        self.cmd.output().map_err(|source| ProcError::Spawn {
            label: self.label.name(),
            program: self.program.clone(),
            source,
        })
    }

    /// Run to completion, returning the exit status. Reaped before returning.
    pub fn status(self) -> Result<ExitStatus, ProcError> {
        self.run().map(|output| output.status)
    }

    /// Run to completion and require a zero exit. Stderr rides the error.
    pub fn ok(self) -> Result<(), ProcError> {
        let label = self.label.name();
        let output = self.run()?;
        if output.status.success() {
            return Ok(());
        }
        Err(ProcError::Status {
            label,
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    /// Run to completion, require a zero exit, return trimmed stdout.
    pub fn text(self) -> Result<String, ProcError> {
        let label = self.label.name();
        let output = self.run()?;
        if !output.status.success() {
            return Err(ProcError::Status {
                label,
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            });
        }
        String::from_utf8(output.stdout)
            .map(|text| text.trim_end().to_string())
            .map_err(|_| ProcError::Utf8 { label })
    }

    /// Write `body` to the child's stdin, close it, then run to completion.
    /// Used by the tmux `load-buffer -` paste path.
    pub fn feed(mut self, body: &[u8]) -> Result<Output, ProcError> {
        self.count();
        let label = self.label.name();
        self.cmd.stdin(Stdio::piped());
        self.cmd.stdout(Stdio::piped());
        self.cmd.stderr(Stdio::piped());
        let mut child = self.cmd.spawn().map_err(|source| ProcError::Spawn {
            label,
            program: self.program.clone(),
            source,
        })?;
        {
            let mut stdin = child.stdin.take().ok_or(ProcError::Io {
                label,
                source: std::io::Error::other("stdin was not piped"),
            })?;
            stdin
                .write_all(body)
                .map_err(|source| ProcError::Io { label, source })?;
        }
        child
            .wait_with_output()
            .map_err(|source| ProcError::Io { label, source })
    }

    /// Start a child that outlives this call. The returned [`Handle`] reaps on
    /// drop; dropping it without calling [`Handle::wait`] terminates the child.
    pub fn detach(mut self) -> Result<Handle, ProcError> {
        self.count();
        let label = self.label.name();
        let child = self.cmd.spawn().map_err(|source| ProcError::Spawn {
            label,
            program: self.program.clone(),
            source,
        })?;
        Ok(Handle { child: Some(child), label })
    }

    /// A GUI handoff such as `/usr/bin/open`: no status worth reading, still
    /// reaped on the reaper thread.
    pub fn handoff(self) -> Result<(), ProcError> {
        let handle = self.detach()?;
        handle.release();
        Ok(())
    }
}

/// The tmux server `INSTANT_TMUX_SOCKET` names, if any.
pub fn configured_tmux_socket() -> Option<String> {
    std::env::var("INSTANT_TMUX_SOCKET").ok().filter(|value| !value.is_empty())
}

// ---------------------------------------------------------------- handle

/// A running child. Dropping this without [`Handle::wait`] or
/// [`Handle::release`] sends SIGTERM and hands the child to the reaper thread.
pub struct Handle {
    child: Option<Child>,
    label: &'static str,
}

impl Handle {
    pub fn pid(&self) -> u32 {
        self.child.as_ref().map(Child::id).unwrap_or(0)
    }

    /// Block until the child exits, reaping it here.
    pub fn wait(mut self) -> Result<ExitStatus, ProcError> {
        let label = self.label;
        match self.child.take() {
            Some(mut child) => child.wait().map_err(|source| ProcError::Io { label, source }),
            None => Err(ProcError::Io {
                label,
                source: std::io::Error::other("already waited"),
            }),
        }
    }

    /// Let the child run to its own end, reaped in the background. Use when
    /// the child owns its lifetime (a GUI app, a detached viewer).
    pub fn release(mut self) {
        if let Some(child) = self.child.take() {
            reaper().send(child).ok();
        }
    }

    /// Terminate the child now and reap it in the background.
    pub fn kill(mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            reaper().send(child).ok();
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            reaper().send(child).ok();
        }
    }
}

// ---------------------------------------------------------------- reaper

/// `Child::wait` blocks and std's `Drop for Child` does not reap, so one
/// thread owns every abandoned child.
fn reaper() -> &'static Sender<Child> {
    static REAPER: OnceLock<Mutex<Sender<Child>>> = OnceLock::new();
    static HANDLE: OnceLock<Sender<Child>> = OnceLock::new();
    HANDLE.get_or_init(|| {
        let (tx, rx) = channel::<Child>();
        std::thread::Builder::new()
            .name("proc-reaper".into())
            .spawn(move || {
                // Children exit out of order; sweep rather than wait in turn,
                // so one long-lived release() cannot stall the queue.
                let mut pending: Vec<Child> = Vec::new();
                loop {
                    match rx.recv_timeout(std::time::Duration::from_millis(250)) {
                        Ok(child) => pending.push(child),
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) if pending.is_empty() => break,
                        Err(_) => {}
                    }
                    pending.retain_mut(|child| !matches!(child.try_wait(), Ok(Some(_))));
                }
            })
            .ok();
        let _ = &REAPER;
        tx
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_trims_and_requires_success() {
        let out = Proc::new("/bin/echo", Label::Other).arg("hello").text().unwrap();
        assert_eq!(out, "hello");

        let err = Proc::new("/usr/bin/false", Label::Other).text().unwrap_err();
        assert!(matches!(err, ProcError::Status { code: Some(1), .. }), "{err}");
    }

    #[test]
    fn spawn_failure_names_the_program() {
        let err = Proc::new("/nonexistent/binary", Label::Other).ok().unwrap_err();
        assert_eq!(
            err.to_string(),
            "other: launch /nonexistent/binary: No such file or directory (os error 2)"
        );
    }

    #[test]
    fn feed_writes_stdin_and_waits() {
        let out = Proc::new("/bin/cat", Label::Other).feed(b"piped body").unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "piped body");
        assert!(out.status.success());
    }

    #[test]
    fn counts_rise_per_label() {
        let before = spawn_counts().into_iter().find(|(n, _)| *n == "git").unwrap().1;
        let _ = Proc::new("/usr/bin/true", Label::Git).ok();
        let after = spawn_counts().into_iter().find(|(n, _)| *n == "git").unwrap().1;
        assert_eq!(after, before + 1);
    }

    /// The defect this module exists to prevent.
    #[test]
    fn no_zombies_after_a_spawn_storm() {
        for _ in 0..64 {
            Proc::new("/usr/bin/true", Label::Other).ok().unwrap();
            Proc::new("/usr/bin/true", Label::Other).handoff().unwrap();
        }
        // handoff() reaps on the background thread; allow one sweep.
        std::thread::sleep(std::time::Duration::from_millis(600));
        let ours = std::process::id().to_string();
        let ps = Proc::new("/bin/ps", Label::Other)
            .args(["-ax", "-o", "ppid=,stat="])
            .text()
            .unwrap();
        let zombies = ps
            .lines()
            .filter(|line| {
                let mut f = line.split_whitespace();
                f.next() == Some(ours.as_str()) && f.next().is_some_and(|s| s.contains('Z'))
            })
            .count();
        assert_eq!(zombies, 0, "{ps}");
    }
}
