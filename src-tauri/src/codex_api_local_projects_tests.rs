use super::*;
use rusqlite::{params, Connection};
use std::sync::{Arc, Barrier};

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    workspace: PathBuf,
    source: Value,
    databases: Vec<PathBuf>,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("codex-home");
        let workspace = temp.path().join("workspace");
        fs::create_dir_all(home.join("sqlite")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        let native = home.join("state_5.sqlite");
        let legacy = home.join("sqlite/state_5.sqlite");
        let conn = Connection::open(&native).unwrap();
        conn.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
            CREATE TABLE project_roots (project_id TEXT NOT NULL, path TEXT NOT NULL);
            CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT, archived INTEGER NOT NULL);
            INSERT INTO projects VALUES ('server-a', '{}');
            INSERT INTO threads VALUES ('active-a','server-a',0), ('archived-a','server-a',1), ('independent',NULL,0);").unwrap();
        conn.execute(
            "INSERT INTO project_roots VALUES ('server-a', ?1)",
            [workspace.to_string_lossy().as_ref()],
        )
        .unwrap();
        drop(conn);
        Connection::open(&legacy)
            .unwrap()
            .execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, archived INTEGER NOT NULL);")
            .unwrap();
        let identity = format!("local:{}", home.to_string_lossy());
        let source = json!({
            LEGACY_IDS: {(identity): {"legacy-a": "server-a"}},
            CATALOG: {"legacy-a": {
                "id":"legacy-a", "name":"Local A", "rootPaths":[workspace.to_string_lossy()],
                "createdAt":1, "updatedAt":2,
                "unknownAccountSecret": "DO_NOT_EXPORT"
            }},
            ROOTS: [workspace.to_string_lossy(), "relative-unproven"],
            LABELS: {(workspace.to_string_lossy()): "Workspace A", "relative-unproven":"DO_NOT_EXPORT"},
            "thread-project-assignments": {
                "active-a":{"projectKind":"local","projectId":"legacy-a"},
                "archived-a":{"projectKind":"local","projectId":"legacy-a"},
                "missing-a":{"projectKind":"local","projectId":"legacy-a"}
            },
            "projectless-thread-ids":["independent","missing-projectless","archived-a"],
            "electron-account-renderer-state-v1": {"owner":"DO_NOT_EXPORT", "inactive":{}},
            "project-writable-roots":{"DO_NOT_EXPORT":true}
        });
        fs::write(
            home.join(GLOBAL_STATE_FILE),
            serde_json::to_vec(&source).unwrap(),
        )
        .unwrap();
        Self {
            _temp: temp,
            home,
            workspace,
            source,
            databases: vec![native, legacy],
        }
    }

    fn seed(&self) -> Value {
        prepare_with_databases(&self.home, &self.source, &self.databases)
            .unwrap()
            .unwrap()
    }

    fn write_native(&self, source: &Value) {
        fs::write(
            self.home.join(GLOBAL_STATE_FILE),
            serde_json::to_vec(source).unwrap(),
        )
        .unwrap();
    }

    fn ready_native(&self, snapshot: &Value) -> Value {
        fs::write(
            self.home.join("auth.json"),
            serde_json::to_vec(&json!({
                "auth_mode":"apikey", "OPENAI_API_KEY":"synthetic-isolated-smoke-key"
            }))
            .unwrap(),
        )
        .unwrap();
        let mut native = self.source.clone();
        for key in [CATALOG, ROOTS, LABELS] {
            native[key] = snapshot["globals"][key].clone();
        }
        native["thread-project-assignments"] = snapshot["memberships"]["assignments"].clone();
        native["projectless-thread-ids"] = snapshot["memberships"]["projectlessThreadIds"].clone();
        native["electron-account-renderer-state-v1"] = json!({"owner":null,"inactive":{}});
        native["electron-persisted-atom-state"] = json!({HYDRATED_ATOM: {
            "version":1, "scope":home_identity(&self.home).unwrap(),
            "revision":snapshot["checkpoint"]["revision"], "nonce":snapshot["checkpoint"]["nonce"]
        }});
        native
    }

    fn add_project(&self, source: &mut Value, legacy: &str, native: &str, name: &str) {
        let path = self.workspace.join(native);
        fs::create_dir_all(&path).unwrap();
        source[CATALOG][legacy] = json!({"id":legacy,"name":name,"rootPaths":[path.to_string_lossy()],"createdAt":1,"updatedAt":2});
        let identity = format!("local:{}", self.home.to_string_lossy());
        source[LEGACY_IDS][identity][legacy] = json!(native);
        let conn = Connection::open(&self.databases[0]).unwrap();
        conn.execute("INSERT INTO projects VALUES (?1,'{}')", [native])
            .unwrap();
        conn.execute(
            "INSERT INTO project_roots VALUES (?1,?2)",
            params![native, path.to_string_lossy()],
        )
        .unwrap();
    }
}

