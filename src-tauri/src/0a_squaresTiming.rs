use std::time::Instant;

#[derive(Default, serde::Serialize)]
pub(super) struct ProjectionTiming {
    pub window_ms: f64,
    pub capture_ms: f64,
    pub store_ms: f64,
    pub turns_ms: f64,
    pub match_ms: f64,
    pub tags_ms: f64,
}

pub(super) fn elapsed_ms(start: &mut Instant) -> f64 {
    let now = Instant::now();
    let milliseconds = now.duration_since(*start).as_secs_f64() * 1000.0;
    *start = now;
    milliseconds
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "explicit read-only projection probe; requires session and tmux target"]
    fn read_only_projection_probe() {
        let session = std::env::var("INSTANT_PROFILE_SESSION").expect("explicit session");
        let target = std::env::var("INSTANT_PROFILE_TARGET").expect("explicit target");
        let socket = std::env::var("INSTANT_PROFILE_SOCKET").ok();
        let (strip, timing) = super::super::project_timed(&session, &target, socket.as_deref(), &Default::default()).unwrap();
        println!("{}", serde_json::json!({ "session": session, "rows": strip.rows,
            "turns": strip.turns.len(), "pinned": strip.pinned.len(), "stages": timing }));
    }
}
