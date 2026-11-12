mod history_safety_regressions {
    use super::*;

    fn assert_native_cutoffs_in_bounds(files: &[PathBuf]) {
        for file in files {
            let meta = read_rollout_session_meta(file).unwrap();
            let Some(base) = meta.pointer("/payload/history_base") else {
                continue;
            };
            if base.is_null() {
                continue;
            }
            let source_id = base["thread_id"].as_str().unwrap();
            let cutoff = base["end_byte_offset"].as_u64().unwrap();
            // Native references identify a physical rollout, not payload.id.
            // Edited filenames are <stable-thread-id>_<new-rollout-id>.
            let sources: Vec<_> = files
                .iter()
                .filter(|candidate| {
                    official_rollout_ids(candidate)
                        .map(|(_, id)| id.to_string())
                        .or_else(|| read_rollout_session_meta(candidate).ok().and_then(|meta| {
                            if meta.pointer("/payload/history_base").is_some() {
                                return None;
                            }
                            meta.pointer("/payload/id")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        }))
                        .is_some_and(|id| id == source_id)
                })
                .collect();
            assert_eq!(
                sources.len(),
                1,
                "synthetic source must resolve unambiguously: {source_id}"
            );
            let bytes = fs::read(sources[0]).unwrap();
            assert!(
                cutoff <= bytes.len() as u64,
                "cutoff byte offset is past the source rollout"
            );
            assert!(
                cutoff == 0 || bytes[cutoff as usize - 1] == 10,
                "cutoff must remain on a record boundary"
            );
        }
    }

    #[test]
    #[ignore = "requires the isolated native verifier's marked synthetic fixture"]
    fn native_synthetic_sync_fixture() {
        let home = PathBuf::from(
            std::env::var_os("GAOGE_SYNTHETIC_HISTORY_HOME").expect("synthetic fixture required"),
        );
        let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/conversation-verification")
            .canonicalize()
            .unwrap();
        let home = home.canonicalize().unwrap();
        assert!(home.starts_with(&allowed));
        assert_eq!(home.file_name().unwrap(), ".codex");
        assert_eq!(
            fs::read_to_string(home.join("gaoge-synthetic-history-fixture")).unwrap(),
            "synthetic-only"
        );
        with_temp_user_home("native-history-verifier", |_| {
            with_codex_dir(&home, || {
                let files = rollout_files();
                assert!(
                    files.len() >= 4,
                    "native edit must create real paginated branches"
                );
                assert_native_cutoffs_in_bounds(&files);
                let before: Vec<_> = files
                    .iter()
                    .map(|p| (p.clone(), fs::read(p).unwrap()))
                    .collect();
                let summaries: Vec<_> = files
                    .iter()
                    .map(|p| scan_rollout_file(p).unwrap())
                    .collect();
                let head = select_rollouts_for_provider_sync(&summaries).unwrap();
                assert_eq!(head.rollouts.len(), 1);
                assert!(head.pending_ids.is_empty());
                for provider in ["openai", "custom"] {
                    let synced = sync_sessions(provider, true).unwrap();
                    assert_eq!(
                        synced["legacyResponseItemsRepaired"].as_u64().unwrap_or(0),
                        0
                    );
                    let materialized = select_rollouts_for_provider_sync(&summaries).unwrap();
                    assert_eq!(materialized.changed_files, 0);
                    assert_eq!(materialized.rollouts[0].path, head.rollouts[0].path);
                    assert_native_cutoffs_in_bounds(&files);
                }
                for (path, bytes) in before {
                    assert_eq!(fs::read(path).unwrap(), bytes);
                }
                assert_eq!(rollout_files().len(), files.len());
            })
        });
    }

    fn make_paginated(file: &Path) {
        let text = fs::read_to_string(file).unwrap();
        let split = text.find(char::from(10)).unwrap();
        let mut meta: Value = serde_json::from_str(&text[..split]).unwrap();
        meta["ordinal"] = json!(0);
        meta["payload"]["history_mode"] = json!("paginated");
        fs::write(
            file,
            format!("{}{}{}", meta, char::from(10), &text[split + 1..]),
        )
        .unwrap();
    }

    #[test]
    fn paginated_sync_preserves_legacy_rows_and_all_byte_offsets() {
        with_temp_user_home("paginated-immutable-prefix", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000701",
                "openai",
                None,
                false,
            );
            make_paginated(&file);
            let mut out = fs::OpenOptions::new().append(true).open(&file).unwrap();
            writeln!(
                out,
                "{}",
                json!({"ordinal":2,"type":"response_item","payload":{
                "type":"function_call","id":"item_0123456789abcdef01234567",
                "call_id":"preserve-call","name":"test_tool","arguments":"{}"}})
            )
            .unwrap();
            writeln!(
                out,
                "{}",
                json!({"ordinal":3,"type":"response_item","payload":{
                "type":"reasoning","id":"item_0123456789abcdef01234568","summary":[]}})
            )
            .unwrap();
            drop(out);
            let before = fs::read_to_string(&file).unwrap();
            let expected = before.replacen(
                r#""model_provider":"openai""#,
                r#""model_provider":"custom""#,
                1,
            );
            let mut cache = RolloutScanCache::default();
            let result =
                sync_rollout_files_incremental(&[file.clone()], "custom", &mut cache).unwrap();
            assert!(result.warnings.is_empty(), "{:?}", result.warnings);
            assert_eq!(result.repaired_legacy_response_items, 0);
            assert_eq!(fs::read_to_string(&file).unwrap(), expected);
            assert_eq!(fs::metadata(&file).unwrap().len(), before.len() as u64);
            sync_rollout_files_incremental(&[file.clone()], "openai", &mut cache).unwrap();
            assert_eq!(fs::read_to_string(&file).unwrap(), before);
        });
    }

    #[test]
    fn paginated_provider_change_never_moves_existing_cutoffs() {
        with_temp_user_home("paginated-provider-length", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000702",
                "long-provider",
                None,
                false,
            );
            make_paginated(&file);
            let before = fs::read(&file).unwrap();
            let (changed, _, old, warning) =
                sync_rollout_provider(&file, "custom", false).unwrap();
            assert!(changed);
            assert_eq!(old, "long-provider");
            assert!(warning.is_none());
            let after = fs::read(&file).unwrap();
            assert_eq!(after.len(), before.len());
            let body = before.iter().position(|b| *b == 10).unwrap() + 1;
            assert_eq!(&after[body..], &before[body..]);
            assert_eq!(read_rollout_session_meta(&file).unwrap()["payload"]["model_provider"], "custom");
        });
    }

    #[test]
    fn native_session_ordinal_without_new_flags_is_never_rewritten() {
        with_temp_user_home("ordinal-only-history", |root| {
            let file = write_incremental_test_rollout(
                root,
                "01980e4f-4a31-7000-8000-000000000704",
                "long-provider",
                None,
                false,
            );
            let text = fs::read_to_string(&file).unwrap();
            let split = text.find(char::from(10)).unwrap();
            let mut meta: Value = serde_json::from_str(&text[..split]).unwrap();
            meta["ordinal"] = json!(0);
            assert!(
                !codex_history_safety::owns_native_history(&meta),
                "Ordinal alone does not identify native paginated history"
            );
            meta["payload"]["session_id"] = meta["payload"]["id"].clone();
            fs::write(
                &file,
                format!("{}{}{}", meta, char::from(10), &text[split + 1..]),
            )
            .unwrap();
            assert!(codex_history_safety::protects(&file).unwrap());
            let before = fs::read(&file).unwrap();
            let (changed, _, _, repaired, warning) =
                rewrite_rollout_for_api_with_before_replace(&file, || {}, false).unwrap();
            assert!(changed);
            assert_eq!(repaired, 0);
            let _ = warning;
            let after = fs::read(&file).unwrap();
            assert_eq!(after.len(), before.len());
            let body = before.iter().position(|b| *b == 10).unwrap() + 1;
            assert_eq!(&after[body..], &before[body..]);
        });
    }

    /// A branch stores `history_base.end_byte_offset` as an offset into the file
    /// it continues from.  That source file usually carries no pagination marker
    /// of its own: only the *branch* records one.  Repairing the source therefore
    /// has to be prevented by recognising the reference, not by finding a marker
    /// on the source.  Rewriting it shortens the file and leaves the branch
    /// pointing past EOF, which Codex reports as
    /// `invalid paginated history lineage ... cutoff byte offset is past the
    /// source rollout` and which makes the conversation unsendable.
    #[test]
    fn referenced_source_of_a_branch_survives_repair_by_length_not_by_marker() {
        with_temp_user_home("paginated-source-cutoff", |root| {
            let id = "01980e4f-4a31-7000-8000-000000000705";
            let source = write_incremental_test_rollout(root, id, "openai", None, false);
            // Deliberately NOT marked paginated. The source is protected because
            // the branch below references it, never because of its own header.
            let mut out = fs::OpenOptions::new().append(true).open(&source).unwrap();
            writeln!(
                out,
                "{}",
                json!({"ordinal":4,"type":"response_item","payload":{
                "type":"reasoning","id":"item_0123456789abcdef01234568","summary":[]}})
            )
            .unwrap();
            drop(out);
            assert!(
                !codex_history_safety::protects(&source).unwrap(),
                "the source must not protect itself, or this test cannot reach the bug"
            );
            // The reasoning row above is a legacy id the direct-API path rewrites,
            // so without lineage protection the source would shrink by one record.
            let cutoff = fs::metadata(&source).unwrap().len();
            let branch_id = "01980e4f-4a31-7000-8000-000000000706";
            let branch = source.with_file_name(format!(
                "rollout-2026-10-04T00-00-00-{branch_id}.jsonl"
            ));
            fs::write(
                &branch,
                format!(
                    "{}{}",
                    json!({"ordinal":5,"type":"session_meta","payload":{
                "id":branch_id,"model_provider":"openai","history_mode":"paginated","history_base":{
                    "thread_id":id,"end_ordinal_exclusive":5,"end_byte_offset":cutoff}}}),
                    char::from(10)
                ),
            )
            .unwrap();
            // Source first: the branch that references it is scanned later, so a
            // single-pass loop would already have rewritten the source by then.
            let files = vec![source.clone(), branch.clone()];
            let source_before = fs::read(&source).unwrap();
            let branch_before = fs::read(&branch).unwrap();
            assert_native_cutoffs_in_bounds(&files);
            let source_name = source.to_string_lossy().to_string();
            // The provider list deliberately mixes lengths.  `custom` and
            // `openai` are both 6 bytes, so they take the equal-length in-place
            // header swap and can never exercise the resize path; the longer ids
            // are the ones that reach it.  A referenced source is the case where
            // that path used to run unguarded, because the source carries no
            // pagination marker of its own for the writer to notice.  The second
            // element says whether the id's byte length matches the fixture's
            // `openai`, which decides whether the resize path is reachable.
            let providers = [
                ("custom", true),
                ("openai", true),
                ("anthropic-relay", false),
                ("another-company-router", false),
            ];
            for (provider, equal_length) in providers {
                let mut cache = RolloutScanCache::default();
                let result = sync_rollout_files_incremental(&files, provider, &mut cache).unwrap();
                assert_eq!(
                    result.repaired_legacy_response_items, 0,
                    "a referenced source must never be repaired: {provider}"
                );
                assert_eq!(
                    result.lineage_sources_preserved, 1,
                    "the referenced source must be counted, not silently skipped"
                );
                // A frozen source never reports itself per file: being a
                // branch's source is a permanent property, so a per-file line
                // would repeat on every login and crowd out actionable warnings.
                // It is counted via `lineage_sources_preserved` instead.  The
                // branch *does* warn under a variable-length provider, because
                // its own header carries the pagination marker and its resize is
                // refused too — pre-existing behavior, asserted here so a source
                // warning cannot hide behind it.
                if equal_length {
                    assert!(
                        result.warnings.is_empty(),
                        "{provider}: {:?}",
                        result.warnings
                    );
                } else {
                    assert!(
                        result
                            .warnings
                            .iter()
                            .all(|warning| !warning.contains(&source_name)),
                        "{provider}: the frozen source must not be reported per-file: {:?}",
                        result.warnings
                    );
                }
                assert_eq!(
                    fs::metadata(&source).unwrap().len(),
                    cutoff,
                    "the source length is load-bearing and must survive {provider}"
                );
                assert_native_cutoffs_in_bounds(&files);
            }
            assert_eq!(fs::read(&source).unwrap(), source_before);
            assert_eq!(fs::read(&branch).unwrap(), branch_before);
        });
    }

    /// The same reference, but the source is written with its own native marker.
    /// Both signals must agree; a source that already protects itself keeps its
    /// bytes and is not counted twice.
    #[test]
    fn marked_source_referenced_by_a_branch_keeps_its_bytes() {
        with_temp_user_home("paginated-marked-source", |root| {
            let id = "01980e4f-4a31-7000-8000-000000000707";
            let source = write_incremental_test_rollout(root, id, "openai", None, false);
            make_paginated(&source);
            let cutoff = fs::metadata(&source).unwrap().len();
            // Snapshot before any provider pass, so the final equality check
            // compares against the original bytes rather than the state left by
            // the first iteration.
            let source_before = fs::read(&source).unwrap();
            let branch_id = "01980e4f-4a31-7000-8000-000000000708";
            let branch = source.with_file_name(format!(
                "rollout-2026-10-04T00-00-00-{branch_id}.jsonl"
            ));
            fs::write(
                &branch,
                format!(
                    "{}{}",
                    json!({"ordinal":1,"type":"session_meta","payload":{
                "id":branch_id,"model_provider":"openai","history_mode":"paginated","history_base":{
                    "thread_id":id,"end_ordinal_exclusive":1,"end_byte_offset":cutoff}}}),
                    char::from(10)
                ),
            )
            .unwrap();
            let files = vec![source.clone(), branch.clone()];
            for provider in ["custom", "openai"] {
                let mut cache = RolloutScanCache::default();
                let result = sync_rollout_files_incremental(&files, provider, &mut cache).unwrap();
                assert_eq!(fs::metadata(&source).unwrap().len(), cutoff);
                assert_native_cutoffs_in_bounds(&files);
                assert_eq!(result.lineage_sources_preserved, 1);
            }
            assert_eq!(fs::read(&source).unwrap(), source_before);
        });
    }

    #[test]
    fn paginated_edit_head_is_not_merged_or_replaced_by_newer_sibling() {
        with_temp_user_home("paginated-edited-head", |root| {
            let id = "01980e4f-4a31-7000-8000-000000000703";
            let current = write_incremental_test_rollout(root, id, "openai", None, false);
            make_paginated(&current);
            let sibling = current.with_file_name("rollout-unselected-sibling.jsonl");
            fs::copy(&current, &sibling).unwrap();
            let first = scan_rollout_file(&current).unwrap();
            let mut second = scan_rollout_file(&sibling).unwrap();
            second.timestamp_ms += 5000;
            second.line_count += 10;
            let db = Connection::open(root.join(".codex/state_5.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);")
                .unwrap();
            db.execute(
                "INSERT INTO threads VALUES (?1, ?2)",
                params![id, current.to_string_lossy()],
            )
            .unwrap();
            let before = fs::read(&current).unwrap();
            for result in [
                materialize_canonical_rollouts(&[first.clone(), second.clone()]).unwrap(),
                select_canonical_rollouts_fast(&[first, second]).unwrap(),
            ] {
                assert_eq!(result.rollouts[0].path, current);
                assert_eq!(result.changed_files, 0);
                assert!(result.pending_ids.is_empty());
            }
            assert_eq!(fs::read(&current).unwrap(), before);
            assert_eq!(fs::read(&sibling).unwrap(), before);
        });
    }
}