#[test]
fn seed_canonicalizes_local_ids_and_reads_only_active_verified_memberships() {
    let f = Fixture::new();
    let value = f.seed();
    assert_eq!(value["version"], 1);
    assert_eq!(value["revision"], 1);
    assert_eq!(value["globals"][CATALOG]["server-a"]["id"], "server-a");
    assert_eq!(value["globals"][CATALOG].as_object().unwrap().len(), 1);
    assert_eq!(value["globals"].as_object().unwrap().len(), 3);
    assert_eq!(
        value["memberships"]["assignments"],
        json!({"active-a":{"projectKind":"local","projectId":"server-a"}})
    );
    assert_eq!(
        value["memberships"]["projectlessThreadIds"],
        json!(["independent"])
    );
    let text = serde_json::to_string(&value).unwrap();
    assert!(!text.contains("DO_NOT_EXPORT"));
    assert!(!text.contains("legacy-a"));
    assert!(!text.contains("archived-a"));
    assert!(!text.contains("missing-a"));
    assert_eq!(read(&f.home).unwrap(), Some(value));
}

#[test]
fn ordinary_prepare_never_replaces_existing_api_edits_or_recaptures_cleared_globals() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut globals = seed["globals"].clone();
    globals[CATALOG]["server-a"]["name"] = json!("API rename");
    let renamed = commit(&f.home, 1, &globals, &seed["memberships"]).unwrap();
    assert_eq!(prepare(&f.home, &f.source).unwrap(), Some(renamed.clone()));
    assert_eq!(prepare(&f.home, &json!({})).unwrap(), Some(renamed));
}

#[test]
fn absent_or_null_source_catalog_does_not_create_an_empty_success_snapshot() {
    let f = Fixture::new();
    assert_eq!(prepare(&f.home, &json!({})).unwrap(), None);
    assert_eq!(prepare(&f.home, &json!({CATALOG:null})).unwrap(), None);
    assert!(!f.home.join(SNAPSHOT_FILE).exists());
}

#[test]
fn explicit_empty_catalog_can_seed_without_native_database() {
    let f = Fixture::new();
    let empty = prepare(&f.home, &json!({CATALOG:{}})).unwrap().unwrap();
    assert_eq!(empty["globals"], empty_globals());
    assert_eq!(empty["memberships"], empty_memberships());
}

#[test]
fn nonempty_source_requires_matching_home_mapping_and_native_database() {
    let f = Fixture::new();
    assert!(prepare(&f.home, &f.source).is_err());
    let mut wrong = f.source.clone();
    wrong[LEGACY_IDS] = json!({"local:another-home":{"legacy-a":"server-a"}});
    assert!(prepare_with_databases(&f.home, &wrong, &f.databases).is_err());
    assert!(!f.home.join(SNAPSHOT_FILE).exists());
}

#[test]
fn filters_linked_cloud_remote_and_network_definitions_without_leaking_roots() {
    let f = Fixture::new();
    let mut source = f.source.clone();
    for (id, field, value) in [
        ("linked", "chatGptBacking", json!({"id":"g-p-cloud"})),
        ("remote", "hostId", json!("ssh:host")),
        ("wsl", "wslDistro", json!("Ubuntu")),
        ("cloud", "cloudProjectId", json!("private-project")),
    ] {
        let mut project = source[CATALOG]["legacy-a"].clone();
        project["id"] = json!(id);
        project[field] = value;
        source[CATALOG][id] = project;
    }
    let mut network = source[CATALOG]["legacy-a"].clone();
    network["id"] = json!("network");
    network["rootPaths"] = json!([f.workspace.to_string_lossy(), "\\\\server\\share"]);
    source[CATALOG]["network"] = network;
    let mapping_key = format!("local:{}", f.home.to_string_lossy());
    source[LEGACY_IDS][mapping_key]["network"] = json!("server-network");
    let result = prepare_with_databases(&f.home, &source, &f.databases)
        .unwrap()
        .unwrap();
    assert_eq!(result["globals"][CATALOG].as_object().unwrap().len(), 1);
    assert_eq!(result["globals"][ROOTS].as_array().unwrap().len(), 1);
}

#[test]
fn stale_cas_and_missing_readback_leave_snapshot_bytes_unchanged() {
    let f = Fixture::new();
    let seed = f.seed();
    let before = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    let mut different = seed["globals"].clone();
    different[CATALOG]["server-a"]["name"] = json!("stale change");
    assert!(commit(&f.home, 0, &different, &seed["memberships"]).is_err());
    assert!(commit(&f.home, 1, &json!({}), &seed["memberships"]).is_err());
    assert!(commit(&f.home, 1, &seed["globals"], &json!({"assignments":{}})).is_err());
    assert_eq!(before, fs::read(f.home.join(SNAPSHOT_FILE)).unwrap());
}

#[test]
fn no_op_commit_does_not_advance_revision_or_rewrite_file() {
    let f = Fixture::new();
    let seed = f.seed();
    let before = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    assert_eq!(
        commit(&f.home, 1, &seed["globals"], &seed["memberships"]).unwrap(),
        seed
    );
    assert_eq!(before, fs::read(f.home.join(SNAPSHOT_FILE)).unwrap());
}

