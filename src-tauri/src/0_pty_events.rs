use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

const QUEUE_CAPACITY: usize = 256;
const MAX_BATCH_CHUNKS: usize = 256;
const BATCH_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct PtyData {
    pub id: String,
    pub chunk: String,
}

#[derive(Debug, Serialize, Clone)]
struct PtyDataBatch {
    chunks: Vec<PtyData>,
}

#[derive(Debug, Serialize)]
pub struct PtyEventStats {
    batches: u64,
    chunks: u64,
    backpressure: u64,
}

#[derive(Default)]
struct Counters {
    batches: AtomicU64,
    chunks: AtomicU64,
    backpressure: AtomicU64,
}

pub struct PtyEvents {
    sender: SyncSender<PtyData>,
    receiver: Mutex<Option<Receiver<PtyData>>>,
    counters: Arc<Counters>,
}

#[derive(Clone)]
pub struct PtyEventSender {
    sender: SyncSender<PtyData>,
    counters: Arc<Counters>,
}

impl Default for PtyEvents {
    fn default() -> Self {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
            counters: Arc::new(Counters::default()),
        }
    }
}

impl PtyEvents {
    pub fn start(&self, app: AppHandle) {
        let Some(receiver) = self.receiver.lock().unwrap().take() else {
            return;
        };
        let counters = self.counters.clone();
        std::thread::spawn(move || {
            run_batches(receiver, BATCH_INTERVAL, |chunks| {
                counters.batches.fetch_add(1, Ordering::Relaxed);
                counters
                    .chunks
                    .fetch_add(chunks.len() as u64, Ordering::Relaxed);
                let _ = app.emit("pty-data-batch", PtyDataBatch { chunks });
            });
        });
    }

    pub fn sender(&self) -> PtyEventSender {
        PtyEventSender {
            sender: self.sender.clone(),
            counters: self.counters.clone(),
        }
    }

    fn stats(&self) -> PtyEventStats {
        PtyEventStats {
            batches: self.counters.batches.load(Ordering::Relaxed),
            chunks: self.counters.chunks.load(Ordering::Relaxed),
            backpressure: self.counters.backpressure.load(Ordering::Relaxed),
        }
    }
}

impl PtyEventSender {
    pub fn send(&self, data: PtyData) -> bool {
        match self.sender.try_send(data) {
            Ok(()) => true,
            Err(TrySendError::Full(data)) => {
                self.counters.backpressure.fetch_add(1, Ordering::Relaxed);
                self.sender.send(data).is_ok()
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }
}

fn run_batches(
    receiver: Receiver<PtyData>,
    interval: Duration,
    mut emit: impl FnMut(Vec<PtyData>),
) {
    while let Ok(first) = receiver.recv() {
        let deadline = Instant::now() + interval;
        let mut chunks = vec![first];
        loop {
            let now = Instant::now();
            if chunks.len() >= MAX_BATCH_CHUNKS {
                if now < deadline {
                    std::thread::sleep(deadline - now);
                }
                break;
            }
            if now >= deadline {
                break;
            }
            match receiver.recv_timeout(deadline - now) {
                Ok(chunk) => chunks.push(chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    emit(chunks);
                    return;
                }
            }
        }
        emit(chunks);
    }
}

#[tauri::command]
pub fn pty_event_stats(events: tauri::State<'_, PtyEvents>) -> PtyEventStats {
    events.stats()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_crosses_the_consumer_boundary_once() {
        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        for index in 0..100 {
            sender
                .send(PtyData {
                    id: "term".into(),
                    chunk: index.to_string(),
                })
                .unwrap();
        }
        drop(sender);

        let mut batches = Vec::new();
        run_batches(receiver, Duration::from_secs(1), |batch| {
            batches.push(batch)
        });

        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].len(), 100);
        assert_eq!(batches[0][0].chunk, "0");
        assert_eq!(batches[0][99].chunk, "99");
    }

    #[test]
    fn bounded_queue_reports_full_instead_of_allocating() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        sender
            .send(PtyData {
                id: "a".into(),
                chunk: "first".into(),
            })
            .unwrap();
        let result = sender.try_send(PtyData {
            id: "b".into(),
            chunk: "second".into(),
        });
        assert!(
            matches!(result, Err(TrySendError::Full(PtyData { id, chunk })) if id == "b" && chunk == "second")
        );
    }

    #[test]
    fn emitted_batch_size_has_a_hard_ceiling() {
        let (sender, receiver) = mpsc::sync_channel(512);
        for index in 0..300 {
            sender
                .send(PtyData {
                    id: "term".into(),
                    chunk: index.to_string(),
                })
                .unwrap();
        }
        drop(sender);

        let mut sizes = Vec::new();
        run_batches(receiver, Duration::from_millis(1), |batch| {
            sizes.push(batch.len())
        });

        assert_eq!(sizes, vec![256, 44]);
    }

    #[test]
    fn sustained_burst_cannot_cross_faster_than_the_batch_clock() {
        let (sender, receiver) = mpsc::sync_channel(1024);
        for index in 0..1024 {
            sender
                .send(PtyData {
                    id: "term".into(),
                    chunk: index.to_string(),
                })
                .unwrap();
        }
        drop(sender);

        let started = Instant::now();
        let mut sizes = Vec::new();
        run_batches(receiver, Duration::from_millis(2), |batch| {
            sizes.push(batch.len())
        });

        assert_eq!(sizes, vec![256, 256, 256, 256]);
        assert!(started.elapsed() >= Duration::from_millis(8));
    }
}
