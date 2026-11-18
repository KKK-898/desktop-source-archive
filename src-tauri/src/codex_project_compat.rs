//! Repair unambiguous legacy-to-native local project memberships in the native migration scope.
//!
//! Codex 26.1103 stores projects and `threads.project_id` in its state database.
//! Its old global-state assignment map is a migration source, not the live store.
//! We never infer membership from cwd, change a native membership, create a
//! project, change auth/feature gates, or mark Codex's migration as completed.
//! The caller must have confirmed that the native client has exited.
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MIGRATIONS: &str = "app-server-projects-migration-by-host";
const LEGACY_IDS: &str = "app-server-project-id-by-legacy-project-id-by-host";
const CONTENT_OWNER: &str = "electron-renderer-content-owner";

/// A current host may already have committed its global state to SQLite. Old
/// JSON is not authoritative then. Do not open the DB or enumerate its owners.
pub(crate) fn has_native_global_state_db(home: &Path) -> bool {
    [".codex-global-state.sqlite", ".codex-global-state.sqlite-wal",
        ".codex-global-state.sqlite-shm", ".codex-global-state.sqlite-journal"]
        .iter().any(|name| match fs::symlink_metadata(home.join(name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            _ => true,
        })
}

pub(super) fn has_content_owner_state(state: &Value) -> bool {
    state.get(CONTENT_OWNER).is_some()
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectCompatReport {
    pub native_projects_owned: bool,
    pub migration_pending: usize,
    pub restored: usize,
    pub already_assigned: usize,
    pub explicitly_projectless: usize,
    pub archived: usize,
    pub skipped_non_local: usize,
    pub missing_assignments: usize,
    pub missing_threads: usize,
    pub missing_projects: usize,
    pub unmapped: usize,
    pub conflicts: usize,
    pub deferred: bool,
    pub warning: String,
    pub backup_path: Option<String>,
}

/// Even an unknown/newer migration marker means native project ownership.
/// Do not run the retired cwd-based legacy assignment rewrite in this case.
pub(super) fn has_native_project_state(state: &Value) -> bool {
    state.get(MIGRATIONS).is_some() || state.get(LEGACY_IDS).is_some()
        // This native envelope can own project globals even when root keys
        // were removed by selectRendererOwner(null). Unknown shapes also
        // prohibit the retired cwd-based membership rewrite.
        || state.get("electron-account-renderer-state-v1").is_some()
        || has_content_owner_state(state)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MembershipChange {
    thread_id: String,
    legacy_project_id: String,
    prior_project_id: Option<String>,
    project_id: String,
}

fn deferred(mut report: ProjectCompatReport, message: &str) -> ProjectCompatReport {
    report.deferred = true;
    report.warning = message.to_string();
    report
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|value| !value.trim().is_empty())
}

fn material(value: &Value) -> bool {
    !value.is_null() && value.as_str() != Some("") && value.as_bool() != Some(false)
}

fn local_only(value: &Value) -> bool {
    // Linked ChatGPT projects still have projectKind=local. Their remote/account
    // lifecycle is native-owned and must never be repaired as a pure local one.
    for key in [
        "chatGptBacking",
        "chatGptBackingCreation",
        "retiredChatGptBacking",
        "chatGptBackingRecoveryPending",
        "cloudProjectId",
        "chatGptProjectId",
    ] {
        if value.get(key).is_some_and(material) {
            return false;
        }
    }
    // Preserve unknown/remote/cloud metadata rather than interpreting it as a
    // local assignment. Native accepts more legacy origins; this repair does not.
    for key in ["projectOrigin", "hostId", "remoteHostId", "sourceHostId"] {
        if let Some(field) = value.get(key).filter(|field| !field.is_null()) {
            if !matches!(field.as_str(), Some("" | "local")) {
                return false;
            }
        }
    }
    for key in ["remoteConnectionId", "connectionId", "sshHost", "remote"] {
        if value.get(key).is_some_and(|field| {
            !field.is_null() && field.as_str() != Some("") && field.as_bool() != Some(false)
        }) {
            return false;
        }
    }
    true
}

fn root_identity(raw: &str) -> Option<String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let normalized = normalized.to_string_lossy().replace('\\', "/");
    let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);
    let normalized = normalized.trim_end_matches('/');
    Some(if cfg!(target_os = "windows") {
        normalized.to_lowercase()
    } else {
        normalized.to_string()
    })
}

