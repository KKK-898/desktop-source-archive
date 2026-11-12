use super::tests::with_temp_user_home;
use super::*;

#[test]
fn prior_exit_confirmation_is_not_current_exit_confirmation() {
    assert!(native_project_recovery_exit_check(false, || {
        panic!("unconfirmed exit must not even invoke the probe")
    })
    .is_err());
    assert!(native_project_recovery_exit_check(true, || Ok(Vec::new())).is_ok());
    assert!(
        native_project_recovery_exit_check(true, || Ok(vec![PathBuf::from(
            "synthetic-restarted-client"
        )]))
        .unwrap_err()
        .contains("重新启动")
    );
    assert!(
        native_project_recovery_exit_check(true, || Err("synthetic access failure".into()))
            .unwrap_err()
            .contains("无法再次确认")
    );
}

#[test]
fn fresh_running_or_unknown_client_defers_without_opening_database_or_losing_ownership() {
    with_temp_user_home("project-sync-fresh-probe", |_root| {
        fs::create_dir_all(codex_dir()).unwrap();
        let state_path = codex_dir().join(".codex-global-state.json");
        let state = json!({"app-server-projects-migration-by-host": {"synthetic": {"version": 1}}})
            .to_string();
        fs::write(&state_path, &state).unwrap();
        let database = codex_dir().join("state_5.sqlite");
        let original = b"not sqlite: no open allowed before a fresh exit check";
        fs::write(&database, original).unwrap();
        for probe in [
            Ok(vec![PathBuf::from("synthetic-client")]),
            Err("synthetic probe failure".to_string()),
        ] {
            let report = sync_native_project_memberships_with_exit_recheck(
                &codex_dir(),
                &[database.clone()],
                true,
                || probe,
            );
            assert!(report.deferred);
            assert!(report.native_projects_owned);
            assert_eq!(report.restored, 0);
            assert!(report.warning.contains("未关闭"));
            assert_eq!(fs::read(&database).unwrap(), original);
            assert_eq!(fs::read_to_string(&state_path).unwrap(), state);
            assert!(!codex_dir().join("backups").exists());
        }
    });
}

#[test]
fn native_recovery_error_retains_native_owned_diagnostic() {
    with_temp_user_home("project-sync-error-owned", |_root| {
        fs::create_dir_all(codex_dir()).unwrap();
        let identity = format!("local:{}", codex_dir().to_string_lossy());
        fs::write(codex_dir().join(".codex-global-state.json"), json!({
            "app-server-projects-migration-by-host": {&identity: {"version":1,"projectsMigrated":true,"threadAssignmentsMigrated":false,"threadAssignmentsReadMigrated":true,"pendingThreadAssignmentIds":["thread"]}},
            "app-server-project-id-by-legacy-project-id-by-host": {&identity:{}},
            "local-projects": {}, "thread-project-assignments": {}, "projectless-thread-ids": []
        }).to_string()).unwrap();
        let database = codex_dir().join("state_5.sqlite");
        fs::write(&database, b"synthetic corrupt sqlite").unwrap();
        let report = sync_native_project_memberships_with_exit_recheck(
            &codex_dir(),
            &[database],
            true,
            || Ok(Vec::new()),
        );
        assert!(report.deferred);
        assert!(report.native_projects_owned);
        assert_eq!(report.restored, 0);
        assert!(report.warning.contains("已保留现有数据"));
    });
}

