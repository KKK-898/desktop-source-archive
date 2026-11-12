//! A deliberately version-scoped adapter for the native model-query Ultra gate.
//! The desktop opt-in and the native per-model/enabled-effort filters stay intact.
//! Only API-key sessions with a custom provider and an explicit catalog gain the
//! local fallback. Unknown query shapes fail closed instead of changing a flag
//! used elsewhere in the application.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const GATE: &[u8] = b"`1186680773`";
const FIXTURE: &str = include_str!("../../scripts/fixtures/codex-ultra-query-26.1007.js");

struct Signature {
    original: String,
    patched: String,
}

fn signature() -> Result<Signature, String> {
    let original = FIXTURE
        .split_once("const nativeUltraQuery26_1007 = ")
        .and_then(|(_, body)| body.trim().strip_suffix(';'))
        .map(str::trim)
        .ok_or("Codex Ultra 回调验证样本格式无效。")?;
    let (bindings, body) = original
        .strip_prefix("({")
        .and_then(|value| value.split_once("},{"))
        .ok_or("Codex Ultra 回调参数结构无效。")?;
    let (context_bindings, _) = body
        .split_once("})=>{")
        .ok_or("Codex Ultra 回调上下文结构无效。")?;
    let binding = |parameters: &str, field: &str| -> Result<String, String> {
        let prefix = format!("{field}:");
        let values = parameters
            .split(',')
            .filter_map(|item| item.strip_prefix(&prefix))
            .collect::<Vec<_>>();
        if values.len() != 1
            || values[0].is_empty()
            || !values[0]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
            || values[0].as_bytes()[0].is_ascii_digit()
        {
            return Err(format!("Codex Ultra 回调绑定无效：{field}"));
        }
        Ok(values[0].to_string())
    };
    let auth = binding(bindings, "authMethod")?;
    let catalog = binding(bindings, "hasConfiguredModelCatalog")?;
    let custom = binding(bindings, "isCustomModelProvider")?;
    let show = binding(bindings, "includeUltraReasoningEffort")?;
    let get = binding(context_bindings, "get")?;
    let original_gate = format!("{show}&&{get}(kc,`1186680773`)");
    let patched_gate =
        format!("{show}&&({get}(kc,`1186680773`)||{auth}===`apikey`&&{custom}&&{catalog})");
    if original.matches(&original_gate).count() != 1 {
        return Err("Codex Ultra 样本门槛表达式不唯一。".to_string());
    }
    Ok(Signature {
        original: original.to_string(),
        patched: original.replacen(&original_gate, &patched_gate, 1),
    })
}

fn offsets(content: &[u8], needle: &[u8]) -> Vec<usize> {
    memchr::memmem::find_iter(content, needle).collect()
}

struct QueryMatch {
    start: usize,
    len: usize,
    already: bool,
}

