// A ⌘-clicked token to a path: cwd, repo root, ancestors up to $HOME, then fzf
// over the index. Every filesystem question is answered here, none in the renderer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::Serialize;

const INDEX_TTL: Duration = Duration::from_secs(30);
const INDEX_CAP: usize = 20_000;
const MAX_RUNGS: usize = 8;
const MAX_SIBLINGS: usize = 400;
const MAX_GIT_REPOS: usize = 4;
const MAX_GIT_REVS: usize = 20;
const MAX_CHOICES: usize = 50;

// nucleo pays 16 per matched char plus boundary bonuses; under 12 per char the
// match is a coincidental subsequence and the token belongs to ripgrep.
const MIN_SCORE_PER_CHAR: u32 = 12;
// Shorter queries match most of an index.
const MIN_FUZZY_QUERY: usize = 4;

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub struct ResolvedRef {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub source: &'static str,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ResolveResult {
    Hit {
        #[serde(rename = "ref")]
        reference: ResolvedRef,
    },
    Choices {
        paths: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
        via: &'static str,
    },
    Absent {
        repo: String,
        rev: String,
        path: String,
        subject: String,
    },
    Miss,
}

#[derive(Clone, Debug)]
pub struct IndexEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// Split a trailing `:123` line reference off a token. Drive letters and
/// `host:8080` in a URL are not line refs.
pub fn split_line_ref(token: &str) -> (String, Option<u32>) {
    let Some(colon) = token.rfind(':') else {
        return (token.to_string(), None);
    };
    let (head, tail) = token.split_at(colon);
    let digits = &tail[1..];
    let is_line = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    // `C:\src` drive letters and `http://host:8080` are not line references.
    let is_url_port = head.split("://").nth(1).is_some_and(|rest| !rest.contains('/'));
    if !is_line || head.is_empty() || head.len() == 1 || is_url_port {
        return (token.to_string(), None);
    }
    match digits.parse::<u32>() {
        Ok(line) => (head.to_string(), Some(line)),
        Err(_) => (token.to_string(), None),
    }
}

/// A token worth walking the filesystem for: it carries a separator or an
/// extension-looking tail. Bare words are symbols far more often than paths.
pub fn looks_like_path(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("www.") {
        return false;
    }
    if token.contains('/') || token.contains('~') {
        return true;
    }
    match token.rfind('.') {
        Some(dot) if dot + 1 < token.len() => {
            let ext = &token[dot + 1..];
            ext.len() <= 16 && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        }
        _ => false,
    }
}

fn trim_slash(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/"
    } else {
        trimmed
    }
}

/// Directories from `cwd` up to and including `boundary`, nearest first. A cwd
/// outside the boundary walks toward the root instead.
pub fn ancestors_of(cwd: &str, boundary: &str, max: usize) -> Vec<String> {
    let start = trim_slash(cwd);
    if start.is_empty() || start == "/" {
        return Vec::new();
    }
    let stop = if boundary.is_empty() { "/" } else { trim_slash(boundary) };
    let inside = start == stop || start.starts_with(&format!("{stop}/"));
    let mut out = Vec::new();
    let mut dir = start.to_string();
    while out.len() < max {
        out.push(dir.clone());
        if inside && dir == stop {
            break;
        }
        let Some(cut) = dir.rfind('/') else { break };
        let parent = if cut == 0 { "/" } else { &dir[..cut] };
        if parent == dir || parent == "/" {
            break;
        }
        dir = parent.to_string();
    }
    out
}

/// Full paths to stat, best guess first, tagged with the rung that produced them.
pub fn crawl_candidates(
    rel: &str,
    cwd: &str,
    repo_root: Option<&str>,
    boundary: &str,
    max: usize,
) -> Vec<(String, &'static str)> {
    if rel.starts_with('/') || rel.starts_with("~/") {
        return vec![(rel.to_string(), "absolute")];
    }
    let tail = rel.strip_prefix("./").unwrap_or(rel);
    let mut out: Vec<(String, &'static str)> = Vec::new();
    let push = |dir: &str, step: &'static str, out: &mut Vec<(String, &'static str)>| {
        if dir.is_empty() {
            return;
        }
        let path = format!("{}/{}", trim_slash(dir), tail);
        if out.iter().any(|(seen, _)| seen == &path) {
            return;
        }
        out.push((path, step));
    };
    push(cwd, "cwd", &mut out);
    if let Some(root) = repo_root {
        push(root, "repo", &mut out);
    }
    for dir in ancestors_of(cwd, boundary, max) {
        push(&dir, "ancestor", &mut out);
    }
    if out.is_empty() {
        out.push((tail.to_string(), "cwd"));
    }
    out
}

/// The repository (or worktree) a directory belongs to: the nearest ancestor
/// holding a `.git` entry, file or directory.
pub fn repo_root_for(cwd: &str) -> Option<String> {
    let mut dir = Path::new(cwd);
    loop {
        if dir.join(".git").exists() {
            return Some(dir.to_string_lossy().into_owned());
        }
        dir = dir.parent()?;
    }
}

