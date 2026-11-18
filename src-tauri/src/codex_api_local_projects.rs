//! Keep the native local project catalog across the native null-account reset.
//!
//! The caller owns the active-home, pure-API-auth and runtime-generation checks.
//! Only the three native-writable local catalog keys cross the renderer bridge.
//! No account envelope, identity, grants or raw thread-membership global key is
//! replayed. Existing API edits are authoritative until a verified native
//! readback is committed; reading this file never re-captures native globals.
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const SNAPSHOT_FILE: &str = ".gaoge-api-local-projects.json";
const GLOBAL_STATE_FILE: &str = ".codex-global-state.json";
const CATALOG: &str = "local-projects";
const ROOTS: &str = "electron-saved-workspace-roots";
const LABELS: &str = "electron-workspace-root-labels";
const LEGACY_IDS: &str = "app-server-project-id-by-legacy-project-id-by-host";
const HYDRATED_ATOM: &str = "gaoge:api-local-projects-hydrated-v1";
const VERSION: u64 = 1;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
const MAX_FILE_SIZE: u64 = 16 * 1024 * 1024;
static SNAPSHOT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    version: u64,
    revision: u64,
    home_identity: String,
    checkpoint_nonce: String,
    globals: Value,
    source_baseline: Value,
    memberships: Value,
    source_membership_baseline: Value,
    deleted_project_ids: BTreeSet<String>,
    local_thread_ids: BTreeSet<String>,
}

impl Snapshot {
    fn payload(&self) -> Value {
        json!({
            "version": self.version,
            "revision": self.revision,
            "globals": self.globals,
            "memberships": self.memberships,
            "checkpoint": {"version": 1, "revision": self.revision, "nonce": self.checkpoint_nonce}
        })
    }
}

fn home_identity(home: &Path) -> Result<String, String> {
    if !home.is_absolute() || !home.is_dir() {
        return Err("本地项目缓存需要已存在的绝对 Codex Home。".into());
    }
    let canonical = fs::canonicalize(home).map_err(|_| "无法确认本地项目缓存目录。")?;
    let mut text = canonical.to_string_lossy().replace('\\', "/");
    if let Some(path) = text.strip_prefix("//?/") {
        text = path.to_owned();
    }
    if cfg!(windows) {
        text.make_ascii_lowercase();
    }
    Ok(format!("{:x}", Sha256::digest(text.as_bytes())))
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    Ok(read_json_bytes(path)?.map(|(value, _)| value))
}

pub(super) fn read_bounded_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取本地项目状态文件。".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_FILE_SIZE {
        return Err("本地项目状态文件类型或大小不受支持，已保留原文件。".into());
    }
    let bytes = fs::read(path).map_err(|_| "读取本地项目状态文件失败。")?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err("本地项目状态文件超过支持范围，已保留原文件。".into());
    }
    Ok(Some(bytes))
}

fn read_json_bytes(path: &Path) -> Result<Option<(Value, Vec<u8>)>, String> {
    let Some(bytes) = read_bounded_bytes(path)? else { return Ok(None); };
    let value =
        serde_json::from_slice(&bytes).map_err(|_| "本地项目状态文件格式无效，已保留原文件。")?;
    Ok(Some((value, bytes)))
}

fn local_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 256
        && !value.starts_with("g-p-")
        && !value.chars().any(char::is_control)
}

fn material(value: &Value) -> bool {
    !value.is_null() && value.as_bool() != Some(false) && value.as_str() != Some("")
}

fn local_only(project: &Value) -> bool {
    for key in [
        "chatGptBacking",
        "chatGptBackingCreation",
        "retiredChatGptBacking",
        "chatGptBackingRecoveryPending",
        "cloudProjectId",
        "chatGptProjectId",
        "remoteConnectionId",
        "connectionId",
        "sshHost",
        "remote",
        "wslDistro",
    ] {
        if project.get(key).is_some_and(material) {
            return false;
        }
    }
    for key in [
        "projectOrigin",
        "hostId",
        "remoteHostId",
        "sourceHostId",
        "projectKind",
    ] {
        if let Some(value) = project.get(key).filter(|value| !value.is_null()) {
            if !matches!(value.as_str(), Some("" | "local")) {
                return false;
            }
        }
    }
    true
}

fn root_identity(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 32_768 || raw.chars().any(char::is_control) {
        return None;
    }
    // UNC, WSL and device paths are not evidence of a local drive project.
    let slashed = raw.replace('\\', "/");
    if slashed.starts_with("//") {
        return None;
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    let mut text = normalized.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.make_ascii_lowercase();
    }
    while text.len() > 3 && text.ends_with('/') {
        text.pop();
    }
    Some(text)
}

fn trusted_mapping(home: &Path, source: &Value) -> Result<BTreeMap<String, String>, String> {
    let Some(all) = source.get(LEGACY_IDS) else {
        return Ok(BTreeMap::new());
    };
    let all = all.as_object().ok_or("原生项目映射格式无效。")?;
    let identity = format!("local:{}", home.to_string_lossy());
    let Some(mapping) = all.get(&identity) else {
        return Ok(BTreeMap::new());
    };
    let mapping = mapping
        .as_object()
        .ok_or("当前 Codex Home 的原生项目映射无效。")?;
    let mut result = BTreeMap::new();
    for (old, new) in mapping {
        let Some(new) = new.as_str() else {
            return Err("原生项目映射包含无效项目 ID。".into());
        };
        // Linked/account projects are deliberately outside this cache.
        if old.starts_with("g-p-") || new.starts_with("g-p-") {
            continue;
        }
        if !local_id(old) || !local_id(new) {
            return Err("原生项目映射包含无效项目 ID。".into());
        }
        result.insert(old.clone(), new.into());
    }
    Ok(result)
}

