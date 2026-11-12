mod provider_only_sync_regressions {
    use super::*;

    #[test]
    fn switching_suppliers_preserves_edited_head_metadata_and_projection_bytes() {
        with_temp_user_home("provider-only-native-head", |root| {
            let id = "01980e4f-4a31-7000-8000-000000000801";
            let revision = "01980e4f-4a31-7000-8000-000000000802";
            let dir = root.join(".codex/sessions/2026/10/06");
            fs::create_dir_all(&dir).unwrap();
            let original = dir.join(format!("rollout-2026-10-06T00-00-00-{id}.jsonl"));
            let source = format!("{}\n{}\n",
                json!({"ordinal":0,"type":"session_meta","payload":{"id":id,"session_id":id,"model_provider":"custom","history_mode":"paginated","source":"vscode","cwd":root,"timestamp":"2026-10-06T00:00:00Z"}}),
                json!({"ordinal":1,"type":"event_msg","payload":{"type":"user_message","message":"Preserve this native conversation"}}));
            fs::write(&original, &source).unwrap();
            let edited = dir.join(format!("rollout-2026-10-06T00-01-00-{id}_{revision}.jsonl"));
            fs::write(&edited, format!("{}\n", json!({"ordinal":2,"type":"session_meta","payload":{"id":id,"session_id":id,"model_provider":"custom","history_mode":"paginated","source":"vscode","cwd":root,"timestamp":"2026-10-06T00:01:00Z","history_base":{"thread_id":id,"end_ordinal_exclusive":2,"end_byte_offset":source.len()}}}))).unwrap();
            // Reproduce an old managed copy with the same physical source ID.
            let managed = root.join(".codex/sessions").join(CODEX_CANONICAL_ROLLOUT_DIR).join(original.file_name().unwrap());
            ensure_parent(&managed).unwrap();
            fs::write(&managed, format!("{source}{}\n", json!({"ordinal":2,"type":"event_msg","payload":{"type":"user_message","message":"An old managed copy must not replace the native branch"}}))).unwrap();
            let paths = [original, edited.clone(), managed];
            let original_bytes: Vec<_> = paths.iter().map(|p| fs::read_to_string(p).unwrap()).collect();
            let db_path = root.join(".codex/state_5.sqlite");
            let db = Connection::open(&db_path).unwrap();
            db.execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, title TEXT, updated_at INTEGER, source TEXT, cwd TEXT, archived INTEGER, has_user_event INTEGER, model TEXT, reasoning_effort TEXT, history_mode TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT);").unwrap();
            db.execute("INSERT INTO threads VALUES (?1,?2,'custom','User chosen title',123456,'vscode','native-workspace',0,1,'native-model','high','paginated')", params![id, edited.to_string_lossy()]).unwrap();
            db.execute("INSERT INTO thread_spawn_edges VALUES (?1,'child','closed')", [id]).unwrap();
            drop(db);
            let history_path = root.join(".codex/thread_history_1.sqlite");
            let history = Connection::open(&history_path).unwrap();
            history.execute_batch("CREATE TABLE thread_turns (thread_id TEXT, status TEXT); CREATE TABLE thread_items (thread_id TEXT, item_json TEXT); CREATE TABLE thread_history_projection_state (thread_id TEXT, next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);").unwrap();
            history.execute("INSERT INTO thread_turns VALUES (?1,'interrupted')",[id]).unwrap();
            history.execute("INSERT INTO thread_items VALUES (?1,'native message')",[id]).unwrap();
            history.execute("INSERT INTO thread_history_projection_state VALUES (?1,33057790,5098)",[id]).unwrap();
            drop(history);
            let projection_bytes = fs::read(&history_path).unwrap();
            for provider in ["openai", "custom", "openai", "custom"] {
                let result = sync_sessions(provider, true).unwrap();
                for field in ["canonicalRolloutFilesChanged","canonicalRolloutPending","sqliteRolloutPathsChanged","sqliteMetadataThreadsChanged","sqliteSpawnEdgesChanged","historyProjectionRowsInvalidated","legacyResponseItemsRepaired","providerMismatches"] {
                    assert_eq!(result[field], 0, "{field}");
                }
                for (path, before) in paths.iter().zip(&original_bytes) {
                    assert_eq!(fs::read_to_string(path).unwrap(), before.replacen("\"model_provider\":\"custom\"", &format!("\"model_provider\":\"{provider}\""), 1));
                }
                let db = Connection::open(&db_path).unwrap();
                let state: (String,String,String,i64,String,String,String,i64) = db.query_row("SELECT rollout_path,model_provider,title,updated_at,cwd,model,reasoning_effort,has_user_event FROM threads WHERE id=?1",[id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?))).unwrap();
                assert_eq!(state, (edited.to_string_lossy().into_owned(),provider.into(),"User chosen title".into(),123456,"native-workspace".into(),"native-model".into(),"high".into(),1));
                assert_eq!(db.query_row("SELECT status FROM thread_spawn_edges",[],|r|r.get::<_,String>(0)).unwrap(),"closed");
                assert_eq!(fs::read(&history_path).unwrap(), projection_bytes);
                assert_eq!(rollout_files().len(), 3);
                assert!(read_session_index(&root.join(".codex/session_index.jsonl")).rows.contains_key(id));
            }
        });
    }

    #[test]
    fn ambiguous_unindexed_histories_are_listed_without_creating_a_merged_head() {
        with_temp_user_home("provider-only-ambiguous", |root| {
            let id = "01980e4f-4a31-7000-8000-000000000803";
            let first = write_incremental_test_rollout(root, id, "openai", None, false);
            let second = first.with_file_name("rollout-second-copy.jsonl");
            fs::copy(&first, &second).unwrap();
            let result = sync_sessions("custom", true).unwrap();
            assert_eq!(result["canonicalRolloutFilesChanged"], 0);
            assert_eq!(result["sqliteBackfilledThreads"], 0);
            assert_eq!(result["providerMismatches"], 0);
            assert_eq!(rollout_files().len(), 2);
            assert!(!root.join(".codex/sessions").join(CODEX_CANONICAL_ROLLOUT_DIR).exists());
            assert!(read_session_index(&root.join(".codex/session_index.jsonl")).rows.contains_key(id));
        });
    }
}