/// Search hits ranked the way an exact tail match deserves: a path ending with
/// the whole token beats one that only shares a filename, shallower beats deeper.
pub fn rank_exact(rel: &str, entries: &[IndexEntry]) -> Vec<(String, bool)> {
    let tail = rel.trim_start_matches("./").trim_start_matches('/');
    let base = tail.rsplit('/').next().unwrap_or(tail);
    let mut scored: Vec<(u8, usize, &str)> = entries
        .iter()
        .filter(|e| !e.is_dir)
        .filter_map(|e| {
            let suffix = e.path.ends_with(&format!("/{tail}")) || e.path == tail;
            let named = e.name == base;
            if !suffix && !named {
                return None;
            }
            Some((
                if suffix { 0 } else { 1 },
                e.path.matches('/').count(),
                e.path.as_str(),
            ))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(b.2)));
    scored.into_iter().map(|(rank, _, path)| (path.to_string(), rank == 0)).collect()
}

/// `rel` joined to each indexed directory, kept when it exists on disk. This is
/// the one rung that reaches into gitignored folders: their parent is indexed
/// even when their contents are not. Shallowest match first.
pub fn under_indexed_dirs(rel: &str, entries: &[IndexEntry]) -> Vec<String> {
    let tail = rel.trim_start_matches("./").trim_start_matches('/');
    if tail.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<String> = entries
        .iter()
        .filter(|e| e.is_dir)
        .filter_map(|e| {
            let candidate = Path::new(&e.path).join(tail);
            std::fs::symlink_metadata(&candidate)
                .is_ok()
                .then(|| candidate.to_string_lossy().into_owned())
        })
        .collect();
    found.sort_by(|a, b| a.matches('/').count().cmp(&b.matches('/').count()).then(a.cmp(b)));
    found.dedup();
    found
}

/// fzf ranking over the index. A token carrying a separator matches whole paths;
/// a bare filename matches basenames, so a folder chain cannot out-score a file.
pub fn rank_fuzzy(query: &str, entries: &[IndexEntry], limit: usize) -> Vec<(String, u32)> {
    let clean = query.trim().trim_start_matches("./").trim_end_matches('/');
    if clean.chars().count() < MIN_FUZZY_QUERY || entries.is_empty() {
        return Vec::new();
    }
    let scoped = clean.contains('/');
    let mut config = Config::DEFAULT;
    config.set_match_paths();
    let mut matcher = Matcher::new(config);
    let pattern = Pattern::parse(clean, CaseMatching::Ignore, Normalization::Smart);
    // `by-test.md` may fuzz its stem, never its extension: a candidate that is
    // not a `.md` file is a coincidence of letters, not the file.
    let extension: Option<String> = clean
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .filter(|(stem, ext)| !stem.is_empty() && !ext.is_empty() && ext.len() <= 16 && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|(_, ext)| format!(".{}", ext.to_ascii_lowercase()));
    let haystack: Vec<&str> = entries
        .iter()
        .map(|e| {
            let keep = extension
                .as_deref()
                .is_none_or(|ext| e.name.to_ascii_lowercase().ends_with(ext));
            if !keep {
                ""
            } else if scoped {
                e.path.as_str()
            } else {
                e.name.as_str()
            }
        })
        .collect();
    let floor = MIN_SCORE_PER_CHAR * clean.chars().filter(|c| *c != '/').count().min(64) as u32;
    let mut buf = Vec::new();
    let mut hits: Vec<(usize, u32)> = Vec::new();
    for (index, candidate) in haystack.iter().enumerate() {
        if candidate.is_empty() {
            continue;
        }
        let Some(score) = pattern.score(Utf32Str::new(candidate, &mut buf), &mut matcher) else {
            continue;
        };
        if score >= floor {
            hits.push((index, score));
        }
    }
    // fzf's own tiebreakers: score, then the shorter candidate, then the name.
    hits.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then(entries[a.0].path.matches('/').count().cmp(&entries[b.0].path.matches('/').count()))
            .then(entries[a.0].path.len().cmp(&entries[b.0].path.len()))
            .then(entries[a.0].path.cmp(&entries[b.0].path))
    });
    hits.truncate(limit);
    hits.into_iter()
        .map(|(index, score)| (entries[index].path.clone(), score))
        .collect()
}