fn required_columns(conn: &Connection, table: &str, expected: &[&str]) -> Result<bool, String> {
    // Table names are fixed literals controlled by this module.
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("读取项目兼容表结构失败：{error}"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("读取项目兼容表结构失败：{error}"))?
        .collect::<Result<BTreeSet<_>, _>>()
        .map_err(|error| format!("读取项目兼容字段失败：{error}"))?;
    Ok(expected.iter().all(|column| columns.contains(*column)))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProjectDatabaseKind {
    Native,
    LegacyThreads,
    Unknown,
}

fn schema_kind(conn: &Connection) -> Result<ProjectDatabaseKind, String> {
    // Views or partial/newer project layouts are unknown, not legacy stores.
    let mut objects = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT lower(name), type FROM sqlite_master WHERE lower(name) IN ('threads', 'projects', 'project_roots')")
        .map_err(|error| format!("读取项目数据库对象失败：{error}"))?;
    for entry in stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("读取项目数据库对象失败：{error}"))?
    {
        let (name, kind) = entry.map_err(|error| format!("读取项目数据库对象失败：{error}"))?;
        objects.insert(name, kind);
    }
    if objects.get("threads").map(String::as_str) != Some("table")
        || !required_columns(conn, "threads", &["id", "archived"])?
    {
        return Ok(ProjectDatabaseKind::Unknown);
    }
    let has_membership = required_columns(conn, "threads", &["project_id"])?;
    if !has_membership
        && !objects.contains_key("projects")
        && !objects.contains_key("project_roots")
    {
        return Ok(ProjectDatabaseKind::LegacyThreads);
    }
    if has_membership
        && objects.get("projects").map(String::as_str) == Some("table")
        && objects.get("project_roots").map(String::as_str) == Some("table")
        && required_columns(conn, "projects", &["id", "metadata"])?
        && required_columns(conn, "project_roots", &["project_id", "path"])?
    {
        return Ok(ProjectDatabaseKind::Native);
    }
    Ok(ProjectDatabaseKind::Unknown)
}

fn file_digest(path: &Path, expected_length: u64) -> Result<[u8; 32], String> {
    let file = fs::File::open(path).map_err(|error| format!("复核项目数据库快照失败：{error}"))?;
    // Bound a racing writer: read at most the snapshotted length plus one.
    let mut file = file.take(expected_length.saturating_add(1));
    let mut total = 0u64;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("复核项目数据库快照失败：{error}"))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        digest.update(&buffer[..count]);
    }
    if total != expected_length {
        return Err("项目数据库在结构检查期间大小已改变，未选择写入目标。".to_string());
    }
    Ok(digest.finalize().into())
}

