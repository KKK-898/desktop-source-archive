// Included inside lib.rs's test module so these regressions reuse its isolated
// temporary home and exercise the same incremental path as account switching.
mod codex_session_compat_regressions {
    use super::*;

    const SCREENSHOT_ITEM_ID: &str = "item_47041e8e4def85d6b443386a";

    fn append_rows(file: &Path, rows: &[Value]) {
        let mut handle = fs::OpenOptions::new().append(true).open(file).unwrap();
        for row in rows {
            writeln!(handle, "{row}").unwrap();
        }
    }

    fn read_rows(file: &Path) -> Vec<Value> {
        fs::read_to_string(file)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn tool_pair(item_id: &str, call_id: &str) -> [Value; 2] {
        [
            json!({
                "type": "response_item",
                "timestamp": "2026-09-26T08:17:00Z",
                "payload": {
                    "type": "function_call",
                    "id": item_id,
                    "call_id": call_id,
                    "name": "shell_command",
                    "arguments": "{\"command\":\"echo preserve-history\"}"
                }
            }),
            json!({
                "type": "response_item",
                "timestamp": "2026-09-26T08:17:01Z",
                "payload": {
                    "type": "function_call_output",
                    "id": "fco_preserve_output",
                    "call_id": call_id,
                    "output": "preserve-history\n{\"id\":\"item_47041e8e4def85d6b443386a\"}"
                }
            }),
        ]
    }

    fn native_reasoning() -> Value {
        json!({
            "type": "response_item",
            "payload": {
                "type": "reasoning",
                "id": "rs_preserve_native",
                "summary": [{ "type": "summary_text", "text": "Keep this summary" }],
                "encrypted_content": "opaque-native-content"
            }
        })
    }

    #[test]
    fn official_sync_preserves_tool_ids_and_official_header() {
        with_temp_user_home("compat-screenshot-tool-only", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000261",
                "openai",
                None,
                false,
            );
            append_rows(&file, &tool_pair(SCREENSHOT_ITEM_ID, "call_preserve_link"));
            append_rows(&file, &[native_reasoning()]);
            let expected = read_rows(&file);
            let original_bytes = fs::read(&file).unwrap();

            let mut cache = RolloutScanCache::default();
            let repaired =
                sync_rollout_files_incremental(&[file.clone()], "openai", &mut cache).unwrap();

            assert!(repaired.warnings.is_empty());
            assert_eq!(repaired.repaired_legacy_response_items, 0);
            assert_eq!(repaired.rollouts[0].provider, "openai");
            assert_eq!(fs::read(&file).unwrap(), original_bytes);
            assert_eq!(read_rows(&file), expected);
            let entry = cache.entries.get(&codex_path_identity(&file)).unwrap();
            assert_eq!(entry.legacy_message_ids, 0);
            assert_eq!(entry.legacy_function_call_ids, Some(1));
            assert_eq!(entry.legacy_api_incompatible_items, 1);

            let bytes_after_repair = fs::read(&file).unwrap();
            let warm =
                sync_rollout_files_incremental(&[file.clone()], "openai", &mut cache).unwrap();
            assert_eq!((warm.cache_hits, warm.cache_misses), (1, 0));
            assert_eq!(warm.body_bytes_scanned, 0);
            assert_eq!(warm.repaired_legacy_response_items, 0);
            assert_eq!(fs::read(&file).unwrap(), bytes_after_repair);
        });
    }

    #[test]
    fn warm_switch_preserves_all_reasoning_and_tool_records() {
        with_temp_user_home("compat-warm-reasoning-checkpoint", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000262",
                "custom",
                None,
                false,
            );
            append_rows(&file, &tool_pair(SCREENSHOT_ITEM_ID, "call_warm_link"));
            let legacy_reasoning = json!({
                "type": "response_item",
                "payload": {
                    "type": "reasoning",
                    "id": "item_bbbbbbbbbbbbbbbbbbbbbbbb",
                    "summary": [{ "type": "summary_text", "text": "Legacy summary" }],
                    "encrypted_content": Value::Null,
                    "content": []
                }
            });
            append_rows(&file, &[legacy_reasoning.clone(), native_reasoning()]);
            let files = [file.clone()];
            let key = codex_path_identity(&file);
            // A read-only scan records relay-produced history without running
            // the relay repair before this test switches back to official.
            let (_, warnings, hits, misses) = scan_rollout_files(&files, "custom");
            assert!(warnings.is_empty());
            assert_eq!((hits, misses), (0, 1));
            let mut cache = read_rollout_scan_cache();
            assert_eq!(cache.entries[&key].legacy_api_incompatible_items, 2);
            assert_eq!(cache.entries[&key].legacy_function_call_ids, Some(1));

            let official = sync_rollout_files_incremental(&files, "openai", &mut cache).unwrap();
            assert!(official.warnings.is_empty());
            assert_eq!((official.cache_hits, official.cache_misses), (1, 0));
            assert_eq!(official.body_bytes_scanned, 0);
            assert_eq!(official.repaired_legacy_response_items, 0);
            let rows = read_rows(&file);
            assert_eq!(rows[2]["payload"]["id"], SCREENSHOT_ITEM_ID);
            assert_eq!(rows[4], legacy_reasoning);
            assert_eq!(rows[5], native_reasoning());
            assert_eq!(cache.entries[&key].legacy_function_call_ids, Some(1));
            assert_eq!(cache.entries[&key].legacy_api_incompatible_items, 2);
            write_rollout_scan_cache(&mut cache).unwrap();
            let mut cache = read_rollout_scan_cache();

            let api = sync_rollout_files_incremental(&files, CODEX_DIRECT_PROVIDER_ID, &mut cache)
                .unwrap();
            assert!(api.warnings.is_empty());
            assert_eq!((api.cache_hits, api.cache_misses), (1, 0));
            assert_eq!(api.body_bytes_scanned, 0);
            assert_eq!(api.repaired_legacy_response_items, 0);
            let rows = read_rows(&file);
            assert_eq!(rows.len(), 6);
            assert_eq!(rows[4], legacy_reasoning);
            assert_eq!(rows[5], native_reasoning());
            assert_eq!(rows[2]["payload"]["call_id"], "call_warm_link");
            assert_eq!(rows[3]["payload"]["call_id"], "call_warm_link");
            assert_eq!(cache.entries[&key].legacy_api_incompatible_items, 2);
        });
    }

    #[test]
    fn repeated_provider_round_trips_preserve_new_appended_calls() {
        with_temp_user_home("compat-tool-round-trips", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000263",
                CODEX_DIRECT_PROVIDER_ID,
                None,
                false,
            );
            append_rows(&file, &tool_pair(SCREENSHOT_ITEM_ID, "call_first"));
            append_rows(&file, &[native_reasoning()]);
            let files = [file.clone()];
            let mut cache = RolloutScanCache::default();
            let first = sync_rollout_files_incremental(&files, "openai", &mut cache).unwrap();
            assert_eq!(first.repaired_legacy_response_items, 0);
            let stable_body = read_rows(&file)[1..].to_vec();

            for provider in [
                CODEX_DIRECT_PROVIDER_ID,
                "openai",
                CODEX_DIRECT_PROVIDER_ID,
                "openai",
            ] {
                let warm = sync_rollout_files_incremental(&files, provider, &mut cache).unwrap();
                assert!(warm.warnings.is_empty());
                assert_eq!((warm.cache_hits, warm.cache_misses), (1, 0));
                assert_eq!(warm.body_bytes_scanned, 0);
                assert_eq!(warm.repaired_legacy_response_items, 0);
                let rows = read_rows(&file);
                assert_eq!(rows[0]["payload"]["model_provider"], provider);
                assert_eq!(&rows[1..], stable_body.as_slice());
            }

            for (provider, item_id, _fixed_id, call_id) in [
                (
                    CODEX_DIRECT_PROVIDER_ID,
                    "item_cccccccccccccccccccccccc",
                    "fc_cccccccccccccccccccccccc",
                    "call_after_official",
                ),
                (
                    "openai",
                    "item_dddddddddddddddddddddddd",
                    "fc_dddddddddddddddddddddddd",
                    "call_after_api",
                ),
            ] {
                let previous_rows = read_rows(&file);
                let pair = tool_pair(item_id, call_id);
                append_rows(&file, &pair);
                let repaired =
                    sync_rollout_files_incremental(&files, provider, &mut cache).unwrap();
                assert!(repaired.warnings.is_empty());
                assert_eq!((repaired.cache_hits, repaired.cache_misses), (0, 1));
                assert!(repaired.body_bytes_scanned > 0);
                assert_eq!(repaired.repaired_legacy_response_items, 0);
                let rows = read_rows(&file);
                assert_eq!(&rows[1..previous_rows.len()], &previous_rows[1..]);
                assert_eq!(&rows[previous_rows.len()..], pair.as_slice());
                let warm = sync_rollout_files_incremental(&files, provider, &mut cache).unwrap();
                assert_eq!((warm.cache_hits, warm.cache_misses), (1, 0));
                assert_eq!(warm.body_bytes_scanned, 0);
                assert_eq!(warm.repaired_legacy_response_items, 0);
            }
        });
    }

    #[test]
    fn cache_without_function_call_checkpoint_rescans_without_history_repair() {
        with_temp_user_home("compat-old-tool-checkpoint", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000264",
                "openai",
                None,
                false,
            );
            append_rows(&file, &tool_pair(SCREENSHOT_ITEM_ID, "call_old_cache"));
            let files = [file.clone()];
            let key = codex_path_identity(&file);
            let (_, warnings, hits, misses) = scan_rollout_files(&files, "openai");
            assert!(warnings.is_empty());
            assert_eq!((hits, misses), (0, 1));
            let mut old_cache = serde_json::to_value(read_rollout_scan_cache()).unwrap();
            old_cache["entries"][&key]
                .as_object_mut()
                .unwrap()
                .remove("legacy_function_call_ids");
            fs::write(rollout_scan_cache_path(), old_cache.to_string()).unwrap();

            let mut cache = read_rollout_scan_cache();
            assert_eq!(cache.entries[&key].legacy_function_call_ids, None);
            let repaired = sync_rollout_files_incremental(&files, "openai", &mut cache).unwrap();
            assert!(repaired.warnings.is_empty());
            assert_eq!((repaired.cache_hits, repaired.cache_misses), (0, 1));
            assert!(repaired.body_bytes_scanned > 0);
            assert_eq!(repaired.repaired_legacy_response_items, 0);
            assert_eq!(read_rows(&file)[2]["payload"]["id"], SCREENSHOT_ITEM_ID);
            assert_eq!(cache.entries[&key].legacy_function_call_ids, Some(1));
            write_rollout_scan_cache(&mut cache).unwrap();
            let mut cache = read_rollout_scan_cache();
            let repaired_bytes = fs::read(&file).unwrap();
            let warm = sync_rollout_files_incremental(&files, "openai", &mut cache).unwrap();
            assert_eq!((warm.cache_hits, warm.cache_misses), (1, 0));
            assert_eq!(warm.body_bytes_scanned, 0);
            assert_eq!(warm.repaired_legacy_response_items, 0);
            assert_eq!(fs::read(&file).unwrap(), repaired_bytes);
        });
    }

    #[test]
    fn official_tool_only_rewrite_preserves_a_concurrent_append() {
        with_temp_user_home("compat-tool-concurrent-append", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000265",
                "openai",
                None,
                false,
            );
            append_rows(&file, &tool_pair(SCREENSHOT_ITEM_ID, "call_racing"));
            let original = fs::read_to_string(&file).unwrap();
            let appended = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"}}\n";
            let (provider_changed, _, _, repaired, warning) =
                rewrite_rollout_for_official_with_before_replace(
                    &file,
                    || {
                        let mut handle = fs::OpenOptions::new().append(true).open(&file).unwrap();
                        handle.write_all(appended.as_bytes()).unwrap();
                        handle.sync_all().unwrap();
                    },
                    false,
                )
                .unwrap();

            assert!(!provider_changed);
            assert_eq!(repaired, 0);
            assert!(warning.is_some());
            assert_eq!(
                fs::read_to_string(&file).unwrap(),
                format!("{original}{appended}")
            );
        });
    }
}
