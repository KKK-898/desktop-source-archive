//! Explicit, portable session import. Never invokes automatic session sync or changes accounts.
use super::*;

const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_HISTORY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct SessionBundle {
    archive: zip::ZipArchive<fs::File>,
    sessions: Vec<Value>,
    hash: String,
}

fn read_entry(
    archive: &mut zip::ZipArchive<fs::File>,
    name: &str,
    limit: u64,
) -> Result<String, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("导出包缺少 {name}"))?;
    if entry.size() > limit {
        return Err(format!("导出条目过大：{name}"));
    }
    let mut text = String::new();
    (&mut entry)
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|error| format!("读取 {name} 失败：{error}"))?;
    if text.len() as u64 > limit {
        return Err(format!("导出条目过大：{name}"));
    }
    Ok(text)
}

fn open_bundle(file_path: &Path) -> Result<SessionBundle, String> {
    let mut file =
        fs::File::open(file_path).map_err(|error| format!("打开会话导出包失败：{error}"))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_ARCHIVE_BYTES {
        return Err("导出包超过 1 GB，请分批导出后导入。".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let hash = format!("{:x}", digest.finalize());
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("不是有效的会话 ZIP：{error}"))?;
    if archive.len() > 30000 {
        return Err("导出包条目过多，请分批导入。".into());
    }
    let mut names = HashSet::new();
    let mut expanded = 0u64;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name();
        if entry.enclosed_name().is_none()
            || name.contains(['\\', ':'])
            || name.split('/').any(|part| part == ".." || part == ".")
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            || !names.insert(name.to_owned())
        {
            return Err("导出包包含不安全或重复的文件路径。".into());
        }
        expanded = expanded.saturating_add(entry.size());
        if entry.size() > MAX_HISTORY_BYTES || expanded > MAX_EXPANDED_BYTES {
            return Err("导出包解压内容过大，请分批导出后导入。".into());
        }
    }
    let manifest: Value = serde_json::from_str(&read_entry(
        &mut archive,
        "manifest.json",
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|_| "会话导出清单损坏。".to_string())?;
    if manifest["kind"] != "Gaoge-Codex-sessions-export"
        || !matches!(manifest["schemaVersion"].as_u64(), Some(1 | 2))
    {
        return Err("请选择本软件导出的会话 ZIP；当前不支持此文件格式或版本。".into());
    }
    let sessions = manifest["sessions"]
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= 5000)
        .ok_or("导出清单必须包含 1 至 5000 个会话。")?
        .clone();
    if manifest["sessionCount"].as_u64() != Some(sessions.len() as u64) {
        return Err("导出清单的会话数量不一致。".into());
    }
    let mut ids = HashSet::new();
    for session in &sessions {
        let id = session["id"].as_str().ok_or("导出清单缺少会话标识。")?;
        if !valid_codex_session_id(id) || id.contains("..") || !ids.insert(id.to_owned()) {
            return Err("导出清单包含无效或重复的会话标识。".into());
        }
    }
    Ok(SessionBundle {
        archive,
        sessions,
        hash,
    })
}

fn session_prefix(index: usize, metadata: &Value) -> String {
    format!(
        "sessions/{:04}-{}",
        index + 1,
        metadata["id"].as_str().unwrap_or_default()
    )
}

fn validate_history(raw: &str, expected_id: Option<&str>) -> Result<Value, String> {
    let mut header = None;
    for (index, line) in raw.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .map_err(|_| format!("原始记录第 {} 行损坏或不完整。", index + 1))?;
        if !value.is_object() || !value["type"].is_string() {
            return Err(format!("原始记录第 {} 行格式无效。", index + 1));
        }
        if header.is_none() {
            if value["type"] != "session_meta" || !value["payload"].is_object() {
                return Err("原始记录缺少 session_meta 头部。".into());
            }
            let id = value["payload"]["id"]
                .as_str()
                .ok_or("原始记录缺少会话标识。")?;
            if !valid_codex_session_id(id) || expected_id.is_some_and(|expected| expected != id) {
                return Err("原始记录与导出清单的会话标识不一致。".into());
            }
            header = Some(value);
        } else if value["type"] == "session_meta" {
            return Err("原始记录包含多个会话头部。".into());
        }
    }
    header.ok_or_else(|| "原始聊天记录为空。".to_string())
}

struct HistoryFile {
    name: String,
    raw: String,
    header: Value,
}
struct ImportHistory {
    files: Vec<HistoryFile>,
}

fn history_filename(metadata: &Value, header: &Value) -> String {
    let id = metadata["id"].as_str().unwrap_or_default();
    let time = parse_timestamp_millis(header.get("timestamp")).unwrap_or(0);
    format!("rollout-{}-{id}.jsonl", official_rollout_timestamp(time))
}

