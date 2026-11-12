// Included in lib.rs's test module to exercise the production incremental
// provider switch with the same isolated temporary-home helper.
mod codex_session_provider_regressions {
    use super::*;

    fn assert_stale_provider_cache_is_repaired(
        root: &Path,
        initial_provider: &str,
        intermediate_provider: &str,
    ) {
        let id = "01980e4f-4a31-7000-8000-000000000281";
        let original = write_incremental_test_rollout(root, id, initial_provider, None, false);
        let filename = format!("rollout-2026-09-01T00-00-00-{id}.jsonl");
        let raw = original.with_file_name(&filename);
        fs::rename(original, &raw).unwrap();
        let canonical = raw
            .parent()
            .unwrap()
            .join(CODEX_CANONICAL_ROLLOUT_DIR)
            .join(filename);
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        fs::copy(&raw, &canonical).unwrap();
        let files = vec![raw, canonical];
        assert!(files.iter().all(|file| is_official_rollout_filename(file)));
        assert!(is_managed_canonical_rollout_path(&files[1]));

        // First normalize the mtime exactly as a completed route switch does.
        let mut cache = RolloutScanCache::default();
        let initial = sync_rollout_files_incremental(&files, initial_provider, &mut cache).unwrap();
        assert!(initial.warnings.is_empty());
        let mut stale_cache = cache.clone();
        let initial_contents: Vec<Vec<u8>> =
            files.iter().map(|file| fs::read(file).unwrap()).collect();
        let initial_states: Vec<_> = files
            .iter()
            .map(|file| rollout_cache_file_state(file).unwrap())
            .collect();

        let switched =
            sync_rollout_files_incremental(&files, intermediate_provider, &mut cache).unwrap();
        assert!(switched.warnings.is_empty());
        assert_eq!(switched.changed, files.len());
        assert_eq!(switched.body_bytes_scanned, 0);
        for (index, file) in files.iter().enumerate() {
            // The regression is an actual cache collision: custom/openai have
            // equal length, and both switches restore the conversation mtime.
            assert_eq!(
                rollout_cache_file_state(file).unwrap(),
                initial_states[index]
            );
            assert!(stale_cache.entries[&codex_path_identity(file)].matches(file));
            assert_eq!(
                read_rollout_session_meta(file).unwrap()["payload"]["model_provider"],
                intermediate_provider
            );
            let bytes = fs::read(file).unwrap();
            let body_start = bytes.iter().position(|byte| *byte == b'\n').unwrap() + 1;
            let initial_body_start = initial_contents[index]
                .iter()
                .position(|byte| *byte == b'\n')
                .unwrap()
                + 1;
            assert_eq!(
                &bytes[body_start..],
                &initial_contents[index][initial_body_start..]
            );
        }

        // Simulate a background scan publishing its pre-switch cache later.
        // File stat checks still match, so routing must read the real header.
        let repaired =
            sync_rollout_files_incremental(&files, initial_provider, &mut stale_cache).unwrap();
        assert!(repaired.warnings.is_empty());
        assert_eq!(
            (repaired.cache_hits, repaired.cache_misses),
            (files.len(), 0)
        );
        assert_eq!(repaired.changed, files.len());
        assert_eq!(repaired.body_bytes_scanned, 0);
        assert_eq!(repaired.repaired_legacy_response_items, 0);
        assert!(repaired
            .rollouts
            .iter()
            .all(|rollout| rollout.provider == initial_provider));
        for (index, file) in files.iter().enumerate() {
            assert_eq!(
                read_rollout_session_meta(file).unwrap()["payload"]["model_provider"],
                initial_provider
            );
            let entry = &stale_cache.entries[&codex_path_identity(file)];
            assert_eq!(entry.summary.provider, initial_provider);
            assert!(entry.matches(file));
            assert_eq!(fs::read(file).unwrap(), initial_contents[index]);
        }

        let repeated =
            sync_rollout_files_incremental(&files, initial_provider, &mut stale_cache).unwrap();
        assert!(repeated.warnings.is_empty());
        assert_eq!(repeated.changed, 0);
        assert_eq!(repeated.body_bytes_scanned, 0);
    }

