use super::*;
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    database: PathBuf,
    state: Value,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let workspace = home.join("workspace");
        let database = home.join("state_5.sqlite");
        let identity = format!("local:{}", home.to_string_lossy());
        let state = json!({
            MIGRATIONS: { (identity.clone()): {
                "version": 1, "projectsMigrated": true,
                "threadAssignmentsMigrated": false,
                "threadAssignmentsReadMigrated": true,
                "pendingThreadAssignmentIds": ["thread-one"]
            }},
            LEGACY_IDS: { (identity): {"legacy-project": "server-project"} },
            "local-projects": { "legacy-project": {
                "id": "legacy-project", "rootPaths": [workspace.to_string_lossy()]
            }},
            "thread-project-assignments": { "thread-one": {
                "projectKind": "local", "projectId": "legacy-project"
            }},
            "projectless-thread-ids": [],
            "feature-gates": {"localProjectTaskMembership": false},
            "private-sentinel": "never-copy-credentials-or-chat-content"
        });
        let conn = Connection::open(&database).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
            CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT DEFAULT '{}');
            CREATE TABLE project_roots (project_id TEXT NOT NULL REFERENCES projects(id), path TEXT);
            CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), archived INTEGER NOT NULL DEFAULT 0, cwd TEXT, updated_at INTEGER DEFAULT 12345, thread_section_id TEXT DEFAULT 'existing-section');
            INSERT INTO projects (id,name) VALUES ('server-project','Project'),('other-project','Other');
            INSERT INTO threads (id,cwd) VALUES ('thread-one','a-different-cwd-is-not-the-source-of-membership');"
        ).unwrap();
        conn.execute(
            "INSERT INTO project_roots VALUES ('server-project', ?1)",
            [workspace.to_string_lossy().as_ref()],
        )
        .unwrap();
        let fixture = Self {
            root,
            database,
            state,
        };
        fixture.save();
        fixture
    }
    fn save(&self) {
        fs::write(
            self.root.path().join(".codex-global-state.json"),
            serde_json::to_vec(&self.state).unwrap(),
        )
        .unwrap();
    }
    fn migration(&mut self) -> &mut Value {
        let identity = format!("local:{}", self.root.path().to_string_lossy());
        &mut self.state[MIGRATIONS][identity]
    }
    fn run(&self) -> Result<ProjectCompatReport, String> {
        sync_native_project_memberships(self.root.path(), &[self.database.clone()], true)
    }
    fn membership(&self) -> Option<String> {
        Connection::open(&self.database)
            .unwrap()
            .query_row(
                "SELECT project_id FROM threads WHERE id = 'thread-one'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }
    fn sql(&self, sql: &str) {
        Connection::open(&self.database)
            .unwrap()
            .execute_batch(sql)
            .unwrap();
    }
}

#[test]
fn restores_only_pending_explicit_local_memberships_and_is_idempotent() {
    let f = Fixture::new();
    let source = fs::read(f.root.path().join(".codex-global-state.json")).unwrap();
    let report = f.run().unwrap();
    assert!(report.native_projects_owned);
    assert_eq!(report.restored, 1);
    assert_eq!(report.migration_pending, 1);
    assert_eq!(f.membership().as_deref(), Some("server-project"));
    assert_eq!(
        source,
        fs::read(f.root.path().join(".codex-global-state.json")).unwrap()
    );
    let backup = fs::read_to_string(report.backup_path.unwrap()).unwrap();
    assert!(!backup.contains("never-copy-credentials-or-chat-content"));
    assert!(!backup.contains("feature-gates"));
    let backup: Value = serde_json::from_str(&backup).unwrap();
    assert!(backup["memberships"][0]["priorProjectId"].is_null());
    assert_eq!(backup["memberships"][0]["projectId"], "server-project");
    assert_eq!(backup["status"], "prepared");
    let second = f.run().unwrap();
    assert_eq!(second.restored, 0);
    assert_eq!(second.already_assigned, 1);
    assert!(second.backup_path.is_none());
    assert_eq!(
        fs::read_dir(f.root.path().join("backups/gaoge-project-compat"))
            .unwrap()
            .count(),
        1
    );
    let conn = Connection::open(&f.database).unwrap();
    let metadata: (i64, String) = conn
        .query_row(
            "SELECT updated_at,thread_section_id FROM threads",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(metadata, (12345, "existing-section".to_string()));
}

#[test]
fn existing_native_membership_is_never_overridden() {
    let f = Fixture::new();
    f.sql("UPDATE threads SET project_id='other-project'");
    let report = f.run().unwrap();
    assert_eq!(report.already_assigned, 1);
    assert_eq!(report.restored, 0);
    assert_eq!(f.membership().as_deref(), Some("other-project"));
    assert!(!f.root.path().join("backups").exists());
}

#[test]
fn explicit_projectless_wins_over_legacy_assignment_without_clearing_pending() {
    let mut f = Fixture::new();
    f.state["projectless-thread-ids"] = json!(["thread-one"]);
    f.save();
    let report = f.run().unwrap();
    assert_eq!(report.explicitly_projectless, 1);
    assert_eq!(report.restored, 0);
    assert!(f.membership().is_none());
    assert_eq!(
        f.migration()["pendingThreadAssignmentIds"],
        json!(["thread-one"])
    );
    assert!(!f.root.path().join("backups").exists());
}

#[test]
fn archived_threads_and_remote_or_cloud_assignments_are_untouched() {
    let f = Fixture::new();
    f.sql("UPDATE threads SET archived=1");
    assert_eq!(f.run().unwrap().archived, 1);
    assert!(f.membership().is_none());
    for (field, value) in [
        ("projectKind", "chatgpt"),
        ("projectOrigin", "chatgpt"),
        ("hostId", "remote-host"),
    ] {
        let mut f = Fixture::new();
        f.state["thread-project-assignments"]["thread-one"][field] = json!(value);
        f.save();
        assert_eq!(f.run().unwrap().skipped_non_local, 1);
        assert!(f.membership().is_none());
    }
    let mut f = Fixture::new();
    f.state["thread-project-membership-host-ids"] = json!({"thread-one":"remote-host"});
    f.save();
    assert_eq!(f.run().unwrap().skipped_non_local, 1);
    assert!(f.membership().is_none());
}

#[test]
fn missing_mapping_project_or_thread_is_not_synthesized() {
    let mut f = Fixture::new();
    let identity = format!("local:{}", f.root.path().to_string_lossy());
    f.state[LEGACY_IDS][&identity] = json!({});
    f.save();
    assert_eq!(f.run().unwrap().unmapped, 1);
    assert!(f.membership().is_none());
    let f = Fixture::new();
    f.sql("DELETE FROM project_roots; DELETE FROM projects WHERE id='server-project'");
    assert_eq!(f.run().unwrap().missing_projects, 1);
    assert!(f.membership().is_none());
    let f = Fixture::new();
    f.sql("DELETE FROM threads");
    assert_eq!(f.run().unwrap().missing_threads, 1);
    assert_eq!(
        Connection::open(&f.database)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn wrong_home_unknown_migration_and_completed_migration_do_not_restore() {
    let mut f = Fixture::new();
    let original = f.migration().clone();
    f.state[MIGRATIONS] = json!({"local:some-other-home": original});
    f.save();
    assert!(f.run().unwrap().deferred);
    assert!(f.membership().is_none());
    for version in [0, 2, 999] {
        let mut f = Fixture::new();
        f.migration()["version"] = json!(version);
        f.save();
        assert!(f.run().unwrap().deferred);
        assert!(f.membership().is_none());
    }
    let mut f = Fixture::new();
    f.migration()["threadAssignmentsMigrated"] = json!(true);
    f.save();
    let report = f.run().unwrap();
    assert_eq!(report.restored, 0);
    assert!(!report.deferred);
    assert!(f.membership().is_none());
}

#[test]
fn missing_pending_and_changed_project_root_do_not_guess_from_cwd() {
    let mut f = Fixture::new();
    f.migration()["pendingThreadAssignmentIds"] = json!(["another-thread"]);
    f.save();
    assert_eq!(f.run().unwrap().missing_assignments, 1);
    assert!(f.membership().is_none());
    let f = Fixture::new();
    f.sql("UPDATE project_roots SET path='different-root'");
    assert_eq!(f.run().unwrap().conflicts, 1);
    assert!(f.membership().is_none());
}

#[test]
fn unsupported_schema_and_multiple_databases_are_deferred() {
    let f = Fixture::new();
    f.sql("ALTER TABLE threads RENAME COLUMN project_id TO future_project_id");
    assert!(f.run().unwrap().deferred);
    assert!(!f.root.path().join("backups").exists());
    let f = Fixture::new();
    let second = f.root.path().join("other-state.sqlite");
    fs::copy(&f.database, &second).unwrap();
    let report =
        sync_native_project_memberships(f.root.path(), &[f.database.clone(), second], true)
            .unwrap();
    assert!(report.deferred);
    assert!(f.membership().is_none());
}

#[test]
fn malformed_source_and_unconfirmed_exit_never_create_or_modify_state() {
    let f = Fixture::new();
    fs::write(f.root.path().join(".codex-global-state.json"), b"{bad-json").unwrap();
    assert!(f.run().is_err());
    assert!(f.membership().is_none());
    assert!(!f.root.path().join("backups").exists());
    // Do not even parse the source or open a DB before the exit precondition.
    let report =
        sync_native_project_memberships(f.root.path(), &[f.database.clone()], false).unwrap();
    assert!(report.deferred);
    assert!(f.membership().is_none());
}

#[test]
fn source_race_rolls_back_every_membership_and_keeps_native_progress() {
    let f = Fixture::new();
    let path = f.root.path().join(".codex-global-state.json");
    let mut concurrent_state = f.state.clone();
    concurrent_state["projectless-thread-ids"] = json!(["thread-one"]);
    let source = serde_json::to_vec(&concurrent_state).unwrap();
    let hook = || fs::write(&path, &source).unwrap();
    let result = sync_inner(f.root.path(), &[f.database.clone()], true, Some(&hook));
    assert!(result.unwrap_err().contains("改变"));
    assert!(f.membership().is_none());
    assert_eq!(fs::read(path).unwrap(), source);
}

#[test]
fn backup_failure_and_sql_failure_leave_memberships_unmodified() {
    let f = Fixture::new();
    fs::write(f.root.path().join("backups"), b"not-a-directory").unwrap();
    assert!(f.run().is_err());
    assert!(f.membership().is_none());
    let mut f = Fixture::new();
    f.migration()["pendingThreadAssignmentIds"] = json!(["thread-one", "thread-two"]);
    f.state["thread-project-assignments"]["thread-two"] =
        f.state["thread-project-assignments"]["thread-one"].clone();
    f.save();
    f.sql("INSERT INTO threads(id) VALUES ('thread-two'); CREATE TRIGGER fail_second BEFORE UPDATE OF project_id ON threads WHEN NEW.id='thread-two' BEGIN SELECT RAISE(ABORT, 'intentional isolated failure'); END;");
    assert!(f.run().is_err());
    assert!(f.membership().is_none());
    let count: i64 = Connection::open(&f.database)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE project_id IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn native_ownership_detection_is_conservative_for_future_versions() {
    assert!(!has_native_project_state(&json!({"local-projects":{}})));
    assert!(has_native_project_state(&json!({MIGRATIONS:null})));
    assert!(has_native_project_state(&json!({LEGACY_IDS:{}})));
    assert!(has_native_project_state(
        &json!({MIGRATIONS:{"some-future-host":{"version":99}}})
    ));
}

#[test]
fn linked_chatgpt_projects_and_native_metadata_backings_are_never_restored() {
    for field in [
        "chatGptBacking",
        "chatGptBackingCreation",
        "retiredChatGptBacking",
        "chatGptBackingRecoveryPending",
    ] {
        let mut f = Fixture::new();
        f.state["local-projects"]["legacy-project"][field] = json!({"synthetic":"cloud-link"});
        f.save();
        assert_eq!(f.run().unwrap().skipped_non_local, 1, "{field}");
        assert!(f.membership().is_none());
        let f = Fixture::new();
        let conn = Connection::open(&f.database).unwrap();
        conn.execute(
            "UPDATE projects SET metadata=?1 WHERE id='server-project'",
            [json!({format!("codex.{field}"):{"synthetic":"cloud-link"}}).to_string()],
        )
        .unwrap();
        drop(conn);
        assert_eq!(f.run().unwrap().skipped_non_local, 1, "native {field}");
        assert!(f.membership().is_none());
    }
}

#[test]
fn malformed_native_metadata_or_mismatched_legacy_identity_are_preserved() {
    for metadata in [
        "[1]",
        "null",
        "{bad",
        r#"{"codex.localProjectId":"another-legacy-id"}"#,
    ] {
        let f = Fixture::new();
        let conn = Connection::open(&f.database).unwrap();
        conn.execute(
            "UPDATE projects SET metadata=?1 WHERE id='server-project'",
            [metadata],
        )
        .unwrap();
        drop(conn);
        assert_eq!(f.run().unwrap().conflicts, 1, "{metadata}");
        assert!(f.membership().is_none());
    }
    let f = Fixture::new();
    f.sql("ALTER TABLE projects RENAME COLUMN metadata TO future_metadata");
    assert!(f.run().unwrap().deferred);
    assert!(f.membership().is_none());
}

#[test]
fn custom_sqlite_home_is_supported_but_non_state_filenames_are_refused() {
    let f = Fixture::new();
    let custom = tempfile::tempdir().unwrap();
    let custom_database = custom.path().join("state_5.sqlite");
    fs::copy(&f.database, &custom_database).unwrap();
    let report =
        sync_native_project_memberships(f.root.path(), &[custom_database.clone()], true).unwrap();
    assert_eq!(report.restored, 1);
    assert!(f.membership().is_none());
    let actual: String = Connection::open(&custom_database)
        .unwrap()
        .query_row(
            "SELECT project_id FROM threads WHERE id='thread-one'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(actual, "server-project");
    let wrong = custom.path().join("other.sqlite");
    fs::copy(&f.database, &wrong).unwrap();
    assert!(
        sync_native_project_memberships(f.root.path(), &[wrong], true)
            .unwrap()
            .deferred
    );
}

#[test]
fn concurrent_writer_and_corrupt_database_abort_without_user_state_changes() {
    let f = Fixture::new();
    let conn = Connection::open(&f.database).unwrap();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    assert!(f.run().is_err());
    conn.execute_batch("ROLLBACK").unwrap();
    assert!(f.membership().is_none());
    assert!(!f.root.path().join("backups").exists());
    let f = Fixture::new();
    let original = b"not a sqlite database";
    fs::write(&f.database, original).unwrap();
    assert!(f.run().is_err());
    assert_eq!(fs::read(&f.database).unwrap(), original);
    assert!(!f.root.path().join("backups").exists());
}

#[test]
fn post_write_verification_rejects_trigger_changed_membership_and_rolls_back() {
    let f = Fixture::new();
    f.sql("CREATE TRIGGER modify_project AFTER UPDATE OF project_id ON threads WHEN NEW.project_id='server-project' BEGIN UPDATE threads SET project_id='other-project' WHERE id=NEW.id; END;");
    assert!(f.run().unwrap_err().contains("复核不一致"));
    assert!(f.membership().is_none());
}

#[test]
fn flat_null_metadata_does_not_mask_a_nested_cloud_binding() {
    let f = Fixture::new();
    let conn = Connection::open(&f.database).unwrap();
    let metadata =
        json!({"codex.chatGptBacking":null,"codex":{"chatGptBacking":{"accountId":"synthetic"}}});
    conn.execute(
        "UPDATE projects SET metadata=?1 WHERE id='server-project'",
        [metadata.to_string()],
    )
    .unwrap();
    drop(conn);
    assert_eq!(f.run().unwrap().skipped_non_local, 1);
    assert!(f.membership().is_none());
}

fn observed_dual_store_fixture() -> (TempDir, PathBuf, PathBuf, Value) {
    let root = tempfile::tempdir().unwrap();
    let mut fixture: Value = serde_json::from_str(include_str!(
        "../../scripts/fixtures/codex-project-migration-26.1103-dual-store.json"
    ))
    .unwrap();
    fn adapt(value: &mut Value, home: &Path) {
        match value {
            Value::String(text) if text.starts_with("__WORKSPACE_") => {
                *text = home
                    .join(text.trim_matches('_'))
                    .to_string_lossy()
                    .into_owned();
            }
            Value::Object(object) => {
                for (key, mut child) in std::mem::take(object) {
                    adapt(&mut child, home);
                    let key = if key == "local:__HOME__" {
                        format!("local:{}", home.to_string_lossy())
                    } else {
                        key
                    };
                    object.insert(key, child);
                }
            }
            Value::Array(children) => {
                for child in children {
                    adapt(child, home);
                }
            }
            _ => {}
        }
    }
    adapt(&mut fixture, root.path());
    fs::write(
        root.path().join(".codex-global-state.json"),
        serde_json::to_vec(&fixture["state"]).unwrap(),
    )
    .unwrap();
    let native = root.path().join("state_5.sqlite");
    let legacy = root.path().join("sqlite/state_5.sqlite");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let conn = Connection::open(&native).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;
        CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT 'Synthetic project',metadata TEXT NOT NULL,position REAL NOT NULL DEFAULT 0,created_at_ms INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE project_roots(project_id TEXT NOT NULL REFERENCES projects(id),position INTEGER NOT NULL DEFAULT 0,path TEXT NOT NULL);
        CREATE TABLE threads(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),archived INTEGER NOT NULL,model_provider TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 12345,thread_section_id TEXT NOT NULL DEFAULT 'preserved-section');").unwrap();
    for project in fixture["nativeDatabase"]["projects"].as_array().unwrap() {
        conn.execute(
            "INSERT INTO projects(id,metadata) VALUES(?1,?2)",
            params![
                project["id"].as_str().unwrap(),
                project["metadata"].to_string()
            ],
        )
        .unwrap();
    }
    for project_root in fixture["nativeDatabase"]["projectRoots"]
        .as_array()
        .unwrap()
    {
        conn.execute(
            "INSERT INTO project_roots(project_id,path) VALUES(?1,?2)",
            params![
                project_root["projectId"].as_str().unwrap(),
                project_root["path"].as_str().unwrap()
            ],
        )
        .unwrap();
    }
    for thread in fixture["nativeDatabase"]["threads"].as_array().unwrap() {
        conn.execute(
            "INSERT INTO threads(id,project_id,archived,model_provider) VALUES(?1,?2,?3,?4)",
            params![
                thread["id"].as_str().unwrap(),
                thread["projectId"].as_str(),
                thread["archived"].as_i64().unwrap(),
                thread["modelProvider"].as_str().unwrap()
            ],
        )
        .unwrap();
    }
    drop(conn);
    let conn = Connection::open(&legacy).unwrap();
    conn.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER NOT NULL,model_provider TEXT NOT NULL); CREATE TABLE unrelated_legacy_state(id TEXT);").unwrap();
    for thread in fixture["legacyDatabase"]["threads"].as_array().unwrap() {
        conn.execute(
            "INSERT INTO threads VALUES(?1,?2,?3)",
            params![
                thread["id"].as_str().unwrap(),
                thread["archived"].as_i64().unwrap(),
                thread["modelProvider"].as_str().unwrap()
            ],
        )
        .unwrap();
    }
    drop(conn);
    (root, native, legacy, fixture)
}

#[test]
fn observed_native_26_1103_dual_store_recovers_complete_first_pass_memberships() {
    let (root, native, legacy, fixture) = observed_dual_store_fixture();
    let source = root.path().join(".codex-global-state.json");
    let before_source = fs::read(&source).unwrap();
    let before_legacy = fs::read(&legacy).unwrap();
    let report =
        sync_native_project_memberships(root.path(), &[legacy.clone(), native.clone()], true)
            .unwrap();
    assert!(
        !report.deferred,
        "native project store was blocked by a legacy thread-only database: {}",
        report.warning
    );
    assert_eq!(report.restored, 223);
    assert_eq!(report.explicitly_projectless, 212);
    assert_eq!(report.missing_assignments, 0);
    assert_eq!(report.missing_threads, 1);
    assert_eq!(report.archived, 11);
    assert_eq!(report.migration_pending, 447);
    assert_eq!(
        report.conflicts + report.unmapped + report.missing_projects + report.skipped_non_local,
        0
    );
    assert!(report.backup_path.is_some());
    assert_eq!(fs::read(&legacy).unwrap(), before_legacy);
    assert_eq!(fs::read(&source).unwrap(), before_source);
    assert_eq!(fs::read_dir(legacy.parent().unwrap()).unwrap().count(), 1);

    let state = &fixture["state"];
    let identity = format!("local:{}", root.path().to_string_lossy());
    let pending = state[MIGRATIONS][&identity]["pendingThreadAssignmentIds"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    let projectless = state["projectless-thread-ids"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    let first_pass =
        state[MIGRATIONS][&identity]["threadAssignmentsReadMigrated"].as_bool() != Some(true);
    let mut expected_projection = BTreeMap::new();
    let conn = Connection::open(&native).unwrap();
    for before in fixture["nativeDatabase"]["threads"].as_array().unwrap() {
        let id = before["id"].as_str().unwrap();
        let eligible = (first_pass || pending.contains(id))
            && !projectless.contains(id)
            && before["archived"] == 0
            && before["projectId"].is_null();
        let expected = if eligible {
            state["thread-project-assignments"][id]["projectId"]
                .as_str()
                .and_then(|legacy_id| state[LEGACY_IDS][&identity][legacy_id].as_str())
        } else {
            before["projectId"].as_str()
        };
        let actual:(Option<String>,i64,String,i64,String)=conn.query_row("SELECT project_id,archived,model_provider,updated_at,thread_section_id FROM threads WHERE id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).unwrap();
        assert_eq!(actual.0.as_deref(), expected, "synthetic thread {id}");
        assert_eq!(actual.1, before["archived"].as_i64().unwrap());
        assert_eq!(actual.2, before["modelProvider"].as_str().unwrap());
        assert_eq!(
            (actual.3, actual.4),
            (12345, "preserved-section".to_string())
        );
        if let Some(project) = expected {
            expected_projection.insert(id.to_string(), project.to_string());
        }
    }
    let projected=conn.prepare("SELECT t.id,p.id FROM threads t JOIN projects p ON t.project_id=p.id JOIN project_roots r ON r.project_id=p.id WHERE t.archived=0 ORDER BY t.id").unwrap().query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).unwrap().collect::<Result<BTreeMap<_,_>,_>>().unwrap();
    assert_eq!(projected, expected_projection);
    assert_eq!(projected.len(), 223);
    let api_snapshot = super::super::codex_api_local_projects::prepare_with_databases(
        root.path(),
        state,
        &[native.clone(), legacy.clone()],
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        api_snapshot["globals"]["local-projects"]
            .as_object()
            .unwrap()
            .len(),
        4
    );
    let cached_assignments = api_snapshot["memberships"]["assignments"]
        .as_object()
        .unwrap();
    assert_eq!(cached_assignments.len(), 223);
    assert_eq!(
        cached_assignments
            .iter()
            .map(|(thread, assignment)| (
                thread.clone(),
                assignment["projectId"].as_str().unwrap().to_owned()
            ))
            .collect::<BTreeMap<_, _>>(),
        projected
    );
    assert!(api_snapshot["memberships"]["projectlessThreadIds"]
        .as_array()
        .unwrap()
        .iter()
        .all(|thread| conn
            .query_row(
                "SELECT archived FROM threads WHERE id=?1",
                [thread.as_str().unwrap()],
                |row| row.get::<_, i64>(0)
            )
            .unwrap()
            == 0));
    // Optional cross-runtime evidence for the native selector harness. This
    // exports only synthetic IDs/paths from this isolated fixture, after the
    // actual Rust transaction and SQL projection, never the user's database.
    if let Ok(output) = std::env::var("GAOGE_PROJECT_FIXTURE_PROJECTION_OUT") {
        let output = PathBuf::from(output);
        assert!(
            output.is_absolute(),
            "fixture projection requires an explicit absolute path"
        );
        let projects = conn.prepare("SELECT id,metadata FROM projects ORDER BY id").unwrap()
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .unwrap().collect::<Result<Vec<_>,_>>().unwrap()
            .into_iter().map(|(id,metadata)| {
                let roots = conn.prepare("SELECT path FROM project_roots WHERE project_id=?1 ORDER BY path").unwrap()
                    .query_map([&id], |row| row.get::<_, String>(0)).unwrap()
                    .collect::<Result<Vec<_>,_>>().unwrap();
                json!({"id":id,"metadata":serde_json::from_str::<Value>(&metadata).unwrap(),"roots":roots.into_iter().map(|path|json!({"path":path})).collect::<Vec<_>>()})
            }).collect::<Vec<_>>();
        let threads = conn.prepare("SELECT id,archived,project_id FROM threads ORDER BY id").unwrap()
            .query_map([], |row| Ok((row.get::<_, String>(0)?,row.get::<_,i64>(1)?,row.get::<_, Option<String>>(2)?)))
            .unwrap().collect::<Result<Vec<_>,_>>().unwrap()
            .into_iter().map(|(id,archived,project_id)|json!({"id":id,"archived":archived,"projectId":project_id})).collect::<Vec<_>>();
        let assignments = projected
            .iter()
            .map(|(id, project)| {
                (
                    id.clone(),
                    json!({"projectKind":"local","projectId":project}),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let projection = json!({"fixtureVersion":1,"syntheticOnly":true,"evidence":fixture["evidence"],"projects":projects,"threads":threads,"memberships":{"assignments":assignments,"projectlessThreadIds":state["projectless-thread-ids"]},"expected":fixture["expected"]});
        fs::write(output, serde_json::to_vec_pretty(&projection).unwrap()).unwrap();
    }
    drop(conn);
    let second =
        sync_native_project_memberships(root.path(), &[native, legacy.clone()], true).unwrap();
    assert_eq!(second.restored, 0);
    assert_eq!(second.already_assigned, 223);
    assert!(!second.deferred);
    assert!(second.backup_path.is_none());
    assert_eq!(fs::read(legacy).unwrap(), before_legacy);
    assert_eq!(fs::read(source).unwrap(), before_source);
}

#[test]
fn duplicate_paths_select_one_native_store_and_legacy_only_is_deferred() {
    let f = Fixture::new();
    let report = sync_native_project_memberships(
        f.root.path(),
        &[
            f.database.clone(),
            f.root.path().join(".").join("state_5.sqlite"),
            f.database.clone(),
        ],
        true,
    )
    .unwrap();
    assert_eq!(report.restored, 1);
    assert!(!report.deferred);

    let f = Fixture::new();
    let legacy = f.root.path().join("state_4.sqlite");
    Connection::open(&legacy)
        .unwrap()
        .execute_batch("CREATE TABLE threads(id TEXT,archived INTEGER)")
        .unwrap();
    let before = fs::read(&legacy).unwrap();
    assert!(
        sync_native_project_memberships(f.root.path(), &[legacy.clone()], true)
            .unwrap()
            .deferred
    );
    assert_eq!(fs::read(&legacy).unwrap(), before);
    assert!(!f.root.path().join("backups").exists());
}

#[test]
fn a_second_full_native_store_is_never_chosen_by_location_or_row_count() {
    let f = Fixture::new();
    let second = f.root.path().join("state_4.sqlite");
    fs::copy(&f.database, &second).unwrap();
    Connection::open(&second)
        .unwrap()
        .execute("DELETE FROM threads", [])
        .unwrap();
    let before_native = fs::read(&f.database).unwrap();
    let before_second = fs::read(&second).unwrap();
    for paths in [
        vec![f.database.clone(), second.clone()],
        vec![second.clone(), f.database.clone()],
    ] {
        let report = sync_native_project_memberships(f.root.path(), &paths, true).unwrap();
        assert!(report.deferred);
        assert!(report.warning.contains("多个完整候选"));
        assert_eq!(report.restored, 0);
    }
    assert_eq!(fs::read(&f.database).unwrap(), before_native);
    assert_eq!(fs::read(&second).unwrap(), before_second);
    assert!(!f.root.path().join("backups").exists());
}

#[test]
fn partial_unknown_and_view_schemas_cannot_be_ignored_as_legacy_candidates() {
    for schema in [
        "CREATE TABLE threads(id TEXT,archived INTEGER,project_id TEXT)",
        "CREATE TABLE threads(id TEXT,archived INTEGER); CREATE TABLE projects(id TEXT)",
        "CREATE TABLE threads(id TEXT,archived INTEGER); CREATE TABLE project_roots(project_id TEXT,path TEXT)",
        "CREATE TABLE threads(id TEXT,archived INTEGER); CREATE TABLE Projects(id TEXT)",
        "CREATE TABLE thread_rows(id TEXT,archived INTEGER); CREATE VIEW threads AS SELECT * FROM thread_rows",
        "CREATE TABLE threads(id TEXT,archived INTEGER,project_id TEXT); CREATE VIEW projects AS SELECT 'p' AS id,'{}' AS metadata; CREATE TABLE project_roots(project_id TEXT,path TEXT)",
        "CREATE TABLE threads(id TEXT)",
        "CREATE TABLE unrelated(id TEXT)",
    ] {
        let f = Fixture::new();
        let other = f.root.path().join("state_4.sqlite");
        Connection::open(&other).unwrap().execute_batch(schema).unwrap();
        let before_native = fs::read(&f.database).unwrap();
        let before_other = fs::read(&other).unwrap();
        let report = sync_native_project_memberships(f.root.path(), &[f.database.clone(), other.clone()], true).unwrap();
        assert!(report.deferred, "unknown candidate was ignored: {schema}");
        assert_eq!(report.restored, 0);
        assert_eq!(fs::read(&f.database).unwrap(), before_native);
        assert_eq!(fs::read(&other).unwrap(), before_other);
        assert!(!f.root.path().join("backups").exists());
    }
}

#[test]
fn corrupt_or_non_file_candidates_abort_instead_of_selecting_a_readable_native_store() {
    let f = Fixture::new();
    let corrupt = f.root.path().join("state_4.sqlite");
    fs::write(&corrupt, b"intentionally corrupt synthetic sqlite fixture").unwrap();
    let before = fs::read(&f.database).unwrap();
    assert!(sync_native_project_memberships(
        f.root.path(),
        &[f.database.clone(), corrupt.clone()],
        true
    )
    .is_err());
    assert_eq!(fs::read(&f.database).unwrap(), before);
    assert_eq!(
        fs::read(&corrupt).unwrap(),
        b"intentionally corrupt synthetic sqlite fixture"
    );
    assert!(!f.root.path().join("backups").exists());
    let directory = f.root.path().join("state_3.sqlite");
    fs::create_dir(&directory).unwrap();
    assert!(
        sync_native_project_memberships(f.root.path(), &[f.database.clone(), directory], true)
            .unwrap()
            .deferred
    );
    assert_eq!(fs::read(&f.database).unwrap(), before);
}

#[test]
fn schema_probe_reads_committed_wal_without_creating_source_sidecars() {
    let root = tempfile::tempdir().unwrap();
    let live = root.path().join("writer.sqlite");
    let conn = Connection::open(&live).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT,archived INTEGER); PRAGMA wal_checkpoint(TRUNCATE); CREATE TABLE projects(id TEXT,metadata TEXT); CREATE TABLE project_roots(project_id TEXT,path TEXT); ALTER TABLE threads ADD COLUMN project_id TEXT;").unwrap();
    // The copied main file still has only the legacy table. The complete native
    // project schema exists in the committed WAL, with deliberately no SHM.
    let snapshot_dir = root.path().join("probe-source");
    fs::create_dir(&snapshot_dir).unwrap();
    let snapshot = snapshot_dir.join("state_5.sqlite");
    fs::copy(&live, &snapshot).unwrap();
    fs::copy(
        database_sidecar(&live, "-wal"),
        database_sidecar(&snapshot, "-wal"),
    )
    .unwrap();
    let before_main = fs::read(&snapshot).unwrap();
    let before_wal = fs::read(database_sidecar(&snapshot, "-wal")).unwrap();
    assert_eq!(
        probe_schema_read_only(&snapshot).unwrap(),
        ProjectDatabaseKind::Native
    );
    assert_eq!(fs::read(&snapshot).unwrap(), before_main);
    assert_eq!(
        fs::read(database_sidecar(&snapshot, "-wal")).unwrap(),
        before_wal
    );
    assert!(!database_sidecar(&snapshot, "-shm").exists());
    assert_eq!(fs::read_dir(&snapshot_dir).unwrap().count(), 2);
    drop(conn);

    // A cleanly closed WAL-mode database also must not gain empty WAL/SHM.
    let closed = snapshot_dir.join("state_4.sqlite");
    let conn = Connection::open(&closed).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT,archived INTEGER)")
        .unwrap();
    drop(conn);
    assert!(!database_sidecar(&closed, "-wal").exists());
    let before = fs::read(&closed).unwrap();
    assert_eq!(
        probe_schema_read_only(&closed).unwrap(),
        ProjectDatabaseKind::LegacyThreads
    );
    assert_eq!(fs::read(&closed).unwrap(), before);
    assert!(!database_sidecar(&closed, "-wal").exists());
    assert!(!database_sidecar(&closed, "-shm").exists());
}

#[test]
fn unread_native_migration_scans_all_explicit_assignments_without_requiring_a_pending_queue() {
    for read_flag in [None, Some(json!(false))] {
        for queue in [
            None,
            Some(json!(["unrelated-pending-thread"])),
            Some(json!([])),
        ] {
            let mut f = Fixture::new();
            f.migration()
                .as_object_mut()
                .unwrap()
                .remove("threadAssignmentsReadMigrated");
            if let Some(flag) = &read_flag {
                f.migration()["threadAssignmentsReadMigrated"] = flag.clone();
            }
            f.migration()
                .as_object_mut()
                .unwrap()
                .remove("pendingThreadAssignmentIds");
            if let Some(ids) = &queue {
                f.migration()["pendingThreadAssignmentIds"] = ids.clone();
            }
            f.save();
            let source = fs::read(f.root.path().join(".codex-global-state.json")).unwrap();
            let report = f.run().unwrap();
            assert!(!report.deferred);
            assert_eq!(report.restored, 1);
            assert_eq!(report.migration_pending, 1);
            assert_eq!(f.membership().as_deref(), Some("server-project"));
            assert_eq!(
                fs::read(f.root.path().join(".codex-global-state.json")).unwrap(),
                source
            );
        }
    }
}

#[test]
fn malformed_read_migration_flags_never_expand_the_native_repair_scope() {
    for flag in [
        Value::Null,
        json!("true"),
        json!("false"),
        json!(0),
        json!(1),
        json!({}),
        json!([]),
    ] {
        let mut f = Fixture::new();
        f.migration()["threadAssignmentsReadMigrated"] = flag;
        f.save();
        let before = fs::read(&f.database).unwrap();
        let report = f.run().unwrap();
        assert!(report.deferred);
        assert_eq!(report.restored, 0);
        assert_eq!(fs::read(&f.database).unwrap(), before);
        assert!(!f.root.path().join("backups").exists());
    }
}

#[test]
fn a_completed_read_checkpoint_keeps_non_pending_native_memberships_untouched() {
    let (root, native, legacy, mut fixture) = observed_dual_store_fixture();
    let identity = format!("local:{}", root.path().to_string_lossy());
    fixture["state"][MIGRATIONS][&identity]["threadAssignmentsReadMigrated"] = json!(true);
    fs::write(
        root.path().join(".codex-global-state.json"),
        serde_json::to_vec(&fixture["state"]).unwrap(),
    )
    .unwrap();
    let report =
        sync_native_project_memberships(root.path(), &[legacy, native.clone()], true).unwrap();
    assert_eq!(report.restored, 162);
    assert_eq!(report.explicitly_projectless, 101);
    assert_eq!(report.migration_pending, 265);
    let pending = fixture["state"][MIGRATIONS][&identity]["pendingThreadAssignmentIds"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    let conn = Connection::open(&native).unwrap();
    for (id, _) in fixture["state"]["thread-project-assignments"]
        .as_object()
        .unwrap()
    {
        if pending.contains(id.as_str()) {
            continue;
        }
        let membership: Option<String> = conn
            .query_row("SELECT project_id FROM threads WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(
            membership.is_none(),
            "Native already-read non-pending membership must remain authoritative"
        );
    }
}


fn move_fixture_into_saved_api_owner(home: &Path, globals: Value) -> Value {
    use base64::Engine;
    let claims = json!({"email":"synthetic-inactive@example.invalid","sub":"synthetic-inactive-user",
        "https://api.openai.com/auth":{"chatgpt_user_id":"synthetic-inactive-user","chatgpt_account_id":"synthetic-inactive-account"}});
    let token = format!("e30.{}.test", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()));
    let auth = json!({"auth_mode":"chatgpt","tokens":{"access_token":token,"id_token":token,"refresh_token":"synthetic-refresh"}});
    crate::with_codex_dir(home, || {
        crate::write_json_pretty(&home.join("auth.json"), &auth).unwrap();
        crate::codex_relay_restore::capture("", "synthetic-api", true).unwrap();
        crate::write_json_pretty(&home.join("auth.json"), &json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-api"})).unwrap();
    });
    let pair = serde_json::to_vec(&["synthetic-inactive-user","synthetic-inactive-account"]).unwrap();
    let owner = format!("{:x}", Sha256::digest(pair));
    let state = json!({"electron-account-renderer-state-v1":{"owner":null,"inactive":{(owner):{"globals":globals}}},
        "preserved-unrelated-setting":true});
    crate::write_json_pretty(&home.join(".codex-global-state.json"), &state).unwrap();
    state
}

#[test]
fn inactive_return_owner_repairs_all_223_memberships_and_seeds_four_projects() {
    crate::tests::with_temp_user_home("inactive-observed-dual-store", |_| {
        let (root, native, legacy, fixture) = observed_dual_store_fixture();
        let home = root.path();
        let state = move_fixture_into_saved_api_owner(home, fixture["state"].clone());
        let source = home.join(".codex-global-state.json");
        let before = fs::read(&source).unwrap();
        let report = sync_native_project_memberships(home, &[native.clone(), legacy.clone()], true).unwrap();
        assert!(!report.deferred, "{}", report.warning);
        assert_eq!(report.restored, 223);
        let selected = crate::codex_api_project_bridge::verified_native_project_source(home, &state).unwrap().unwrap();
        let snapshot = crate::codex_api_local_projects::prepare_with_databases(home, &selected, &[native,legacy]).unwrap().unwrap();
        assert_eq!(snapshot["globals"]["local-projects"].as_object().unwrap().len(), 4);
        assert_eq!(snapshot["memberships"]["assignments"].as_object().unwrap().len(), 223);
        assert_eq!(before, fs::read(source).unwrap());
    });
}

#[test]
fn inactive_source_still_verifies_the_entire_native_file_before_transaction_commit() {
    crate::tests::with_temp_user_home("inactive-whole-source-race", |_| {
        let f = Fixture::new();
        let mut state = move_fixture_into_saved_api_owner(f.root.path(), f.state.clone());
        state["preserved-unrelated-setting"] = json!("changed-during-transaction");
        let concurrent = serde_json::to_vec(&state).unwrap();
        let path = f.root.path().join(".codex-global-state.json");
        let hook = || fs::write(&path, &concurrent).unwrap();
        let result = sync_inner(f.root.path(), &[f.database.clone()], true, Some(&hook));
        assert!(result.unwrap_err().contains("改变"));
        assert!(f.membership().is_none());
        assert_eq!(concurrent, fs::read(path).unwrap());
    });
}
