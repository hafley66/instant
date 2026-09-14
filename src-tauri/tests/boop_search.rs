// Integration tests over the real boop-store schema and real SQLite files.
use boop_store::ident::Store;
use instant_lib::boop_search::{indexed_turns, open_index, search, sync_index, fts_query, snippet};
use rusqlite::params;
use std::path::{Path, PathBuf};


/// A real boop.db with the real schema, filled through its own connection.
struct Fixture {
    dir: tempfile::TempDir,
    boop: PathBuf,
    index: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let boop = dir.path().join("boop.db");
    let index = dir.path().join("boop-search.db");
    let store = Store::open(boop.clone()).expect("real boop-store schema");
    let conn = store.connection();
    conn.execute_batch(
        "INSERT OR IGNORE INTO dict_role (value) VALUES ('user'), ('assistant'), ('tool');
         INSERT OR IGNORE INTO dict_harness (value) VALUES ('claude');
         INSERT OR IGNORE INTO dict_cwd (value) VALUES ('/work/repo');
         INSERT INTO dict_session (value) VALUES ('sess-a'), ('sess-b');
         INSERT INTO agent_session (session_id, harness_id, nickname, cwd_id, started_ts)
           SELECT id, (SELECT id FROM dict_harness WHERE value = 'claude'), 'alpha',
                  (SELECT id FROM dict_cwd WHERE value = '/work/repo'), 1000
           FROM dict_session WHERE value = 'sess-a';
         INSERT INTO agent_session (session_id, harness_id, nickname, cwd_id, started_ts)
           SELECT id, (SELECT id FROM dict_harness WHERE value = 'claude'), NULL, NULL, 2000
           FROM dict_session WHERE value = 'sess-b';",
    )
    .unwrap();
    drop(store);
    Fixture { dir, boop, index }
}

fn add_turn(boop: &Path, session: &str, turn: i64, ts: i64, role: &str, said: &str) {
    let store = Store::open(boop.to_path_buf()).unwrap();
    store
        .connection()
        .execute(
            "INSERT INTO agent_turn (session_id, turn, ts, role_id, said)
             VALUES ((SELECT id FROM dict_session WHERE value = ?1), ?2, ?3,
                     (SELECT id FROM dict_role WHERE value = ?4), ?5)",
            params![session, turn, ts, role, said],
        )
        .unwrap();
}

#[test]
fn indexes_user_and_assistant_turns_and_finds_them_case_insensitively() {
    let fx = fixture();
    add_turn(&fx.boop, "sess-a", 0, 10, "user", "breaker breaker, this is Rubber Duck");
    add_turn(&fx.boop, "sess-a", 1, 20, "assistant", "Copy that, Rubber Duck. Ten-four.");
    add_turn(&fx.boop, "sess-a", 2, 30, "tool", "BREAKER output that must never index");
    add_turn(&fx.boop, "sess-b", 0, 40, "user", "unrelated words only");
    let conn = open_index(&fx.index, &fx.boop).unwrap();
    let visited = sync_index(&conn, |_, _| {}).unwrap();
    assert_eq!(visited, 2);
    assert_eq!(indexed_turns(&conn).unwrap(), 3);

    let hits = search(&conn, "BREAKER", "all", 50).unwrap();
    assert_eq!(hits.len(), 1, "the tool turn stays out of the index");
    let hit = &hits[0];
    assert_eq!((hit.session.as_str(), hit.turn, hit.role.as_str()), ("sess-a", 0, "user"));
    assert_eq!(hit.harness, "claude");
    assert_eq!(hit.cwd.as_deref(), Some("/work/repo"));
    assert_eq!(hit.nickname.as_deref(), Some("alpha"));
    assert_eq!(hit.session_last_ts, 30, "last activity counts every role");
    assert_eq!(hit.session_turns, 3);
    assert!(hit.snippet.to_lowercase().contains("breaker"));

    let ducks = search(&conn, "rubber duck", "all", 50).unwrap();
    assert_eq!(ducks.iter().map(|hit| hit.turn).collect::<Vec<_>>(), vec![1, 0], "newest first");
    let bots = search(&conn, "rubber", "assistant", 50).unwrap();
    assert_eq!(bots.len(), 1);
    assert_eq!(bots[0].role, "assistant");
    assert!(search(&conn, "   ", "all", 50).unwrap().is_empty());
    assert_eq!(search(&conn, "rubb", "all", 50).unwrap().len(), 2, "prefix match");
    drop(fx.dir);
}

#[test]
fn second_sync_only_appends_turns_past_each_session_mark() {
    let fx = fixture();
    add_turn(&fx.boop, "sess-a", 0, 10, "user", "first question");
    let conn = open_index(&fx.index, &fx.boop).unwrap();
    assert_eq!(sync_index(&conn, |_, _| {}).unwrap(), 1);
    assert_eq!(sync_index(&conn, |_, _| {}).unwrap(), 0, "nothing moved, nothing visited");

    add_turn(&fx.boop, "sess-a", 1, 20, "assistant", "second answer");
    add_turn(&fx.boop, "sess-b", 0, 30, "user", "third thing");
    let mut ticks = Vec::new();
    assert_eq!(sync_index(&conn, |done, total| ticks.push((done, total))).unwrap(), 2);
    assert_eq!(ticks, vec![(0, 2), (2, 2)]);
    assert_eq!(indexed_turns(&conn).unwrap(), 3);
    assert_eq!(search(&conn, "second", "all", 50).unwrap()[0].turn, 1);
    assert_eq!(search(&conn, "third", "user", 50).unwrap()[0].session, "sess-b");
    drop(fx.dir);
}

#[test]
fn fts_query_and_snippet_shapes() {
    assert_eq!(fts_query("breaker  \"rig\" "), "\"breaker\"* \"rig\"*");
    assert_eq!(fts_query("  "), "");
    let long = format!("{}NEEDLE{}", "a".repeat(300), "b".repeat(300));
    let s = snippet(&long, "needle");
    assert!(s.starts_with('…') && s.ends_with('…'));
    assert!(s.contains("NEEDLE"));
    assert!(s.find("NEEDLE").unwrap() <= 45, "match sits near the snippet head: {s}");
    assert_eq!(snippet("short text", "zzz"), "short text");
}

/// Real-database timing: `BOOP_DB=~/.agent/boop.db BOOP_SEARCH_INDEX=/tmp/x.db cargo test --test boop_search -- --ignored real_db`.
#[test]
#[ignore]
fn real_db_index_and_search_timing() {
    let boop = PathBuf::from(std::env::var("BOOP_DB").expect("BOOP_DB"));
    let index = PathBuf::from(std::env::var("BOOP_SEARCH_INDEX").expect("BOOP_SEARCH_INDEX"));
    let conn = open_index(&index, &boop).unwrap();
    let started = std::time::Instant::now();
    let visited = sync_index(&conn, |done, total| {
        if done % 1000 == 0 {
            eprintln!("sync {done}/{total} at {:?}", started.elapsed());
        }
    })
    .unwrap();
    eprintln!("sync visited {visited} sessions, {} turns indexed, in {:?}", indexed_turns(&conn).unwrap(), started.elapsed());
    for (needle, role) in [("breaker", "all"), ("rubber duck", "user"), ("subscribe", "assistant"), ("boop", "all")] {
        let t = std::time::Instant::now();
        let hits = search(&conn, needle, role, 500).unwrap();
        eprintln!("search {needle:?} role={role}: {} hits in {:?}; first: {:?}", hits.len(), t.elapsed(), hits.first().map(|h| (&h.session, h.turn, &h.snippet)));
    }
}