fn catalog_ids(globals: &Value) -> BTreeSet<String> {
    globals
        .get(CATALOG)
        .and_then(Value::as_object)
        .map(|catalog| catalog.keys().cloned().collect())
        .unwrap_or_default()
}

fn sanitize_globals(
    source: &Value,
    mapping: &BTreeMap<String, String>,
    known_native_ids: &BTreeSet<String>,
    require_native_id: bool,
) -> Result<Option<Value>, String> {
    let Some(raw_catalog) = source.get(CATALOG).filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let raw_catalog = raw_catalog
        .as_object()
        .ok_or("原生本地项目目录格式无效。")?;
    if raw_catalog.len() > 4096 {
        return Err("本地项目目录超过支持范围。".into());
    }
    let native_ids: BTreeSet<_> = mapping.values().cloned().collect();
    let mut catalog = Map::new();
    let mut roots = BTreeMap::<String, String>::new();
    for (key, project) in raw_catalog {
        if key.starts_with("g-p-") || !local_only(project) {
            continue;
        }
        if !local_id(key) || project.get("id").and_then(Value::as_str) != Some(key) {
            return Err("本地项目目录的项目 ID 不一致。".into());
        }
        let id = mapping.get(key).unwrap_or(key);
        if require_native_id
            && !mapping.contains_key(key)
            && !native_ids.contains(key)
            && !known_native_ids.contains(key)
        {
            return Err("原生项目 ID 映射尚未就绪，稍后重试。".into());
        }
        let name = project
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty() && name.len() <= 4096)
            .ok_or("本地项目名称无效。")?;
        let raw_roots = project
            .get("rootPaths")
            .and_then(Value::as_array)
            .ok_or("本地项目根目录格式无效。")?;
        if raw_roots.len() > 256 {
            return Err("本地项目根目录数量超过支持范围。".into());
        }
        let mut project_roots = Vec::new();
        let mut seen = BTreeSet::new();
        let mut unsupported = false;
        for root in raw_roots {
            let Some(raw) = root.as_str() else {
                return Err("本地项目根目录必须为字符串。".into());
            };
            let Some(identity) = root_identity(raw) else {
                unsupported = true;
                break;
            };
            if seen.insert(identity.clone()) {
                roots.entry(identity).or_insert_with(|| raw.to_owned());
                project_roots.push(json!(raw));
            }
        }
        if unsupported {
            // A mixed local/remote definition must not become a partial project.
            continue;
        }
        let mut safe = Map::new();
        safe.insert("id".into(), json!(id));
        safe.insert("name".into(), json!(name));
        safe.insert("rootPaths".into(), Value::Array(project_roots));
        for field in ["createdAt", "updatedAt"] {
            let value = project
                .get(field)
                .filter(|value| {
                    value.as_f64().is_some_and(|number| {
                        number.is_finite() && number >= 0.0 && number <= MAX_SAFE_REVISION as f64
                    })
                })
                .ok_or("本地项目时间字段无效。")?;
            safe.insert(field.into(), value.clone());
        }
        if let Some(previous) = catalog.insert(id.clone(), Value::Object(safe.clone())) {
            if previous != Value::Object(safe) {
                return Err("多个本地目录指向同一个原生项目且内容冲突。".into());
            }
        }
    }
    // Rebuild the accepted root universe after rejecting mixed/remote entries.
    roots.clear();
    for project in catalog.values() {
        for root in project["rootPaths"].as_array().into_iter().flatten() {
            let raw = root.as_str().expect("validated project root");
            roots
                .entry(root_identity(raw).expect("validated local root"))
                .or_insert_with(|| raw.to_owned());
        }
    }
    let mut saved_roots = Vec::new();
    let mut saved_ids = BTreeSet::new();
    if let Some(raw_roots) = source.get(ROOTS).and_then(Value::as_array) {
        for raw in raw_roots.iter().filter_map(Value::as_str) {
            if let Some(identity) =
                root_identity(raw).filter(|identity| roots.contains_key(identity))
            {
                if saved_ids.insert(identity.clone()) {
                    saved_roots.push(json!(roots[&identity]));
                }
            }
        }
    }
    for (identity, raw) in &roots {
        if saved_ids.insert(identity.clone()) {
            saved_roots.push(json!(raw));
        }
    }
    let mut labels = Map::new();
    if let Some(raw_labels) = source.get(LABELS).and_then(Value::as_object) {
        for (raw, label) in raw_labels {
            if let Some(identity) =
                root_identity(raw).filter(|identity| roots.contains_key(identity))
            {
                if let Some(label) = label.as_str().filter(|label| label.len() <= 4096) {
                    labels.insert(roots[&identity].clone(), json!(label));
                }
            }
        }
    }
    Ok(Some(
        json!({ CATALOG: catalog, ROOTS: saved_roots, LABELS: labels }),
    ))
}

