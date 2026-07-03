// Meme generator + Slack emoji maker backend.
// Requires ImageMagick 6 (convert) or 7 (magick) on the user's PATH.

use std::path::{Path, PathBuf};

static MAGICK_BIN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn magick_bin() -> &'static str {
    MAGICK_BIN.get_or_init(|| {
        // ImageMagick 7 unified binary.
        if is_on_path("magick") {
            return "magick".to_string();
        }
        // ImageMagick 6 legacy binary.
        if is_on_path("convert") {
            return "convert".to_string();
        }
        // Default; error messages will tell the user what to install.
        "magick".to_string()
    })
}

fn is_on_path(name: &str) -> bool {
    std::process::Command::new(name)
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn build_magick(args: &[String]) -> std::process::Command {
    let mut cmd = std::process::Command::new(magick_bin());
    cmd.args(args);
    cmd
}

#[derive(serde::Serialize)]
pub struct MagickResult {
    ok: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    command: String,
}

fn command_display(args: &[String]) -> String {
    let mut s = magick_bin().to_string();
    for a in args {
        s.push(' ');
        if a.contains(' ') {
            s.push_str(&format!("\"{a}\""));
        } else {
            s.push_str(a);
        }
    }
    s
}

/// Run an arbitrary ImageMagick command. The frontend is expected to pass
/// complete arguments including input/output paths. We do not validate paths
/// beyond making sure the binary exists.
#[tauri::command]
pub fn magick_run(args: Vec<String>) -> Result<MagickResult, String> {
    // Verify ImageMagick is available.
    let bin = magick_bin();
    let probe = std::process::Command::new(bin)
        .arg("-version")
        .output()
        .map_err(|e| format!("cannot run '{bin}': {e}. Is ImageMagick installed?"))?;
    if !probe.status.success() {
        return Err(format!("'{bin}' -version failed. Is ImageMagick installed?"));
    }

    let display = command_display(&args);
    let out = build_magick(&args)
        .output()
        .map_err(|e| format!("failed to run ImageMagick: {e}"))?;

    Ok(MagickResult {
        ok: out.status.success(),
        exit_code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        command: display,
    })
}

/// Convert an image to a Slack-compatible custom emoji.
/// Slack requires a square image, max 128x128 px, and under 128 KB.
/// We resize to fit inside 128x128, pad to square with transparency, and
/// fall back to reducing colors/quality if the file is still too large.
#[tauri::command]
pub fn make_slack_emoji(input: String, output: String) -> Result<MagickResult, String> {
    let input = PathBuf::from(input);
    let output = PathBuf::from(output);
    if !input.exists() {
        return Err(format!("input not found: {}", input.display()));
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // First pass: fit inside 128x128, pad to square with transparent background.
    let mut args = vec![
        input.to_string_lossy().into_owned(),
        "-resize".to_string(),
        "128x128>".to_string(),
        "-background".to_string(),
        "none".to_string(),
        "-gravity".to_string(),
        "center".to_string(),
        "-extent".to_string(),
        "128x128".to_string(),
        "-strip".to_string(),
        output.to_string_lossy().into_owned(),
    ];

    let mut res = run_magick(&args)?;
    if !res.ok {
        return Ok(res);
    }

    // Try to keep the file under Slack's 128 KB limit.
    let mut quality = 92i32;
    while file_size(&output)? > 128 * 1024 && quality > 30 {
        quality -= 8;
        // Forcibly quantize colors and raise compression.
        args = vec![
            input.to_string_lossy().into_owned(),
            "-resize".to_string(),
            "128x128>".to_string(),
            "-background".to_string(),
            "none".to_string(),
            "-gravity".to_string(),
            "center".to_string(),
            "-extent".to_string(),
            "128x128".to_string(),
            "-strip".to_string(),
            "-quality".to_string(),
            quality.to_string(),
            output.to_string_lossy().into_owned(),
        ];
        res = run_magick(&args)?;
        if !res.ok {
            return Ok(res);
        }
    }

    // Final fallback for stubborn GIFs: reduce color palette.
    if file_size(&output)? > 128 * 1024 {
        args = vec![
            input.to_string_lossy().into_owned(),
            "-resize".to_string(),
            "128x128>".to_string(),
            "-background".to_string(),
            "none".to_string(),
            "-gravity".to_string(),
            "center".to_string(),
            "-extent".to_string(),
            "128x128".to_string(),
            "-strip".to_string(),
            "-colors".to_string(),
            "64".to_string(),
            output.to_string_lossy().into_owned(),
        ];
        res = run_magick(&args)?;
    }

    Ok(res)
}

fn run_magick(args: &[String]) -> Result<MagickResult, String> {
    magick_run(args.to_vec())
}

fn file_size(path: &Path) -> Result<u64, String> {
    std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

/// Save a PNG data URL to disk.
#[tauri::command]
pub fn save_meme(path: String, data_url: String) -> Result<(), String> {
    let prefix = "data:image/png;base64,";
    let b64 = data_url
        .strip_prefix(prefix)
        .ok_or_else(|| "expected image/png data URL".to_string())?;
    let bytes = base64_decode(b64)?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| e.to_string())
}