#[test]
fn api_new_project_uses_trusted_native_mapping_and_membership_in_same_commit() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut native = f.source.clone();
    f.add_project(&mut native, "new-api-local", "server-b", "API created");
    native["thread-project-membership-host-ids"] = json!({"new-thread":"local"});
    f.write_native(&native);
    let mut globals = seed["globals"].clone();
    globals[CATALOG]["new-api-local"] = native[CATALOG]["new-api-local"].clone();
    let mut memberships = seed["memberships"].clone();
    memberships["assignments"]["new-thread"] =
        json!({"projectKind":"local","projectId":"new-api-local"});
    let result = commit(&f.home, 1, &globals, &memberships).unwrap();
    assert_eq!(result["revision"], 2);
    assert_eq!(
        result["globals"][CATALOG]["server-b"]["name"],
        "API created"
    );
    assert_eq!(
        result["memberships"]["assignments"]["new-thread"]["projectId"],
        "server-b"
    );
    assert!(result["globals"][CATALOG].get("new-api-local").is_none());
}

#[test]
fn unknown_native_mapping_waits_and_ignores_renderer_supplied_mapping() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut globals = seed["globals"].clone();
    let mut new = globals[CATALOG]["server-a"].clone();
    new["id"] = json!("unmapped");
    globals[CATALOG]["unmapped"] = new;
    globals[LEGACY_IDS] =
        json!({format!("local:{}",f.home.to_string_lossy()):{"unmapped":"server-a"}});
    assert!(commit(&f.home, 1, &globals, &seed["memberships"]).is_err());
    assert_eq!(read(&f.home).unwrap(), Some(seed));
}