fn reject_unavailable_account_catalog(source: &Value) -> Result<(), String> {
    if source.get(CATALOG).is_some_and(|value| !value.is_null()) {
        return Ok(());
    }
    let unavailable = || "本地项目仍在账户隔离状态中，无法确认安全恢复来源，尚未恢复。".to_string();
    // Native owner reset can move a complete catalog away from root globals.
    // Never turn this upgrade case into a successful empty first-run snapshot,
    // and never select an account merely because it is the only inactive one.
    if source.get(LEGACY_IDS).is_some()
        || source
            .get("app-server-projects-migration-by-host")
            .is_some()
    {
        return Err(unavailable());
    }
    let Some(envelope) = source.get("electron-account-renderer-state-v1") else {
        return Ok(());
    };
    let envelope = envelope.as_object().ok_or_else(unavailable)?;
    let inactive = envelope
        .get("inactive")
        .and_then(Value::as_object)
        .ok_or_else(unavailable)?;
    for saved in inactive.values() {
        let globals = saved
            .get("globals")
            .and_then(Value::as_object)
            .ok_or_else(unavailable)?;
        if globals.get(CATALOG).is_some_and(|catalog| {
            catalog
                .as_object()
                .is_none_or(|catalog| !catalog.is_empty())
        }) || globals.contains_key(LEGACY_IDS)
            || globals.contains_key("app-server-projects-migration-by-host")
            || globals
                .get("thread-project-assignments")
                .is_some_and(|value| value.as_object().is_none_or(|value| !value.is_empty()))
            || globals
                .get(ROOTS)
                .is_some_and(|value| value.as_array().is_none_or(|value| !value.is_empty()))
        {
            return Err(unavailable());
        }
    }
    Ok(())
}
fn empty_globals() -> Value {
    json!({CATALOG: {}, ROOTS: [], LABELS: {}})
}

fn read_locked(home: &Path) -> Result<Option<Snapshot>, String> {
    let identity = home_identity(home)?;
    let Some(value) = read_json(&home.join(SNAPSHOT_FILE))? else {
        return Ok(None);
    };
    let snapshot: Snapshot =
        serde_json::from_value(value).map_err(|_| "本地项目缓存结构无效，已保留原文件。")?;
    if snapshot.version != VERSION
        || snapshot.revision == 0
        || snapshot.revision > MAX_SAFE_REVISION
        || snapshot.home_identity != identity
        || snapshot.checkpoint_nonce.len() != 64
        || !snapshot
            .checkpoint_nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("本地项目缓存版本、修订号或所属目录不匹配，已保留原文件。".into());
    }
    for globals in [&snapshot.globals, &snapshot.source_baseline] {
        if sanitize_globals(globals, &BTreeMap::new(), &BTreeSet::new(), false)?.as_ref()
            != Some(globals)
        {
            return Err("本地项目缓存包含不支持的字段，已保留原文件。".into());
        }
    }
    for (memberships, globals) in [
        (&snapshot.memberships, &snapshot.globals),
        (
            &snapshot.source_membership_baseline,
            &snapshot.source_baseline,
        ),
    ] {
        if sanitize_memberships(memberships, &BTreeMap::new(), globals)? != *memberships {
            return Err("本地项目归属缓存包含不支持字段，已保留原文件。".into());
        }
    }
    if snapshot.deleted_project_ids.iter().any(|id| !local_id(id))
        || snapshot.deleted_project_ids.len() > 16384
    {
        return Err("本地项目删除记录无效，已保留原文件。".into());
    }
    if snapshot.local_thread_ids.len() > 200_000
        || snapshot
            .local_thread_ids
            .iter()
            .any(|id| !valid_thread_id(id))
        || membership_entries(&snapshot.memberships)
            .keys()
            .any(|id| !snapshot.local_thread_ids.contains(id))
    {
        return Err("本机线程验证缓存无效，已保留原文件。".into());
    }
    Ok(Some(snapshot))
}

fn write_locked(home: &Path, snapshot: &Snapshot) -> Result<(), String> {
    write_locked_if(home, snapshot, &|| Ok(()))
}

fn write_locked_if(home: &Path, snapshot: &Snapshot, verify: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(snapshot).map_err(|_| "无法编码本地项目缓存。")?;
    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err("本地项目缓存超过支持范围，未覆盖原文件。".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(home).map_err(|_| "无法创建本地项目缓存临时文件。")?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| "写入本地项目缓存临时文件失败。")?;
    if super::codex_project_compat::has_native_global_state_db(home) {
        return Err("原生全局存储已改变，保留已有本地项目缓存。".into());
    }
    verify()?;
    temporary
        .persist(home.join(SNAPSHOT_FILE))
        .map_err(|_| "原子替换本地项目缓存失败，原文件保持有效。")?;
    Ok(())
}

fn new_checkpoint_nonce() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "无法创建本地项目保存校验码。")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn advance(snapshot: &mut Snapshot) -> Result<(), String> {
    if snapshot.revision >= MAX_SAFE_REVISION {
        return Err("本地项目缓存修订号已达上限。".into());
    }
    snapshot.checkpoint_nonce = new_checkpoint_nonce()?;
    snapshot.revision += 1;
    Ok(())
}

