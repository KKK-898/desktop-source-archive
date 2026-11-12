//! Keep slow balance HTTP requests off the renderer bridge's serial event loop.
//! A process owns one worker and one queued job; each bridge owns its replies.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    Arc,
};
use std::thread;

const MAX_BALANCE_WAITERS: usize = 16;

struct Job<T> {
    active: Arc<AtomicBool>,
    reply: SyncSender<T>,
}

pub(crate) struct BalanceWorker<T> {
    sender: SyncSender<Job<T>>,
}

impl<T: Send + 'static> BalanceWorker<T> {
    pub(crate) fn start(fetch: impl Fn() -> T + Send + 'static) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Job<T>>(1);
        thread::Builder::new()
            .name("gaoge-codex-balance-worker".to_string())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    if !job.active.load(Ordering::Acquire) {
                        continue;
                    }
                    // Production fetch has an eight-second HTTP deadline. A
                    // closed bridge never waits for it or accepts its result.
                    let result = fetch();
                    if job.active.load(Ordering::Acquire) {
                        let _ = job.reply.try_send(result);
                    }
                }
            })?;
        Ok(Self { sender })
    }

    fn request(&self) -> Result<Pending<T>, &'static str> {
        let active = Arc::new(AtomicBool::new(true));
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .try_send(Job {
                active: active.clone(),
                reply,
            })
            .map_err(|error| match error {
                TrySendError::Full(_) => "余额查询正在处理中，请稍后重试。",
                TrySendError::Disconnected(_) => "余额查询服务暂时不可用。",
            })?;
        Ok(Pending { active, receiver })
    }
}

struct Pending<T> {
    active: Arc<AtomicBool>,
    receiver: Receiver<T>,
}

impl<T> Drop for Pending<T> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

/// Owned by a single bridge connection. Never transfer it to another generation.
pub(crate) struct BridgeRequests<T, K> {
    pending: Option<Pending<T>>,
    waiters: Vec<K>,
}

impl<T, K> Default for BridgeRequests<T, K> {
    fn default() -> Self {
        Self {
            pending: None,
            waiters: Vec::new(),
        }
    }
}