/// Exactly one directory named `token`, or nothing: a bare word that matches
/// several folders (or none) is a ripgrep query.
pub fn unique_dir_named(token: &str, entries: &[IndexEntry]) -> Option<String> {
    let want = token.trim().to_ascii_lowercase();
    if want.chars().count() < MIN_FUZZY_QUERY {
        return None;
    }
    let mut found: Option<&IndexEntry> = None;
    for entry in entries.iter().filter(|e| e.is_dir) {
        if !entry.name.eq_ignore_ascii_case(&want) {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(entry);
    }
    found.map(|e| e.path.clone())
}

/// Sibling checkouts: agent output prints a path relative to ITS repo root, so a
/// token that misses every ancestor join is tried under the neighbouring repos.
/// Only directories holding a `.git` count, and only at or above the repo root.
pub fn sibling_candidates(
    rel: &str,
    cwd: &str,
    repo_root: Option<&str>,
    boundary: &str,
    max: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    let start = repo_root.unwrap_or(cwd);
    for ancestor in ancestors_of(start, boundary, max) {
        let Ok(children) = std::fs::read_dir(&ancestor) else { continue };
        let mut seen = 0;
        for child in children.flatten() {
            seen += 1;
            if seen > MAX_SIBLINGS {
                break;
            }
            if !child.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let path = child.path();
            if child.file_name().to_string_lossy().starts_with('.') || !path.join(".git").exists() {
                continue;
            }
            out.push(format!("{}/{}", path.to_string_lossy(), rel));
        }
    }
    out
}

/// Repos worth asking git about: a checkout whose first path segment exists, so
/// `plans/x.md` only questions repos that actually have a `plans` directory.
fn git_probe_repos(rel: &str, cwd: &str, repo_root: Option<&str>, boundary: &str) -> Vec<String> {
    let head = rel.split('/').next().unwrap_or(rel);
    let mut repos: Vec<String> = repo_root.map(|r| vec![r.to_string()]).unwrap_or_default();
    for ancestor in ancestors_of(cwd, boundary, MAX_RUNGS) {
        let Ok(children) = std::fs::read_dir(&ancestor) else { continue };
        for child in children.flatten().take(MAX_SIBLINGS) {
            let path = child.path();
            if !path.join(".git").exists() || !path.join(head).is_dir() {
                continue;
            }
            let repo = path.to_string_lossy().into_owned();
            if !repos.contains(&repo) {
                repos.push(repo);
            }
            if repos.len() >= MAX_GIT_REPOS {
                return repos;
            }
        }
    }
    repos
}

fn git_out(repo: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git").arg("-C").arg(repo).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A path git knows and the working tree does not: deleted, on another branch,
/// or fetched but never checked out. Answers with the newest commit holding it.
pub fn git_absent(rel: &str, repos: &[String]) -> Option<(String, String, String)> {
    for repo in repos {
        let Some(revs) = git_out(repo, &["rev-list", "--all", "--", rel]) else { continue };
        // The newest commit touching a path can be the one that deleted it, so
        // walk back until a revision still holds the blob.
        for rev in revs.lines().take(MAX_GIT_REVS) {
            if git_out(repo, &["cat-file", "-e", &format!("{rev}:{rel}")]).is_none() {
                continue;
            }
            let subject = git_out(repo, &["log", "-1", "--format=%h %s", rev]).unwrap_or_default();
            return Some((repo.clone(), rev.to_string(), subject));
        }
    }
    None
}

type IndexCache = Mutex<HashMap<PathBuf, (Instant, Arc<Vec<IndexEntry>>)>>;

fn index_cache() -> &'static IndexCache {
    static CACHE: OnceLock<IndexCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The gitignore-aware file and directory list under `root`, cached briefly: a
/// wall of agent output resolves many tokens against the same tree.
fn index_for(root: &Path) -> Arc<Vec<IndexEntry>> {
    let key = root.to_path_buf();
    if let Some((at, entries)) = index_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        if at.elapsed() < INDEX_TTL {
            return entries;
        }
    }
    let mut entries = Vec::new();
    let mut walker = WalkBuilder::new(root);
    walker
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .follow_links(false)
        // Dependency trees and git internals are never what a pasted path
        // means; keeping them out stops fzf offering node_modules noise.
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != "node_modules" && name != ".git"
        });
    for result in walker.build() {
        if entries.len() >= INDEX_CAP {
            break;
        }
        let Ok(entry) = result else { continue };
        let Some(file_type) = entry.file_type() else { continue };
        let path = entry.path();
        if path == root {
            continue;
        }
        entries.push(IndexEntry {
            path: path.to_string_lossy().into_owned(),
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: file_type.is_dir(),
        });
    }
    let entries = Arc::new(entries);
    if let Ok(mut cache) = index_cache().lock() {
        cache.insert(key, (Instant::now(), entries.clone()));
    }
    entries
}

/// Drop the cached indexes (a preview watch reporting a change calls this).
pub fn clear_index_cache() {
    if let Ok(mut cache) = index_cache().lock() {
        cache.clear();
    }
}

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// The rung that knows what the agent did: a token the agent printed names a
/// file it touched, or a file beside one. Exact tail on the touched paths
/// first (newest wins when only one distinct file carries the tail), then the
/// token joined to every directory the evidence sits under.
pub fn resolve_from_evidence(rel: &str, evidence: &crate::boop::AgentEvidence) -> Option<ResolveResult> {
    let tail = rel.trim_start_matches("./").trim_start_matches('/');
    if tail.is_empty() {
        return None;
    }
    let suffix = format!("/{tail}");
    let mut touched: Vec<String> = Vec::new();
    for path in &evidence.paths {
        if (path.ends_with(&suffix) || path == tail) && !touched.contains(path) {
            touched.push(path.clone());
        }
    }
    touched.retain(|path| std::fs::symlink_metadata(path).is_ok());
    if touched.len() == 1 {
        return Some(ResolveResult::Hit {
            reference: ResolvedRef { path: touched.remove(0), line: None, source: "touched" },
        });
    }
    if touched.len() > 1 {
        touched.truncate(MAX_CHOICES);
        return Some(ResolveResult::Choices { paths: touched, line: None, via: "exact" });
    }
    for dir in &evidence.dirs {
        let candidate = Path::new(dir).join(tail);
        if std::fs::symlink_metadata(&candidate).is_ok() {
            return Some(ResolveResult::Hit {
                reference: ResolvedRef {
                    path: candidate.to_string_lossy().into_owned(),
                    line: None,
                    source: "touched",
                },
            });
        }
    }
    None
}