#[test]
fn manual_and_startup_sync_wait_for_the_shared_foreground_launch_lock() {
    for startup in [false, true] {
        with_temp_user_home(
            if startup {
                "startup-sync-lock"
            } else {
                "manual-sync-lock"
            },
            |_root| {
                fs::create_dir_all(codex_dir()).unwrap();
                // Invalid config stops the call immediately after the lock is acquired;
                // it never reaches process controls, database creation or session sync.
                let config_path = codex_config_path();
                fs::write(&config_path, [0xff, 0xfe, 0xfd]).unwrap();
                let holder = CODEX_CONFIGURE_LOCK.lock().unwrap();
                let finished = AtomicBool::new(false);
                thread::scope(|scope| {
                    let worker = scope.spawn(|| {
                        let result = if startup {
                            gaoge_sync_codex_sessions_on_startup_inner()
                        } else {
                            gaoge_sync_codex_sessions_inner()
                        };
                        finished.store(true, Ordering::SeqCst);
                        assert!(result.is_err());
                    });
                    let deadline = Instant::now() + Duration::from_secs(3);
                    while CODEX_CONFIGURE_ACTIVE.load(Ordering::Acquire) == 0 {
                        assert!(
                            Instant::now() < deadline,
                            "sync never began waiting on foreground lock"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    assert!(!finished.load(Ordering::SeqCst));
                    assert!(!codex_dir().join("state_5.sqlite").exists());
                    drop(holder);
                    worker.join().unwrap();
                });
                assert!(finished.load(Ordering::SeqCst));
                assert_eq!(fs::read(&config_path).unwrap(), [0xff, 0xfe, 0xfd]);
                assert_eq!(CODEX_CONFIGURE_ACTIVE.load(Ordering::SeqCst), 0);
                assert!(!codex_dir().join("locks/gaogeaii-configure.lock").exists());
            },
        );
    }
}


/// Exercise production candidate discovery, provider sync, project recovery and
/// global-state preservation together. A lone native DB hid this regression.
#[test]
fn production_session_sync_preserves_projects_across_dual_store_api_round_trips() {
    with_temp_user_home("project-sync-dual-store-round-trips", |_root| {
        let home = codex_dir();
        fs::create_dir_all(home.join("sqlite")).unwrap();
        let mut fixture: Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/codex-project-migration-26.1103-dual-store.json"
        )).unwrap();
        fn adapt(value: &mut Value, home: &Path) {
            match value {
                Value::String(text) if text.starts_with("__WORKSPACE_") => {
                    *text = home.join(text.trim_matches('_')).to_string_lossy().into_owned();
                }
                Value::Object(object) => {
                    for (key, mut child) in std::mem::take(object) {
                        adapt(&mut child, home);
                        let key = if key == "local:__HOME__" {
                            format!("local:{}", home.to_string_lossy())
                        } else { key };
                        object.insert(key, child);
                    }
                }
                Value::Array(children) => children.iter_mut().for_each(|child| adapt(child, home)),
                _ => {}
            }
        }
        adapt(&mut fixture, &home);
        fixture["state"]["electron-persisted-atom-state"] = json!({
            "electron:onboarding-projectless-completed": true,
            "last_completed_onboarding": 1794134871,
            "electron:onboarding-welcome-pending": true,
            "synthetic-user-preference": "must-survive"
        });
        let original_state = serde_json::to_vec(&fixture["state"]).unwrap();
        fs::write(home.join(".codex-global-state.json"), &original_state).unwrap();
        let native = home.join("state_5.sqlite");
        let legacy = home.join("sqlite/state_5.sqlite");
        for (path, data, is_native) in [
            (&native, &fixture["nativeDatabase"], true),
            (&legacy, &fixture["legacyDatabase"], false),
        ] {
            let conn = Connection::open(path).unwrap();
            conn.execute_batch("CREATE TABLE threads (
                id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT 'Synthetic conversation',
                created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 2,
                model_provider TEXT NOT NULL, archived INTEGER NOT NULL,
                thread_section_id TEXT NOT NULL DEFAULT 'preserved-section');").unwrap();
            if is_native {
                conn.execute_batch("ALTER TABLE threads ADD COLUMN project_id TEXT;
                    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,metadata TEXT,position REAL,
                        created_at_ms INTEGER,updated_at_ms INTEGER);
                    CREATE TABLE project_roots(project_id TEXT,position INTEGER,path TEXT);").unwrap();
                for project in data["projects"].as_array().unwrap() {
                    conn.execute("INSERT INTO projects VALUES(?1,'Synthetic project',?2,0,1,2)",
                        params![project["id"].as_str().unwrap(), project["metadata"].to_string()]).unwrap();
                }
                for root in data["projectRoots"].as_array().unwrap() {
                    conn.execute("INSERT INTO project_roots VALUES(?1,0,?2)",
                        params![root["projectId"].as_str().unwrap(), root["path"].as_str().unwrap()]).unwrap();
                }
            }
            for thread in data["threads"].as_array().unwrap() {
                conn.execute("INSERT INTO threads(id,model_provider,archived) VALUES(?1,?2,?3)",
                    params![thread["id"].as_str().unwrap(), thread["modelProvider"].as_str().unwrap(),
                        thread["archived"].as_i64().unwrap()]).unwrap();
            }
        }
        let expected = fixture["expected"]["restored"].as_u64().unwrap();
        let mut memberships_after_first = Vec::new();
        for (iteration, provider) in ["custom", "openai", "custom", "custom"].iter().enumerate() {
            // Synthetic documents only; no real login, tokens, process or network.
            if *provider == "custom" {
                write_codex_api_auth("synthetic-project-round-trip", "fixture").unwrap();
                let auth = read_json_if_exists(&home.join("auth.json")).unwrap().unwrap();
                assert_eq!(auth["auth_mode"], "apikey");
                assert!(auth.get("tokens").is_none());
            } else {
                fs::write(home.join("auth.json"), json!({"auth_mode":"chatgpt",
                    "tokens":{"access_token":"synthetic-official-token","account_id":"synthetic-account"}
                }).to_string()).unwrap();
            }
            let auth_before = fs::read(home.join("auth.json")).unwrap();
            let report = sync_sessions(provider, true).unwrap();
            let projects = &report["nativeProjectSync"];
            assert_eq!(projects["deferred"], false, "{projects}");
            assert_eq!(projects["restored"], if iteration == 0 { expected } else { 0 });
            assert_eq!(projects["alreadyAssigned"], if iteration == 0 { 0 } else { expected });
            assert_eq!(report["providerMismatches"], 0);
            assert_eq!(fs::read(home.join("auth.json")).unwrap(), auth_before);
            assert_eq!(fs::read(home.join(".codex-global-state.json")).unwrap(), original_state);
            let conn = Connection::open(&native).unwrap();
            let memberships = conn.prepare("SELECT id,project_id FROM threads WHERE project_id IS NOT NULL ORDER BY id")
                .unwrap().query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            assert_eq!(memberships.len() as u64, expected);
            if iteration == 0 { memberships_after_first = memberships; }
            else { assert_eq!(memberships, memberships_after_first); }
            assert_eq!(conn.query_row("SELECT count(*) FROM projects", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
            assert_eq!(conn.query_row("SELECT count(*) FROM threads WHERE updated_at <> 2 OR thread_section_id <> 'preserved-section'",
                [], |row| row.get::<_, i64>(0)).unwrap(), 0);
            let legacy_conn = Connection::open(&legacy).unwrap();
            assert!(!sqlite_columns(&legacy_conn, "threads").iter().any(|column| column == "project_id"));
            assert_eq!(legacy_conn.query_row("SELECT count(*) FROM threads", [], |row| row.get::<_, i64>(0)).unwrap() as usize,
                fixture["legacyDatabase"]["threads"].as_array().unwrap().len());
        }
    });
}


#[test]
fn api_onboarding_bridge_uses_only_active_home_shared_completion_for_pure_api() {
    with_temp_user_home("api-onboarding-bridge-scope", |root| {
        let default_home = codex_dir();
        let active_home = root.join("isolated-active-home");
        fs::create_dir_all(&default_home).unwrap();
        fs::create_dir_all(&active_home).unwrap();
        let evidence = |time| json!({"electron-persisted-atom-state": {
            "electron:onboarding-projectless-completed": true,
            "last_completed_onboarding": time,
            "account-private-key": "never-export"
        }});
        fs::write(default_home.join(".codex-global-state.json"), evidence(100).to_string()).unwrap();
        fs::write(active_home.join(".codex-global-state.json"), evidence(200).to_string()).unwrap();
        let auth_path = active_home.join("auth.json");
        std::env::set_var("CODEX_HOME", &active_home);
        for (auth, expected) in [
            (build_codex_api_auth("synthetic-api-key"), true),
            (json!({"auth_mode":"chatgpt","tokens":{"access_token":"synthetic"}}), false),
            (json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic","tokens":{"access_token":"synthetic"}}), false),
            (json!({}), false),
        ] {
            fs::write(&auth_path, auth.to_string()).unwrap();
            let result = handle_codex_session_delete_bridge_request("/fuel/status", &json!({}));
            assert_eq!(result.get("apiLocalOnboarding").is_some(), expected);
            if expected {
                assert_eq!(result["apiLocalOnboarding"], json!({"projectlessCompleted":true,"completedAt":200}));
            }
            assert!(!result.to_string().contains("never-export"));
        }
        fs::write(&auth_path, build_codex_api_auth("synthetic-api-key").to_string()).unwrap();
        fs::write(active_home.join(".codex-global-state.json"), "{}").unwrap();
        assert!(codex_fuel_runtime_state().get("apiLocalOnboarding").is_none(), "first-time API cannot inherit an inactive home's completion");
        fs::write(active_home.join(".codex-global-state.json"), "{corrupt").unwrap();
        assert!(codex_fuel_runtime_state().get("apiLocalOnboarding").is_none());
    });
}