fn database_sidecar(database: &Path, suffix: &str) -> PathBuf {
    let mut path = database.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn with_read_only_database_snapshot<T>(
    database: &Path,
    reader: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    // SQLITE_OPEN_READ_ONLY can still create WAL/SHM files beside a WAL-mode
    // database. Inspect a private temporary snapshot instead, preserving WAL
    // contents rather than using immutable=1 (which would ignore them).
    let temporary = tempfile::Builder::new()
        .prefix("gaoge-project-schema-")
        .tempdir()
        .map_err(|error| format!("创建只读项目结构检查快照失败：{error}"))?;
    let copy = temporary.path().join("state.sqlite");
    let mut snapshots = Vec::new();
    for suffix in ["", "-wal", "-journal"] {
        let source = database_sidecar(database, suffix);
        let target = database_sidecar(&copy, suffix);
        let before = match fs::metadata(&source) {
            Ok(metadata) => Some((metadata.len(), metadata.modified().ok())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !suffix.is_empty() => {
                None
            }
            Err(error) => return Err(format!("读取项目数据库快照信息失败：{error}")),
        };
        let expected = if let Some((length, modified)) = before {
            fs::copy(&source, &target)
                .map_err(|error| format!("复制只读项目结构检查快照失败：{error}"))?;
            let after = fs::metadata(&source)
                .map_err(|error| format!("复核项目数据库快照信息失败：{error}"))?;
            if after.len() != length || after.modified().ok() != modified {
                return Err("项目数据库在结构检查期间已改变，未选择写入目标。".to_string());
            }
            Some((length, modified, file_digest(&target, length)?))
        } else {
            None
        };
        snapshots.push((source, expected));
    }
    let conn = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("打开只读项目结构检查快照失败：{error}"))?;
    let result = reader(&conn)?;
    drop(conn);
    // Bounded-memory hashes detect changes while main/WAL files were copied.
    // Absent sidecars must remain absent, too. Never checkpoint the real store.
    for (source, expected) in snapshots {
        let current = match fs::metadata(&source) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("复核原始项目数据库失败：{error}")),
        };
        let unchanged = match (current, expected) {
            (None, None) => true,
            (Some(metadata), Some((length, modified, digest))) => {
                metadata.len() == length
                    && metadata.modified().ok() == modified
                    && file_digest(&source, length)? == digest
            }
            _ => false,
        };
        if !unchanged {
            return Err("项目数据库在结构检查期间已改变，未选择写入目标。".to_string());
        }
    }
    Ok(result)
}

fn probe_schema_read_only(database: &Path) -> Result<ProjectDatabaseKind, String> {
    with_read_only_database_snapshot(database, schema_kind)
}

fn permitted_database_name(database: &Path) -> bool {
    database
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| {
            name.strip_prefix("state_")
                .and_then(|name| name.strip_suffix(".sqlite"))
        })
        .is_some_and(|version| {
            !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn source_unchanged(path: &Path, original: &[u8]) -> Result<(), String> {
    let current = fs::read(path).map_err(|error| format!("复核项目迁移来源失败：{error}"))?;
    if current != original || path.parent().map_or(true, has_native_global_state_db) {
        return Err("项目迁移来源在同步期间已改变，原生项目归属事务已取消。".to_string());
    }
    Ok(())
}

fn write_recovery_record(
    home: &Path,
    database: &Path,
    source: &[u8],
    migration_identity: &str,
    changes: &[MembershipChange],
) -> Result<PathBuf, String> {
    let directory = home.join("backups").join("gaoge-project-compat");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("创建项目归属恢复记录目录失败，未修改归属：{error}"))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    // A minimal before-image, not a copy of auth/global-state/chat content.
    // Prepared records are also safe after rollback: restore only when the
    // current membership still equals the recorded proposed project ID.
    let record = json!({
        "version": 1,
        "status": "prepared",
        "createdAtMs": timestamp.to_string(),
        "databasePath": database.to_string_lossy(),
        "sourceSha256": format!("{:x}", Sha256::digest(source)),
        "migrationIdentity": migration_identity,
        "restoreCondition": "Restore priorProjectId only if current project_id still equals projectId; a prepared record does not prove commit.",
        "memberships": changes,
    });
    let bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("编码项目归属恢复记录失败：{error}"))?;
    for nonce in 0..32u32 {
        let path = directory.join(format!(
            "memberships-{timestamp}-{}-{nonce}.json",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!("创建项目归属恢复记录失败，未修改归属：{error}"));
            }
        };
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("保存项目归属恢复记录失败，未修改归属：{error}"));
        }
        return Ok(path);
    }
    Err("项目归属恢复记录文件冲突，未修改归属。".to_string())
}

