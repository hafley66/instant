//! Bounded execution for interactive click commands, including shell children.
use super::{Proc, ProcError};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

impl Proc {
    pub fn run_bounded(mut self, timeout: Duration, cap: usize) -> Result<Output, ProcError> {
        self.count();
        let io = |source| ProcError::Io { label: self.label.name(), source };
        let mut child = self.cmd.process_group(0).stdin(Stdio::null())
            .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
            .map_err(|source| ProcError::Spawn {
                label: self.label.name(), program: self.program.clone(), source,
            })?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let overflow = AtomicBool::new(false);
        let started = Instant::now();
        std::thread::scope(|scope| {
            let read = |mut pipe: Box<dyn Read + Send>| {
                let mut bytes = Vec::new();
                let mut chunk = [0; 8192];
                loop {
                    let n = pipe.read(&mut chunk)?;
                    if n == 0 { break; }
                    let remaining = cap.saturating_sub(bytes.len());
                    bytes.extend_from_slice(&chunk[..n.min(remaining)]);
                    if n > remaining { overflow.store(true, Ordering::Relaxed); break; }
                }
                Ok::<_, std::io::Error>(bytes)
            };
            let out = scope.spawn(move || read(Box::new(stdout)));
            let err = scope.spawn(move || read(Box::new(stderr)));
            let mut status = None;
            let mut failure = None;
            loop {
                match child.try_wait() {
                    Ok(value) => { if value.is_some() { status = value; } }
                    Err(error) => { failure = Some(error); break; }
                }
                if overflow.load(Ordering::Relaxed) {
                    failure = Some(std::io::Error::other("click output limit reached")); break;
                }
                if status.is_some() && out.is_finished() && err.is_finished() { break; }
                if started.elapsed() >= timeout {
                    failure = Some(std::io::Error::new(std::io::ErrorKind::TimedOut, "click command timed out")); break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if failure.is_some() {
                // Negative pid signals the fresh process group, including rg.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
                let _ = child.kill();
            }
            let waited = child.wait();
            let stdout = out.join().unwrap().map_err(io)?;
            let stderr = err.join().unwrap().map_err(io)?;
            if let Some(error) = failure { return Err(io(error)); }
            Ok(Output { status: status.or_else(|| waited.ok()).unwrap(), stdout, stderr })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proc::Label;

    #[test]
    fn captures_both_pipes_and_preserves_exit_status() {
        let output = Proc::new("/bin/sh", Label::Shell).args(["-c", "printf hello; printf error >&2; exit 1"])
            .run_bounded(Duration::from_secs(1), 100).unwrap();
        assert_eq!((output.status.code(), output.stdout, output.stderr), (Some(1), b"hello".to_vec(), b"error".to_vec()));
    }

    #[test]
    fn bounds_output_and_descendants_holding_pipes() {
        for script in ["while :; do printf abcdefghijklmnop; done", "sleep 30 & wait"] {
            let start = Instant::now();
            let result = Proc::new("/bin/sh", Label::Shell).args(["-c", script])
                .run_bounded(Duration::from_millis(100), 1024);
            assert!(result.is_err());
            assert!(start.elapsed() < Duration::from_secs(3));
        }
    }
}
