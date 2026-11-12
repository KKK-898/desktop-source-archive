#[test]
fn deep_scan_cache_merge_preserves_new_provider_after_same_length_rewrite() {
    with_temp_user_home("deep-scan-provider-cache-race", |root| {
        let file = write_incremental_test_rollout(
            root,
            "01980e4f-4a31-7000-8000-0000000005a1",
            "openai",
            None,
            false,
        );
        let first = scan_rollout_file_details(&file).unwrap();
        restore_rollout_modified_time(&first.summary).unwrap();
        let old_entry = scan_rollout_file_details(&file).unwrap();
        let key = codex_path_identity(&file);
        let mut cache = RolloutScanCache::default();
        cache.entries.insert(key.clone(), old_entry.clone());
        write_rollout_scan_cache(&mut cache).unwrap();
        let background_snapshot = read_rollout_scan_cache();

        let mut foreground_cache = read_rollout_scan_cache();
        sync_rollout_files_incremental(
            std::slice::from_ref(&file),
            "custom",
            &mut foreground_cache,
        )
        .unwrap();
        // The restored timestamp and equal-length provider make the old
        // snapshot indistinguishable by its size/mtime checkpoint alone.
        assert!(old_entry.matches(&file));
        assert_eq!(
            read_rollout_session_meta(&file).unwrap()["payload"]["model_provider"],
            "custom"
        );
        let new_file = write_incremental_test_rollout(
            root,
            "01980e4f-4a31-7000-8000-0000000005a2",
            "custom",
            None,
            false,
        );
        let new_key = codex_path_identity(&new_file);
        foreground_cache.entries.insert(
            new_key.clone(),
            scan_rollout_file_details(&new_file).unwrap(),
        );
        write_rollout_scan_cache(&mut foreground_cache).unwrap();

        let mut latest_cache = read_rollout_scan_cache();
        let published = merge_rollout_scan_cache_entries(
            &mut latest_cache,
            background_snapshot.entries.into_iter().collect(),
        );
        assert_eq!(published, 0);
        assert_eq!(latest_cache.entries[&key].summary.provider, "custom");
        assert!(latest_cache.entries[&new_key].body_scanned);
        assert_eq!(latest_cache.entries.len(), 2);

        // A newer bounded foreground scan is also authoritative about its
        // provider; an older deep scan must not "upgrade" it back to openai.
        let current = latest_cache.entries.get_mut(&key).unwrap();
        current.body_scanned = false;
        current.summary.body_scanned = false;
        assert_eq!(
            merge_rollout_scan_cache_entries(&mut latest_cache, vec![(key.clone(), old_entry)]),
            0
        );
        assert_eq!(latest_cache.entries[&key].summary.provider, "custom");
        assert!(!latest_cache.entries[&key].body_scanned);
        write_rollout_scan_cache(&mut latest_cache).unwrap();
        let saved = read_rollout_scan_cache();
        assert_eq!(saved.entries[&key].summary.provider, "custom");
        assert!(saved.entries.contains_key(&new_key));
    });
}

#[test]
fn deep_scan_cache_merge_upgrades_only_current_matching_shallow_entry() {
    with_temp_user_home("deep-scan-cache-upgrade", |root| {
        let file = write_incremental_test_rollout(
            root,
            "01980e4f-4a31-7000-8000-0000000005a3",
            "openai",
            None,
            false,
        );
        let shallow = scan_rollout_file_header_details(&file).unwrap();
        let deep = scan_rollout_file_details(&file).unwrap();
        assert!(!shallow.body_scanned);
        assert!(deep.body_scanned);
        let key = codex_path_identity(&file);
        let mut cache = RolloutScanCache::default();
        cache.entries.insert(key.clone(), shallow);
        assert_eq!(
            merge_rollout_scan_cache_entries(&mut cache, vec![(key.clone(), deep.clone())]),
            1
        );
        assert!(cache.entries[&key].body_scanned);
        assert!(cache.entries[&key].summary.body_scanned);
        assert_eq!(cache.entries[&key].summary.provider, "openai");
        assert_eq!(
            merge_rollout_scan_cache_entries(&mut cache, vec![(key.clone(), deep)]),
            0
        );
    });
}

#[test]
fn deep_scan_cache_merge_discards_result_when_file_changed_after_scan() {
    with_temp_user_home("deep-scan-cache-stale-body", |root| {
        let file = write_incremental_test_rollout(
            root,
            "01980e4f-4a31-7000-8000-0000000005a4",
            "openai",
            None,
            false,
        );
        let deep = scan_rollout_file_details(&file).unwrap();
        let key = codex_path_identity(&file);
        writeln!(
            fs::OpenOptions::new().append(true).open(&file).unwrap(),
            "{}",
            json!({"type":"event_msg","payload":{"type":"token_count"}})
        )
        .unwrap();
        assert!(!deep.matches(&file));
        let current = scan_rollout_file_header_details(&file).unwrap();
        let expected_size = current.size_bytes;
        let mut cache = RolloutScanCache::default();
        cache.entries.insert(key.clone(), current);
        assert_eq!(
            merge_rollout_scan_cache_entries(&mut cache, vec![(key.clone(), deep)]),
            0
        );
        assert_eq!(cache.entries[&key].size_bytes, expected_size);
        assert!(!cache.entries[&key].body_scanned);
    });
}
