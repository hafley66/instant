// Services: every managed State<T> payload in one struct, built once at boot and
// managed as Arc<Services> so background threads (ingest server, pty reader, cdp
// attach) share it the way they shared Tauri-managed state before.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use crate::activity::{ActivityDb, CaptureEnabled, RulesState, WatcherState};
use crate::capture::{TapActive, WindowFocused};
use crate::cdp::{CdpStore, ChromeEngine};
use crate::config::ConfigState;
use crate::favorites::Favorites;
use crate::fs_watch::FsWatchClaims;
use crate::pty::PtyStore;
use crate::pty_events::PtyEvents;
use crate::workspace::Workspaces;

pub struct Services {
    pub pty: PtyStore,
    pub pty_events: PtyEvents,
    pub cdp: CdpStore,
    pub chrome_engine: ChromeEngine,
    pub workspaces: Workspaces,
    pub favorites: Favorites,
    pub fs_watch: FsWatchClaims,
    pub capture_enabled: CaptureEnabled,
    pub tap_active: TapActive,
    pub window_focused: WindowFocused,
    pub activity: ActivityDb,
    pub config: ConfigState,
    pub rules: RulesState,
    pub watcher: WatcherState,
}

impl Services {
    /// Build all state the way lib.rs setup used to, keyed off `data_dir`.
    pub fn boot(data_dir: &Path) -> Result<Services, String> {
        let conn = crate::activity::open(&data_dir.join("activity.db")).map_err(|e| e.to_string())?;

        let cfg_path = data_dir.join("config.json");
        let (cfg, status) = crate::config::read_or_default(&cfg_path);

        let rules_path = data_dir.join("rules.json");
        let rules = crate::activity::read_rules(&rules_path);

        let favorites = Favorites::default();
        crate::favorites::init(&favorites, data_dir);

        Ok(Services {
            pty: PtyStore::default(),
            pty_events: PtyEvents::default(),
            cdp: CdpStore::default(),
            chrome_engine: ChromeEngine::default(),
            workspaces: Workspaces(Mutex::new(crate::workspace::load(data_dir))),
            favorites,
            fs_watch: FsWatchClaims::default(),
            capture_enabled: CaptureEnabled(Arc::new(AtomicBool::new(false))),
            tap_active: TapActive(Arc::new(AtomicBool::new(false))),
            window_focused: WindowFocused(Arc::new(AtomicBool::new(false))),
            activity: ActivityDb(Mutex::new(conn)),
            config: ConfigState {
                config: Mutex::new(cfg),
                path: cfg_path,
                status: Mutex::new(status),
                excluded_count: AtomicU64::new(0),
            },
            rules: RulesState {
                rules: Mutex::new(rules),
                path: rules_path,
                revision: AtomicU64::new(1),
            },
            watcher: WatcherState(Mutex::new(Default::default())),
        })
    }
}