    #[test]
    fn stale_official_cache_cannot_leave_custom_headers_after_official_restore() {
        with_temp_user_home("provider-stale-official-cache", |root| {
            assert_stale_provider_cache_is_repaired(root, "openai", "custom");
        });
    }

    #[test]
    fn stale_custom_cache_cannot_leave_official_headers_after_relay_login() {
        with_temp_user_home("provider-stale-custom-cache", |root| {
            assert_stale_provider_cache_is_repaired(root, "custom", "openai");
        });
    }

    #[test]
    fn foreground_switch_permanently_invalidates_old_background_generation() {
        with_temp_user_home("provider-stale-background-generation", |_| {
            assert!(!CODEX_SESSION_SYNC_BACKGROUND.with(Cell::get));
            let old_generation = CODEX_SESSION_SYNC_GENERATION.load(Ordering::Acquire);
            assert!(codex_background_generation_is_current(old_generation));

            let foreground = CodexSessionSyncPriorityGuard::start();
            let new_generation = CODEX_SESSION_SYNC_GENERATION.load(Ordering::Acquire);
            assert_ne!(new_generation, old_generation);
            assert!(!codex_background_generation_is_current(old_generation));
            assert!(codex_background_generation_is_current(new_generation));
            drop(foreground);

            // A yielded worker must stay cancelled after foreground priority
            // clears; otherwise its captured provider can overwrite the DB.
            assert!(!codex_background_generation_is_current(old_generation));
            assert!(codex_background_generation_is_current(new_generation));
        });
    }

    #[test]
    fn expired_canonical_worker_cannot_publish_after_foreground_finishes() {
        with_temp_user_home("provider-stale-canonical-publish", |root| {
            let file = root.join("canonical-provider.txt");
            fs::write(&file, "openai").unwrap();
            let generation = CODEX_SESSION_SYNC_GENERATION.load(Ordering::Acquire);
            drop(CodexSessionSyncPriorityGuard::start());
            assert!(!codex_session_sync_should_yield_background());

            CODEX_SESSION_SYNC_BACKGROUND.with(|value| value.set(true));
            CODEX_SESSION_SYNC_BACKGROUND_GENERATION.with(|value| value.set(Some(generation)));
            let result = with_canonical_rollout_publication(|| {
                fs::write(&file, "custom").map_err(|error| error.to_string())
            });
            CODEX_SESSION_SYNC_BACKGROUND_GENERATION.with(|value| value.set(None));
            CODEX_SESSION_SYNC_BACKGROUND.with(|value| value.set(false));
            assert!(result.is_err());
            assert_eq!(fs::read_to_string(&file).unwrap(), "openai");
        });
    }

    #[test]
    fn official_restore_reports_secondary_sync_failure_before_restart() {
        with_temp_user_home("provider-secondary-sync-failure", |root| {
            let secondary = root.join("secondary-codex");
            fs::create_dir_all(root.join(".codex")).unwrap();
            fs::create_dir_all(&secondary).unwrap();
            // Exercise the real target loop with a database path that cannot
            // be opened as a file, independent of Windows ACL behavior.
            fs::create_dir(secondary.join("state_5.sqlite")).unwrap();
            std::env::set_var("CODEX_HOME", &secondary);
            let result = sync_codex_route_targets("openai", true).unwrap();
            assert!(result["targets"]
                .as_array()
                .unwrap()
                .iter()
                .any(|target| target["status"] == "failed" && target["primaryTarget"] == false));
            assert!(require_official_session_sync_completed(&result).is_err());
        });
    }

    #[test]
    fn official_restart_requires_provider_sync_success() {
        assert!(require_official_session_sync_completed(&json!({
            "status": "failed",
            "warnings": ["rollout header update failed"]
        })).is_err());
        assert!(require_official_session_sync_completed(&json!({
            "status": "completed", "providerMismatches": 2
        })).is_err());
        assert!(require_official_session_sync_completed(&json!({
            "status": "completed", "providerMismatches": 0,
            "targets": [{"providerMismatches": 1}]
        })).is_err());
        assert!(require_official_session_sync_completed(&json!({
            "status": "completed", "providerMismatches": 0,
            "targets": [{"providerMismatches": 0}],
            "warnings": ["canonical merge pending"]
        })).is_ok());
    }
}