fn read_history(bundle: &mut SessionBundle, index: usize) -> Result<ImportHistory, String> {
    let metadata = &bundle.sessions[index];
    let prefix = session_prefix(index, metadata);
    let stored: Value = serde_json::from_str(&read_entry(
        &mut bundle.archive,
        &format!("{prefix}/metadata.json"),
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|_| "会话元数据损坏。".to_string())?;
    if stored["id"] != metadata["id"] {
        return Err("会话元数据与清单不一致。".into());
    }
    let raw = read_entry(
        &mut bundle.archive,
        &format!("{prefix}/conversation.jsonl"),
        MAX_HISTORY_BYTES,
    )?;
    let header = validate_history(&raw, metadata["id"].as_str())?;
    let name = stored["rolloutFileName"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| history_filename(metadata, &header));
    if !safe_history_filename(&name) {
        return Err("会话历史文件名无效。".into());
    }
    let mut files = vec![HistoryFile { name, raw, header }];
    if let Some(dependencies) = stored["historyFiles"].as_array() {
        if dependencies.len() > 128 {
            return Err("分支依赖过多，请拆分导入。".into());
        }
        for dependency in dependencies {
            let name = dependency
                .as_str()
                .filter(|name| safe_history_filename(name))
                .ok_or("分支历史文件名无效。")?
                .to_owned();
            if files.iter().any(|file| file.name == name) {
                return Err("分支历史文件重复。".into());
            }
            let raw = read_entry(
                &mut bundle.archive,
                &format!("{prefix}/history/{name}"),
                MAX_HISTORY_BYTES,
            )?;
            let header = validate_history(&raw, None)?;
            files.push(HistoryFile { name, raw, header });
            if files.iter().map(|file| file.raw.len() as u64).sum::<u64>() > MAX_HISTORY_BYTES {
                return Err("单个会话及其分支历史超过 256 MB，请分批整理后导出。".into());
            }
        }
    }
    validate_dependencies(&files)?;
    Ok(ImportHistory { files })
}

fn safe_history_filename(name: &str) -> bool {
    !name.contains(['/', '\\', ':'])
        && !name.contains("..")
        && name.starts_with("rollout-")
        && name.ends_with(".jsonl")
        && name.len() <= 180
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn physical_id(file: &HistoryFile) -> &str {
    official_rollout_ids(Path::new(&file.name))
        .map(|(_, id)| id)
        .unwrap_or_else(|| file.header["payload"]["id"].as_str().unwrap_or_default())
}

fn validate_dependencies(files: &[HistoryFile]) -> Result<(), String> {
    let mut physical_ids = HashSet::new();
    for file in files {
        if !physical_ids.insert(physical_id(file)) {
            return Err("导出包包含重复的历史文件标识。".into());
        }
        let mut current = file;
        let mut visited = HashSet::new();
        while let Some(base) = current
            .header
            .pointer("/payload/history_base")
            .filter(|base| !base.is_null())
        {
            let id = base["thread_id"].as_str().ok_or("历史分支缺少依赖标识。")?;
            if !visited.insert(id.to_owned()) {
                return Err("历史分支存在循环引用。".into());
            }
            let source = files
                .iter()
                .find(|source| physical_id(source) == id)
                .ok_or("导出包缺少分支依赖记录，请在原电脑使用新版软件重新导出。")?;
            let end = base["end_byte_offset"]
                .as_u64()
                .ok_or("历史分支缺少有效的记录位置。")?;
            if end > source.raw.len() as u64
                || (end > 0 && source.raw.as_bytes()[end as usize - 1] != b'\n')
            {
                return Err("历史分支引用的位置超出原始记录或不在完整记录边界。".into());
            }
            current = source;
        }
    }
    Ok(())
}

fn existing_ids(home: &Path) -> Result<HashSet<String>, String> {
    let target = CodexDirTarget {
        dir: home.to_path_buf(),
        source: "import",
        primary: true,
    };
    let metadata = read_managed_codex_native_metadata(&[target.clone()]);
    if !metadata.warnings.is_empty() {
        return Err(format!(
            "无法完整检查本机会话，暂不导入：{}",
            metadata.warnings.join("；")
        ));
    }
    let mut ids: HashSet<String> = metadata.index_entries.into_keys().collect();
    for file in codex_session_management_files(&[target]) {
        let header = read_rollout_session_meta(&file)
            .map_err(|error| format!("无法检查本机会话 {}：{error}", file.display()))?;
        if let Some(id) = header.pointer("/payload/id").and_then(Value::as_str) {
            ids.insert(id.to_owned());
        }
    }
    Ok(ids)
}

fn source_cwd(metadata: &Value, header: &Value) -> String {
    header
        .pointer("/payload/cwd")
        .and_then(Value::as_str)
        .filter(|cwd| !cwd.trim().is_empty())
        .or_else(|| metadata["cwd"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn preview_rows(bundle: &mut SessionBundle, home: &Path) -> Result<Vec<Value>, String> {
    let existing = existing_ids(home)?;
    let deleted = deleted_codex_session_ids();
    let mut rows = Vec::new();
    for index in 0..bundle.sessions.len() {
        let metadata = bundle.sessions[index].clone();
        let id = metadata["id"].as_str().unwrap_or_default();
        let (status, message, cwd) = if existing.contains(id) {
            (
                "duplicate",
                "本机已有此会话，将跳过并保留现有记录。".to_owned(),
                String::new(),
            )
        } else if deleted.contains(id) {
            (
                "deleted",
                "本机曾删除此会话，已跳过以保留删除状态。".to_owned(),
                String::new(),
            )
        } else if metadata["rawAvailable"].as_bool() == Some(false) {
            (
                "metadataOnly",
                "仅包含标题等索引信息，没有原始聊天记录。".to_owned(),
                String::new(),
            )
        } else {
            match read_history(bundle, index) {
                Ok(history) => (
                    "ready",
                    String::new(),
                    source_cwd(&metadata, &history.files[0].header),
                ),
                Err(error) => ("invalid", error, String::new()),
            }
        };
        let suggested = if cwd.is_empty() {
            home_dir().to_string_lossy().to_string()
        } else if Path::new(&cwd).is_absolute() && Path::new(&cwd).is_dir() {
            cwd.clone()
        } else {
            String::new()
        };
        rows.push(
            json!({ "id": id, "title": metadata["title"].as_str().unwrap_or("未命名会话"),
            "status": status, "message": message, "cwd": cwd, "suggestedProjectPath": suggested,
            "archived": metadata["archived"].as_bool().unwrap_or(false) }),
        );
    }
    Ok(rows)
}

pub(super) fn preview(request: Value) -> Result<Value, String> {
    if request["cancelled"].as_bool() == Some(true) {
        return Ok(json!({"cancelled": true}));
    }
    let file_path = request["filePath"].as_str().ok_or("请选择会话 ZIP。")?;
    let home = codex_plugin_market_home()?;
    let mut bundle = open_bundle(Path::new(file_path))?;
    let sessions = preview_rows(&mut bundle, &home)?;
    Ok(
        json!({ "cancelled": false, "filePath": file_path, "archiveHash": bundle.hash,
        "codexHome": home, "sessions": sessions, "codexRunning": !list_running_codex_app_dirs().is_empty() }),
    )
}

// Rewrite only structured working directories. Chat text, prompts and tool output are not replaced.
// Referenced byte boundaries are recalculated from complete records, keeping the history graph.
fn rewrite_history(
    history: &ImportHistory,
    cwd: &str,
    provider: &str,
) -> Result<Vec<String>, String> {
    fn rewrite(
        index: usize,
        files: &[HistoryFile],
        cwd: &str,
        provider: &str,
        output: &mut HashMap<usize, (String, BTreeMap<u64, u64>)>,
    ) -> Result<(), String> {
        if output.contains_key(&index) {
            return Ok(());
        }
        let file = &files[index];
        let base_offset = if let Some(base) = file
            .header
            .pointer("/payload/history_base")
            .filter(|value| !value.is_null())
        {
            let source = files
                .iter()
                .position(|source| Some(physical_id(source)) == base["thread_id"].as_str())
                .ok_or("缺少分支历史。")?;
            rewrite(source, files, cwd, provider, output)?;
            Some(
                *output[&source]
                    .1
                    .get(&base["end_byte_offset"].as_u64().ok_or("分支位置无效。")?)
                    .ok_or("分支记录边界无效。")?,
            )
        } else {
            None
        };
        let mut text = String::new();
        let mut offsets = BTreeMap::from([(0, 0)]);
        let mut old_offset = 0u64;
        for line in file.raw.split_inclusive('\n') {
            old_offset += line.len() as u64;
            if line.trim().is_empty() {
                text.push_str(line);
            } else {
                let mut value: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
                let original = value.clone();
                if matches!(
                    value["type"].as_str(),
                    Some("session_meta" | "turn_context")
                ) {
                    if let Some(payload) = value["payload"].as_object_mut() {
                        if payload.contains_key("cwd") || original["type"] == "session_meta" {
                            payload.insert("cwd".into(), json!(cwd));
                        }
                        if original["type"] == "session_meta" {
                            payload.insert("model_provider".into(), json!(provider));
                        }
                        for key in ["runtime_workspace_roots", "workspace_roots"] {
                            if payload.contains_key(key) {
                                payload.insert(key.into(), json!([cwd]));
                            }
                        }
                    }
                    if value["type"] == "session_meta" {
                        if let Some(offset) = base_offset {
                            value["payload"]["history_base"]["end_byte_offset"] = json!(offset);
                        }
                    }
                }
                // Current Codex resumes from the latest persisted thread settings,
                // which take precedence over session_meta and turn_context.
                if value["type"] == "event_msg"
                    && value["payload"]["type"] == "thread_settings_applied"
                {
                    if let Some(settings) = value["payload"]["thread_settings"].as_object_mut() {
                        settings.insert("cwd".into(), json!(cwd));
                        settings.insert("runtime_workspace_roots".into(), json!([cwd]));
                        settings.insert("model_provider_id".into(), json!(provider));
                    }
                }
                if value == original {
                    text.push_str(line);
                } else {
                    text.push_str(&serde_json::to_string(&value).map_err(|e| e.to_string())?);
                    if line.ends_with('\n') {
                        text.push('\n');
                    }
                }
            }
            offsets.insert(old_offset, text.len() as u64);
        }
        output.insert(index, (text, offsets));
        Ok(())
    }
    let mut output = HashMap::new();
    for index in 0..history.files.len() {
        rewrite(index, &history.files, cwd, provider, &mut output)?;
    }
    Ok((0..history.files.len())
        .map(|index| output.remove(&index).unwrap().0)
        .collect())
}

// A transferred branch must stand on its own: native pagination does not rebuild
// missing ancestors' projection databases on another computer. Resolve only the
// selected branch's immutable prefixes into the NEW imported file. Original files
// and export ZIP bytes are never changed; discarded turns remain excluded.
fn portable_current_branch(
    history: &ImportHistory,
    cwd: &str,
    provider: &str,
) -> Result<String, String> {
    let rewritten = rewrite_history(history, cwd, provider)?;
    let mut header = validate_history(&rewritten[0], None)?;
    if history.files.len() == 1 {
        return Ok(rewritten[0].clone());
    }
    fn append_prefix(
        index: usize,
        end: usize,
        history: &ImportHistory,
        rewritten: &[String],
        output: &mut String,
    ) -> Result<(), String> {
        let meta = validate_history(&rewritten[index], None)?;
        if let Some(base) = meta
            .pointer("/payload/history_base")
            .filter(|base| !base.is_null())
        {
            let source = history
                .files
                .iter()
                .position(|file| Some(physical_id(file)) == base["thread_id"].as_str())
                .ok_or("缺少分支源记录。")?;
            append_prefix(
                source,
                base["end_byte_offset"].as_u64().ok_or("分支位置无效。")? as usize,
                history,
                rewritten,
                output,
            )?;
        }
        let prefix = rewritten[index]
            .get(..end)
            .ok_or("分支位置超出完整记录。")?;
        for line in prefix.split_inclusive('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
            if value["type"] == "session_meta" {
                continue;
            }
            output.push_str(line);
            if !line.ends_with('\n') {
                output.push('\n');
            }
        }
        Ok(())
    }
    let payload = header["payload"].as_object_mut().ok_or("会话头部无效。")?;
    payload.remove("history_base");
    payload.remove("forked_from_ordinal_exclusive");
    if header.get("ordinal").is_some() {
        header["ordinal"] = json!(0);
    }
    let mut output = format!("{header}\n");
    append_prefix(0, rewritten[0].len(), history, &rewritten, &mut output)?;
    validate_history(&output, history.files[0].header["payload"]["id"].as_str())?;
    Ok(output)
}

fn import_database() -> Result<Option<Connection>, String> {
    let config = read_text_if_exists(&codex_config_path())?;
    let configured = codex_sqlite_home_from_config(&config).or_else(codex_sqlite_home_from_env);
    let paths = configured
        .map(|dir| vec![dir.join("state_5.sqlite")])
        .unwrap_or_else(codex_state_sqlite_paths);
    let Some(path) = paths.iter().find(|path| path.is_file()) else {
        return Ok(None);
    };
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| format!("打开本机会话数据库失败：{e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    if !sqlite_table_exists_checked(&conn, "threads")? {
        return Err("本机会话数据库尚未初始化，请先启动并退出 Codex 后再导入。".into());
    }
    Ok(Some(conn))
}

fn insert_thread(
    conn: &Connection,
    summary: &RolloutSummary,
    header: &Value,
) -> Result<(), String> {
    let available: HashSet<String> = sqlite_columns_checked(conn, "threads")?
        .into_iter()
        .collect();
    if !["id", "rollout_path", "cwd", "title"]
        .iter()
        .all(|column| available.contains(*column))
    {
        return Err("本机 Codex 数据库版本不受支持，请更新 Codex 后重试。".into());
    }
    let seconds = summary.timestamp_ms / 1000;
    let created_ms =
        parse_timestamp_millis(header.get("timestamp")).unwrap_or(summary.timestamp_ms);
    let mut fields: Vec<(&str, SqlValue)> = vec![
        ("id", summary.id.clone().into()),
        (
            "rollout_path",
            summary.path.to_string_lossy().to_string().into(),
        ),
        ("cwd", summary.cwd.clone().into()),
        ("title", summary.title.clone().into()),
        ("created_at", (created_ms / 1000).into()),
        ("updated_at", seconds.into()),
        ("created_at_ms", created_ms.into()),
        ("updated_at_ms", summary.timestamp_ms.into()),
        ("recency_at", seconds.into()),
        ("recency_at_ms", summary.timestamp_ms.into()),
        ("source", summary.source.clone().into()),
        ("model_provider", summary.provider.clone().into()),
        ("sandbox_policy", "\"read-only\"".to_string().into()),
        ("approval_mode", "untrusted".to_string().into()),
        ("tokens_used", 0i64.into()),
        ("has_user_event", i64::from(summary.has_user_event).into()),
        ("archived", i64::from(summary.archived).into()),
        (
            "archived_at",
            if summary.archived {
                seconds.into()
            } else {
                SqlValue::Null
            },
        ),
        ("cli_version", summary.cli_version.clone().into()),
        ("first_user_message", summary.title.clone().into()),
        ("memory_mode", "disabled".to_string().into()),
        ("preview", summary.title.clone().into()),
        (
            "thread_source",
            summary.sqlite_thread_source().to_string().into(),
        ),
        (
            "model",
            summary
                .model
                .clone()
                .map(SqlValue::Text)
                .unwrap_or(SqlValue::Null),
        ),
        (
            "reasoning_effort",
            summary
                .reasoning_effort
                .clone()
                .map(SqlValue::Text)
                .unwrap_or(SqlValue::Null),
        ),
    ];
    for key in ["history_mode", "session_id"] {
        if let Some(value) = header["payload"][key].as_str() {
            fields.push((key, value.to_string().into()));
        }
    }
    fields.retain(|(key, _)| available.contains(*key));
    let names = fields
        .iter()
        .map(|(key, _)| format!("\"{key}\""))
        .collect::<Vec<_>>()
        .join(",");
    let placeholders = (1..=fields.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    conn.execute(
        &format!("INSERT INTO threads ({names}) VALUES ({placeholders})"),
        params_from_iter(fields.into_iter().map(|(_, value)| value)),
    )
    .map_err(|e| format!("写入会话数据库失败，已取消此会话导入：{e}"))?;
    Ok(())
}

fn publish_session(
    home: &Path,
    metadata: &Value,
    history: &ImportHistory,
    cwd: &str,
    provider: &str,
) -> Result<(), String> {
    let rewritten = vec![portable_current_branch(history, cwd, provider)?];
    let imported_header = validate_history(&rewritten[0], None)?;
    let stage = tempfile::Builder::new()
        .prefix(".gaoge-session-import-")
        .tempdir_in(home)
        .map_err(|e| e.to_string())?;
    let archived = metadata["archived"].as_bool().unwrap_or(false);
    let timestamp = metadata["updatedAtMs"]
        .as_i64()
        .or_else(|| parse_timestamp_millis(metadata.get("updatedAt")))
        .unwrap_or(0);
    let date = Utc
        .timestamp_millis_opt(timestamp)
        .single()
        .unwrap_or_else(Utc::now);
    let mut paths = Vec::new();
    for (index, file) in history.files.iter().take(1).enumerate() {
        let directory = if index == 0 && archived {
            home.join("archived_sessions")
        } else {
            home.join("sessions")
                .join(date.format("%Y/%m/%d").to_string())
        };
        paths.push(directory.join(&file.name));
        fs::write(stage.path().join(&file.name), &rewritten[index]).map_err(|e| e.to_string())?;
    }
    let mut summary = scan_rollout_file(&stage.path().join(&history.files[0].name))?;
    summary.path = paths[0].clone();
    summary.cwd = cwd.into();
    summary.provider = provider.into();
    summary.archived = archived;
    summary.timestamp_ms = timestamp;
    summary.title = metadata["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&summary.title)
        .to_owned();
    let index_path = home.join("session_index.jsonl");
    let old_index = if index_path.exists() {
        Some(fs::read_to_string(&index_path).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let index_guard = if old_index.is_some() {
        Some(file_write_guard(&index_path)?)
    } else {
        None
    };
    let mut next_index = old_index.clone().unwrap_or_default();
    if !next_index.is_empty() && !next_index.ends_with('\n') {
        next_index.push('\n');
    }
    next_index.push_str(&write_session_index_jsonl(&[rollout_index_entry(
        &summary,
    )])?);
    let mut database = import_database()?;
    let transaction = database
        .as_mut()
        .map(Connection::transaction)
        .transpose()
        .map_err(|e| e.to_string())?;
    if let Some(tx) = &transaction {
        insert_thread(tx, &summary, &imported_header)?;
    }
    let mut created = Vec::new();
    let mut index_written = false;
    let result = (|| -> Result<(), String> {
        for (index, target) in paths.iter().enumerate() {
            // Shared branch sources are reusable only when their complete content agrees.
            if target.exists() {
                if index > 0
                    && fs::read(target).map_err(|e| e.to_string())? == rewritten[index].as_bytes()
                {
                    continue;
                }
                return Err(format!(
                    "本地已有同名历史文件，未覆盖：{}",
                    target.display()
                ));
            }
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut temp = tempfile::NamedTempFile::new_in(target.parent().unwrap())
                .map_err(|e| e.to_string())?;
            temp.write_all(rewritten[index].as_bytes())
                .and_then(|_| temp.as_file().sync_all())
                .map_err(|e| e.to_string())?;
            temp.persist_noclobber(target)
                .map_err(|e| format!("保存会话失败：{e}"))?;
            created.push(target.clone());
        }
        if let Some(guard) = &index_guard {
            if !write_text_if_unchanged(&index_path, &next_index, guard)? {
                return Err("本机会话索引发生变化，请退出 Codex 后重新导入。".into());
            }
        } else {
            let mut temp = tempfile::NamedTempFile::new_in(home).map_err(|e| e.to_string())?;
            temp.write_all(next_index.as_bytes())
                .and_then(|_| temp.as_file().sync_all())
                .map_err(|e| e.to_string())?;
            temp.persist_noclobber(&index_path)
                .map_err(|e| format!("创建会话索引失败：{e}"))?;
        }
        index_written = true;
        if let Some(tx) = transaction {
            tx.commit().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        if index_written {
            let rollback = (|| -> Result<(), String> {
                let guard = file_write_guard(&index_path)?;
                if fs::read_to_string(&index_path).map_err(|e| e.to_string())? != next_index {
                    return Err("会话索引被其他进程修改，请重新扫描确认。".into());
                }
                if let Some(old) = old_index {
                    if !write_text_if_unchanged(&index_path, &old, &guard)? {
                        return Err("回滚索引时发生并发修改。".into());
                    }
                } else {
                    fs::remove_file(&index_path).map_err(|e| e.to_string())?;
                }
                Ok(())
            })();
            if let Err(e) = rollback {
                rollback_errors.push(e);
            }
        }
        for file in created {
            if let Err(e) = fs::remove_file(&file) {
                rollback_errors.push(e.to_string());
            }
        }
        return Err(if rollback_errors.is_empty() {
            error
        } else {
            format!("{error}；回滚提示：{}", rollback_errors.join("；"))
        });
    }
    Ok(())
}

pub(super) fn import(request: Value) -> Result<Value, String> {
    if !probe_running_codex_app_dirs()?.is_empty() {
        return Err("请先退出 Codex，再点击开始导入，避免运行中的会话索引覆盖导入结果。".into());
    }
    let home = codex_plugin_market_home()?;
    let _delete_guard = CODEX_SESSION_DELETE_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _sync_guard = CODEX_SESSION_SYNC_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    with_codex_dir(&home, || {
        let _lock = acquire_codex_lock("session-sync")?;
        import_into(request, &home)
    })
}

fn import_into(request: Value, home: &Path) -> Result<Value, String> {
    let file_path = request["filePath"].as_str().ok_or("请选择会话 ZIP。")?;
    let mut bundle = open_bundle(Path::new(file_path))?;
    if request["archiveHash"].as_str() != Some(bundle.hash.as_str()) {
        return Err("导出包已改变，请重新选择文件并预览。".into());
    }
    let ids = requested_codex_session_ids(&request, 5000)?;
    if ids.is_empty() {
        return Err("请选择要导入的完整会话。".into());
    }
    if ids.iter().any(|id| {
        !bundle
            .sessions
            .iter()
            .any(|row| row["id"].as_str() == Some(id))
    }) {
        return Err("选择的会话不在导出包中。".into());
    }
    let rows = preview_rows(&mut bundle, home)?;
    let mappings = request["projectMappings"].as_object();
    let config = with_codex_dir(home, || read_text_if_exists(&codex_config_path()))?;
    let provider = codex_configured_session_provider(&config)?;
    let mut imported = Vec::new();
    let mut skipped = Vec::new();
    let mut failures = Vec::new();
    fs::create_dir_all(home).map_err(|e| e.to_string())?;
    for (index, row) in rows.iter().enumerate() {
        let id = row["id"].as_str().unwrap_or_default();
        if !ids.iter().any(|selected| selected == id) {
            continue;
        }
        if row["status"] != "ready" {
            skipped
                .push(json!({"sessionId": id, "message": row["message"], "reason": row["status"]}));
            continue;
        }
        let cwd = row["cwd"].as_str().unwrap_or_default();
        let target = mappings
            .and_then(|map| map.get(cwd))
            .and_then(Value::as_str)
            .unwrap_or_else(|| row["suggestedProjectPath"].as_str().unwrap_or_default());
        let result = (|| -> Result<(), String> {
            if target.is_empty() || !Path::new(target).is_absolute() || !Path::new(target).is_dir()
            {
                return Err("原项目目录不存在，请选择本机项目文件夹后重试。".into());
            }
            let history = read_history(&mut bundle, index)?;
            with_codex_dir(home, || {
                publish_session(home, &bundle.sessions[index], &history, target, &provider)
            })
        })();
        match result {
            Ok(()) => imported.push(id.to_owned()),
            Err(message) => failures.push(json!({"sessionId": id, "message": message})),
        }
    }
    Ok(
        json!({"importedCount": imported.len(), "skippedCount": skipped.len(), "failedCount": failures.len(),
        "importedSessionIds": imported, "skipped": skipped, "failures": failures,
        "restartRequired": true, "codexHome": home}),
    )
}

/// Include physical history dependencies so edits/forks can be resumed on another computer.
pub(super) fn export_history(
    record: &ManagedCodexSessionRecord,
    raw: &str,
) -> Result<(Value, Vec<(String, String)>), String> {
    let mut metadata = managed_codex_session_json(record);
    if !record.raw_available {
        return Ok((metadata, Vec::new()));
    }
    let header = validate_history(raw, Some(&record.summary.id))?;
    let name = record
        .summary
        .path
        .file_name()
        .and_then(OsStr::to_str)
        .filter(|name| safe_history_filename(name))
        .map(str::to_owned)
        .unwrap_or_else(|| history_filename(&metadata, &header));
    metadata["rolloutFileName"] = json!(name);
    let mut files = vec![HistoryFile {
        name,
        raw: raw.to_owned(),
        header,
    }];
    let candidates = if files[0]
        .header
        .pointer("/payload/history_base")
        .is_some_and(|base| !base.is_null())
    {
        codex_session_management_files(&codex_route_targets())
    } else {
        Vec::new()
    };
    let mut index = 0;
    while index < files.len() {
        if let Some(base) = files[index]
            .header
            .pointer("/payload/history_base")
            .filter(|base| !base.is_null())
        {
            let id = base["thread_id"]
                .as_str()
                .ok_or("分支历史缺少引用标识，无法完整导出。")?
                .to_owned();
            if !files.iter().any(|file| physical_id(file) == id) {
                let matching = candidates
                    .iter()
                    .filter(|path| {
                        official_rollout_ids(path).is_some_and(|(_, physical)| physical == id)
                    })
                    .collect::<Vec<_>>();
                let source = matching.first().ok_or_else(|| {
                    format!(
                        "会话 {} 缺少分支历史 {id}，无法完整导出。",
                        record.summary.id
                    )
                })?;
                let source_size = fs::metadata(source).map_err(|e| e.to_string())?.len();
                if source_size > MAX_HISTORY_BYTES {
                    return Err("分支历史过大，请分批整理后导出。".into());
                }
                let source_raw = fs::read_to_string(source).map_err(|e| e.to_string())?;
                for alternative in matching.iter().skip(1) {
                    if fs::read(alternative).map_err(|e| e.to_string())? != source_raw.as_bytes() {
                        return Err(format!(
                            "分支历史 {id} 存在不同副本，请确认原电脑的会话历史后重试。"
                        ));
                    }
                }
                let source_header = validate_history(&source_raw, None)?;
                files.push(HistoryFile {
                    name: source.file_name().unwrap().to_string_lossy().to_string(),
                    raw: source_raw,
                    header: source_header,
                });
            }
        }
        if files.len() > 129
            || files.iter().map(|file| file.raw.len() as u64).sum::<u64>() > MAX_HISTORY_BYTES
        {
            return Err("单个会话及其分支历史超过导入限制，请分批整理后导出。".into());
        }
        index += 1;
    }
    validate_dependencies(&files)?;
    metadata["historyFiles"] = json!(files
        .iter()
        .skip(1)
        .map(|file| &file.name)
        .collect::<Vec<_>>());
    Ok((
        metadata,
        files
            .into_iter()
            .skip(1)
            .map(|file| (file.name, file.raw))
            .collect(),
    ))
}

pub(super) fn select_export_head(record: &mut ManagedCodexSessionRecord) -> Result<(), String> {
    if !record.raw_available || !codex_history_safety::protects(&record.summary.path)? {
        return Ok(());
    }
    for target in codex_route_targets() {
        if !record.summary.path.starts_with(&target.dir) {
            continue;
        }
        for database in with_codex_dir(&target.dir, codex_state_sqlite_paths)
            .into_iter()
            .filter(|path| path.is_file())
        {
            let conn =
                Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(|e| e.to_string())?;
            if !sqlite_table_exists_checked(&conn, "threads")? {
                continue;
            }
            let head: Option<String> = conn
                .query_row(
                    "SELECT rollout_path FROM threads WHERE id = ?1",
                    params![record.summary.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(head) = head {
                let head = PathBuf::from(head);
                let roots = [
                    target.dir.join("sessions"),
                    target.dir.join("archived_sessions"),
                ];
                if !safe_codex_rollout_path(&head, &roots) || !head.is_file() {
                    return Err("原生会话入口不可读取，无法完整导出。".into());
                }
                let summary = scan_rollout_file(&head)?;
                if summary.id != record.summary.id {
                    return Err("原生会话入口与会话标识不一致。".into());
                }
                record.summary.path = head;
                return Ok(());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIRST: &str = "01980e4f-4a31-7000-8000-000000000221";
    const SECOND: &str = "01980e4f-4a31-7000-8000-000000000222";

    fn isolated(label: &str, task: impl FnOnce(&Path)) {
        crate::tests::with_temp_user_home(label, |root| {
            let previous = std::env::var_os("CODEX_SQLITE_HOME");
            std::env::remove_var("CODEX_SQLITE_HOME");
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task(root)));
            if let Some(value) = previous {
                std::env::set_var("CODEX_SQLITE_HOME", value);
            } else {
                std::env::remove_var("CODEX_SQLITE_HOME");
            }
            if let Err(error) = result {
                std::panic::resume_unwind(error);
            }
        });
    }

    fn raw(id: &str, cwd: &str) -> String {
        [
            json!({"timestamp":"2026-11-01T01:00:00.000Z","type":"session_meta","payload":{
                "id":id,"timestamp":"2026-11-01T01:00:00.000Z","cwd":cwd,"model_provider":"old-provider","source":"cli","cli_version":"1.0"}}),
            json!({"timestamp":"2026-11-01T01:00:01.000Z","type":"turn_context","payload":{"cwd":cwd}}),
            json!({"timestamp":"2026-11-01T01:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("Keep literal path {cwd} in the conversation")}]}}),
            json!({"timestamp":"2026-11-01T01:00:03.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Portable answer"}]}}),
        ].iter().map(|v| format!("{v}\n")).collect()
    }

    fn metadata(id: &str, available: bool) -> Value {
        json!({"id":id,"title":"自定义会话标题","cwd":"/old-machine/project","rawAvailable":available,
            "updatedAtMs":1793494803000i64,"archived":true})
    }

    fn bundle(path: &Path, sessions: &[(Value, Option<String>)], extra: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", opts).unwrap();
        zip.write_all(json!({"schemaVersion":1,"kind":"Gaoge-Codex-sessions-export","sessionCount":sessions.len(),
            "sessions":sessions.iter().map(|(meta,_)|meta).collect::<Vec<_>>()}).to_string().as_bytes()).unwrap();
        for (index, (meta, raw)) in sessions.iter().enumerate() {
            let prefix = session_prefix(index, meta);
            zip.start_file(format!("{prefix}/metadata.json"), opts)
                .unwrap();
            zip.write_all(meta.to_string().as_bytes()).unwrap();
            if let Some(raw) = raw {
                zip.start_file(format!("{prefix}/conversation.jsonl"), opts)
                    .unwrap();
                zip.write_all(raw.as_bytes()).unwrap();
            }
        }
        for (name, contents) in extra {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(contents.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    fn request(path: &Path, ids: &[&str], cwd: &Path) -> Value {
        json!({"filePath":path,"archiveHash":open_bundle(path).unwrap().hash,"sessionIds":ids,
            "projectMappings":{"/old-machine/project":cwd.to_string_lossy()}})
    }

    fn database(home: &Path) -> PathBuf {
        fs::create_dir_all(home).unwrap();
        let path = home.join("state_5.sqlite");
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE threads (
            id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL,
            updated_at INTEGER NOT NULL, updated_at_ms INTEGER, created_at INTEGER, model_provider TEXT,
            archived INTEGER NOT NULL, source TEXT, thread_source TEXT, history_mode TEXT);").unwrap();
        path
    }

    #[test]
    fn session_transfer_imports_legacy_zip_restores_index_database_and_project_without_sync() {
        isolated("session-transfer-legacy", |root| {
            let archive = root.join("legacy.zip");
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/old-machine/project")),
                )],
                &[],
            );
            let target = root.join("other-computer/.codex");
            let project = root.join("new-project");
            fs::create_dir_all(&project).unwrap();
            let db = database(&target);
            fs::write(
                target.join("config.toml"),
                "model_provider = \"local-api\"\n",
            )
            .unwrap();
            let response = with_codex_dir(&target, || {
                import_into(request(&archive, &[FIRST], &project), &target)
            })
            .unwrap();
            assert_eq!(response["importedCount"], 1);
            assert_eq!(response["failedCount"], 0);
            let conn = Connection::open(db).unwrap();
            let (file, title, cwd, provider, archived): (String,String,String,String,i64) = conn.query_row(
                "SELECT rollout_path,title,cwd,model_provider,archived FROM threads WHERE id=?1", params![FIRST],
                |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
            assert_eq!(title, "自定义会话标题");
            assert_eq!(cwd, project.to_string_lossy());
            assert_eq!(provider, "local-api");
            assert_eq!(archived, 1);
            assert!(Path::new(&file).starts_with(target.join("archived_sessions")));
            let content = fs::read_to_string(file).unwrap();
            assert!(content.contains("Keep literal path /old-machine/project in the conversation"));
            assert!(content.contains("Portable answer"));
            let header = validate_history(&content, Some(FIRST)).unwrap();
            assert_eq!(header["payload"]["cwd"], cwd);
            assert_eq!(header["payload"]["model_provider"], provider);
            let context: Value = serde_json::from_str(content.lines().nth(1).unwrap()).unwrap();
            assert_eq!(context["payload"]["cwd"], cwd);
            let index = read_session_index(&target.join("session_index.jsonl"));
            assert_eq!(index.rows[FIRST]["thread_name"], "自定义会话标题");
            assert!(!target.join("auth.json").exists());
        });
    }

    #[test]
    fn session_transfer_duplicate_import_never_overwrites_existing_history() {
        isolated("session-transfer-duplicate", |root| {
            let archive = root.join("sessions.zip");
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/old-machine/project")),
                )],
                &[],
            );
            let home = root.join("target");
            let request = request(&archive, &[FIRST], root);
            let first = with_codex_dir(&home, || import_into(request.clone(), &home)).unwrap();
            assert_eq!(first["importedCount"], 1);
            let index_before = fs::read(home.join("session_index.jsonl")).unwrap();
            let target = CodexDirTarget {
                dir: home.clone(),
                source: "test",
                primary: true,
            };
            let file = codex_session_management_files(&[target]).remove(0);
            let bytes_before = fs::read(&file).unwrap();
            let second = with_codex_dir(&home, || import_into(request, &home)).unwrap();
            assert_eq!(second["importedCount"], 0);
            assert_eq!(second["skippedCount"], 1);
            assert_eq!(fs::read(file).unwrap(), bytes_before);
            assert_eq!(
                fs::read(home.join("session_index.jsonl")).unwrap(),
                index_before
            );
        });
    }

    #[test]
    fn session_transfer_preview_reports_metadata_only_corrupt_mismatched_and_missing_history() {
        isolated("session-transfer-invalid", |root| {
            let archive = root.join("mixed.zip");
            bundle(
                &archive,
                &[
                    (metadata(FIRST, false), None),
                    (
                        metadata(SECOND, true),
                        Some(raw(FIRST, "/old-machine/project")),
                    ),
                    (metadata("metadata-missing", true), None),
                    (metadata("history-corrupt", true), Some("{broken".into())),
                ],
                &[],
            );
            let mut zip = open_bundle(&archive).unwrap();
            let rows = preview_rows(&mut zip, &root.join("new-home")).unwrap();
            assert_eq!(rows[0]["status"], "metadataOnly");
            assert!(rows[1..].iter().all(|row| row["status"] == "invalid"));
            assert!(!root.join("new-home").exists());
        });
    }

    #[test]
    fn session_transfer_rejects_path_traversal_and_changed_archive() {
        isolated("session-transfer-unsafe", |root| {
            let archive = root.join("unsafe.zip");
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/old-machine/project")),
                )],
                &[("../outside.txt", "bad")],
            );
            assert!(open_bundle(&archive).is_err());
            assert!(!root.join("outside.txt").exists());
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/old-machine/project")),
                )],
                &[],
            );
            let req = request(&archive, &[FIRST], root);
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/different-project")),
                )],
                &[],
            );
            assert!(import_into(req, &root.join("destination"))
                .unwrap_err()
                .contains("已改变"));
            assert!(!root.join("destination").exists());
        });
    }

    #[test]
    fn session_transfer_missing_project_fails_without_creating_history() {
        isolated("session-transfer-mapping", |root| {
            let archive = root.join("sessions.zip");
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/old-machine/project")),
                )],
                &[],
            );
            let home = root.join("destination");
            let outcome = with_codex_dir(&home, || {
                import_into(request(&archive, &[FIRST], &root.join("missing")), &home)
            })
            .unwrap();
            assert_eq!(outcome["failedCount"], 1);
            assert_eq!(outcome["importedCount"], 0);
            assert!(!home.join("sessions").exists());
            assert!(!home.join("session_index.jsonl").exists());
        });
    }

    #[test]
    fn session_transfer_branch_export_and_import_resolves_native_prefixes_after_path_mapping() {
        isolated("session-transfer-branch", |root| {
            let home = root.join(".codex");
            let sessions = home.join("sessions/2026/11/01");
            fs::create_dir_all(&sessions).unwrap();
            let source_name = format!("rollout-2026-11-01T01-00-00-{FIRST}.jsonl");
            let source = raw(FIRST, "/old-machine/project");
            fs::write(sessions.join(&source_name), &source).unwrap();
            let mut head: Vec<Value> = raw(SECOND, "/old-machine/project")
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            head[0]["ordinal"] = json!(4);
            head[0]["payload"]["history_mode"] = json!("paginated");
            head[0]["payload"]["history_base"] =
                json!({"thread_id":FIRST,"end_byte_offset":source.len(),"last_ordinal":3});
            let head_name = format!("rollout-2026-11-01T02-00-00-{SECOND}.jsonl");
            fs::write(
                sessions.join(&head_name),
                head.iter()
                    .map(|value| format!("{value}\n"))
                    .collect::<String>(),
            )
            .unwrap();
            let archive = root.join("branch.zip");
            gaoge_export_codex_sessions_inner(json!({"filePath":archive,"sessionIds":[SECOND]}))
                .unwrap();
            let mut portable = open_bundle(&archive).unwrap();
            let history = read_history(&mut portable, 0).unwrap();
            assert_eq!(history.files.len(), 2);
            let target = root.join("other-computer");
            let project = root.join("much-longer-新项目-path");
            fs::create_dir_all(&project).unwrap();
            let result = with_codex_dir(&target, || {
                import_into(request(&archive, &[SECOND], &project), &target)
            })
            .unwrap();
            assert_eq!(result["importedCount"], 1, "{result}");
            let files = codex_session_management_files(&[CodexDirTarget {
                dir: target,
                source: "test",
                primary: true,
            }]);
            assert_eq!(
                files.len(),
                1,
                "Transferred history must not depend on source-machine projection caches"
            );
            let head_file = files
                .iter()
                .find(|file| file.file_name().unwrap() == head_name.as_str())
                .unwrap();
            let new_head = read_rollout_session_meta(head_file).unwrap();
            assert!(new_head["payload"]["history_base"].is_null());
            let imported = fs::read_to_string(head_file).unwrap();
            assert_eq!(imported.matches("Portable answer").count(), 2);
            assert!(imported.contains("Keep literal path /old-machine/project in the conversation"));
            assert_eq!(
                fs::read_to_string(sessions.join(source_name)).unwrap(),
                source
            );
        });
    }

    #[test]
    fn session_transfer_rejects_missing_and_cyclic_branch_dependencies() {
        isolated("session-transfer-cutoffs", |root| {
            let mut values: Vec<Value> = raw(FIRST, "/old-machine/project")
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            values[0]["payload"]["history_base"] =
                json!({"thread_id":SECOND,"end_byte_offset":100});
            let text = values
                .iter()
                .map(|value| format!("{value}\n"))
                .collect::<String>();
            let archive = root.join("incomplete.zip");
            bundle(&archive, &[(metadata(FIRST, true), Some(text))], &[]);
            let mut zip = open_bundle(&archive).unwrap();
            assert!(read_history(&mut zip, 0)
                .err()
                .unwrap()
                .contains("缺少分支"));
            let mut first = HistoryFile {
                name: format!("rollout-2026-11-01T01-00-00-{FIRST}.jsonl"),
                raw: raw(FIRST, "/old-machine/project"),
                header: values[0].clone(),
            };
            first.header["payload"]["history_base"]["thread_id"] = json!(FIRST);
            first.header["payload"]["history_base"]["end_byte_offset"] = json!(0);
            assert!(validate_dependencies(&[first])
                .unwrap_err()
                .contains("循环"));
        });
    }

    #[test]
    fn session_transfer_native_thread_settings_follow_target_directory_and_provider() {
        let mut values: Vec<Value> = raw(FIRST, "/old-machine/project")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        values[0]["payload"]["runtime_workspace_roots"] = json!(["/old-machine/project"]);
        values[1]["payload"]["workspace_roots"] = json!(["/old-machine/project"]);
        values.push(json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":FIRST,
            "thread_settings":{"cwd":"/old-machine/project","model_provider_id":"old-provider","runtime_workspace_roots":["/old-machine/project"]}}}));
        let text = values
            .iter()
            .map(|value| format!("{value}\n"))
            .collect::<String>();
        let history = ImportHistory {
            files: vec![HistoryFile {
                name: format!("rollout-2026-11-01T01-00-00-{FIRST}.jsonl"),
                header: values[0].clone(),
                raw: text,
            }],
        };
        let transferred =
            portable_current_branch(&history, "/new/project", "target-provider").unwrap();
        let records: Vec<Value> = transferred
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            records[0]["payload"]["runtime_workspace_roots"],
            json!(["/new/project"])
        );
        assert_eq!(
            records[1]["payload"]["workspace_roots"],
            json!(["/new/project"])
        );
        let settings = &records.last().unwrap()["payload"]["thread_settings"];
        assert_eq!(settings["cwd"], "/new/project");
        assert_eq!(settings["model_provider_id"], "target-provider");
        assert_eq!(settings["runtime_workspace_roots"], json!(["/new/project"]));
        assert!(transferred.contains("Keep literal path /old-machine/project in the conversation"));
    }

    #[test]
    fn session_transfer_commit_failure_rolls_back_published_file_and_index() {
        isolated("session-transfer-commit-failure", |root| {
            let home = root.join("destination");
            fs::create_dir_all(&home).unwrap();
            let db = home.join("state_5.sqlite");
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE permitted_ids (id TEXT PRIMARY KEY);
                CREATE TABLE threads (id TEXT PRIMARY KEY REFERENCES permitted_ids(id) DEFERRABLE INITIALLY DEFERRED,
                rollout_path TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL, updated_at INTEGER, archived INTEGER);").unwrap();
            fs::write(home.join("session_index.jsonl"),format!("{}\n",json!({"id":SECOND,"thread_name":"existing","updated_at":"2026-11-01T01:00:00Z"}))).unwrap();
            let before = fs::read(home.join("session_index.jsonl")).unwrap();
            let archive = root.join("sessions.zip");
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/old-machine/project")),
                )],
                &[],
            );
            let outcome = with_codex_dir(&home, || {
                import_into(request(&archive, &[FIRST], root), &home)
            })
            .unwrap();
            assert_eq!(outcome["failedCount"], 1);
            assert_eq!(outcome["importedCount"], 0);
            assert_eq!(fs::read(home.join("session_index.jsonl")).unwrap(), before);
            assert!(codex_session_management_files(&[CodexDirTarget {
                dir: home,
                source: "test",
                primary: true
            }])
            .is_empty());
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        });
    }

    #[test]
    fn session_transfer_sqlite_failure_preserves_existing_index_and_rolls_back() {
        isolated("session-transfer-rollback", |root| {
            let home = root.join("destination");
            let db = database(&home);
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TRIGGER reject_import BEFORE INSERT ON threads BEGIN SELECT RAISE(ABORT,'simulated database failure'); END;").unwrap();
            fs::write(home.join("session_index.jsonl"),format!("{}\n",json!({"id":SECOND,"thread_name":"existing","updated_at":"2026-11-01T01:00:00Z"}))).unwrap();
            let before = fs::read(home.join("session_index.jsonl")).unwrap();
            let archive = root.join("sessions.zip");
            bundle(
                &archive,
                &[(
                    metadata(FIRST, true),
                    Some(raw(FIRST, "/old-machine/project")),
                )],
                &[],
            );
            let outcome = with_codex_dir(&home, || {
                import_into(request(&archive, &[FIRST], root), &home)
            })
            .unwrap();
            assert_eq!(outcome["failedCount"], 1);
            assert_eq!(outcome["importedCount"], 0);
            assert_eq!(fs::read(home.join("session_index.jsonl")).unwrap(), before);
            assert!(!home.join("archived_sessions").exists());
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM threads", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        });
    }
}

#[cfg(test)]
mod native_verification {
    use super::*;
    #[test]
    #[ignore = "requires a marked isolated native Codex fixture"]
    fn session_transfer_native_fixture() {
        let fixture = PathBuf::from(
            std::env::var_os("GAOGE_SESSION_TRANSFER_FIXTURE").expect("fixture required"),
        )
        .canonicalize()
        .unwrap();
        let allowed = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/session-transfer-verification")
            .canonicalize()
            .unwrap();
        assert!(fixture.starts_with(&allowed) && fixture != allowed);
        assert_eq!(
            fs::read_to_string(fixture.join("synthetic-only")).unwrap(),
            "session-transfer-test"
        );
        crate::tests::with_temp_user_home("session-transfer-native", |_| {
            let source = fixture.join("source-home");
            let target = fixture.join("target-home");
            let project = fixture.join("target-project");
            let input: Value =
                serde_json::from_str(&fs::read_to_string(fixture.join("input.json")).unwrap())
                    .unwrap();
            let ids = input["sessionIds"].as_array().unwrap();
            std::env::set_var("CODEX_HOME", &source);
            let archive = fixture.join("export.zip");
            with_codex_dir(&source, || {
                gaoge_export_codex_sessions_inner(json!({"filePath":archive,"sessionIds":ids}))
            })
            .unwrap();
            let mut bundle = open_bundle(&archive).unwrap();
            let rows = with_codex_dir(&target, || preview_rows(&mut bundle, &target)).unwrap();
            let mappings: Map<String, Value> = rows
                .iter()
                .map(|row| (row["cwd"].as_str().unwrap().to_string(), json!(project)))
                .collect();
            let result = with_codex_dir(&target, || import_into(json!({"filePath":archive,"archiveHash":bundle.hash,"sessionIds":ids,"projectMappings":mappings}),&target)).unwrap();
            fs::write(fixture.join("import-result.json"), result.to_string()).unwrap();
            assert_eq!(
                result["importedCount"].as_u64(),
                Some(ids.len() as u64),
                "{result}"
            );
            assert_eq!(result["failedCount"], 0, "{result}");
        });
    }
}