fn callback_body_end(content: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    let mut line_comment = false;
    let mut block_comment = false;
    let mut index = start;
    while index < content.len() {
        let byte = content[index];
        let next = content.get(index + 1).copied();
        if line_comment {
            line_comment = !matches!(byte, b'\n' | b'\r');
            index += 1;
            continue;
        }
        if block_comment {
            if byte == b'*' && next == Some(b'/') {
                block_comment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == delimiter {
                quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'/' && matches!(next, Some(b'/' | b'*')) {
            line_comment = next == Some(b'/');
            block_comment = next == Some(b'*');
            index += 2;
            continue;
        }
        match byte {
            b'\'' | b'"' | b'`' => quote = Some(byte),
            b'{' => depth = depth.checked_add(1)?,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index + 1);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn query_candidates(content: &[u8]) -> Result<Vec<usize>, String> {
    let mut candidates = Vec::new();
    for context in offsets(content, b"queryClient") {
        let search_start = context.saturating_sub(2048);
        let Some(relative_start) = content[search_start..context]
            .iter()
            .rposition(|byte| *byte == b'(')
        else {
            continue;
        };
        let start = search_start + relative_start;
        let window = &content[start..content.len().min(context.saturating_add(512))];
        let Some(arrow) = memchr::memmem::find(window, b"=>") else {
            continue;
        };
        let compact = window[..arrow]
            .iter()
            .copied()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect::<Vec<_>>();
        let Ok(parameters) = std::str::from_utf8(&compact) else {
            continue;
        };
        let Some((parameters, context_parameters)) = parameters
            .strip_prefix("({")
            .and_then(|value| value.strip_suffix("})"))
            .and_then(|value| value.split_once("},{"))
        else {
            continue;
        };
        if parameters.contains(['{', '}']) || context_parameters.contains(['{', '}']) {
            continue;
        }
        let has_field = |object: &str, field: &str| {
            object.split(',').any(|entry| {
                entry
                    .strip_prefix(field)
                    .is_some_and(|tail| tail.starts_with(':'))
            })
        };
        if !has_field(context_parameters, "queryClient")
            || !(has_field(parameters, "includeUltraReasoningEffort")
                || [
                    "hasConfiguredModelCatalog",
                    "isCustomModelProvider",
                    "modelCatalogPath",
                ]
                .iter()
                .all(|field| has_field(parameters, field)))
        {
            continue;
        }
        let body_start = start + arrow + 2;
        let Some(body_start) = content[body_start..]
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
            .map(|offset| body_start + offset)
            .filter(|index| content[*index] == b'{')
        else {
            continue;
        };
        let end =
            callback_body_end(content, body_start).ok_or("Codex Ultra 模型查询回调边界无效。")?;
        // Older callbacks without this gate are outside this adapter's scope.
        // Stay within this callback so a later function's flag cannot match it.
        if memchr::memmem::find(&content[body_start..end], GATE).is_some()
            && !candidates.contains(&start)
        {
            candidates.push(start);
        }
    }
    Ok(candidates)
}

fn query_match(content: &[u8], signatures: &Signature) -> Result<Option<QueryMatch>, String> {
    // This flag also appears in unrelated UI paths and in the flag registry.
    // Count model-query callbacks, never all references to the flag itself.
    let candidates = query_candidates(content)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    let originals = offsets(content, signatures.original.as_bytes());
    let patched = offsets(content, signatures.patched.as_bytes());
    if candidates.len() != 1 {
        return Err("Codex Ultra 模型查询回调出现多次，已停止修改。".to_string());
    }
    match (originals.as_slice(), patched.as_slice()) {
        ([start], []) => Ok(Some(QueryMatch {
            start: *start,
            len: signatures.original.len(),
            already: false,
        })),
        ([], [start]) => Ok(Some(QueryMatch {
            start: *start,
            len: signatures.patched.len(),
            already: true,
        })),
        _ => Err("Codex Ultra 模型查询回调结构已变化或不唯一，已停止修改。".to_string()),
    }
}

#[derive(Clone)]
struct PackedFile {
    path: Vec<String>,
    offset: usize,
    size: usize,
}

impl PackedFile {
    fn name(&self) -> String {
        self.path.join("/")
    }
}

struct Archive {
    header: Value,
    data_start: usize,
    files: Vec<PackedFile>,
}

fn collect_files(
    directory: &Value,
    parent: &[String],
    packed: &mut Vec<PackedFile>,
) -> Result<(), String> {
    let files = directory
        .get("files")
        .and_then(Value::as_object)
        .ok_or("Codex ASAR 目录结构无效。")?;
    for (name, entry) in files {
        let mut path = parent.to_vec();
        path.push(name.clone());
        if entry.get("files").is_some() {
            collect_files(entry, &path, packed)?;
        } else if entry.get("unpacked").and_then(Value::as_bool) == Some(true)
            || entry.get("link").is_some()
        {
            continue;
        } else {
            let offset = entry
                .get("offset")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or("Codex ASAR 文件偏移无效。")?;
            let size = entry
                .get("size")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or("Codex ASAR 文件长度无效。")?;
            packed.push(PackedFile { path, offset, size });
        }
    }
    Ok(())
}

fn archive(content: &[u8]) -> Result<Option<Archive>, String> {
    let Some((header_range, data_start)) = super::asar_header_layout(content) else {
        if content.starts_with(&4u32.to_le_bytes()) {
            return Err("Codex ASAR Pickle 头无效，已停止修改。".to_string());
        }
        return Ok(None);
    };
    let header: Value = serde_json::from_slice(&content[header_range])
        .map_err(|error| format!("Codex ASAR 目录解析失败：{error}"))?;
    let mut files = Vec::new();
    collect_files(&header, &[], &mut files)?;
    files.sort_by_key(|file| file.offset);
    let data_len = content.len() - data_start;
    let mut previous_range = None;
    for file in &files {
        let end = file
            .offset
            .checked_add(file.size)
            .filter(|end| *end <= data_len)
            .ok_or("Codex ASAR 文件越界。")?;
        if file.size > 0 {
            if let Some((previous_start, previous_end)) = previous_range {
                // Electron archives can deduplicate identical files by giving
                // several paths the same complete packed range. Partial
                // overlaps are still invalid and must never be shifted.
                if file.offset < previous_end
                    && (file.offset != previous_start || end != previous_end)
                {
                    return Err("Codex ASAR 文件区间重叠，已停止修改。".to_string());
                }
            }
            previous_range = Some((file.offset, end));
        }
    }
    Ok(Some(Archive {
        header,
        data_start,
        files,
    }))
}

fn matching_file(
    content: &[u8],
    archive: &Archive,
    signatures: &Signature,
) -> Result<Option<(PackedFile, QueryMatch)>, String> {
    let mut found = None;
    for file in &archive.files {
        if !file.name().ends_with(".js") {
            continue;
        }
        let start = archive.data_start + file.offset;
        if let Some(query) = query_match(&content[start..start + file.size], signatures)? {
            if found.is_some() {
                return Err("Codex ASAR Ultra 模型查询文件不唯一。".to_string());
            }
            found = Some((file.clone(), query));
        }
    }
    Ok(found)
}

fn entry_mut<'a>(header: &'a mut Value, path: &[String]) -> Result<&'a mut Value, String> {
    let mut current = header;
    for segment in path {
        current = current
            .get_mut("files")
            .and_then(|files| files.get_mut(segment))
            .ok_or("Codex ASAR 文件条目丢失。")?;
    }
    Ok(current)
}

fn digest(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn update_integrity(entry: &mut Value, old: &[u8], next: &[u8]) -> Result<(), String> {
    let integrity = entry
        .get_mut("integrity")
        .and_then(Value::as_object_mut)
        .ok_or("Codex Ultra 目标文件缺少完整性元数据。")?;
    if integrity.get("algorithm").and_then(Value::as_str) != Some("SHA256") {
        return Err("Codex Ultra 目标文件摘要算法不受支持。".to_string());
    }
    let block_size = integrity
        .get("blockSize")
        .and_then(Value::as_u64)
        .and_then(|size| usize::try_from(size).ok())
        .filter(|size| *size > 0)
        .ok_or("Codex Ultra 目标文件摘要分块大小无效。")?;
    let old_blocks = old.chunks(block_size).map(digest).collect::<Vec<_>>();
    if integrity.get("hash").and_then(Value::as_str) != Some(digest(old).as_str())
        || integrity.get("blocks") != Some(&json!(old_blocks))
    {
        return Err("Codex Ultra 目标文件原始摘要不匹配，已停止修改。".to_string());
    }
    integrity.insert("hash".to_string(), json!(digest(next)));
    integrity.insert(
        "blocks".to_string(),
        json!(next.chunks(block_size).map(digest).collect::<Vec<_>>()),
    );
    entry["size"] = json!(next.len());
    Ok(())
}

fn encode_archive(header: &Value, payload: &[u8]) -> Result<Vec<u8>, String> {
    let header =
        serde_json::to_vec(header).map_err(|error| format!("Codex ASAR 目录编码失败：{error}"))?;
    let json_len = u32::try_from(header.len()).map_err(|_| "Codex ASAR 目录过大。")?;
    let padded_len = header
        .len()
        .checked_add(3)
        .map(|value| value & !3)
        .ok_or("Codex ASAR 目录长度溢出。")?;
    let pickle_payload = u32::try_from(padded_len)
        .ok()
        .and_then(|value| value.checked_add(4))
        .ok_or("Codex ASAR Pickle 长度溢出。")?;
    let header_size = pickle_payload
        .checked_add(4)
        .ok_or("Codex ASAR Pickle 长度溢出。")?;
    let mut result = Vec::new();
    result.extend_from_slice(&4u32.to_le_bytes());
    result.extend_from_slice(&header_size.to_le_bytes());
    result.extend_from_slice(&pickle_payload.to_le_bytes());
    result.extend_from_slice(&json_len.to_le_bytes());
    result.extend_from_slice(&header);
    result.resize(16 + padded_len, 0);
    result.extend_from_slice(payload);
    Ok(result)
}

/// Return whether the unique recognized callback is already patched and its
/// archive asset path (empty for an unpacked JavaScript file).
pub(super) fn inspect(content: &[u8]) -> Result<Option<(bool, String)>, String> {
    let signatures = signature()?;
    if let Some(archive) = archive(content)? {
        Ok(matching_file(content, &archive, &signatures)?
            .map(|(file, query)| (query.already, file.name())))
    } else {
        Ok(query_match(content, &signatures)?.map(|query| (query.already, String::new())))
    }
}

/// Build and validate a replacement in memory before changing the caller's
/// buffer. Existing archive files and unrelated header metadata are preserved.
pub(super) fn patch(content: &mut Vec<u8>) -> Result<Option<(bool, bool, String)>, String> {
    let signatures = signature()?;
    let (next, asset) = if let Some(mut archive) = archive(content)? {
        let Some((file, query)) = matching_file(content, &archive, &signatures)? else {
            return Ok(None);
        };
        // Changing a shared target would also change its other paths. The
        // supported native bundle has a unique target, so reject that unknown
        // layout rather than silently leaving another entry's hashes stale.
        if archive.files.iter().any(|other| {
            other.path != file.path && other.offset == file.offset && other.size == file.size
        }) {
            return Err("Codex Ultra 目标文件与其他路径共享数据，已停止修改。".to_string());
        }
        let start = archive.data_start + file.offset;
        let old = &content[start..start + file.size];
        if query.already {
            // A recognized code marker must not hide a corrupt archive entry.
            update_integrity(entry_mut(&mut archive.header, &file.path)?, old, old)?;
            return Ok(Some((false, false, file.name())));
        }
        let mut replacement = old.to_vec();
        replacement.splice(
            query.start..query.start + query.len,
            signatures.patched.bytes(),
        );
        update_integrity(
            entry_mut(&mut archive.header, &file.path)?,
            old,
            &replacement,
        )?;
        let delta = replacement
            .len()
            .checked_sub(file.size)
            .ok_or("Codex Ultra 补丁长度异常。")?;
        let old_end = file.offset + file.size;
        for other in &archive.files {
            if other.path != file.path && other.offset >= old_end {
                let offset = other
                    .offset
                    .checked_add(delta)
                    .ok_or("Codex ASAR 文件新偏移溢出。")?;
                entry_mut(&mut archive.header, &other.path)?["offset"] = json!(offset.to_string());
            }
        }
        let mut payload = content[archive.data_start..].to_vec();
        payload.splice(file.offset..old_end, replacement);
        (encode_archive(&archive.header, &payload)?, file.name())
    } else {
        let Some(query) = query_match(content, &signatures)? else {
            return Ok(None);
        };
        if query.already {
            return Ok(Some((false, false, String::new())));
        }
        let mut next = content.clone();
        next.splice(
            query.start..query.start + query.len,
            signatures.patched.bytes(),
        );
        (next, String::new())
    };
    if inspect(&next)? != Some((true, asset.clone())) {
        return Err("Codex Ultra 补丁内存校验失败。".to_string());
    }
    *content = next;
    Ok(Some((true, true, asset)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        signature().unwrap().original.into_bytes()
    }

    fn file_header(content: &[u8], offset: usize) -> Value {
        json!({
            "size": content.len(), "offset": offset.to_string(), "executable": false,
            "integrity": { "algorithm": "SHA256", "hash": digest(content),
                "blockSize": 64, "blocks": content.chunks(64).map(digest).collect::<Vec<_>>() }
        })
    }

    fn synthetic_archive() -> Vec<u8> {
        let before = b"binary prefix\0\xff";
        let target = fixture();
        let after = b"function unrelated(){return 'retain this file'}";
        let header = json!({ "customHeader": { "retained": true }, "files": {
            "before.bin": file_header(before, 0),
            "webview": { "files": { "assets": { "files": {
                "app-initial.js": file_header(&target, before.len()),
                "other.js": file_header(after, before.len() + target.len()),
                "external.node": { "size": 3, "unpacked": true },
                "alias.js": { "link": "webview/assets/other.js" }
            } } } }
        } });
        let payload = [before.as_slice(), target.as_slice(), after.as_slice()].concat();
        encode_archive(&header, &payload).unwrap()
    }

    #[test]
    fn codex_ultra_query_changes_only_scoped_gate_and_is_idempotent() {
        let original = fixture();
        let mut bytes = original.clone();
        assert_eq!(inspect(&bytes).unwrap(), Some((false, String::new())));
        assert_eq!(
            patch(&mut bytes).unwrap(),
            Some((true, true, String::new()))
        );
        let expected = String::from_utf8(original).unwrap().replace(
            "a&&u(kc,`1186680773`)",
            "a&&(u(kc,`1186680773`)||t===`apikey`&&o&&r)",
        );
        assert_eq!(bytes, expected.as_bytes());
        assert!(expected.contains("enabledReasoningEfforts:_"));
        assert!(expected.contains(
            "hasConfiguredModelCatalog:r,includeUltraReasoningEffort:y,isCustomModelProvider:o"
        ));
        let once = bytes.clone();
        assert_eq!(
            patch(&mut bytes).unwrap(),
            Some((false, false, String::new()))
        );
        assert_eq!(bytes, once);
    }

    #[test]
    fn codex_ultra_query_keeps_other_uses_of_the_same_remote_flag() {
        let prefix = "const flags={multiAgentMode:`1186680773`};";
        let suffix = ";const remote=Gc(r,`1186680773`);";
        let mut bytes = [prefix.as_bytes(), &fixture(), suffix.as_bytes()].concat();
        assert!(patch(&mut bytes).unwrap().unwrap().0);
        assert!(bytes.starts_with(prefix.as_bytes()));
        assert!(bytes.ends_with(suffix.as_bytes()));
    }

    #[test]
    fn codex_ultra_unknown_and_duplicate_callbacks_are_rejected_atomically() {
        let original = String::from_utf8(fixture()).unwrap();
        for mutated in [
            original.replace("authMethod:t", "authMethod:z"),
            original.replace("authMethod:t", " authMethod : t "),
            original.replace("includeUltraReasoningEffort:a,", ""),
            original.replace(
                "includeUltraReasoningEffort:y",
                "includeUltraReasoningEffort:a",
            ),
            original.replace("a&&u(kc,", "a||u(kc,"),
            original.replace(
                "hasConfiguredModelCatalog:r",
                "hasConfiguredModelCatalog:!0",
            ),
            original.replace("sendRequest(`model/list`", "sendRequest(`thread/list`"),
            format!("{original};{original}"),
            format!("{original};{}", signature().unwrap().patched),
        ] {
            let mut bytes = mutated.into_bytes();
            let before = bytes.clone();
            assert!(inspect(&bytes).is_err());
            assert!(patch(&mut bytes).is_err());
            assert_eq!(bytes, before);
        }
        assert_eq!(inspect(b"function unrelated(){}").unwrap(), None);
    }

    #[test]
    fn codex_ultra_older_queries_without_gate_are_not_modified_or_cross_matched() {
        let older = b"({hasConfiguredModelCatalog:r,isCustomModelProvider:o,modelCatalogPath:c},{get:u,queryClient:d,scope:f})=>{return{select:()=>r}}";
        let unrelated = b";function unrelated(){return u(kc,`1186680773`)}";
        let mut content = [older.as_slice(), unrelated.as_slice()].concat();
        let original = content.clone();
        assert_eq!(inspect(&content).unwrap(), None);
        assert_eq!(patch(&mut content).unwrap(), None);
        assert_eq!(content, original);
        content.extend_from_slice(&fixture());
        assert_eq!(inspect(&content).unwrap(), Some((false, String::new())));
        assert!(patch(&mut content).unwrap().unwrap().0);
    }

    #[test]
    fn codex_ultra_asar_preserves_other_files_offsets_and_metadata() {
        let mut bytes = synthetic_archive();
        let old = bytes.clone();
        let mut before = archive(&old).unwrap().unwrap();
        let target_name = "webview/assets/app-initial.js";
        assert_eq!(
            inspect(&bytes).unwrap(),
            Some((false, target_name.to_string()))
        );
        assert_eq!(
            patch(&mut bytes).unwrap(),
            Some((true, true, target_name.to_string()))
        );
        let mut after = archive(&bytes).unwrap().unwrap();
        let delta = signature().unwrap().patched.len() - signature().unwrap().original.len();
        assert_eq!(before.header["customHeader"], after.header["customHeader"]);
        for file in before.files.clone() {
            let next = after
                .files
                .iter()
                .find(|item| item.path == file.path)
                .unwrap()
                .clone();
            let old_content =
                &old[before.data_start + file.offset..before.data_start + file.offset + file.size];
            let next_content =
                &bytes[after.data_start + next.offset..after.data_start + next.offset + next.size];
            let mut previous_entry = entry_mut(&mut before.header, &file.path).unwrap().clone();
            let next_entry = entry_mut(&mut after.header, &file.path).unwrap().clone();
            if file.name() == target_name {
                assert_eq!(next.offset, file.offset);
                assert_eq!(next.size, file.size + delta);
                let integrity = &next_entry["integrity"];
                assert_eq!(integrity["hash"], json!(digest(next_content)));
                assert_eq!(
                    integrity["blocks"],
                    json!(next_content.chunks(64).map(digest).collect::<Vec<_>>())
                );
                assert!(integrity["blocks"].as_array().unwrap().len() > 2);
            } else {
                assert_eq!(old_content, next_content);
                if file.name().ends_with("other.js") {
                    assert_eq!(next.offset, file.offset + delta);
                    previous_entry["offset"] = next_entry["offset"].clone();
                }
                assert_eq!(previous_entry, next_entry);
            }
        }
        assert_eq!(
            before.header["files"]["webview"]["files"]["assets"]["files"]["external.node"],
            after.header["files"]["webview"]["files"]["assets"]["files"]["external.node"]
        );
        assert_eq!(
            before.header["files"]["webview"]["files"]["assets"]["files"]["alias.js"],
            after.header["files"]["webview"]["files"]["assets"]["files"]["alias.js"]
        );
        let once = bytes.clone();
        assert_eq!(
            patch(&mut bytes).unwrap(),
            Some((false, false, target_name.to_string()))
        );
        assert_eq!(once, bytes);
    }

    #[test]
    fn codex_ultra_asar_corruption_is_rejected_without_mutating_input() {
        let original = synthetic_archive();
        let parsed = archive(&original).unwrap().unwrap();
        for change in ["hash", "overlap", "size", "blockSize"] {
            let mut header = parsed.header.clone();
            let target =
                &mut header["files"]["webview"]["files"]["assets"]["files"]["app-initial.js"];
            match change {
                "hash" => target["integrity"]["hash"] = json!("bad"),
                "overlap" => target["offset"] = json!("0"),
                "size" => target["size"] = json!(u64::MAX),
                _ => target["integrity"]["blockSize"] = json!(0),
            }
            let mut invalid = encode_archive(&header, &original[parsed.data_start..]).unwrap();
            let before = invalid.clone();
            assert!(patch(&mut invalid).is_err(), "{change}");
            assert_eq!(invalid, before);
        }
    }

    #[test]
    fn codex_ultra_asar_accepts_deduplicated_non_target_files_but_not_partial_overlaps() {
        let original = synthetic_archive();
        let parsed = archive(&original).unwrap().unwrap();
        let mut header = parsed.header.clone();
        header["files"]["before-copy.bin"] = header["files"]["before.bin"].clone();
        let assets = &mut header["files"]["webview"]["files"]["assets"]["files"];
        assets["other-copy.js"] = assets["other.js"].clone();
        let mut bytes = encode_archive(&header, &original[parsed.data_start..]).unwrap();
        assert!(patch(&mut bytes).unwrap().unwrap().0);
        let next = archive(&bytes).unwrap().unwrap();
        assert_eq!(
            next.header["files"]["before-copy.bin"],
            next.header["files"]["before.bin"]
        );
        let assets = &next.header["files"]["webview"]["files"]["assets"]["files"];
        assert_eq!(assets["other-copy.js"], assets["other.js"]);
        let once = bytes.clone();
        assert!(!patch(&mut bytes).unwrap().unwrap().0);
        assert_eq!(once, bytes);

        // A contained range at the same offset is not exact deduplication.
        header["files"]["before-copy.bin"]["size"] = json!(1);
        let mut invalid = encode_archive(&header, &original[parsed.data_start..]).unwrap();
        let before = invalid.clone();
        assert!(patch(&mut invalid).is_err());
        assert_eq!(invalid, before);
    }

    #[test]
    fn codex_ultra_asar_rejects_a_shared_target_without_modifying_aliases() {
        let original = synthetic_archive();
        let parsed = archive(&original).unwrap().unwrap();
        let mut header = parsed.header.clone();
        header["files"]["shared-target.bin"] =
            header["files"]["webview"]["files"]["assets"]["files"]["app-initial.js"].clone();
        let mut invalid = encode_archive(&header, &original[parsed.data_start..]).unwrap();
        let before = invalid.clone();
        assert!(patch(&mut invalid).unwrap_err().contains("共享数据"));
        assert_eq!(invalid, before);
    }

    #[test]
    fn codex_ultra_installed_asar_is_verified_only_in_memory_when_provided() {
        let Ok(path) = std::env::var("CODEX_ULTRA_ASAR_FIXTURE") else {
            return;
        };
        let original = std::fs::read(path).unwrap();
        let before = inspect(&original).unwrap().expect("model-query Ultra gate");
        assert!(!before.0, "provide the original, unpatched native archive");
        assert!(before.1.ends_with(".js"));
        let mut next = original;
        assert_eq!(
            patch(&mut next).unwrap(),
            Some((true, true, before.1.clone()))
        );
        assert_eq!(inspect(&next).unwrap(), Some((true, before.1.clone())));
        let once = next.clone();
        assert_eq!(patch(&mut next).unwrap(), Some((false, false, before.1)));
        assert_eq!(next, once);
    }
}