fn empty_memberships() -> Value {
    json!({"assignments": {}, "projectlessThreadIds": []})
}

fn valid_thread_id(id: &str) -> bool {
    local_id(id) && !id.contains('/') && !id.contains('\\')
}

fn sanitize_memberships(
    input: &Value,
    mapping: &BTreeMap<String, String>,
    globals: &Value,
) -> Result<Value, String> {
    let assignments = input
        .get("assignments")
        .and_then(Value::as_object)
        .ok_or("本地项目归属提交缺少完整分配表。")?;
    let projectless = input
        .get("projectlessThreadIds")
        .and_then(Value::as_array)
        .ok_or("本地项目归属提交缺少完整无项目清单。")?;
    if assignments.len() + projectless.len() > 100_000 {
        return Err("本地线程项目归属数量超过支持范围。".into());
    }
    let known = catalog_ids(globals);
    let mut safe = Map::new();
    for (thread, assignment) in assignments {
        if !valid_thread_id(thread) {
            return Err("本地项目归属包含无效线程 ID。".into());
        }
        if assignment.get("projectKind").and_then(Value::as_str) != Some("local")
            || !local_only(assignment)
        {
            continue;
        }
        let id = assignment
            .get("projectId")
            .and_then(Value::as_str)
            .filter(|id| local_id(id))
            .ok_or("本地项目归属包含无效项目 ID。")?;
        let canonical = mapping.get(id).map(String::as_str).unwrap_or(id);
        // A linked, deleted or remote project must never enter local restore.
        if !known.contains(canonical) {
            continue;
        }
        safe.insert(
            thread.clone(),
            json!({"projectKind": "local", "projectId": canonical}),
        );
    }
    let mut projectless_ids = BTreeSet::new();
    for id in projectless {
        let id = id
            .as_str()
            .filter(|id| valid_thread_id(id))
            .ok_or("无项目清单包含无效线程 ID。")?;
        if safe.contains_key(id) {
            return Err("同一线程同时有项目归属和无项目标记，未提交冲突状态。".into());
        }
        projectless_ids.insert(id.to_owned());
    }
    Ok(json!({"assignments": safe, "projectlessThreadIds": projectless_ids}))
}

fn initial_memberships(
    home: &Path,
    source: &Value,
    globals: &Value,
    state_paths: &[PathBuf],
) -> Result<(Value, BTreeSet<String>), String> {
    if catalog_ids(globals).is_empty() && state_paths.is_empty() {
        return Ok((empty_memberships(), BTreeSet::new()));
    }
    let verified =
        super::codex_project_compat::read_local_project_snapshot(state_paths, &globals[CATALOG])?;
    let active: BTreeSet<_> = verified["activeThreadIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let hosts = source
        .get("thread-project-membership-host-ids")
        .and_then(Value::as_object);
    let mut assignments = verified["assignments"]
        .as_object()
        .expect("verified assignments")
        .clone();
    assignments.retain(|thread, _| {
        hosts
            .and_then(|hosts| hosts.get(thread))
            .is_none_or(|host| host.as_str() == Some("local"))
    });
    let mut projectless = BTreeSet::new();
    for thread in source
        .get("projectless-thread-ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if active.contains(thread)
            && hosts
                .and_then(|hosts| hosts.get(thread))
                .is_none_or(|host| host.as_str() == Some("local"))
        {
            assignments.remove(thread);
            projectless.insert(thread.to_owned());
        }
    }
    let mapping = trusted_mapping(home, source)?;
    let known = catalog_ids(globals);
    let identity = format!("local:{}", home.to_string_lossy());
    let migration_complete = source
        .get("app-server-projects-migration-by-host")
        .and_then(|all| all.get(&identity))
        .and_then(|migration| migration.get("threadAssignmentsMigrated"))
        .and_then(Value::as_bool)
        == Some(true);
    if !migration_complete {
        if let Some(legacy) = source.get("thread-project-assignments") {
            let legacy = legacy.as_object().ok_or("原生线程项目归属源格式无效。")?;
            for (thread, assignment) in legacy {
                if !active.contains(thread.as_str())
                    || projectless.contains(thread)
                    || assignment.get("projectKind").and_then(Value::as_str) != Some("local")
                    || !local_only(assignment)
                    || hosts
                        .and_then(|hosts| hosts.get(thread))
                        .is_some_and(|host| host.as_str() != Some("local"))
                {
                    continue;
                }
                let Some(id) = assignment.get("projectId").and_then(Value::as_str) else {
                    continue;
                };
                let canonical = mapping.get(id).map(String::as_str).unwrap_or(id);
                if known.contains(canonical)
                    && verified["activeThreadProjectIds"]
                        .get(thread)
                        .is_some_and(Value::is_null)
                {
                    return Err("原生本地线程归属尚未修复，未保存不完整项目快照。".into());
                }
            }
        }
    }
    let memberships = sanitize_memberships(
        &json!({"assignments": assignments, "projectlessThreadIds": projectless}),
        &BTreeMap::new(),
        globals,
    )?;
    let approved = active
        .into_iter()
        .filter(|thread| {
            hosts
                .and_then(|hosts| hosts.get(*thread))
                .is_none_or(|host| host.as_str() == Some("local"))
        })
        .map(str::to_owned)
        .collect();
    Ok((memberships, approved))
}

/// Main-process host metadata and previous DB-verified IDs are the only local
/// evidence. A missing host for a new thread is not permission to replay it as
/// local. Explicit remote ownership supersedes any older local approval.
fn filter_membership_hosts(
    memberships: &Value,
    native: &Value,
    previous_local_ids: &BTreeSet<String>,
) -> Result<(Value, BTreeSet<String>), String> {
    let hosts = match native.get("thread-project-membership-host-ids") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_object().ok_or("原生线程主机归属格式无效。")?),
    };
    let mut approved = previous_local_ids.clone();
    approved.retain(|thread| {
        hosts
            .and_then(|hosts| hosts.get(thread))
            .is_none_or(|host| host.as_str() == Some("local"))
    });
    let assignments = memberships
        .get("assignments")
        .and_then(Value::as_object)
        .ok_or("本地项目归属提交缺少完整分配表。")?;
    let projectless = memberships
        .get("projectlessThreadIds")
        .and_then(Value::as_array)
        .ok_or("本地项目归属提交缺少完整无项目清单。")?;
    let mut safe_assignments = Map::new();
    let mut safe_projectless = Vec::new();
    for (thread, assignment) in assignments {
        if !valid_thread_id(thread) {
            return Err("本地项目归属包含无效线程 ID。".into());
        }
        if assignment.get("projectKind").and_then(Value::as_str) != Some("local")
            || !local_only(assignment)
        {
            continue;
        }
        match hosts.and_then(|hosts| hosts.get(thread)) {
            Some(host) if host.as_str() == Some("local") => {
                approved.insert(thread.clone());
            }
            Some(_) => continue,
            None if !approved.contains(thread) => {
                return Err("新线程的本机归属尚未验证，稍后重试。".into())
            }
            None => {}
        }
        safe_assignments.insert(thread.clone(), assignment.clone());
    }
    for thread in projectless {
        let thread = thread
            .as_str()
            .filter(|thread| valid_thread_id(thread))
            .ok_or("无项目清单包含无效线程 ID。")?;
        match hosts.and_then(|hosts| hosts.get(thread)) {
            Some(host) if host.as_str() == Some("local") => {
                approved.insert(thread.to_owned());
            }
            Some(_) => continue,
            None if !approved.contains(thread) => continue,
            None => {}
        }
        safe_projectless.push(json!(thread));
    }
    if approved.len() > 200_000 {
        return Err("本机线程验证记录超过支持范围。".into());
    }
    Ok((
        json!({"assignments":safe_assignments,"projectlessThreadIds":safe_projectless}),
        approved,
    ))
}