pub(super) fn sync_native_project_memberships(
    codex_home: &Path,
    state_paths: &[PathBuf],
    client_exit_confirmed: bool,
) -> Result<ProjectCompatReport, String> {
    sync_inner(codex_home, state_paths, client_exit_confirmed, None)
}

fn sync_inner(
    codex_home: &Path,
    state_paths: &[PathBuf],
    client_exit_confirmed: bool,
    // An isolated test hook proves rollback on source races; production is None.
    before_commit: Option<&dyn Fn()>,
) -> Result<ProjectCompatReport, String> {
    let report = ProjectCompatReport::default();
    if !client_exit_confirmed {
        return Ok(deferred(
            report,
            "尚未确认 Codex 退出，未修改原生项目归属。",
        ));
    }
    if !codex_home.is_absolute() {
        return Ok(deferred(
            report,
            "Codex 目录不是绝对路径，未猜测项目迁移身份。",
        ));
    }
    if has_native_global_state_db(codex_home) {
        return Ok(deferred(ProjectCompatReport { native_projects_owned: true, ..report },
            "原生全局状态可能已迁移，旧文件不用于恢复项目归属。"));
    }
    let source_path = codex_home.join(".codex-global-state.json");
    let original = match fs::read(&source_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(error) => return Err(format!("读取项目迁移来源失败：{error}")),
    };
    let state: Value = serde_json::from_slice(&original)
        .map_err(|error| format!("解析项目迁移来源失败，未修改归属：{error}"))?;
    let mut report = ProjectCompatReport {
        native_projects_owned: has_native_project_state(&state),
        ..report
    };
    if !report.native_projects_owned {
        return Ok(report);
    }
    if has_content_owner_state(&state) {
        return Ok(deferred(report, "当前原生项目未验证独立归属，未修改项目数据。"));
    }
    // Keep original/source_path bound to the complete native file for the
    // transaction's race checks, even when an older launch hid the exact
    // return-account catalog in its inactive renderer partition.
    let selected = super::codex_api_project_bridge::verified_native_project_source(codex_home, &state)?;
    let state = selected.as_ref().unwrap_or(&state);
    // Do not normalize or merge account/home identities. Native constructs this
    // exact key from hostId + connection.codexHome(). A mismatch is a hard defer.
    let migration_identity = format!("local:{}", codex_home.to_string_lossy());
    let Some(migration) = state
        .get(MIGRATIONS)
        .and_then(|value| value.get(&migration_identity))
    else {
        return Ok(deferred(
            report,
            "当前 Codex 目录没有对应的原生项目迁移身份，未跨目录恢复。",
        ));
    };
    if migration.get("version").and_then(Value::as_u64) != Some(1)
        || migration.get("projectsMigrated").and_then(Value::as_bool) != Some(true)
    {
        return Ok(deferred(
            report,
            "原生项目迁移版本未知或项目尚未迁移，未修改归属。",
        ));
    }
    if migration
        .get("threadAssignmentsMigrated")
        .and_then(Value::as_bool)
        == Some(true)
    {
        // Old assignments cease to be authoritative after native migration.
        return Ok(report);
    }
    if migration
        .get("threadAssignmentsMigrated")
        .and_then(Value::as_bool)
        != Some(false)
    {
        return Ok(deferred(report, "原生线程归属迁移状态未知，未修改归属。"));
    }
    // Native ed4.migrate scans all explicit legacy records until its first
    // successful read migration. Only after that checkpoint is pending a
    // complete retry queue. A missing checkpoint is the reviewed old shape;
    // malformed values are not evidence that a first pass is safe.
    let read_migrated = match migration.get("threadAssignmentsReadMigrated") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        _ => {
            return Ok(deferred(
                report,
                "原生归属读取迁移状态格式未知，未修改归属。",
            ))
        }
    };
    let pending = match migration.get("pendingThreadAssignmentIds") {
        Some(Value::Array(values)) => {
            let ids = values
                .iter()
                .filter_map(nonempty_string)
                .collect::<BTreeSet<_>>();
            if ids.len() != values.len() {
                return Ok(deferred(
                    report,
                    "原生待迁移线程清单包含无效或重复项，未修改归属。",
                ));
            }
            ids
        }
        None if !read_migrated => BTreeSet::new(),
        _ => {
            return Ok(deferred(
                report,
                "原生待迁移线程清单缺失或格式未知，未修改归属。",
            ))
        }
    };
    let Some(mappings) = state
        .get(LEGACY_IDS)
        .and_then(|value| value.get(&migration_identity))
        .and_then(Value::as_object)
    else {
        return Ok(deferred(
            report,
            "当前目录缺少原生项目 ID 映射，未按目录名猜测归属。",
        ));
    };
    let Some(projects) = state.get("local-projects").and_then(Value::as_object) else {
        return Ok(deferred(report, "本地旧项目定义缺失，未恢复原生项目归属。"));
    };
    let Some(assignments) = state
        .get("thread-project-assignments")
        .and_then(Value::as_object)
    else {
        return Ok(deferred(
            report,
            "明确的旧线程归属缺失，未按工作目录生成归属。",
        ));
    };
    let projectless = match state.get("projectless-thread-ids") {
        None => BTreeSet::new(),
        Some(Value::Array(ids)) if ids.iter().all(|id| nonempty_string(id).is_some()) => {
            ids.iter().filter_map(nonempty_string).collect()
        }
        _ => return Ok(deferred(report, "显式无项目清单格式未知，未修改归属。")),
    };
    let candidates = if read_migrated {
        pending
    } else {
        // This is exactly native's first-pass candidate source. Do not infer
        // membership from a thread's cwd, recency, provider, or account.
        if assignments.keys().any(|id| id.trim().is_empty()) {
            return Ok(deferred(
                report,
                "明确的旧线程归属包含无效线程 ID，未修改归属。",
            ));
        }
        assignments
            .keys()
            .map(String::as_str)
            .chain(projectless.iter().copied())
            .collect()
    };
    report.migration_pending = candidates.len();
    if candidates.is_empty() {
        return Ok(report);
    }
    let member_hosts = state.get("thread-project-membership-host-ids");
    if member_hosts.is_some_and(|value| !value.is_object()) {
        return Ok(deferred(report, "线程项目主机归属格式未知，未修改归属。"));
    }
    let mut databases = BTreeMap::new();
    for path in state_paths {
        match fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Ok(deferred(report, "候选项目数据库不是文件，未猜测写入目标。")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("读取候选项目数据库信息失败：{error}")),
        }
        let identity =
            fs::canonicalize(path).map_err(|error| format!("解析项目数据库路径失败：{error}"))?;
        databases.entry(identity).or_insert_with(|| path.clone());
    }
    // An old sqlite/state_N.sqlite may coexist with the new native state store.
    // Exclude only a proven thread-only legacy schema; never choose by path,
    // modification time, row count, or by ignoring an unreadable candidate.
    let mut native_databases = Vec::new();
    for database in databases.into_values() {
        // The resolver owns custom sqlite_home/CODEX_SQLITE_HOME paths.
        if !permitted_database_name(&database) {
            return Ok(deferred(
                report,
                "项目数据库名称不是原生 state 数据库，未修改归属。",
            ));
        }
        match probe_schema_read_only(&database)? {
            ProjectDatabaseKind::Native => native_databases.push(database),
            ProjectDatabaseKind::LegacyThreads => {}
            ProjectDatabaseKind::Unknown => {
                return Ok(deferred(
                    report,
                    "候选项目数据库结构未知或迁移不完整，未猜测写入目标。",
                ))
            }
        }
    }
    if native_databases.len() != 1 {
        return Ok(deferred(
            report,
            "原生项目数据库缺失或存在多个完整候选，未猜测写入目标。",
        ));
    }
    let database = native_databases
        .pop()
        .expect("one verified native database");
    let mut conn = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| format!("打开现有项目数据库失败，未创建替代数据库：{error}"))?;
    conn.busy_timeout(Duration::from_millis(500))
        .map_err(|error| format!("设置项目数据库竞争保护失败：{error}"))?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|error| format!("启用项目引用完整性检查失败：{error}"))?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("无法独占项目归属写事务，未修改归属：{error}"))?;
    // Recheck inside the write transaction: the selected file may have changed
    // since the read-only probe. A partial or replaced schema is never repaired.
    if schema_kind(&tx)? != ProjectDatabaseKind::Native {
        return Ok(deferred(
            report,
            "原生项目数据库结构尚不支持安全归属恢复，未修改数据库。",
        ));
    }
    source_unchanged(&source_path, &original)?;
    let mut changes = Vec::new();
    for thread_id in candidates {
        if projectless.contains(thread_id) {
            report.explicitly_projectless += 1;
            continue;
        }
        let Some(assignment) = assignments.get(thread_id) else {
            report.missing_assignments += 1;
            continue;
        };
        let host_is_local = member_hosts
            .and_then(|hosts| hosts.get(thread_id))
            .is_none_or(|host| host.as_str() == Some("local"));
        if assignment.get("projectKind").and_then(Value::as_str) != Some("local")
            || !local_only(assignment)
            || !host_is_local
        {
            report.skipped_non_local += 1;
            continue;
        }
        let Some(legacy_id) = assignment.get("projectId").and_then(nonempty_string) else {
            report.unmapped += 1;
            continue;
        };
        let Some(project) = projects.get(legacy_id) else {
            report.missing_projects += 1;
            continue;
        };
        if !local_only(project) {
            report.skipped_non_local += 1;
            continue;
        }
        if project
            .get("id")
            .is_some_and(|id| id.as_str() != Some(legacy_id))
        {
            report.conflicts += 1;
            continue;
        }
        let Some(server_id) = mappings.get(legacy_id).and_then(nonempty_string) else {
            report.unmapped += 1;
            continue;
        };
        let roots = project.get("rootPaths").and_then(Value::as_array);
        let legacy_roots = roots.and_then(|roots| {
            roots
                .iter()
                .map(|root| root.as_str().and_then(root_identity))
                .collect::<Option<BTreeSet<_>>>()
        });
        let Some(legacy_roots) = legacy_roots.filter(|roots| !roots.is_empty()) else {
            report.conflicts += 1;
            continue;
        };
        let native_metadata = tx
            .query_row(
                "SELECT metadata FROM projects WHERE id = ?1",
                [server_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("检查原生项目元数据失败：{error}"))?;
        let Some(native_metadata) = native_metadata else {
            report.missing_projects += 1;
            continue;
        };
        let metadata = match serde_json::from_str::<Value>(&native_metadata) {
            Ok(Value::Object(metadata)) => Value::Object(metadata),
            _ => {
                report.conflicts += 1;
                continue;
            }
        };
        let native_fields = |key: &str| {
            [
                metadata.get(format!("codex.{key}")),
                metadata
                    .get("codex")
                    .and_then(|namespace| namespace.get(key)),
            ]
        };
        if !local_only(&metadata)
            || metadata
                .get("codex")
                .is_some_and(|namespace| !namespace.is_null() && !namespace.is_object())
            || [
                "chatGptBacking",
                "chatGptBackingCreation",
                "retiredChatGptBacking",
                "chatGptBackingRecoveryPending",
            ]
            .iter()
            .any(|key| native_fields(key).into_iter().flatten().any(material))
        {
            report.skipped_non_local += 1;
            continue;
        }
        if native_fields("localProjectId")
            .into_iter()
            .flatten()
            .any(|id| id.as_str() != Some(legacy_id))
        {
            report.conflicts += 1;
            continue;
        }
        let native_roots = {
            let mut stmt = tx
                .prepare("SELECT path FROM project_roots WHERE project_id = ?1")
                .map_err(|error| format!("检查原生项目目录失败：{error}"))?;
            let rows = stmt
                .query_map([server_id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("读取原生项目目录失败：{error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("读取原生项目目录失败：{error}"))?;
            rows.iter()
                .map(|root| root_identity(root))
                .collect::<Option<BTreeSet<_>>>()
        };
        if native_roots.as_ref() != Some(&legacy_roots) {
            report.conflicts += 1;
            continue;
        }
        let existing = tx
            .query_row(
                "SELECT project_id, archived FROM threads WHERE id = ?1",
                [thread_id],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|error| format!("读取现有线程项目归属失败：{error}"))?;
        let Some((prior_project_id, archived)) = existing else {
            report.missing_threads += 1;
            continue;
        };
        if archived != 0 {
            report.archived += 1;
            continue;
        }
        if prior_project_id.is_some() {
            report.already_assigned += 1;
            continue;
        }
        changes.push(MembershipChange {
            thread_id: thread_id.to_string(),
            legacy_project_id: legacy_id.to_string(),
            prior_project_id,
            project_id: server_id.to_string(),
        });
    }
    if changes.is_empty() {
        return Ok(report);
    }
    source_unchanged(&source_path, &original)?;
    let backup = write_recovery_record(
        codex_home,
        &database,
        &original,
        &migration_identity,
        &changes,
    )?;
    report.backup_path = Some(backup.to_string_lossy().into_owned());
    for change in &changes {
        let affected = tx.execute(
            "UPDATE threads SET project_id = ?1 WHERE id = ?2 AND project_id IS NULL AND archived = 0 AND EXISTS (SELECT 1 FROM projects WHERE id = ?1)",
            params![change.project_id, change.thread_id],
        ).map_err(|error| format!("恢复原生项目归属失败，事务已取消：{error}"))?;
        if affected != 1 {
            return Err("原生项目归属在同步期间发生竞争，事务已取消。".to_string());
        }
    }
    for change in &changes {
        let actual = tx
            .query_row(
                "SELECT project_id FROM threads WHERE id = ?1",
                [&change.thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("复核已写入的原生项目归属失败：{error}"))?;
        if actual.as_ref().and_then(|value| value.as_ref()) != Some(&change.project_id) {
            return Err("原生项目归属写后复核不一致，事务已取消。".to_string());
        }
    }
    if let Some(hook) = before_commit {
        hook();
    }
    source_unchanged(&source_path, &original)?;
    tx.commit()
        .map_err(|error| format!("提交原生项目归属事务失败：{error}"))?;
    report.restored = changes.len();
    // Keep native pending IDs and migration flags untouched. The native client
    // must observe/acknowledge memberships using its own RPC and gate policy.
    Ok(report)
}

/// Project-only initial API snapshot. All SQL runs against a stable private
/// main/WAL copy; neither source sidecars nor account-owned global state change.
/// Only a unique native schema is accepted when an old thread-only store also
/// exists. Caller supplies already canonicalized, strictly local definitions.
pub(super) fn read_local_project_snapshot(
    state_paths: &[PathBuf],
    catalog: &Value,
) -> Result<Value, String> {
    let catalog = catalog.as_object().ok_or("本地项目目录格式无效。")?;
    let mut candidates = BTreeMap::new();
    for database in state_paths {
        match fs::metadata(database) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err("候选项目数据库不是文件。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("读取候选项目数据库失败：{error}")),
        }
        if !permitted_database_name(database) {
            return Err("候选项目数据库名称不受支持。".into());
        }
        let identity = fs::canonicalize(database)
            .map_err(|error| format!("确认候选项目数据库失败：{error}"))?;
        candidates
            .entry(identity)
            .or_insert_with(|| database.clone());
    }
    let mut native = None;
    for candidate in candidates.into_values() {
        match probe_schema_read_only(&candidate)? {
            ProjectDatabaseKind::LegacyThreads => {}
            ProjectDatabaseKind::Native if native.is_none() => native = Some(candidate),
            ProjectDatabaseKind::Native => {
                return Err("存在多个原生项目数据库，未猜测本地归属。".into())
            }
            ProjectDatabaseKind::Unknown => {
                return Err("候选项目数据库结构未知，未读取本地归属。".into())
            }
        }
    }
    let database = native.ok_or("原生项目数据库尚未就绪，未猜测本地归属。")?;
    with_read_only_database_snapshot(&database, |conn| {
        if schema_kind(conn)? != ProjectDatabaseKind::Native {
            return Err("原生项目数据库结构已改变。".into());
        }
        for (id, project) in catalog {
            let metadata: Option<String> = conn
                .query_row("SELECT metadata FROM projects WHERE id = ?1", [id], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(|error| format!("读取原生项目元数据失败：{error}"))?;
            let metadata = metadata.ok_or("目录引用的原生项目已不存在，未恢复过期目录。")?;
            let metadata: Value =
                serde_json::from_str(&metadata).map_err(|_| "原生项目元数据格式无效。")?;
            if !metadata.is_object()
                || !local_only(&metadata)
                || metadata
                    .get("codex")
                    .is_some_and(|value| !value.is_null() && !value.is_object())
                || [
                    "chatGptBacking",
                    "chatGptBackingCreation",
                    "retiredChatGptBacking",
                    "chatGptBackingRecoveryPending",
                ]
                .iter()
                .any(|key| {
                    [
                        metadata.get(format!("codex.{key}")),
                        metadata.get("codex").and_then(|value| value.get(key)),
                    ]
                    .into_iter()
                    .flatten()
                    .any(material)
                })
            {
                return Err("目录包含非纯本地原生项目，未跨账户恢复。".into());
            }
            let expected = project
                .get("rootPaths")
                .and_then(Value::as_array)
                .and_then(|roots| {
                    roots
                        .iter()
                        .map(|root| root.as_str().and_then(root_identity))
                        .collect::<Option<BTreeSet<_>>>()
                })
                .ok_or("本地项目根目录证据无效。")?;
            let mut stmt = conn
                .prepare("SELECT path FROM project_roots WHERE project_id = ?1")
                .map_err(|error| format!("读取原生项目根目录失败：{error}"))?;
            let raw = stmt
                .query_map([id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("读取原生项目根目录失败：{error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("读取原生项目根目录失败：{error}"))?;
            let actual = raw
                .iter()
                .map(|root| root_identity(root))
                .collect::<Option<BTreeSet<_>>>();
            if actual.as_ref() != Some(&expected) {
                return Err("本地目录与原生项目根目录不一致，未恢复。".into());
            }
        }
        let mut assignments = serde_json::Map::new();
        let mut active = Vec::new();
        let mut active_project_ids = serde_json::Map::new();
        let mut stmt = conn
            .prepare("SELECT id, project_id FROM threads WHERE archived = 0 ORDER BY id")
            .map_err(|error| format!("读取原生线程项目归属失败：{error}"))?;
        for row in stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|error| format!("读取原生线程项目归属失败：{error}"))?
        {
            let (thread, project) =
                row.map_err(|error| format!("读取原生线程项目归属失败：{error}"))?;
            active.push(json!(thread));
            active_project_ids.insert(thread.clone(), json!(project));
            if let Some(project) = project.filter(|id| catalog.contains_key(id)) {
                assignments.insert(
                    thread,
                    json!({"projectKind": "local", "projectId": project}),
                );
            }
        }
        Ok(
            json!({"assignments": assignments, "activeThreadIds": active, "activeThreadProjectIds": active_project_ids}),
        )
    })
}
#[cfg(test)]
#[path = "codex_project_compat_tests.rs"]
mod tests;