impl<T: Send + 'static, K> BridgeRequests<T, K> {
    /// Only balance reads leave the bridge thread. Configuration mutations and
    /// fuel status retain their existing serial execution order.
    pub(crate) fn dispatch(
        &mut self,
        path: &str,
        target: K,
        worker: &BalanceWorker<T>,
        immediate: impl FnOnce() -> T,
    ) -> Result<Option<(K, T)>, (K, &'static str)> {
        if path != "/account/balance" {
            return Ok(Some((target, immediate())));
        }
        if self.waiters.len() >= MAX_BALANCE_WAITERS {
            return Err((target, "余额查询等待过多，请稍后重试。"));
        }
        if self.pending.is_none() {
            self.pending = match worker.request() {
                Ok(pending) => Some(pending),
                Err(error) => return Err((target, error)),
            };
        }
        self.waiters.push(target);
        Ok(None)
    }

    pub(crate) fn poll(&mut self) -> Option<(Vec<K>, Result<T, &'static str>)> {
        let result = match self.pending.as_ref()?.receiver.try_recv() {
            Ok(result) => Ok(result),
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => Err("余额查询服务暂时不可用。"),
        };
        self.pending = None;
        Some((std::mem::take(&mut self.waiters), result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::{Duration, Instant};

    fn collect<T: Send + 'static, K>(
        requests: &mut BridgeRequests<T, K>,
    ) -> (Vec<K>, Result<T, &'static str>) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(reply) = requests.poll() {
                return reply;
            }
            assert!(
                Instant::now() < deadline,
                "background balance reply did not arrive"
            );
            thread::yield_now();
        }
    }

    #[test]
    fn slow_balance_does_not_block_fuel_or_reorder_immediate_operations() {
        let (started, started_rx) = mpsc::sync_channel(1);
        let (release, release_rx) = mpsc::sync_channel(1);
        let worker = BalanceWorker::start(move || {
            started.send(()).unwrap();
            release_rx.recv().unwrap();
            42
        })
        .unwrap();
        let mut requests = BridgeRequests::default();
        assert!(requests
            .dispatch("/account/balance", 1, &worker, || panic!(
                "balance must be deferred"
            ))
            .unwrap()
            .is_none());
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            requests.dispatch("/fuel/status", 2, &worker, || 7).unwrap(),
            Some((2, 7))
        );
        assert_eq!(
            requests
                .dispatch("/speed/select", 3, &worker, || 8)
                .unwrap(),
            Some((3, 8))
        );
        assert!(
            requests.poll().is_none(),
            "fuel returned while balance remains blocked"
        );
        release.send(()).unwrap();
        assert_eq!(collect(&mut requests), (vec![1], Ok(42)));
    }

    #[test]
    fn concurrent_balance_requests_are_coalesced_and_waiters_are_bounded() {
        let (release, release_rx) = mpsc::sync_channel(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let worker = BalanceWorker::start(move || {
            observed.fetch_add(1, Ordering::SeqCst);
            release_rx.recv().unwrap();
            42
        })
        .unwrap();
        let mut requests = BridgeRequests::default();
        for id in 0..MAX_BALANCE_WAITERS {
            assert!(requests
                .dispatch("/account/balance", id, &worker, || 0)
                .unwrap()
                .is_none());
        }
        assert!(requests
            .dispatch("/account/balance", MAX_BALANCE_WAITERS, &worker, || 0)
            .is_err());
        release.send(()).unwrap();
        let (targets, result) = collect(&mut requests);
        assert_eq!(targets, (0..MAX_BALANCE_WAITERS).collect::<Vec<_>>());
        assert_eq!(result, Ok(42));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn closing_a_bridge_drops_old_results_and_reconnects_share_a_bounded_worker() {
        let (started, started_rx) = mpsc::sync_channel(1);
        let (release, release_rx) = mpsc::sync_channel(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let worker = BalanceWorker::start(move || {
            let call = observed.fetch_add(1, Ordering::SeqCst) + 1;
            if call == 1 {
                started.send(()).unwrap();
                release_rx.recv().unwrap();
            }
            call
        })
        .unwrap();
        let mut old = BridgeRequests::default();
        old.dispatch("/account/balance", "reused-request-id", &worker, || 0)
            .unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(old);
        let mut current = BridgeRequests::default();
        current
            .dispatch("/account/balance", "reused-request-id", &worker, || 0)
            .unwrap();
        let mut overflow = BridgeRequests::default();
        assert!(overflow
            .dispatch("/account/balance", "third-connection", &worker, || 0)
            .is_err());
        release.send(()).unwrap();
        assert_eq!(collect(&mut current), (vec!["reused-request-id"], Ok(2)));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_closed_queued_bridge_is_skipped_without_an_extra_network_request() {
        let (started, started_rx) = mpsc::sync_channel(1);
        let (release, release_rx) = mpsc::sync_channel(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let worker = BalanceWorker::start(move || {
            let call = observed.fetch_add(1, Ordering::SeqCst) + 1;
            if call == 1 {
                started.send(()).unwrap();
                release_rx.recv().unwrap();
            }
            call
        })
        .unwrap();
        let mut first = BridgeRequests::default();
        first
            .dispatch("/account/balance", 1, &worker, || 0)
            .unwrap();
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut closed = BridgeRequests::default();
        closed
            .dispatch("/account/balance", 2, &worker, || 0)
            .unwrap();
        drop(closed);
        release.send(()).unwrap();
        assert_eq!(collect(&mut first), (vec![1], Ok(1)));
        // A live third job follows the canceled queued job on the same worker.
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut third = BridgeRequests::default();
        loop {
            if third.dispatch("/account/balance", 3, &worker, || 0).is_ok() {
                break;
            }
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        assert_eq!(collect(&mut third), (vec![3], Ok(2)));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