fn membership_entries(memberships: &Value) -> BTreeMap<String, Value> {
    let mut entries: BTreeMap<_, _> = memberships["assignments"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(id, value)| (id.clone(), value.clone()))
        .collect();
    for id in memberships["projectlessThreadIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        entries.insert(id.to_owned(), Value::Null);
    }
    entries
}

fn memberships_from_entries(
    entries: BTreeMap<String, Value>,
    globals: &Value,
) -> Result<Value, String> {
    let mut assignments = Map::new();
    let mut projectless = Vec::new();
    let known = catalog_ids(globals);
    for (thread, assignment) in entries {
        if assignment.is_null()
            || assignment
                .get("projectId")
                .and_then(Value::as_str)
                .is_some_and(|id| !known.contains(id))
        {
            projectless.push(json!(thread));
        } else {
            assignments.insert(thread, assignment);
        }
    }

    sanitize_memberships(
        &json!({"assignments": assignments, "projectlessThreadIds": projectless}),
        &BTreeMap::new(),
        globals,
    )
}

fn new_snapshot(
    home: &Path,
    globals: Value,
    memberships: Value,
    seeded: bool,
    local_thread_ids: BTreeSet<String>,
) -> Result<Snapshot, String> {
    Ok(Snapshot {
        version: VERSION,
        revision: 1,
        home_identity: home_identity(home)?,
        checkpoint_nonce: new_checkpoint_nonce()?,
        source_baseline: if seeded {
            globals.clone()
        } else {
            empty_globals()
        },
        source_membership_baseline: if seeded {
            memberships.clone()
        } else {
            empty_memberships()
        },
        globals,
        memberships,
        deleted_project_ids: BTreeSet::new(),
        local_thread_ids,
    })
}

/// Read only. In particular, never capture an inactive account or reapply a
/// snapshot to native globals from a poll request.
pub(super) fn read(home: &Path) -> Result<Option<Value>, String> {
    let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "本地项目缓存锁不可用。")?;
    let snapshot = read_locked(home)?;
    if snapshot.is_none() {
        if super::codex_project_compat::has_native_global_state_db(home) {
            return Ok(None);
        }
        if let Some(source) = read_json(&home.join(GLOBAL_STATE_FILE))? {
            if super::codex_project_compat::has_content_owner_state(&source) {
                return Ok(None);
            }
            reject_unavailable_account_catalog(&source)?;
            if source
                .get(CATALOG)
                .and_then(Value::as_object)
                .is_some_and(|catalog| !catalog.is_empty())
            {
                return Err("本地项目快照尚未验证，正在等待安全初始化。".into());
            }
        }
    }
    Ok(snapshot.map(|snapshot| snapshot.payload()))
}

