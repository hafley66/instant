use serde::Serialize;
use std::fs::{self, File};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct FenceCommandResult {
    stdout: String,
    stderr: String,
    code: i32,
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn expand(command: &str, path: &str, columns: u32, language: &str) -> String {
    let language = if language.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        language.to_string()
    } else {
        quote(language)
    };
    command
        .replace("$1", &quote(path))
        .replace("$WIDTH", &columns.to_string())
        .replace("$LANG", &language)
}

pub(crate) fn execute(command: &str, language: &str, text: &str, columns: u32) -> Result<FenceCommandResult, String> {
    let dir = tempfile::Builder::new().prefix("instant fence ").tempdir().map_err(|e| e.to_string())?;
    let input = dir.path().join("input");
    let stdout_path = dir.path().join("stdout");
    let stderr_path = dir.path().join("stderr");
    fs::write(&input, text).map_err(|e| e.to_string())?;
    let stdout = File::create(&stdout_path).map_err(|e| e.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|e| e.to_string())?;
    let script = expand(command, &input.to_string_lossy(), columns, language);
    let mut child = Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .process_group(0)
        .env("PATH", crate::pty::path_env())
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let code = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status.code().unwrap_or(1),
            None if start.elapsed() >= Duration::from_secs(5) => {
                // The shell can spawn a formatter; the timeout covers its whole group.
                unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
                child.wait().map_err(|e| e.to_string())?;
                break 124;
            }
            None => thread::sleep(Duration::from_millis(10)),
        }
    };
    Ok(FenceCommandResult {
        stdout: fs::read_to_string(stdout_path).map_err(|e| e.to_string())?,
        stderr: fs::read_to_string(stderr_path).map_err(|e| e.to_string())?,
        code,
    })
}

#[tauri::command]
pub async fn run_fence_command(command: String, language: String, text: String, columns: u32) -> Result<FenceCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || execute(&command, &language, &text, columns))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn expands_all_tokens_with_a_spaced_path() {
        assert_eq!(expand("cat $1 # $WIDTH $LANG", "/tmp/a b", 72, "ts"),
            "cat '/tmp/a b' # 72 ts");
    }

    #[test]
    fn cat_round_trips_text() {
        let result = execute("cat $1", "txt", "one\ntwo\n", 80).unwrap();
        assert_eq!((result.stdout.as_str(), result.stderr.as_str(), result.code), ("one\ntwo\n", "", 0));
    }

    #[test]
    fn redirect_replaces_text() {
        let result = execute("tr a-z A-Z < $1", "txt", "abc xyz\n", 80).unwrap();
        assert_eq!((result.stdout.as_str(), result.stderr.as_str(), result.code), ("ABC XYZ\n", "", 0));
    }

    #[test]
    fn missing_binary_returns_shell_code() {
        let result = execute("instant_nonexistent_fence_binary_7391 $1", "txt", "x", 80).unwrap();
        assert_eq!(result.code, 127);
    }

    #[test]
    fn times_out_and_kills_child() {
        let start = Instant::now();
        let result = execute("sleep 10", "txt", "x", 80).unwrap();
        assert_eq!(result.code, 124);
        assert!(start.elapsed() < Duration::from_secs(7));
    }
}
