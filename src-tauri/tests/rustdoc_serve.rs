// Real-filesystem tests for the bounded rustdoc resolver. Integration rather
// than in-module: the resolver reads and canonicalizes real paths, and this tier
// builds the lib without its cfg(test) code.

use std::path::PathBuf;

use instant_lib::serve::rustdoc::{canonical_root, crate_list, listing_html, resolve, DocError};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join(format!("instant-rustdoc-unit-{}", std::process::id()))
        .join(name);
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
    let file = resolve(&root, "docprobe/index.html").unwrap();
    assert!(file.ends_with("docprobe/index.html"));
    let dir = resolve(&root, "docprobe").unwrap();
    assert!(dir.ends_with("docprobe/index.html"));
    let js = resolve(&root, "docprobe/static.files/main.js").unwrap();
    assert!(js.ends_with("static.files/main.js"));
}

#[test]
fn serves_from_a_root_path_containing_spaces() {
    let root = canonical_root(&scratch("root with spaces")).unwrap();
    let file = resolve(&root, "docprobe/index.html").unwrap();
    assert!(file.starts_with(&root));
    assert!(file.to_string_lossy().contains("root with spaces"));
}

#[test]
fn serves_a_filename_containing_a_literal_percent() {
    // The extractor decodes once, so `%25` arrived as `%`; the resolver must not
    // decode again or the name would be treated as an escape sequence.
    let root = canonical_root(&scratch("percent")).unwrap();
    std::fs::write(root.join("100%.html"), "<html>percent</html>").unwrap();
    let file = resolve(&root, "100%.html").unwrap();
    assert!(file.ends_with("100%.html"));
}

#[test]
fn rejects_parent_traversal() {
    let root = canonical_root(&scratch("traversal")).unwrap();
    assert_eq!(resolve(&root, "../secret"), Err(DocError::Forbidden));
    assert_eq!(resolve(&root, "docprobe/../../secret"), Err(DocError::Forbidden));
    assert_eq!(resolve(&root, ".."), Err(DocError::Forbidden));
}

#[test]
fn rejects_symlink_escape_of_a_file_and_of_a_directory_index() {
    let root = canonical_root(&scratch("escape")).unwrap();
    let outside_file = std::env::temp_dir()
        .join(format!("instant-rustdoc-outside-file-{}", std::process::id()));
    let outside_index = std::env::temp_dir()
        .join(format!("instant-rustdoc-outside-index-{}", std::process::id()));
    std::fs::write(&outside_file, "secret").unwrap();
    std::fs::write(&outside_index, "<html>secret</html>").unwrap();
    std::fs::create_dir_all(root.join("linked")).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside_file, root.join("docprobe/leak.html")).unwrap();
        // A directory whose index.html is a symlink out of the root must be
        // rejected when the URL asks for the directory, not just the file name.
        std::os::unix::fs::symlink(&outside_index, root.join("linked/index.html")).unwrap();
        assert_eq!(resolve(&root, "docprobe/leak.html"), Err(DocError::Forbidden));
        assert_eq!(resolve(&root, "linked"), Err(DocError::Forbidden));
        assert_eq!(resolve(&root, "linked/index.html"), Err(DocError::Forbidden));
    }
    let _ = std::fs::remove_file(&outside_file);
    let _ = std::fs::remove_file(&outside_index);
}

#[test]
fn missing_and_nul_paths_are_not_found_or_forbidden() {
    let root = canonical_root(&scratch("missing")).unwrap();
    assert_eq!(resolve(&root, "docprobe/nope.html"), Err(DocError::NotFound));
    assert_eq!(resolve(&root, "docprobe/\0x"), Err(DocError::Forbidden));
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