/// The no-database entry point only seeds empty catalogs. Production passes
/// resolved native/legacy/custom sqlite paths to prepare_with_databases.
pub(super) fn prepare(home: &Path, source: &Value) -> Result<Option<Value>, String> {
    prepare_with_databases(home, source, &[])
}

/// First capture after offline membership repair, before native startup clears
/// account-owned globals. Existing API state is preserved on ordinary startup.
pub(super) fn prepare_with_databases(
    home: &Path,
    source: &Value,
    state_paths: &[PathBuf],
) -> Result<Option<Value>, String> {
    prepare_if_current(home, source, state_paths, &|| Ok(()))
}

pub(super) fn prepare_if_current(
    home: &Path,
    source: &Value,
    state_paths: &[PathBuf],
    verify: &dyn Fn() -> Result<(), String>,
) -> Result<Option<Value>, String> {
    let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "本地项目缓存锁不可用。")?;
    verify()?;
    if let Some(snapshot) = read_locked(home)? {
        return Ok(Some(snapshot.payload()));
    }
    if super::codex_project_compat::has_native_global_state_db(home)
        || super::codex_project_compat::has_content_owner_state(source) {
        return Ok(None);
    }
    reject_unavailable_account_catalog(source)?;
    let mapping = trusted_mapping(home, source)?;
    let Some(globals) = sanitize_globals(source, &mapping, &BTreeSet::new(), true)? else {
        return Ok(None);
    };
    let (memberships, local_thread_ids) = initial_memberships(home, source, &globals, state_paths)?;
    let snapshot = new_snapshot(home, globals, memberships, true, local_thread_ids)?;
    write_locked_if(home, &snapshot, verify)?;
    Ok(Some(snapshot.payload()))
}

pub(super) fn capture(home: &Path, source: &Value) -> Result<Option<Value>, String> {
    capture_with_databases(home, source, &[])
}

/// Explicit official-to-API capture. Reconcile against the previous official
/// baseline, so stale account globals cannot resurrect an API deletion or erase
/// API-only projects. Simultaneous conflicting edits preserve the API value.
pub(super) fn capture_with_databases(
    home: &Path,
    source: &Value,
    state_paths: &[PathBuf],
) -> Result<Option<Value>, String> {
    let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "本地项目缓存锁不可用。")?;
    let existing = read_locked(home)?;
    if super::codex_project_compat::has_native_global_state_db(home)
        || super::codex_project_compat::has_content_owner_state(source) {
        return Ok(existing.map(|snapshot| snapshot.payload()));
    }
    let known = existing
        .as_ref()
        .map(|snapshot| catalog_ids(&snapshot.globals))
        .unwrap_or_default();
    reject_unavailable_account_catalog(source)?;
    let mapping = trusted_mapping(home, source)?;
    let Some(incoming) = sanitize_globals(source, &mapping, &known, true)? else {
        return Ok(None);
    };
    let (incoming_memberships, incoming_local_thread_ids) =
        initial_memberships(home, source, &incoming, state_paths)?;
    let Some(mut snapshot) = existing else {
        let snapshot = new_snapshot(
            home,
            incoming,
            incoming_memberships,
            true,
            incoming_local_thread_ids,
        )?;
        write_locked(home, &snapshot)?;
        return Ok(Some(snapshot.payload()));
    };
    let previous_deleted = snapshot.deleted_project_ids.clone();
    let baseline = snapshot.source_baseline[CATALOG]
        .as_object()
        .expect("validated baseline");
    let official = incoming[CATALOG]
        .as_object()
        .expect("validated incoming catalog");
    let mut merged = snapshot.globals[CATALOG]
        .as_object()
        .expect("validated catalog")
        .clone();
    let mut retained_conflicts = BTreeSet::new();
    for (id, old) in baseline {
        if !official.contains_key(id) {
            if merged.get(id) == Some(old) {
                merged.remove(id);
                snapshot.deleted_project_ids.insert(id.clone());
            } else if merged.contains_key(id) {
                // An API edit after the shared baseline wins an official
                // deletion conflict, including its existing memberships.
                retained_conflicts.insert(id.clone());
            }
        } else if merged.get(id) == Some(old) {
            merged.insert(id.clone(), official[id].clone());
        }
    }
    for (id, project) in official {
        if !baseline.contains_key(id) && !snapshot.deleted_project_ids.contains(id) {
            merged.entry(id.clone()).or_insert_with(|| project.clone());
        }
    }
    let mut input = snapshot.globals.clone();
    input[CATALOG] = Value::Object(merged);
    if let (Some(labels), Some(incoming_labels)) =
        (input[LABELS].as_object_mut(), incoming[LABELS].as_object())
    {
        for (root, label) in incoming_labels {
            labels.entry(root.clone()).or_insert_with(|| label.clone());
        }
    }
    let globals = sanitize_globals(&input, &BTreeMap::new(), &BTreeSet::new(), false)?
        .expect("merged catalog present");
    let old_memberships = membership_entries(&snapshot.source_membership_baseline);
    let official_memberships = membership_entries(&incoming_memberships);
    let mut merged_memberships = membership_entries(&snapshot.memberships);
    for (thread, old) in &old_memberships {
        if old
            .get("projectId")
            .and_then(Value::as_str)
            .is_some_and(|id| retained_conflicts.contains(id))
        {
            continue;
        }
        if merged_memberships.get(thread) == Some(old) {
            match official_memberships.get(thread) {
                Some(incoming) => {
                    merged_memberships.insert(thread.clone(), incoming.clone());
                }
                None => {
                    merged_memberships.insert(thread.clone(), Value::Null);
                }
            }
        }
    }
    for (thread, incoming) in &official_memberships {
        if !old_memberships.contains_key(thread) {
            merged_memberships
                .entry(thread.clone())
                .or_insert_with(|| incoming.clone());
        }
    }
    let memberships = memberships_from_entries(merged_memberships, &globals)?;
    let mut local_thread_ids = snapshot.local_thread_ids.clone();
    local_thread_ids.extend(incoming_local_thread_ids);
    let (memberships, local_thread_ids) =
        filter_membership_hosts(&memberships, source, &local_thread_ids)?;
    if globals != snapshot.globals
        || incoming != snapshot.source_baseline
        || memberships != snapshot.memberships
        || incoming_memberships != snapshot.source_membership_baseline
        || local_thread_ids != snapshot.local_thread_ids
    {
        snapshot.globals = globals;
        snapshot.source_baseline = incoming;
        snapshot.memberships = memberships;
        snapshot.source_membership_baseline = incoming_memberships;
        snapshot.local_thread_ids = local_thread_ids;
        advance(&mut snapshot)?;
        write_locked(home, &snapshot)?;
    } else if snapshot.deleted_project_ids != previous_deleted {
        advance(&mut snapshot)?;
        write_locked(home, &snapshot)?;
    }
    Ok(Some(snapshot.payload()))
}