#[cfg(test)]
fn resolve_ref_blocking(token: String, cwd: String, home: String) -> ResolveResult {
    resolve_ref_with(token, cwd, home, &crate::boop::AgentEvidence::default())
}

fn resolve_ref_with(
    token: String,
    cwd: String,
    home: String,
    evidence: &crate::boop::AgentEvidence,
) -> ResolveResult {
    let clean = token.trim().trim_matches(|c| c == '\'' || c == '"' || c == '`');
    if clean.is_empty() {
        return ResolveResult::Miss;
    }
    let (rel, line) = split_line_ref(clean);
    if rel.is_empty() {
        return ResolveResult::Miss;
    }

    if rel.starts_with('/') || rel.starts_with("~/") {
        return ResolveResult::Hit {
            reference: ResolvedRef { path: rel, line, source: "absolute" },
        };
    }

    if let Some(found) = resolve_from_evidence(&rel, evidence) {
        return match found {
            ResolveResult::Hit { reference } => ResolveResult::Hit {
                reference: ResolvedRef { line, ..reference },
            },
            ResolveResult::Choices { paths, via, .. } => ResolveResult::Choices { paths, line, via },
            other => other,
        };
    }

    let repo_root = repo_root_for(&cwd);
    let search_root = repo_root.clone().unwrap_or_else(|| cwd.clone());

    if !looks_like_path(&rel) {
        if search_root.is_empty() {
            return ResolveResult::Miss;
        }
        let entries = index_for(Path::new(&search_root));
        return match unique_dir_named(&rel, &entries) {
            Some(path) => ResolveResult::Hit {
                reference: ResolvedRef { path, line: None, source: "fuzzy" },
            },
            None => ResolveResult::Miss,
        };
    }

    for (candidate, step) in
        crawl_candidates(&rel, &cwd, repo_root.as_deref(), &home, MAX_RUNGS)
    {
        if std::fs::symlink_metadata(&candidate).is_ok() {
            return ResolveResult::Hit {
                reference: ResolvedRef { path: candidate, line, source: step },
            };
        }
    }

    if search_root.is_empty() {
        return ResolveResult::Miss;
    }
    let entries = index_for(Path::new(&search_root));
    let exact = rank_exact(&rel, &entries);
    // One whole-tail match is unambiguous even when the bare filename repeats.
    let tails: Vec<&(String, bool)> = exact.iter().filter(|(_, tail)| *tail).collect();
    if exact.len() == 1 || tails.len() == 1 {
        let path = tails.first().map_or_else(|| exact[0].0.clone(), |(path, _)| path.clone());
        return ResolveResult::Hit {
            reference: ResolvedRef { path, line, source: "search" },
        };
    }
    if exact.len() > 1 {
        let mut paths: Vec<String> = exact.into_iter().map(|(path, _)| path).collect();
        paths.truncate(MAX_CHOICES);
        return ResolveResult::Choices { paths, line, via: "exact" };
    }

    // A file inside a gitignored directory: `out/timeline.txt` under a lab whose
    // .gitignore hides `out`. The walker never lists the file, but it lists the
    // lab, so the token joined to every indexed directory finds it with a stat.
    let ignored = under_indexed_dirs(&rel, &entries);
    if ignored.len() == 1 {
        return ResolveResult::Hit {
            reference: ResolvedRef { path: ignored[0].clone(), line, source: "ignored" },
        };
    }
    if ignored.len() > 1 {
        let mut paths = ignored;
        paths.truncate(MAX_CHOICES);
        return ResolveResult::Choices { paths, line, via: "exact" };
    }

    for candidate in sibling_candidates(&rel, &cwd, repo_root.as_deref(), &home, MAX_RUNGS) {
        if std::fs::symlink_metadata(&candidate).is_ok() {
            return ResolveResult::Hit {
                reference: ResolvedRef { path: candidate, line, source: "sibling" },
            };
        }
    }

    let fuzzy = rank_fuzzy(&rel, &entries, 20);
    if fuzzy.is_empty() {
        // Nothing on disk anywhere. A path-shaped token may still be a file git
        // holds and the working tree does not.
        if rel.contains('/') {
            let repos = git_probe_repos(&rel, &cwd, repo_root.as_deref(), &home);
            if let Some((repo, rev, subject)) = git_absent(&rel, &repos) {
                return ResolveResult::Absent { repo, rev, path: rel, subject };
            }
        }
        return ResolveResult::Miss;
    }
    ResolveResult::Choices {
        paths: fuzzy.into_iter().map(|(path, _)| path).collect(),
        line,
        via: "fuzzy",
    }
}