#[test]
fn empty_deletion_and_membership_unassignment_survive_restart_and_stale_official_capture() {
    let f = Fixture::new();
    let seed = f.seed();
    let deleted = commit(&f.home, 1, &empty_globals(), &empty_memberships()).unwrap();
    assert!(deleted["globals"][CATALOG].as_object().unwrap().is_empty());
    assert_eq!(
        deleted["memberships"]["projectlessThreadIds"],
        json!(["active-a", "independent"])
    );
    assert_eq!(prepare(&f.home, &f.source).unwrap(), Some(deleted.clone()));
    let refreshed = capture_with_databases(&f.home, &f.source, &f.databases)
        .unwrap()
        .unwrap();
    assert_eq!(refreshed, deleted);
    assert_eq!(read(&f.home).unwrap(), Some(deleted));
    assert_eq!(
        seed["memberships"]["assignments"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn explicit_unassignment_overrides_stale_native_database_on_later_capture() {
    let f = Fixture::new();
    let seed = f.seed();
    let unassigned = commit(
        &f.home,
        1,
        &seed["globals"],
        &json!({"assignments":{},"projectlessThreadIds":["active-a","independent"]}),
    )
    .unwrap();
    let refreshed = capture_with_databases(&f.home, &f.source, &f.databases)
        .unwrap()
        .unwrap();
    assert_eq!(refreshed, unassigned);
    assert!(refreshed["memberships"]["assignments"]
        .as_object()
        .unwrap()
        .is_empty());
}

#[test]
fn official_refresh_preserves_api_rename_and_api_only_project_and_merges_new_official_project() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut native = f.source.clone();
    f.add_project(&mut native, "api-b", "server-b", "API B");
    f.write_native(&native);
    let mut globals = seed["globals"].clone();
    globals[CATALOG]["server-a"]["name"] = json!("API A");
    globals[CATALOG]["api-b"] = native[CATALOG]["api-b"].clone();
    commit(&f.home, 1, &globals, &seed["memberships"]).unwrap();
    let mut official = f.source.clone();
    f.add_project(&mut official, "official-c", "server-c", "Official C");
    official[CATALOG]["legacy-a"]["name"] = json!("Official conflicting A");
    let result = capture_with_databases(&f.home, &official, &f.databases)
        .unwrap()
        .unwrap();
    assert_eq!(result["globals"][CATALOG].as_object().unwrap().len(), 3);
    assert_eq!(result["globals"][CATALOG]["server-a"]["name"], "API A");
    assert_eq!(result["globals"][CATALOG]["server-b"]["name"], "API B");
    assert_eq!(result["globals"][CATALOG]["server-c"]["name"], "Official C");
}

#[test]
fn official_only_rename_and_deletion_are_applied_without_resetting_api_catalog() {
    let f = Fixture::new();
    f.seed();
    let mut official = f.source.clone();
    official[CATALOG]["legacy-a"]["name"] = json!("Official rename");
    let renamed = capture_with_databases(&f.home, &official, &f.databases)
        .unwrap()
        .unwrap();
    assert_eq!(
        renamed["globals"][CATALOG]["server-a"]["name"],
        "Official rename"
    );
    official[CATALOG] = json!({});
    let deleted = capture_with_databases(&f.home, &official, &f.databases)
        .unwrap()
        .unwrap();
    assert!(deleted["globals"][CATALOG].as_object().unwrap().is_empty());
    assert!(deleted["memberships"]["assignments"]
        .as_object()
        .unwrap()
        .is_empty());
}

#[test]
fn membership_conflicts_are_rejected_and_remote_memberships_never_exported() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut memberships = seed["memberships"].clone();
    memberships["projectlessThreadIds"] = json!(["active-a"]);
    assert!(commit(&f.home, 1, &seed["globals"], &memberships).is_err());
    memberships = seed["memberships"].clone();
    memberships["assignments"]["remote-thread"] =
        json!({"projectKind":"local","projectId":"server-a","hostId":"ssh:private"});
    memberships["assignments"]["cloud-thread"] =
        json!({"projectKind":"chatgpt","projectId":"g-p-private"});
    assert_eq!(
        commit(&f.home, 1, &seed["globals"], &memberships).unwrap(),
        seed
    );
}

#[test]
fn corrupt_unknown_or_cross_home_snapshot_is_preserved_and_never_repaired_blindly() {
    for change in ["version", "home", "globals", "json"] {
        let f = Fixture::new();
        f.seed();
        let file = f.home.join(SNAPSHOT_FILE);
        let mut raw: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        match change {
            "version" => raw["version"] = json!(999),
            "home" => raw["homeIdentity"] = json!("another-home"),
            "globals" => raw["globals"]["accountTokens"] = json!("never-export"),
            _ => {}
        }
        let bytes = if change == "json" {
            b"{broken".to_vec()
        } else {
            serde_json::to_vec(&raw).unwrap()
        };
        fs::write(&file, &bytes).unwrap();
        assert!(read(&f.home).is_err());
        assert!(prepare(&f.home, &f.source).is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
}

#[test]
fn ambiguous_or_partial_database_schema_fails_before_cache_creation() {
    for partial in [false, true] {
        let f = Fixture::new();
        if partial {
            Connection::open(&f.databases[1])
                .unwrap()
                .execute_batch("ALTER TABLE threads ADD COLUMN project_id TEXT;")
                .unwrap();
        } else {
            fs::copy(&f.databases[0], &f.databases[1]).unwrap();
        }
        assert!(prepare_with_databases(&f.home, &f.source, &f.databases).is_err());
        assert!(!f.home.join(SNAPSHOT_FILE).exists());
    }
}

#[test]
fn missing_project_or_mismatching_native_roots_fail_closed() {
    for missing in [false, true] {
        let f = Fixture::new();
        let conn = Connection::open(&f.databases[0]).unwrap();
        conn.execute(
            if missing {
                "DELETE FROM projects"
            } else {
                "UPDATE project_roots SET path='relative-invalid'"
            },
            [],
        )
        .unwrap();
        drop(conn);
        assert!(prepare_with_databases(&f.home, &f.source, &f.databases).is_err());
        assert!(!f.home.join(SNAPSHOT_FILE).exists());
    }
}

#[test]
fn readonly_projection_preserves_original_database_and_sidecars_in_wal_mode() {
    let f = Fixture::new();
    let conn = Connection::open(&f.databases[0]).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        UPDATE threads SET archived=0 WHERE id='archived-a';",
    )
    .unwrap();
    let paths: Vec<_> = ["", "-wal", "-shm", "-journal"]
        .iter()
        .map(|suffix| PathBuf::from(format!("{}{suffix}", f.databases[0].to_string_lossy())))
        .collect();
    let before: Vec<_> = paths.iter().map(|path| fs::read(path).ok()).collect();
    let result = f.seed();
    // archived-a is now active, but its explicit projectless source wins.
    assert!(result["memberships"]["projectlessThreadIds"]
        .as_array()
        .unwrap()
        .contains(&json!("archived-a")));
    let after: Vec<_> = paths.iter().map(|path| fs::read(path).ok()).collect();
    assert_eq!(before, after);
    drop(conn);
}

#[test]
fn simultaneous_commits_allow_exactly_one_writer_at_same_revision() {
    let f = Fixture::new();
    let seed = f.seed();
    let barrier = Arc::new(Barrier::new(3));
    let mut writers = Vec::new();
    for name in ["API writer A", "API writer B"] {
        let home = f.home.clone();
        let mut globals = seed["globals"].clone();
        globals[CATALOG]["server-a"]["name"] = json!(name);
        let memberships = seed["memberships"].clone();
        let barrier = barrier.clone();
        writers.push(std::thread::spawn(move || {
            barrier.wait();
            commit(&home, 1, &globals, &memberships)
        }));
    }
    barrier.wait();
    let results: Vec<_> = writers
        .into_iter()
        .map(|writer| writer.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(read(&f.home).unwrap().unwrap()["revision"], 2);
}

#[test]
fn revision_zero_only_creates_cache_and_revision_overflow_preserves_bytes() {
    let f = Fixture::new();
    let mut native = f.source.clone();
    native["thread-project-membership-host-ids"] =
        json!({"new-thread":"local","stale-thread":"local"});
    f.write_native(&native);
    let created = commit(&f.home, 0, &empty_globals(), &empty_memberships()).unwrap();
    assert_eq!(created["revision"], 1);
    assert_eq!(
        commit(&f.home, 0, &empty_globals(), &empty_memberships()).unwrap(),
        created
    );
    assert!(commit(
        &f.home,
        0,
        &empty_globals(),
        &json!({"assignments":{},"projectlessThreadIds":["stale-thread"]})
    )
    .is_err());
    let file = f.home.join(SNAPSHOT_FILE);
    let mut stored: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    stored["revision"] = json!(MAX_SAFE_REVISION);
    fs::write(&file, serde_json::to_vec(&stored).unwrap()).unwrap();
    let before = fs::read(&file).unwrap();
    assert!(commit(
        &f.home,
        MAX_SAFE_REVISION,
        &empty_globals(),
        &json!({"assignments":{},"projectlessThreadIds":["new-thread"]})
    )
    .is_err());
    assert_eq!(before, fs::read(&file).unwrap());
}

/// This ignored helper is only for an explicitly isolated smoke home. It uses
/// the production module rather than duplicating canonicalization/CAS in JS.
#[test]
#[ignore]
fn isolated_api_project_command() {
    let request_path = PathBuf::from(
        std::env::var_os("GAOGE_API_PROJECT_TEST_REQUEST").expect("isolated request path"),
    );
    let request: Value = serde_json::from_slice(&fs::read(&request_path).unwrap()).unwrap();
    let home = PathBuf::from(request["home"].as_str().expect("home"));
    let sentinel = home.join(".gaoge-isolated-project-smoke");
    assert!(sentinel.is_file(), "isolated smoke sentinel is required");
    assert!(
        home.starts_with(std::env::temp_dir()),
        "smoke home must stay in temporary directory"
    );
    let smoke_root = home
        .ancestors()
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("gaoge-native-api-smoke-"))
        })
        .expect("dedicated gaoge-native-api-smoke root");
    let canonical_root = fs::canonicalize(smoke_root).unwrap();
    let canonical_temp = fs::canonicalize(std::env::temp_dir()).unwrap();
    assert!(
        canonical_root.starts_with(canonical_temp),
        "canonical smoke root must stay in temp"
    );
    assert!(fs::canonicalize(&home)
        .unwrap()
        .starts_with(&canonical_root));
    assert!(fs::canonicalize(&request_path)
        .unwrap()
        .starts_with(&canonical_root));
    let output = PathBuf::from(request["output"].as_str().unwrap());
    assert!(output.is_absolute());
    assert!(fs::canonicalize(output.parent().unwrap())
        .unwrap()
        .starts_with(&canonical_root));
    if output.exists() {
        assert!(fs::canonicalize(&output)
            .unwrap()
            .starts_with(&canonical_root));
    }
    for path in request
        .get("statePaths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = PathBuf::from(path.as_str().unwrap());
        assert!(path.is_absolute());
        assert!(fs::canonicalize(&path)
            .unwrap()
            .starts_with(&canonical_root));
    }
    let auth: Value = serde_json::from_slice(&fs::read(home.join("auth.json")).unwrap()).unwrap();
    assert_eq!(
        auth,
        json!({"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-isolated-smoke-key"})
    );
    let response = match request["command"].as_str().unwrap() {
        "prepare" | "capture" => {
            let paths: Vec<PathBuf> = request["statePaths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| PathBuf::from(path.as_str().unwrap()))
                .collect();
            if request["command"] == "prepare" {
                prepare_with_databases(&home, &request["source"], &paths)
            } else {
                capture_with_databases(&home, &request["source"], &paths)
            }
        }
        "read" => read(&home),
        "finalize" => finalize_native_state(
            &home,
            request
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or(&home_identity(&home).unwrap()),
        ),
        "commit" => commit(
            &home,
            request["revision"].as_u64().unwrap(),
            &request["globals"],
            &request["memberships"],
        )
        .map(Some),
        _ => panic!("unsupported isolated command"),
    };

    let safe = match response {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    fs::write(output, serde_json::to_vec_pretty(&safe).unwrap()).unwrap();
}

#[test]
fn same_canonical_values_acknowledge_new_revision_without_overwriting_changes() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut globals = seed["globals"].clone();
    globals[CATALOG]["server-a"]["name"] = json!("API rename");
    let latest = commit(&f.home, 1, &globals, &seed["memberships"]).unwrap();
    let before = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    assert_eq!(
        commit(&f.home, 1, &globals, &seed["memberships"]).unwrap(),
        latest
    );
    assert!(commit(&f.home, 1, &seed["globals"], &seed["memberships"]).is_err());
    assert_eq!(before, fs::read(f.home.join(SNAPSHOT_FILE)).unwrap());
    let mut legacy_globals = latest["globals"].clone();
    let mut project = legacy_globals[CATALOG]
        .as_object_mut()
        .unwrap()
        .remove("server-a")
        .unwrap();
    project["id"] = json!("legacy-a");
    legacy_globals[CATALOG]["legacy-a"] = project;
    let mut legacy_memberships = seed["memberships"].clone();
    legacy_memberships["assignments"]["active-a"]["projectId"] = json!("legacy-a");
    assert_eq!(
        commit(&f.home, 1, &legacy_globals, &legacy_memberships).unwrap(),
        latest
    );
}

#[test]
fn initial_capture_defers_until_explicit_active_memberships_are_repaired() {
    let f = Fixture::new();
    Connection::open(&f.databases[0])
        .unwrap()
        .execute("UPDATE threads SET project_id=NULL WHERE id='active-a'", [])
        .unwrap();
    assert!(prepare_with_databases(&f.home, &f.source, &f.databases).is_err());
    assert!(!f.home.join(SNAPSHOT_FILE).exists());
    Connection::open(&f.databases[0])
        .unwrap()
        .execute(
            "UPDATE threads SET project_id='server-a' WHERE id='active-a'",
            [],
        )
        .unwrap();
    let result = f.seed();
    assert_eq!(
        result["memberships"]["assignments"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn completed_native_migration_and_explicit_projectless_do_not_demand_legacy_reassignment() {
    for complete in [false, true] {
        let f = Fixture::new();
        Connection::open(&f.databases[0])
            .unwrap()
            .execute("UPDATE threads SET project_id=NULL WHERE id='active-a'", [])
            .unwrap();
        let mut source = f.source.clone();
        if complete {
            source["app-server-projects-migration-by-host"] = json!({format!("local:{}",f.home.to_string_lossy()):{"threadAssignmentsMigrated":true}});
        } else {
            source["projectless-thread-ids"]
                .as_array_mut()
                .unwrap()
                .push(json!("active-a"));
        }
        let result = prepare_with_databases(&f.home, &source, &f.databases)
            .unwrap()
            .unwrap();
        assert!(result["memberships"]["assignments"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}

#[test]
fn commits_filter_remote_and_unknown_projectless_ids_and_require_new_assignment_proof() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut native = f.source.clone();
    native["thread-project-membership-host-ids"] = json!({"remote-thread":"ssh:remote"});
    f.write_native(&native);
    let mut memberships = seed["memberships"].clone();
    memberships["projectlessThreadIds"] = json!(["independent", "unknown-thread", "remote-thread"]);
    assert_eq!(
        commit(&f.home, 1, &seed["globals"], &memberships).unwrap(),
        seed
    );
    memberships["assignments"]["unknown-thread"] =
        json!({"projectKind":"local","projectId":"server-a"});
    assert!(commit(&f.home, 1, &seed["globals"], &memberships).is_err());
    native["thread-project-membership-host-ids"]["unknown-thread"] = json!("local");
    f.write_native(&native);
    memberships["projectlessThreadIds"] = json!(["independent"]);
    let saved = commit(&f.home, 1, &seed["globals"], &memberships).unwrap();
    assert!(saved["memberships"]["assignments"]
        .get("unknown-thread")
        .is_some());
}

#[test]
fn explicit_remote_host_revokes_previous_local_approval_without_local_tombstone() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut native = f.source.clone();
    native["thread-project-membership-host-ids"] =
        json!({"active-a":"ssh:remote","independent":"ssh:remote"});
    f.write_native(&native);
    let saved = commit(&f.home, 1, &seed["globals"], &seed["memberships"]).unwrap();
    assert_eq!(saved["memberships"], empty_memberships());
    assert_eq!(read(&f.home).unwrap(), Some(saved));
}

#[test]
fn commit_rejects_non_catalog_global_keys_even_for_same_value_cas_retries() {
    let f = Fixture::new();
    let seed = f.seed();
    for key in [
        "electron-account-renderer-state-v1",
        "thread-project-assignments",
        "project-writable-roots",
        "unknown",
    ] {
        let mut globals = seed["globals"].clone();
        globals[key] = json!({"private":"not-allowed"});
        assert!(commit(&f.home, 1, &globals, &seed["memberships"]).is_err());
        assert!(commit(&f.home, 0, &globals, &seed["memberships"]).is_err());
    }
    assert_eq!(read(&f.home).unwrap(), Some(seed));
}

#[test]
fn upgrade_with_saved_account_projects_never_claims_empty_api_initialization() {
    let f = Fixture::new();
    let source = json!({"electron-account-renderer-state-v1":{"owner":null,"inactive":{
        "opaque-owner":{"atoms":{},"globals":f.source}
    }}});
    f.write_native(&source);
    assert!(prepare_with_databases(&f.home, &source, &f.databases).is_err());
    assert!(capture_with_databases(&f.home, &source, &f.databases).is_err());
    assert!(read(&f.home).is_err());
    assert!(!f.home.join(SNAPSHOT_FILE).exists());
    assert!(super::super::codex_project_compat::has_native_project_state(&source));
}

#[test]
fn multiple_or_unknown_inactive_account_envelopes_are_never_guessed() {
    let f = Fixture::new();
    for source in [
        json!({"electron-account-renderer-state-v1":{"owner":null,"inactive":{"a":{"globals":f.source},"b":{"globals":f.source}}}}),
        json!({"electron-account-renderer-state-v1":{"owner":null,"inactive":{"a":{"futureShape":f.source}}}}),
        json!({"electron-account-renderer-state-v1":true}),
    ] {
        assert!(prepare_with_databases(&f.home, &source, &f.databases).is_err());
        assert!(super::super::codex_project_compat::has_native_project_state(&source));
        assert!(!f.home.join(SNAPSHOT_FILE).exists());
    }
}

#[test]
fn existing_api_snapshot_remains_readable_after_native_moves_account_globals() {
    let f = Fixture::new();
    let saved = f.seed();
    let source = json!({"electron-account-renderer-state-v1":{"owner":null,"inactive":{
        "opaque-owner":{"atoms":{},"globals":f.source}
    }}});
    f.write_native(&source);
    assert_eq!(read(&f.home).unwrap(), Some(saved.clone()));
    assert_eq!(
        prepare_with_databases(&f.home, &source, &f.databases).unwrap(),
        Some(saved)
    );
}

#[test]
fn checkpoint_nonce_tracks_revision_and_noop_receipts_remain_stable() {
    let f = Fixture::new();
    let seed = f.seed();
    assert_eq!(seed["checkpoint"]["version"], 1);
    assert_eq!(seed["checkpoint"]["revision"], seed["revision"]);
    assert_eq!(seed["checkpoint"]["nonce"].as_str().unwrap().len(), 64);
    assert_eq!(
        commit(&f.home, 1, &seed["globals"], &seed["memberships"]).unwrap(),
        seed
    );
    let mut globals = seed["globals"].clone();
    globals[CATALOG]["server-a"]["name"] = json!("API renamed");
    let changed = commit(&f.home, 1, &globals, &seed["memberships"]).unwrap();
    assert_eq!(changed["checkpoint"]["revision"], 2);
    assert_ne!(changed["checkpoint"]["nonce"], seed["checkpoint"]["nonce"]);
    assert_eq!(
        commit(&f.home, 1, &globals, &seed["memberships"]).unwrap(),
        changed
    );
}

#[test]
fn omitted_membership_retry_is_idempotent_without_accepting_newer_assignment_loss() {
    let f = Fixture::new();
    let seed = f.seed();
    let removed = commit(&f.home, 1, &seed["globals"], &empty_memberships()).unwrap();
    assert_eq!(
        removed["memberships"]["projectlessThreadIds"],
        json!(["active-a", "independent"])
    );
    let bytes = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    assert_eq!(
        commit(&f.home, 1, &seed["globals"], &empty_memberships()).unwrap(),
        removed
    );
    assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
    let assigned = commit(&f.home, 2, &seed["globals"], &seed["memberships"]).unwrap();
    assert_eq!(assigned["revision"], 3);
    let bytes = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    assert!(commit(&f.home, 1, &seed["globals"], &empty_memberships()).is_err());
    assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
}

#[test]
fn api_rename_wins_official_deletion_conflict_with_existing_memberships() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut globals = seed["globals"].clone();
    globals[CATALOG]["server-a"]["name"] = json!("API preserved name");
    let renamed = commit(&f.home, 1, &globals, &seed["memberships"]).unwrap();
    let mut official = f.source.clone();
    official[CATALOG] = json!({});
    official["thread-project-assignments"] = json!({});
    official["projectless-thread-ids"] = json!(["active-a", "independent"]);
    let merged = capture_with_databases(&f.home, &official, &f.databases)
        .unwrap()
        .unwrap();
    assert_eq!(merged["globals"], renamed["globals"]);
    assert_eq!(merged["memberships"], renamed["memberships"]);
    assert_eq!(
        capture_with_databases(&f.home, &official, &f.databases).unwrap(),
        Some(merged.clone())
    );
    assert_eq!(prepare(&f.home, &official).unwrap(), Some(merged));
}

#[test]
fn finalize_saves_fast_native_rename_new_project_deletion_and_omitted_memberships() {
    let mut f = Fixture::new();
    let mut source = f.source.clone();
    f.add_project(&mut source, "legacy-b", "server-b", "Local B");
    Connection::open(&f.databases[0])
        .unwrap()
        .execute("INSERT INTO threads VALUES ('active-b','server-b',0)", [])
        .unwrap();
    source["thread-project-assignments"]["active-b"] =
        json!({"projectKind":"local","projectId":"legacy-b"});
    f.source = source;
    f.write_native(&f.source);
    let seed = f.seed();
    let mut native = f.ready_native(&seed);
    native[CATALOG]["server-a"]["name"] = json!("Fast native rename");
    native[CATALOG].as_object_mut().unwrap().remove("server-b");
    f.add_project(&mut native, "fresh-c", "server-c", "Fast new project");
    native["thread-project-assignments"] =
        json!({"new-thread":{"projectKind":"local","projectId":"fresh-c"}});
    native["thread-project-membership-host-ids"] = json!({"new-thread":"local"});
    f.write_native(&native);
    let original_native = fs::read(f.home.join(GLOBAL_STATE_FILE)).unwrap();
    let original_auth = fs::read(f.home.join("auth.json")).unwrap();
    let original_database = fs::read(&f.databases[0]).unwrap();
    assert_eq!(read(&f.home).unwrap(), Some(seed.clone()));
    let result = finalize_native_state(&f.home, &home_identity(&f.home).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(result["revision"], 2);
    assert_eq!(
        result["globals"][CATALOG]["server-a"]["name"],
        "Fast native rename"
    );
    assert!(result["globals"][CATALOG].get("server-b").is_none());
    assert_eq!(
        result["globals"][CATALOG]["server-c"]["name"],
        "Fast new project"
    );
    assert_eq!(
        result["memberships"]["assignments"]["new-thread"]["projectId"],
        "server-c"
    );
    assert_eq!(
        result["memberships"]["projectlessThreadIds"],
        json!(["active-a", "active-b", "independent"])
    );
    assert_eq!(prepare(&f.home, &f.source).unwrap(), Some(result.clone()));
    assert_eq!(
        fs::read(f.home.join(GLOBAL_STATE_FILE)).unwrap(),
        original_native
    );
    assert_eq!(fs::read(f.home.join("auth.json")).unwrap(), original_auth);
    assert_eq!(fs::read(&f.databases[0]).unwrap(), original_database);
    let bytes = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    assert_eq!(
        finalize_native_state(&f.home, &home_identity(&f.home).unwrap()).unwrap(),
        None
    );
    assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
}

#[test]
fn finalize_accepts_native_omitted_empty_memberships_after_exact_checkpoint() {
    let f = Fixture::new();
    let seed = prepare(&f.home, &empty_globals()).unwrap().unwrap();
    let mut native = f.ready_native(&seed);
    native
        .as_object_mut()
        .unwrap()
        .remove("thread-project-assignments");
    native
        .as_object_mut()
        .unwrap()
        .remove("projectless-thread-ids");
    f.add_project(
        &mut native,
        "new-empty-b",
        "server-b",
        "First empty project",
    );
    f.write_native(&native);
    let result = finalize_native_state(&f.home, &home_identity(&f.home).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        result["globals"][CATALOG]["server-b"]["name"],
        "First empty project"
    );
    assert_eq!(result["memberships"], empty_memberships());
    let mut native = f.ready_native(&result);
    native[CATALOG] = json!({});
    native
        .as_object_mut()
        .unwrap()
        .remove("thread-project-assignments");
    native
        .as_object_mut()
        .unwrap()
        .remove("projectless-thread-ids");
    f.write_native(&native);
    let deleted = finalize_native_state(&f.home, &home_identity(&f.home).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(deleted["globals"], empty_globals());
    assert_eq!(deleted["memberships"], empty_memberships());
}

#[test]
fn finalize_exact_noop_preserves_cache_bytes_and_nonce() {
    let f = Fixture::new();
    let seed = f.seed();
    let native = f.ready_native(&seed);
    f.write_native(&native);
    let bytes = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    for _ in 0..2 {
        assert_eq!(
            finalize_native_state(&f.home, &home_identity(&f.home).unwrap()).unwrap(),
            Some(seed.clone())
        );
        assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
    }
}

#[test]
fn finalize_defers_partial_hydration_wrong_owner_scope_revision_and_nonce() {
    let f = Fixture::new();
    let seed = f.seed();
    let scope = home_identity(&f.home).unwrap();
    let original = f.ready_native(&seed);
    let bytes = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    let mut variants = Vec::new();
    let mut missing_marker = original.clone();
    missing_marker["electron-persisted-atom-state"] = json!({});
    variants.push(missing_marker);
    let mut absent_owner = original.clone();
    absent_owner["electron-account-renderer-state-v1"] = json!({"inactive":{}});
    variants.push(absent_owner);
    let mut wrong_owner = original.clone();
    wrong_owner["electron-account-renderer-state-v1"]["owner"] = json!("official-owner");
    variants.push(wrong_owner);
    for (field, value) in [
        ("scope", json!("other-home")),
        ("revision", json!(0)),
        ("revision", json!(2)),
        ("nonce", json!("wrong-nonce")),
        ("version", json!(2)),
    ] {
        let mut native = original.clone();
        native["electron-persisted-atom-state"][HYDRATED_ATOM][field] = value;
        variants.push(native);
    }
    let mut missing_catalog = original.clone();
    missing_catalog.as_object_mut().unwrap().remove(CATALOG);
    variants.push(missing_catalog);
    for mut native in variants {
        if let Some(catalog) = native.get_mut(CATALOG) {
            *catalog = json!({});
        }
        native["thread-project-assignments"] = json!({});
        native["projectless-thread-ids"] = json!([]);
        f.write_native(&native);
        assert_eq!(finalize_native_state(&f.home, &scope).unwrap(), None);
        assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
    }
    f.write_native(&original);
    assert_eq!(
        finalize_native_state(&f.home, "different-scope").unwrap(),
        None
    );
    assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
}

#[test]
fn finalize_rejects_non_api_auth_and_malformed_explicit_collections() {
    let f = Fixture::new();
    let seed = f.seed();
    let scope = home_identity(&f.home).unwrap();
    let original = f.ready_native(&seed);
    f.write_native(&original);
    let bytes = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    for auth in [
        json!({}),
        json!({"auth_mode":"chatgpt"}),
        json!({"auth_mode":"apikey","OPENAI_API_KEY":""}),
    ] {
        fs::write(f.home.join("auth.json"), serde_json::to_vec(&auth).unwrap()).unwrap();
        assert_eq!(finalize_native_state(&f.home, &scope).unwrap(), None);
        assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
    }
    f.ready_native(&seed);
    for (key, invalid) in [
        (CATALOG, json!(null)),
        ("thread-project-assignments", json!(null)),
        ("thread-project-assignments", json!([])),
        ("projectless-thread-ids", json!(null)),
        ("projectless-thread-ids", json!({})),
    ] {
        let mut native = original.clone();
        native[key] = invalid;
        f.write_native(&native);
        assert!(finalize_native_state(&f.home, &scope).is_err());
        assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
    }
}

#[test]
fn finalize_old_receipt_cannot_replace_a_newer_cas_snapshot() {
    let f = Fixture::new();
    let seed = f.seed();
    let mut native = f.ready_native(&seed);
    native[CATALOG] = json!({});
    native["thread-project-assignments"] = json!({});
    f.write_native(&native);
    let mut globals = seed["globals"].clone();
    globals[CATALOG]["server-a"]["name"] = json!("Newer CAS name");
    let newer = commit(&f.home, 1, &globals, &seed["memberships"]).unwrap();
    let bytes = fs::read(f.home.join(SNAPSHOT_FILE)).unwrap();
    assert_eq!(
        finalize_native_state(&f.home, &home_identity(&f.home).unwrap()).unwrap(),
        None
    );
    assert_eq!(fs::read(f.home.join(SNAPSHOT_FILE)).unwrap(), bytes);
    assert_eq!(read(&f.home).unwrap(), Some(newer));
}
