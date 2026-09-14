// Real-filesystem tests for the bounded rustdoc resolver. Integration rather
// than in-module: the resolver reads and canonicalizes real paths, and this tier
// builds the lib without its cfg(test) code.

use std::path::PathBuf;

use instant_lib::serve::rustdoc::{canonical_root, crate_list, listing_html, resolve, DocError};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("instant-rustdoc-unit-{}", std::process::id()));
    let dir = dir.join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("docprobe/static.files")).unwrap();
    std::fs::write(dir.join("docprobe/index.html"), "<html>crate</html>").unwrap();
    std::fs::write(dir.join("docprobe/struct.Pair.html"), "<html>pair</html>").unwrap();
    std::fs::write(dir.join("docprobe/static.files/main.js"), "// js").unwrap();
    dir
}

#[test]
fn canonical_root_rejects_files_and_missing_paths() {
    let root = scratch("canonical");
    assert!(canonical_root(&root).is_ok());
    assert!(canonical_root(&root.join("docprobe/index.html")).is_err());
    assert!(canonical_root(&root.join("nope")).is_err());
}

#[test]
fn serves_files_and_appends_index_for_directories() {
    let root = canonical_root(&scratch("serve")).unwrap();
    let (file, mime) = resolve(&root, "docprobe/index.html").unwrap();
    assert!(file.ends_with("docprobe/index.html"));
    assert_eq!(mime, "text/html; charset=utf-8");
    let (dir, mime) = resolve(&root, "docprobe").unwrap();
    assert!(dir.ends_with("docprobe/index.html"));
    assert_eq!(mime, "text/html; charset=utf-8");
    let (_, js) = resolve(&root, "docprobe/static.files/main.js").unwrap();
    assert_eq!(js, "text/javascript; charset=utf-8");
}

#[test]
fn serves_from_a_root_path_containing_spaces() {
    let root = canonical_root(&scratch("root with spaces")).unwrap();
    let (file, _) = resolve(&root, "docprobe/index.html").unwrap();
    assert!(file.starts_with(&root));
    assert!(file.to_string_lossy().contains("root with spaces"));
}

#[test]
fn rejects_parent_and_encoded_traversal() {
    let root = canonical_root(&scratch("traversal")).unwrap();
    assert_eq!(resolve(&root, "../secret"), Err(DocError::Forbidden));
    assert_eq!(resolve(&root, "..%2fsecret"), Err(DocError::Forbidden));
    assert_eq!(resolve(&root, "%2e%2e/secret"), Err(DocError::Forbidden));
    assert_eq!(resolve(&root, "docprobe/../../secret"), Err(DocError::Forbidden));
}

#[test]
fn rejects_symlink_escape_and_keeps_absolute_inside_root() {
    let root = canonical_root(&scratch("escape")).unwrap();
    let outside = std::env::temp_dir().join(format!("instant-rustdoc-outside-{}", std::process::id()));
    std::fs::write(&outside, "secret").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("docprobe/leak.html")).unwrap();
    // A leading slash is treated as relative to the root, so it can only
    // resolve inside it; an existing outer file is simply not found.
    assert_eq!(resolve(&root, "/etc/hosts"), Err(DocError::NotFound));
    #[cfg(unix)]
    assert_eq!(resolve(&root, "docprobe/leak.html"), Err(DocError::Forbidden));
    let _ = std::fs::remove_file(&outside);
}

#[test]
fn missing_and_malformed_paths_are_not_found_or_forbidden() {
    let root = canonical_root(&scratch("missing")).unwrap();
    assert_eq!(resolve(&root, "docprobe/nope.html"), Err(DocError::NotFound));
    assert_eq!(resolve(&root, "docprobe/%zz"), Err(DocError::Forbidden));
}

#[test]
fn listing_names_only_crate_directories() {
    let root = canonical_root(&scratch("listing")).unwrap();
    std::fs::create_dir_all(root.join("search.index")).unwrap();
    std::fs::write(root.join("search.index/root.js"), "//").unwrap();
    assert_eq!(crate_list(&root), vec!["docprobe".to_string()]);
    let html = listing_html(&root);
    assert!(html.contains("docprobe/index.html"));
    assert!(!html.contains("search.index"));
}