/// Normalize a complete native readback before comparing revisions. Inferred
/// absence is normalized on both first delivery and a lost-response retry;
/// equality still rejects a stale request omitting any newer assignment.
fn apply_readback(
    home: &Path,
    existing: Option<Snapshot>,
    native: &Value,
    expected_revision: u64,
    globals: &Value,
    memberships: &Value,
) -> Result<(Snapshot, bool), String> {
    let fields = globals.as_object().ok_or("本地项目目录提交格式无效。")?;
    if fields
        .keys()
        .any(|key| !matches!(key.as_str(), CATALOG | ROOTS | LABELS))
    {
        return Err("本地项目提交包含不允许的全局字段，未保存。".into());
    }
    let revision = existing
        .as_ref()
        .map(|snapshot| snapshot.revision)
        .unwrap_or(0);
    let mapping = trusted_mapping(home, native)?;
    let known = existing
        .as_ref()
        .map(|snapshot| catalog_ids(&snapshot.globals))
        .unwrap_or_default();
    let globals = sanitize_globals(globals, &mapping, &known, true)?
        .ok_or("本地项目提交缺少完整目录，未修改缓存。")?;
    let approved = existing
        .as_ref()
        .map(|snapshot| snapshot.local_thread_ids.clone())
        .unwrap_or_default();
    let (memberships, local_thread_ids) = filter_membership_hosts(memberships, native, &approved)?;
    let mut memberships = sanitize_memberships(&memberships, &mapping, &globals)?;
    if let Some(snapshot) = &existing {
        // Absence from a complete readback is explicit removal. Normalize
        // before CAS equality so retrying a lost response is idempotent.
        let mut entries = membership_entries(&memberships);
        for (thread, _) in membership_entries(&snapshot.memberships) {
            if local_thread_ids.contains(&thread) {
                entries.entry(thread).or_insert(Value::Null);
            }
        }
        memberships = memberships_from_entries(entries, &globals)?;
    }
    let identical = existing.as_ref().is_some_and(|snapshot| {
        snapshot.globals == globals
            && snapshot.memberships == memberships
            && snapshot.local_thread_ids == local_thread_ids
    });
    if expected_revision != revision && !identical {
        return Err("本地项目缓存已更新，请读取新修订后重试。".into());
    }
    if identical {
        return Ok((existing.expect("identical existing snapshot"), false));
    }
    let snapshot = match existing {
        Some(mut snapshot) => {
            for removed in catalog_ids(&snapshot.globals).difference(&catalog_ids(&globals)) {
                snapshot.deleted_project_ids.insert(removed.clone());
            }
            for present in catalog_ids(&globals) {
                snapshot.deleted_project_ids.remove(&present);
            }
            snapshot.globals = globals;
            snapshot.memberships = memberships;
            snapshot.local_thread_ids = local_thread_ids;
            advance(&mut snapshot)?;
            snapshot
        }
        None => new_snapshot(home, globals, memberships, false, local_thread_ids)?,
    };
    if snapshot.deleted_project_ids.len() > 16384 {
        return Err("本地项目删除记录超过支持范围，未修改缓存。".into());
    }
    Ok((snapshot, true))
}

