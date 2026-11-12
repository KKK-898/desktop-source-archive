use super::tests::with_temp_user_home;
use super::*;

fn wait_until_foreground_active() {
    let deadline = Instant::now() + Duration::from_secs(3);
    while CODEX_CONFIGURE_ACTIVE.load(Ordering::Acquire) == 0 {
        assert!(Instant::now() < deadline, "foreground action never started");
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn foreground_waits_for_memory_lock_then_executes_once() {
    with_temp_user_home("foreground-memory-wait", |_root| {
        let mutex = Mutex::new(());
        let holder = mutex.lock().unwrap();
        let writes = AtomicU64::new(0);
        thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let _operation =
                    lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_secs(3))
                        .unwrap();
                writes.fetch_add(1, Ordering::SeqCst);
            });
            wait_until_foreground_active();
            assert!(codex_session_sync_should_yield_background());
            assert_eq!(writes.load(Ordering::SeqCst), 0);
            drop(holder);
            worker.join().unwrap();
        });
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert_eq!(CODEX_CONFIGURE_ACTIVE.load(Ordering::SeqCst), 0);
        assert!(!codex_session_sync_should_yield_background());
        assert!(!codex_dir().join("locks/gaogeaii-configure.lock").exists());
    });
}

#[test]
fn foreground_preserves_live_file_owner_and_runs_after_release() {
    with_temp_user_home("foreground-file-wait", |_root| {
        let mutex = Mutex::new(());
        let holder = acquire_codex_lock("configure").unwrap();
        let owner = fs::read(&holder.path).unwrap();
        let writes = AtomicU64::new(0);
        thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let _operation =
                    lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_secs(3))
                        .unwrap();
                writes.fetch_add(1, Ordering::SeqCst);
            });
            wait_until_foreground_active();
            assert_eq!(fs::read(&holder.path).unwrap(), owner);
            assert_eq!(writes.load(Ordering::SeqCst), 0);
            drop(holder);
            worker.join().unwrap();
        });
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert!(mutex.try_lock().is_ok());
        assert_eq!(CODEX_CONFIGURE_ACTIVE.load(Ordering::SeqCst), 0);
    });
}

#[test]
fn foreground_memory_timeout_leaves_configuration_untouched_and_can_retry() {
    with_temp_user_home("foreground-memory-timeout", |_root| {
        let mutex = Mutex::new(());
        let holder = mutex.lock().unwrap();
        fs::create_dir_all(codex_dir()).unwrap();
        let config = codex_dir().join("config.toml");
        fs::write(&config, "model = \"existing\"\n").unwrap();
        let before = fs::read(&config).unwrap();
        let result =
            lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_millis(80));
        assert!(result.err().unwrap().contains("本次操作尚未执行"));
        assert_eq!(fs::read(config).unwrap(), before);
        assert_eq!(CODEX_CONFIGURE_ACTIVE.load(Ordering::SeqCst), 0);
        drop(holder);
        assert!(
            lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_secs(1)).is_ok()
        );
    });
}

#[test]
fn foreground_file_timeout_releases_memory_lock_without_deleting_live_owner() {
    with_temp_user_home("foreground-file-timeout", |_root| {
        let mutex = Mutex::new(());
        let holder = acquire_codex_lock("configure").unwrap();
        let before = fs::read(&holder.path).unwrap();
        let result =
            lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_millis(80));
        assert!(result.err().unwrap().contains("本次操作尚未执行"));
        assert_eq!(fs::read(&holder.path).unwrap(), before);
        assert!(mutex.try_lock().is_ok());
        assert_eq!(CODEX_CONFIGURE_ACTIVE.load(Ordering::SeqCst), 0);
        drop(holder);
        assert!(
            lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_secs(1)).is_ok()
        );
    });
}

#[test]
fn foreground_filesystem_errors_fail_promptly_and_release_activity() {
    with_temp_user_home("foreground-io-failure", |_root| {
        let mutex = Mutex::new(());
        fs::create_dir_all(codex_dir()).unwrap();
        let locks = codex_dir().join("locks");
        fs::write(&locks, "fixture blocks directory creation").unwrap();
        let started = Instant::now();
        let result = lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_secs(10));
        assert!(result.err().unwrap().contains("创建 Codex 锁目录失败"));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(mutex.try_lock().is_ok());
        assert_eq!(CODEX_CONFIGURE_ACTIVE.load(Ordering::SeqCst), 0);
        fs::remove_file(locks).unwrap();
        assert!(
            lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_secs(1)).is_ok()
        );
    });
}

#[test]
fn foreground_recovers_poisoned_mutex() {
    with_temp_user_home("foreground-poison-recovery", |_root| {
        let mutex = Mutex::new(());
        thread::scope(|scope| {
            let _ = scope
                .spawn(|| {
                    let _guard = mutex.lock().unwrap();
                    panic!("poison fixture mutex");
                })
                .join();
        });
        assert!(mutex.is_poisoned());
        let operation =
            lock_codex_foreground_operation_with_timeout(&mutex, Duration::from_secs(1)).unwrap();
        assert!(!mutex.is_poisoned());
        drop(operation);
        assert_eq!(CODEX_CONFIGURE_ACTIVE.load(Ordering::SeqCst), 0);
    });
}
