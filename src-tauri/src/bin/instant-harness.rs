use instant_lib::harness_store::{messages, resolve, sessions, HarnessId};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or("");
    let value = |flag: &str| {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    };
    let Some(id) = value("--harness").and_then(HarnessId::parse) else {
        eprintln!("--harness must be claude, opencode, codex, or kimi");
        std::process::exit(1)
    };
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("HOME is unset");
        std::process::exit(1)
    };
    let cwd = value("--cwd");
    let output = match command {
        "sessions" => serde_json::to_value(sessions(&home, id, cwd)).unwrap(),
        "resolve" => {
            let Some(cwd) = cwd else {
                eprintln!("resolve requires --cwd");
                std::process::exit(1)
            };
            serde_json::to_value(resolve(&home, id, cwd)).unwrap()
        }
        "messages" => {
            let Some(cwd) = cwd else {
                eprintln!("messages requires --cwd");
                std::process::exit(1)
            };
            let Some(session) = value("--session") else {
                eprintln!("messages requires --session");
                std::process::exit(1)
            };
            let after_seq = value("--after-seq").and_then(|value| value.parse().ok());
            serde_json::to_value(messages(id, session, cwd, after_seq)).unwrap()
        }
        _ => {
            eprintln!("usage: instant-harness sessions|resolve|messages --harness <id> [--cwd <dir>] [--session <id>] [--after-seq <n>]");
            std::process::exit(1)
        }
    };
    println!("{}", serde_json::to_string(&output).unwrap());
}