/// Commit a complete local native readback after one-time hydration. The caller
/// must reject stale runtime generations while holding its account-switch lock.
/// Zero creates the first cache; absent collections never mean user deletion.
pub(super) fn commit(
    home: &Path,
    expected_revision: u64,
    globals: &Value,
    memberships: &Value,
) -> Result<Value, String> {
    let native = read_json(&home.join(GLOBAL_STATE_FILE))?.unwrap_or_else(|| json!({}));
    commit_if_current(home, &native, expected_revision, globals, memberships, &|| Ok(()))
}

pub(super) fn commit_if_current(
    home: &Path,
    native: &Value,
    expected_revision: u64,
    globals: &Value,
    memberships: &Value,
    verify: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "本地项目缓存锁不可用。")?;
    verify()?;
    if super::codex_project_compat::has_native_global_state_db(home) {
        return Err("原生全局状态可能已迁移，无法验证此前项目归属，未修改缓存。".into());
    }
    if super::codex_project_compat::has_content_owner_state(native) {
        return Err("当前原生项目范围未验证，未修改本地项目缓存。".into());
    }
    let existing = read_locked(home)?;
    let (snapshot, changed) = apply_readback(
        home,
        existing,
        native,
        expected_revision,
        globals,
        memberships,
    )?;
    if changed {
        write_locked_if(home, &snapshot, verify)?;
    }
    Ok(snapshot.payload())
}

/// Save native changes from the last polling interval after the caller has
/// confirmed native exit, before replacing API auth. A native account-scoped
/// atom proves this exact snapshot was fully hydrated in the exiting process.
/// Native clears the atom on *every* null-owner selection, including startup.
/// Missing/old receipts or an absent catalog defer without modifying files.
pub(super) fn finalize_native_state(home: &Path, scope: &str) -> Result<Option<Value>, String> {
    let _guard = SNAPSHOT_LOCK.lock().map_err(|_| "本地项目缓存锁不可用。")?;
    if super::codex_project_compat::has_native_global_state_db(home) {
        return Ok(None);
    }
    let auth_path = home.join("auth.json");
    let Some((auth, auth_bytes)) = read_json_bytes(&auth_path)? else {
        return Ok(None);
    };
    if !super::codex_api_mode::enabled(Some(&auth)) {
        return Ok(None);
    }
    let Some(snapshot) = read_locked(home)? else {
        return Ok(None);
    };
    if snapshot.home_identity != scope {
        return Ok(None);
    }
    let state_path = home.join(GLOBAL_STATE_FILE);
    let Some((native, native_bytes)) = read_json_bytes(&state_path)? else {
        return Ok(None);
    };
    if super::codex_project_compat::has_content_owner_state(&native) || native
        .get("electron-account-renderer-state-v1")
        .and_then(|state| state.get("owner"))
        != Some(&Value::Null)
    {
        return Ok(None);
    }
    let Some(marker) = native
        .get("electron-persisted-atom-state")
        .and_then(|atoms| atoms.get(HYDRATED_ATOM))
    else {
        return Ok(None);
    };
    if marker.get("version").and_then(Value::as_u64) != Some(1)
        || marker.get("scope").and_then(Value::as_str) != Some(scope)
        || marker.get("revision").and_then(Value::as_u64) != Some(snapshot.revision)
        || marker.get("nonce").and_then(Value::as_str) != Some(snapshot.checkpoint_nonce.as_str())
    {
        return Ok(None);
    }
    // Native omits untouched empty membership collections. The exact receipt,
    // cleared by every startup, proves the full hydrate/readback completed;
    // only absence gets native defaults, never malformed explicit values.
    let Some(catalog) = native.get(CATALOG) else {
        return Ok(None);
    };
    let empty_assignments = json!({});
    let empty_projectless = json!([]);
    let assignments = native
        .get("thread-project-assignments")
        .unwrap_or(&empty_assignments);
    let projectless = native
        .get("projectless-thread-ids")
        .unwrap_or(&empty_projectless);
    if !catalog.is_object() || !assignments.is_object() || !projectless.is_array() {
        return Err("原生项目最终状态不完整，已保留本地项目缓存。".into());
    }
    let mut globals = json!({CATALOG: catalog});
    for key in [ROOTS, LABELS] {
        if let Some(value) = native.get(key) {
            globals[key] = value.clone();
        }
    }
    let memberships = json!({"assignments":assignments,"projectlessThreadIds":projectless});
    let revision = snapshot.revision;
    let (snapshot, changed) = apply_readback(
        home,
        Some(snapshot),
        &native,
        revision,
        &globals,
        &memberships,
    )?;
    // Reject a restart/account switch race instead of committing a projection
    // from an older root file. No original auth or native state is written.
    if super::codex_project_compat::has_native_global_state_db(home)
        || read_json_bytes(&auth_path)?.map(|(_, bytes)| bytes) != Some(auth_bytes)
        || read_json_bytes(&state_path)?.map(|(_, bytes)| bytes) != Some(native_bytes)
    {
        return Err("原生状态在最终保存前发生变化，已保留本地项目缓存，请重试。".into());
    }
    if changed {
        write_locked(home, &snapshot)?;
    }
    Ok(Some(snapshot.payload()))
}

#[cfg(test)]
#[path = "codex_api_local_projects_tests.rs"]
mod tests;