/// Every ⌘-click resolution lands in instant.log as one `resolve_ref` event:
/// what was asked, what the ledger offered, which rung answered, how long.
#[tauri::command]
pub async fn resolve_ref(
    app: tauri::AppHandle,
    token: String,
    cwd: String,
    sessions: Option<Vec<String>>,
) -> Result<ResolveResult, String> {
    let home = home_dir();
    let sessions = sessions.unwrap_or_default();
    let started = Instant::now();
    let (result, evidence_paths, evidence_dirs) = tauri::async_runtime::spawn_blocking({
        let token = token.clone();
        let cwd = cwd.clone();
        let sessions = sessions.clone();
        move || {
            let evidence = crate::boop::agent_evidence(&sessions, &home);
            let result = resolve_ref_with(token, cwd, home, &evidence);
            (result, evidence.paths.len(), evidence.dirs.len())
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let (kind, path, source, via, count) = match &result {
        ResolveResult::Hit { reference } => ("hit", reference.path.clone(), reference.source, "", 1),
        ResolveResult::Choices { paths, via, .. } => ("choices", paths.first().cloned().unwrap_or_default(), "", *via, paths.len()),
        ResolveResult::Absent { repo, rev, .. } => ("absent", format!("{repo}@{rev}"), "", "", 0),
        ResolveResult::Miss => ("miss", String::new(), "", "", 0),
    };
    crate::log_event(
        &app,
        "INFO",
        "resolve_ref",
        serde_json::json!({
            "token": token,
            "cwd": cwd,
            "sessions": sessions,
            "evidence_paths": evidence_paths,
            "evidence_dirs": evidence_dirs,
            "result": kind,
            "path": path,
            "source": source,
            "via": via,
            "count": count,
            "ms": started.elapsed().as_millis() as u64,
        }),
    );
    Ok(result)
}

/// The bytes of a path at a revision, for a file the working tree does not hold.
#[tauri::command]
pub async fn read_git_blob(repo: String, rev: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_out(&repo, &["show", &format!("{rev}:{path}")])
            .ok_or_else(|| format!("{path} is not in {rev}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clear_ref_index() {
    clear_index_cache();
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/me";
    const REPO: &str = "/Users/me/projects/instant";

    fn file(path: &str) -> IndexEntry {
        IndexEntry {
            path: path.to_string(),
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            is_dir: false,
        }
    }

    fn dir(path: &str) -> IndexEntry {
        IndexEntry { is_dir: true, ..file(path) }
    }

    fn index() -> Vec<IndexEntry> {
        vec![
            file(&format!("{REPO}/src/main.ts")),
            file(&format!("{REPO}/src/preview.ts")),
            file(&format!("{REPO}/src/mdview/MdPanel.tsx")),
            file(&format!("{REPO}/e2e/MdPanel.tsx")),
            file(&format!("{REPO}/packages/patchset-diff/src/index.ts")),
            dir(&format!("{REPO}/src")),
            dir(&format!("{REPO}/src/mdview")),
            dir(&format!("{REPO}/e2e")),
            dir(&format!("{REPO}/packages")),
            dir(&format!("{REPO}/packages/patchset-diff")),
        ]
    }

    /// RECEIPT. A repo-relative token whose file sits inside a gitignored
    /// directory resolves to that file, before fzf gets to guess.
    #[test]
    fn a_file_inside_a_gitignored_directory_still_resolves() {
        let root = std::env::temp_dir().join(format!("instant-ignored-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let lab = root.join("labs").join("otel");
        std::fs::create_dir_all(lab.join("out")).unwrap();
        std::fs::write(lab.join(".gitignore"), "out\n").unwrap();
        std::fs::write(lab.join("out").join("timeline.txt"), "0.371s span>\n").unwrap();
        std::fs::write(root.join("README.md"), "root\n").unwrap();
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "-q"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "git init in {}", root.display());
        clear_index_cache();
        let entries = index_for(&root);
        assert!(
            !entries.iter().any(|e| e.path.ends_with("out/timeline.txt")),
            "the walker honours .gitignore, so the file is not indexed"
        );
        let cwd = root.to_string_lossy().into_owned();
        let result = resolve_ref_blocking("out/timeline.txt".into(), cwd.clone(), cwd.clone());
        let expected = lab.join("out").join("timeline.txt").to_string_lossy().into_owned();
        assert_eq!(
            result,
            ResolveResult::Hit {
                reference: ResolvedRef { path: expected, line: None, source: "ignored" }
            }
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// RECEIPT. What the agent touched outranks every filesystem guess: the
    /// token joins to a directory above a touched file, so a file the walker
    /// never indexes (gitignored `out/`) resolves from the ledger alone.
    #[test]
    fn a_token_resolves_beside_a_file_the_agent_touched() {
        let root = std::env::temp_dir().join(format!("instant-evidence-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let lab = root.join("labs").join("otel");
        std::fs::create_dir_all(lab.join("out")).unwrap();
        std::fs::write(lab.join("out").join("timeline.txt"), "t\n").unwrap();
        std::fs::write(lab.join("out").join("perfetto.png"), "p\n").unwrap();
        let touched = lab.join("out").join("perfetto.png").to_string_lossy().into_owned();
        let boundary = root.to_string_lossy().into_owned();
        let evidence = crate::boop::AgentEvidence {
            dirs: crate::boop::evidence_dirs(&[touched.clone()], &[], &boundary),
            paths: vec![touched.clone()],
        };
        assert_eq!(
            evidence.dirs,
            vec![
                lab.join("out").to_string_lossy().into_owned(),
                lab.to_string_lossy().into_owned(),
                root.join("labs").to_string_lossy().into_owned(),
            ]
        );
        let cwd = boundary.clone();
        let hit = resolve_ref_with("out/timeline.txt:3".into(), cwd.clone(), boundary.clone(), &evidence);
        assert_eq!(
            hit,
            ResolveResult::Hit {
                reference: ResolvedRef {
                    path: lab.join("out").join("timeline.txt").to_string_lossy().into_owned(),
                    line: Some(3),
                    source: "touched",
                }
            }
        );
        let exact = resolve_ref_with("perfetto.png".into(), cwd, boundary, &evidence);
        assert_eq!(
            exact,
            ResolveResult::Hit {
                reference: ResolvedRef { path: touched, line: None, source: "touched" }
            }
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// RECEIPT. A token with an extension never fuzzes onto a file of another
    /// kind: `out/by-test.md` finds no `.md` here, so fzf answers nothing.
    #[test]
    fn fzf_keeps_the_extension_literal() {
        let entries = vec![
            file(&format!("{REPO}/node_modules/.pnpm/buffer-equal-constant-time@1.0.1/node_modules/buffer-equal-constant-time/index.js")),
            dir(&format!("{REPO}/node_modules/.pnpm/buffer-equal-constant-time@1.0.1/node_modules/buffer-equal-constant-time")),
            file(&format!("{REPO}/lab/out/by-tests.md")),
        ];
        let hits = rank_fuzzy("out/by-test.md", &entries, 20);
        assert_eq!(hits.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec![format!("{REPO}/lab/out/by-tests.md").as_str()]);
        assert!(rank_fuzzy("out/by-test.txt", &entries, 20).is_empty());
    }

    #[test]
    fn splits_a_line_reference() {
        assert_eq!(split_line_ref("src/main.ts:214"), ("src/main.ts".into(), Some(214)));
        assert_eq!(split_line_ref("main.ts"), ("main.ts".into(), None));
        assert_eq!(split_line_ref("http://host:8080"), ("http://host:8080".into(), None));
        assert_eq!(split_line_ref("C:8"), ("C:8".into(), None));
    }

    #[test]
    fn recognizes_path_shapes() {
        assert!(looks_like_path("src/main.ts"));
        assert!(looks_like_path("MdPanel.tsx"));
        assert!(looks_like_path("~/notes.md"));
        assert!(!looks_like_path("renderPathInto"));
        assert!(!looks_like_path("https://example.com/a.ts"));
    }

    #[test]
    fn walks_ancestors_to_the_boundary() {
        assert_eq!(
            ancestors_of(&format!("{REPO}/src/mdview"), HOME, 8),
            vec![
                format!("{REPO}/src/mdview"),
                format!("{REPO}/src"),
                REPO.to_string(),
                format!("{HOME}/projects"),
                HOME.to_string(),
            ]
        );
        assert_eq!(ancestors_of(&format!("{REPO}/src"), HOME, 1), vec![format!("{REPO}/src")]);
        assert_eq!(ancestors_of("/tmp/e2e/src", HOME, 8), vec!["/tmp/e2e/src", "/tmp/e2e", "/tmp"]);
        assert!(ancestors_of("/", HOME, 8).is_empty());
    }

    #[test]
    fn orders_the_rungs_cwd_then_repo_then_ancestors() {
        let candidates = crawl_candidates("notes.md", &format!("{REPO}/src"), Some(REPO), HOME, 8);
        assert_eq!(
            candidates,
            vec![
                (format!("{REPO}/src/notes.md"), "cwd"),
                (format!("{REPO}/notes.md"), "repo"),
                (format!("{HOME}/projects/notes.md"), "ancestor"),
                (format!("{HOME}/notes.md"), "ancestor"),
            ]
        );
    }

    #[test]
    fn reaches_a_sibling_repo_and_leaves_absolutes_alone() {
        let paths: Vec<String> =
            crawl_candidates("instant-lanes/README.md", &format!("{REPO}/src"), Some(REPO), HOME, 8)
                .into_iter()
                .map(|(path, _)| path)
                .collect();
        assert!(paths.contains(&format!("{HOME}/projects/instant-lanes/README.md")));
        assert_eq!(
            crawl_candidates("/a/b.ts", &format!("{REPO}/src"), Some(REPO), HOME, 8),
            vec![("/a/b.ts".to_string(), "absolute")]
        );
    }

    #[test]
    fn ranks_an_exact_tail_over_a_filename() {
        let entries = index();
        assert_eq!(
            rank_exact("MdPanel.tsx", &entries),
            vec![
                (format!("{REPO}/e2e/MdPanel.tsx"), true),
                (format!("{REPO}/src/mdview/MdPanel.tsx"), true),
            ]
        );
        // The whole-tail match sorts first and is the only one marked as such.
        assert_eq!(
            rank_exact("mdview/MdPanel.tsx", &entries),
            vec![
                (format!("{REPO}/src/mdview/MdPanel.tsx"), true),
                (format!("{REPO}/e2e/MdPanel.tsx"), false),
            ]
        );
        assert!(rank_exact("nope.ts", &entries).is_empty());
    }

    #[test]
    fn fzf_finds_abbreviated_names_and_folders() {
        let entries = index();
        assert_eq!(rank_fuzzy("prevew.ts", &entries, 5)[0].0, format!("{REPO}/src/preview.ts"));
        let mdpanel: Vec<String> = rank_fuzzy("mdpanel", &entries, 5).into_iter().map(|(p, _)| p).collect();
        assert_eq!(
            mdpanel,
            vec![format!("{REPO}/e2e/MdPanel.tsx"), format!("{REPO}/src/mdview/MdPanel.tsx")]
        );
        assert_eq!(
            rank_fuzzy("patchset-diff", &entries, 5)[0].0,
            format!("{REPO}/packages/patchset-diff")
        );
    }

    #[test]
    fn fzf_refuses_noise() {
        let entries = index();
        assert!(rank_fuzzy("qqqqzz", &entries, 5).is_empty());
        assert!(rank_fuzzy("nope.ts", &entries, 5).is_empty());
        assert!(rank_fuzzy(".ts", &entries, 5).is_empty());
    }

    #[test]
    fn folder_words_resolve_only_when_unique() {
        let entries = index();
        assert_eq!(
            unique_dir_named("patchset-diff", &entries),
            Some(format!("{REPO}/packages/patchset-diff"))
        );
        assert_eq!(unique_dir_named("mdview", &entries), Some(format!("{REPO}/src/mdview")));
        assert_eq!(unique_dir_named("e2e", &entries), None);
        assert_eq!(unique_dir_named("MdPanel.tsx", &entries), None);
    }

    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!("instant-refresolve-{name}"));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Tree(root)
        }

        fn file(&self, rel: &str) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "x").unwrap();
            path
        }

        fn path(&self, rel: &str) -> String {
            self.0.join(rel).to_string_lossy().into_owned()
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn resolve(tree: &Tree, token: &str, cwd: &str) -> ResolveResult {
        clear_index_cache();
        resolve_ref_blocking(token.to_string(), cwd.to_string(), tree.0.to_string_lossy().into())
    }

    #[test]
    fn resolves_against_a_real_tree() {
        let tree = Tree::new("ladder");
        tree.file("projects/instant/.git/HEAD");
        tree.file("projects/instant/src/main.ts");
        tree.file("projects/instant/src/preview.ts");
        tree.file("projects/instant/e2e/MdPanel.tsx");
        tree.file("projects/instant/src/mdview/MdPanel.tsx");
        tree.file("projects/instant-lanes/README.md");
        tree.file("TODO.md");
        let cwd = tree.path("projects/instant/src");

        assert_eq!(
            resolve(&tree, "main.ts", &cwd),
            ResolveResult::Hit {
                reference: ResolvedRef {
                    path: tree.path("projects/instant/src/main.ts"),
                    line: None,
                    source: "cwd",
                },
            }
        );
        assert_eq!(
            resolve(&tree, "main.ts:214", &cwd),
            ResolveResult::Hit {
                reference: ResolvedRef {
                    path: tree.path("projects/instant/src/main.ts"),
                    line: Some(214),
                    source: "cwd",
                },
            }
        );
        assert_eq!(
            resolve(&tree, "e2e/MdPanel.tsx", &cwd),
            ResolveResult::Hit {
                reference: ResolvedRef {
                    path: tree.path("projects/instant/e2e/MdPanel.tsx"),
                    line: None,
                    source: "repo",
                },
            }
        );
        assert_eq!(
            resolve(&tree, "instant-lanes/README.md", &cwd),
            ResolveResult::Hit {
                reference: ResolvedRef {
                    path: tree.path("projects/instant-lanes/README.md"),
                    line: None,
                    source: "ancestor",
                },
            }
        );
        assert_eq!(
            resolve(&tree, "TODO.md", &cwd),
            ResolveResult::Hit {
                reference: ResolvedRef { path: tree.path("TODO.md"), line: None, source: "ancestor" },
            }
        );
    }

    #[test]
    fn falls_through_exact_then_fuzzy_then_ripgrep() {
        let tree = Tree::new("fallthrough");
        tree.file("repo/.git/HEAD");
        tree.file("repo/src/preview.ts");
        tree.file("repo/src/mdview/MdPanel.tsx");
        tree.file("repo/e2e/MdPanel.tsx");
        tree.file("repo/packages/patchset-diff/src/index.ts");
        let cwd = tree.path("repo/src");

        assert_eq!(
            resolve(&tree, "MdPanel.tsx", &cwd),
            ResolveResult::Choices {
                paths: vec![
                    tree.path("repo/e2e/MdPanel.tsx"),
                    tree.path("repo/src/mdview/MdPanel.tsx"),
                ],
                line: None,
                via: "exact",
            }
        );
        assert_eq!(
            resolve(&tree, "prevew.ts", &cwd),
            ResolveResult::Choices {
                paths: vec![tree.path("repo/src/preview.ts")],
                line: None,
                via: "fuzzy",
            }
        );
        assert_eq!(
            resolve(&tree, "patchset-diff", &cwd),
            ResolveResult::Hit {
                reference: ResolvedRef {
                    path: tree.path("repo/packages/patchset-diff"),
                    line: None,
                    source: "fuzzy",
                },
            }
        );
        assert_eq!(resolve(&tree, "qqqzzz.ts", &cwd), ResolveResult::Miss);
        assert_eq!(resolve(&tree, "renderPathInto", &cwd), ResolveResult::Miss);
    }

    fn git(tree: &Tree, rel: &str, args: &[&str]) -> String {
        let repo = tree.0.join(rel);
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn crawls_sideways_into_a_sibling_checkout() {
        let tree = Tree::new("siblings");
        tree.file("projects/instant/.git/HEAD");
        tree.file("projects/instant/src/main.ts");
        tree.file("projects/sprefa/.git/HEAD");
        tree.file("projects/sprefa/plans/bench/STUDY.md");
        let cwd = tree.path("projects/instant/src");

        // The token is relative to sprefa's root, so no ancestor join reaches it.
        let joins = crawl_candidates("plans/bench/STUDY.md", &cwd, None, &tree.0.to_string_lossy(), 8);
        let _ = sibling_candidates("plans/bench/STUDY.md", &cwd, None, &tree.0.to_string_lossy(), 8);
        assert!(joins.iter().all(|(path, _)| std::fs::symlink_metadata(path).is_err()));

        assert_eq!(
            resolve(&tree, "plans/bench/STUDY.md", &cwd),
            ResolveResult::Hit {
                reference: ResolvedRef {
                    path: tree.path("projects/sprefa/plans/bench/STUDY.md"),
                    line: None,
                    source: "sibling",
                },
            }
        );
    }

    #[test]
    fn reports_a_path_only_git_still_holds() {
        let tree = Tree::new("gitabsent");
        tree.file("projects/instant/.git/HEAD");
        tree.file("projects/sprefa/plans/keep.md");
        tree.file("projects/sprefa/plans/STUDY.md");
        git(&tree, "projects/sprefa", &["init", "-q", "-b", "main"]);
        git(&tree, "projects/sprefa", &["add", "-A"]);
        git(&tree, "projects/sprefa", &["commit", "-qm", "study doc"]);
        let rev = git(&tree, "projects/sprefa", &["rev-parse", "HEAD"]);
        std::fs::remove_file(tree.0.join("projects/sprefa/plans/STUDY.md")).unwrap();
        git(&tree, "projects/sprefa", &["commit", "-aqm", "drop it"]);
        let cwd = tree.path("projects/instant");

        match resolve(&tree, "plans/STUDY.md", &cwd) {
            ResolveResult::Absent { repo, rev: found, path, subject } => {
                assert_eq!(repo, tree.path("projects/sprefa"));
                assert_eq!(found, rev);
                assert_eq!(path, "plans/STUDY.md");
                assert!(subject.ends_with("study doc"), "{subject}");
            }
            other => panic!("expected Absent, got {other:?}"),
        }
    }

    #[test]
    fn serializes_the_shape_the_renderer_expects() {
        let hit = ResolveResult::Hit {
            reference: ResolvedRef { path: "/a/b.ts".into(), line: Some(9), source: "cwd" },
        };
        assert_eq!(
            serde_json::to_string(&hit).unwrap(),
            r#"{"kind":"hit","ref":{"path":"/a/b.ts","line":9,"source":"cwd"}}"#
        );
        let choices =
            ResolveResult::Choices { paths: vec!["/a/b.ts".into()], line: None, via: "fuzzy" };
        assert_eq!(
            serde_json::to_string(&choices).unwrap(),
            r#"{"kind":"choices","paths":["/a/b.ts"],"via":"fuzzy"}"#
        );
        assert_eq!(serde_json::to_string(&ResolveResult::Miss).unwrap(), r#"{"kind":"miss"}"#);
        let absent = ResolveResult::Absent {
            repo: "/r".into(),
            rev: "abc".into(),
            path: "plans/x.md".into(),
            subject: "abc study".into(),
        };
        assert_eq!(
            serde_json::to_string(&absent).unwrap(),
            r#"{"kind":"absent","repo":"/r","rev":"abc","path":"plans/x.md","subject":"abc study"}"#
        );
    }
}
