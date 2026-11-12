//! Keep the small set of settings taken over by a relay outside CODEX_HOME.
//! Closing the relay removes its overrides instead of inventing an official
//! provider/model. In the native sidebar an explicit provider is also a label.
use super::*;

#[derive(Default, Serialize, Deserialize)]
struct RelayRestoreState {
    root_lines: Vec<String>,
    fast_mode_lines: Vec<String>,
    #[serde(default)]
    shadowed_provider_sections: Vec<Vec<String>>,
    #[serde(default)]
    auth_baseline_captured: bool,
    #[serde(default)]
    encrypted_preserved_auth: String,
    #[serde(default)]
    preserved_auth_hash: String,
    #[serde(default)]
    preserved_auth_in_place: bool,
    #[serde(default, rename = "preserved_auth", skip_serializing)]
    legacy_preserved_auth: Option<Value>,
    #[serde(default)]
    preserved_active_account_key: String,
    official_account_key: Option<String>,
    legacy: bool,
    api_key_hashes: Vec<String>,
}

pub(super) enum ExplicitAuthBaseline {
    Account(String),
    SignedOut,
    Preserved {
        auth: Value,
        active_account_key: String,
    },
    PreservedInPlace {
        auth_hash: String,
        active_account_key: String,
    },
    Unknown,
}

fn state_path() -> PathBuf {
    let dir = codex_dir().to_string_lossy().replace('\\', "/");
    let identity = if cfg!(windows) {
        dir.to_lowercase()
    } else {
        dir
    };
    roaming_app_dir()
        .join("codex-relay-restore")
        .join(format!("{:x}.json", Sha256::digest(identity.as_bytes())))
}

fn read_state() -> Result<Option<RelayRestoreState>, String> {
    let path = state_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = read_text_if_exists(&path)?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("读取 Codex 中转恢复记录失败：{error}"))
}

fn is_relay_config(config: &str) -> bool {
    has_gaoge_managed_provider_config(config)
        || config.lines().any(line_has_gaoge_relay_marker)
        || split_codex_config(config).sections.iter().any(|section| {
            is_official_openai_override_section(&section.header)
                && official_openai_section_has_managed_route(&section.lines)
        })
        || configured_root_value(config, "model_catalog_json").is_some_and(|path| {
            Path::new(&path).file_name() == Some(OsStr::new(CODEX_MODEL_CATALOG_FILE))
        })
}

fn is_saved_root_key(key: &str) -> bool {
    matches!(
        key,
        "model_provider"
            | "model"
            | "model_reasoning_effort"
            | "model_context_window"
            | "model_auto_compact_token_limit"
            | "model_auto_compact_token_limit_scope"
            | "model_catalog_json"
            | "profile"
            | "service_tier"
            | "features.fast_mode"
    )
}

/// These values select a provider/profile or a model catalog at the root of
/// Codex's configuration.  Restoring any of them after a relay close can
/// activate a third-party route again, even when the relay provider section
/// itself has been removed.
fn is_explicit_route_root_key(key: &str) -> bool {
    matches!(key, "model_provider" | "profile" | "model_catalog_json")
}

/// `openai` is the built-in provider.  A user-defined table with this name
/// shadows the built-in endpoint/auth behavior, so it must never survive an
/// explicit return to the official route. Other provider tables are safe to
/// keep as long as no root selector activates them.
fn is_openai_provider_override_section(header: &str) -> bool {
    toml_header_matches(header, "model_providers", "openai")
        || toml_header_matches(header, "profiles", "openai")
}

fn is_restore_root_line_allowed(line: &str) -> bool {
    !parse_toml_key_value(trim_toml_line(line))
        .is_some_and(|(key, _)| is_explicit_route_root_key(key))
}

fn key_hash(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.trim().as_bytes()))
}

fn encrypt_preserved_auth(auth: &Value) -> Result<(String, String), String> {
    let serialized = serde_json::to_string(auth)
        .map_err(|error| format!("编码 Codex 登录前认证状态失败：{error}"))?;
    let encrypted = encrypt_secret(&serialized)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            "当前系统没有可用的安全凭据存储，已取消登录以避免明文保存原 Codex 认证。".to_string()
        })?;
    Ok((encrypted, key_hash(&serialized)))
}

fn auth_value_hash(auth: &Value) -> Result<String, String> {
    serde_json::to_string(auth)
        .map(|serialized| key_hash(&serialized))
        .map_err(|error| format!("编码 Codex 登录前认证状态失败：{error}"))
}

pub(super) fn auth_matches_hash(auth: &Value, expected_hash: &str) -> Result<bool, String> {
    Ok(auth_value_hash(auth)? == expected_hash)
}

fn decrypt_preserved_auth(encrypted: &str, expected_hash: &str) -> Result<Option<Value>, String> {
    if encrypted.trim().is_empty() {
        return Ok(None);
    }
    let serialized = decrypt_secret(encrypted)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "无法解密 Codex 登录前认证状态，未修改当前登录。".to_string())?;
    if !expected_hash.trim().is_empty() && key_hash(&serialized) != expected_hash {
        return Err("Codex 登录前认证状态校验失败，未修改当前登录。".to_string());
    }
    serde_json::from_str(&serialized)
        .map(Some)
        .map_err(|error| format!("解析 Codex 登录前认证状态失败：{error}"))
}

fn is_shadowed_direct_provider_section(header: &str) -> bool {
    toml_header_matches(header, "model_providers", CODEX_DIRECT_PROVIDER_ID)
        || toml_header_matches(header, "profiles", CODEX_DIRECT_PROVIDER_ID)
}

/// Capture non-auth settings once, before the first write. A confirmed live
/// ChatGPT -> API transition captures its own return identity, while repeated
/// API logins and non-overwriting group/model changes keep the prior baseline.
pub(super) fn capture(
    config: &str,
    api_key: &str,
    auth_will_be_replaced: bool,
) -> Result<(), String> {
    let existing_state = read_state()?;
    let is_first_capture = existing_state.is_none();
    let original_auth = if is_first_capture || auth_will_be_replaced {
        read_json_if_exists(&codex_auth_path())?
    } else {
        None
    };
    let original_active_account_key = if is_first_capture {
        read_registry()?
            .get("activeAccountKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        String::new()
    };
    let captured_official_account_key = if (is_first_capture || auth_will_be_replaced)
        && original_auth.as_ref().is_some_and(|auth| {
            codex_auth_is_real_account_snapshot(auth) && !auth_account_key(auth).is_empty()
        }) {
        save_current_live_codex_auth_snapshot()?
    } else {
        None
    };
    let starts_official_to_api_transition =
        auth_will_be_replaced && captured_official_account_key.is_some();
    let (first_encrypted_preserved_auth, first_preserved_auth_hash, first_auth_in_place) =
        if is_first_capture && captured_official_account_key.is_none() {
            match original_auth.as_ref() {
                Some(auth) if auth_will_be_replaced => {
                    let (encrypted, hash) = encrypt_preserved_auth(auth)?;
                    (encrypted, hash, false)
                }
                Some(auth) => (String::new(), auth_value_hash(auth)?, true),
                None => (String::new(), String::new(), false),
            }
        } else {
            (String::new(), String::new(), false)
        };
    let mut state = match existing_state {
        Some(mut state) => {
            if starts_official_to_api_transition {
                // A real account has been logged in since this record was
                // created. We are about to replace that live identity, not
                // merely change an API route. Keep its exact saved key, never
                // infer an account from stale registry selection or recency.
                let account_key = captured_official_account_key.as_ref().unwrap();
                state.official_account_key = Some(account_key.clone());
                state.auth_baseline_captured = true;
                state.preserved_active_account_key = account_key.clone();
                state.encrypted_preserved_auth.clear();
                state.preserved_auth_hash.clear();
                state.preserved_auth_in_place = false;
                state.legacy_preserved_auth = None;
                state.legacy = false;
            } else if state.official_account_key.is_none()
                && state.encrypted_preserved_auth.is_empty()
                && state.legacy_preserved_auth.is_some()
            {
                let (encrypted, hash) =
                    encrypt_preserved_auth(state.legacy_preserved_auth.as_ref().unwrap())?;
                state.encrypted_preserved_auth = encrypted;
                state.preserved_auth_hash = hash;
                state.preserved_auth_in_place = false;
                state.legacy_preserved_auth = None;
            } else if state.official_account_key.is_some() {
                state.legacy_preserved_auth = None;
            } else if auth_will_be_replaced && state.preserved_auth_in_place {
                // A later no-account/aggregate login must secure the original
                // auth before replacing an earlier in-place baseline.
                let auth = read_json_if_exists(&codex_auth_path())?.ok_or_else(|| {
                    "登录前保留的 Codex 认证已丢失，已取消登录以避免覆盖原状态。".to_string()
                })?;
                if !auth_matches_hash(&auth, &state.preserved_auth_hash)? {
                    return Err(
                        "登录前保留的 Codex 认证已被其他程序修改，已取消登录以避免覆盖该变更。".to_string()
                    );
                }
                let (encrypted, hash) = encrypt_preserved_auth(&auth)?;
                state.encrypted_preserved_auth = encrypted;
                state.preserved_auth_hash = hash;
                state.preserved_auth_in_place = false;
            }
            state
        }
        None => {
            let legacy = is_relay_config(config);
            let parts = split_codex_config(config);
            let shadowed_provider_sections = if legacy {
                Vec::new()
            } else {
                parts
                    .sections
                    .iter()
                    .filter(|section| is_shadowed_direct_provider_section(&section.header))
                    .map(|section| {
                        let mut block = Vec::with_capacity(section.lines.len() + 1);
                        block.push(section.header.clone());
                        block.extend(section.lines.clone());
                        block
                    })
                    .collect()
            };
            RelayRestoreState {
                root_lines: if legacy {
                    Vec::new()
                } else {
                    parts
                        .root_lines
                        .into_iter()
                        .filter(|line| {
                            parse_toml_key_value(trim_toml_line(line)).is_some_and(
                                |(key, value)| {
                                    is_saved_root_key(key)
                                        && !(key == "model_provider" && value == "openai")
                                },
                            )
                        })
                        .collect()
                },
                fast_mode_lines: if legacy {
                    Vec::new()
                } else {
                    parts
                        .sections
                        .into_iter()
                        .filter(|section| {
                            toml_header_segments(&section.header).as_deref()
                                == Some(&["features".to_string()])
                        })
                        .flat_map(|section| section.lines)
                        .filter(|line| {
                            parse_toml_key_value(trim_toml_line(line))
                                .is_some_and(|(key, _)| key == "fast_mode")
                        })
                        .collect()
                },
                shadowed_provider_sections,
                auth_baseline_captured: !legacy || starts_official_to_api_transition,
                encrypted_preserved_auth: first_encrypted_preserved_auth,
                preserved_auth_hash: first_preserved_auth_hash,
                preserved_auth_in_place: first_auth_in_place,
                legacy_preserved_auth: None,
                preserved_active_account_key: original_active_account_key,
                official_account_key: captured_official_account_key,
                legacy: legacy && !starts_official_to_api_transition,
                api_key_hashes: Vec::new(),
            }
        }
    };
    let hash = key_hash(api_key);
    if !state.api_key_hashes.contains(&hash) {
        state.api_key_hashes.push(hash);
    }
    let text = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("编码 Codex 中转恢复记录失败：{error}"))?;
    write_text_atomic(&state_path(), &text)
}

pub(super) fn restore_config(existing: &str) -> Result<String, String> {
    restore_config_with_state(existing, read_state()?)
}

/// Only the explicit force-official operation may ignore a malformed restore
/// record. Keep its exact bytes outside CODEX_HOME before removing any route.
pub(super) fn backup_corrupt_state_for_force_official() -> Result<Option<PathBuf>, String> {
    let path = state_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取 Codex 中转恢复记录失败：{error}")),
    };
    if serde_json::from_slice::<RelayRestoreState>(&bytes).is_ok() {
        return Ok(None);
    }
    save_force_official_evidence("restore-state", &bytes).map(Some)
}

fn save_force_official_evidence(label: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let source = state_path();
    let stem = source.file_stem().and_then(OsStr::to_str).unwrap_or("codex");
    let digest = format!("{:x}", Sha256::digest(bytes));
    let backup = source.with_file_name(format!("{stem}.{label}.{digest}.recovery.json"));
    // Legacy restore records can contain credentials too. Recovery evidence
    // must use secure storage rather than creating a new plaintext secret copy.
    let encoded = general_purpose::STANDARD.encode(bytes);
    let encrypted = encrypt_secret(&encoded)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "无法安全保留 Codex 恢复证据，已取消强制恢复以保护原认证。".to_string())?;
    let evidence = json!({
        "schemaVersion": 1,
        "kind": label,
        "sha256": digest,
        "encryptedBytesBase64": encrypted,
    });
    write_json_pretty_atomic(&backup, &evidence)
        .map_err(|error| format!("保留 Codex 强制恢复证据失败：{error}"))?;
    Ok(backup)
}

pub(super) fn backup_auth_for_force_official() -> Result<Option<PathBuf>, String> {
    match fs::read(codex_auth_path()) {
        Ok(bytes) => save_force_official_evidence("auth", &bytes).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("保留 Codex 原认证失败：{error}")),
    }
}

pub(super) fn restore_config_without_saved_state(existing: &str) -> Result<String, String> {
    restore_config_with_state(existing, None)
}

fn restore_config_with_state(
    existing: &str,
    state: Option<RelayRestoreState>,
) -> Result<String, String> {
    // Models and limits from an external provider need not exist on the
    // official service. Use Codex's native defaults in that case.
    let baseline = state.as_ref().map(|state| state.root_lines.join("\n"));
    let baseline = baseline.as_deref().unwrap_or(existing);
    let external_model = baseline.parse::<toml_edit::Document>().ok().is_some_and(|document| {
        document.get("model_provider").and_then(toml_edit::Item::as_str)
            .is_some_and(|provider| !provider.is_empty() && provider != "openai")
            || document.get("profile").is_some()
    });
    let taken_over = state.is_some() || is_relay_config(existing);
    let mut parts = split_codex_config(&if taken_over {
        merge_codex_config(existing, "")
    } else {
        existing.to_string()
    });

    // This function is used by both the normal close and the explicit
    // "force official" action.  Even when an old install lost its restore
    // record, the resulting config must not keep an active third-party root
    // selector or an `openai` shadow table.  Provider definitions with other
    // names remain available for a later deliberate selection.
    parts.root_lines.retain(|line| {
        !parse_toml_key_value(trim_toml_line(line))
            .is_some_and(|(key, _)| is_explicit_route_root_key(key))
    });
    parts
        .sections
        .retain(|section| !is_openai_provider_override_section(&section.header));

    if taken_over {
        // The built-in provider is selected by omission.  Keep the restored
        // model/reasoning and speed preferences, but never restore a root
        // provider/profile/catalog selector that could reactivate the relay
        // (or an external route such as basispoints_local).
        parts.root_lines.retain(|line| {
            !parse_toml_key_value(trim_toml_line(line))
                .is_some_and(|(key, _)| matches!(key, "service_tier" | "features.fast_mode"))
        });
        for section in &mut parts.sections {
            if toml_header_segments(&section.header).as_deref() == Some(&["features".to_string()]) {
                section.lines.retain(|line| {
                    !parse_toml_key_value(trim_toml_line(line))
                        .is_some_and(|(key, _)| key == "fast_mode")
                });
            }
        }
        if let Some(state) = state {
            let RelayRestoreState {
                root_lines,
                fast_mode_lines,
                shadowed_provider_sections,
                ..
            } = state;
            parts
                .root_lines
                .extend(root_lines.into_iter().filter(|line| {
                    is_restore_root_line_allowed(line)
                        && !parse_toml_key_value(trim_toml_line(line))
                            .is_some_and(|(key, _)| key == "disable_response_storage")
                }));
            if !fast_mode_lines.is_empty() {
                if let Some(section) = parts.sections.iter_mut().find(|section| {
                    toml_header_segments(&section.header).as_deref()
                        == Some(&["features".to_string()])
                }) {
                    section.lines.extend(fast_mode_lines);
                } else {
                    parts.sections.push(CodexConfigSection {
                        header: "[features]".to_string(),
                        lines: fast_mode_lines,
                    });
                }
            }
            let mut existing_headers = parts
                .sections
                .iter()
                .filter_map(|section| toml_header_segments(&section.header))
                .collect::<HashSet<_>>();
            for block in shadowed_provider_sections {
                let Some((header, lines)) = block.split_first() else {
                    continue;
                };
                if is_openai_provider_override_section(header) {
                    continue;
                }
                let Some(identity) = toml_header_segments(header) else {
                    continue;
                };
                if existing_headers.insert(identity) {
                    parts.sections.push(CodexConfigSection {
                        header: header.clone(),
                        lines: lines.to_vec(),
                    });
                }
            }
        }
        parts
            .sections
            .retain(|section| section.lines.iter().any(|line| !line.trim().is_empty()));
    }
    let rendered = restore_codex_code_mode(&render_codex_config_parts(parts))?;
    let mut document = rendered.parse::<toml_edit::Document>()
        .map_err(|error| format!("解析 Codex 官方配置失败：{error}"))?;
    let root = document.as_table_mut();
    // Parse the final document as well: quoted keys, dotted keys and inline
    // tables must not bypass the official-route cleanup.
    for key in ["model_provider", "profile", "model_catalog_json", "base_url",
        "wire_api", "requires_openai_auth", "experimental_bearer_token",
        "env_key", "http_headers", "env_http_headers", "auth"] {
        root.remove(key);
    }
    if root.get("forced_login_method").and_then(toml_edit::Item::as_str) == Some("api") {
        root.remove("forced_login_method");
    }
    if external_model {
        for key in ["model", "model_context_window", "model_auto_compact_token_limit",
            "model_auto_compact_token_limit_scope", "service_tier"] {
            root.remove(key);
        }
        if let Some(features) = root.get_mut("features").and_then(toml_edit::Item::as_table_like_mut) {
            features.remove("fast_mode");
        }
    }
    if let Some(providers) = root.get_mut("model_providers").and_then(toml_edit::Item::as_table_like_mut) {
        providers.remove("openai");
    }
    Ok(document.to_string())
}

/// A deliberate account switch supersedes the account to restore when the
/// relay is later closed, without changing its original non-auth settings.
pub(super) fn select_official_account(account_key: &str) -> Result<(), String> {
    let Some(mut state) = read_state()? else {
        return Ok(());
    };
    state.official_account_key = Some(account_key.to_string());
    state.auth_baseline_captured = true;
    state.encrypted_preserved_auth.clear();
    state.preserved_auth_hash.clear();
    state.preserved_auth_in_place = false;
    state.legacy_preserved_auth = None;
    state.preserved_active_account_key = account_key.to_string();
    let text = serde_json::to_string_pretty(&state)
        .map_err(|error| format!("编码 Codex 中转恢复记录失败：{error}"))?;
    write_text_atomic(&state_path(), &text)
}

pub(super) fn owns_api_auth(
    auth: &Value,
    relay_key: &str,
    config: &str,
    registry: &Value,
) -> Result<bool, String> {
    if !codex_auth_is_api_key_only(auth) {
        return Ok(false);
    }
    if codex_auth_is_gaoge_managed_api_auth(auth, relay_key, registry) {
        return Ok(true);
    }
    let key = codex_auth_api_key(auth).unwrap_or("");
    if read_state()?.is_some_and(|state| state.api_key_hashes.contains(&key_hash(key))) {
        return Ok(true);
    }
    // Migration for existing installs whose router state is missing or stale:
    // inspect the route BEFORE removing it, and compare keys, never delete an
    // unrelated personal API login merely because a relay was configured.
    Ok(is_relay_config(config)
        && [CODEX_DIRECT_PROVIDER_ID, CODEX_LEGACY_PROVIDER_ID, "openai"]
            .iter()
            .any(|provider| {
                model_provider_value(config, provider, "experimental_bearer_token")
                    .is_some_and(|token| token.trim() == key)
            }))
}

pub(super) fn explicit_auth_baseline() -> Result<Option<ExplicitAuthBaseline>, String> {
    let Some(state) = read_state()?.filter(|state| !state.legacy) else {
        return Ok(None);
    };
    if let Some(account_key) = state.official_account_key {
        return Ok(Some(ExplicitAuthBaseline::Account(account_key)));
    }
    if !state.auth_baseline_captured {
        // Restore records created by an older build cannot distinguish an
        // intentional sign-out from an unrelated personal API login.
        return Ok(Some(ExplicitAuthBaseline::Unknown));
    }
    if state.preserved_auth_in_place {
        return Ok(Some(ExplicitAuthBaseline::PreservedInPlace {
            auth_hash: state.preserved_auth_hash,
            active_account_key: state.preserved_active_account_key,
        }));
    }
    let preserved_auth =
        decrypt_preserved_auth(&state.encrypted_preserved_auth, &state.preserved_auth_hash)?
            .or(state.legacy_preserved_auth);
    Ok(Some(match preserved_auth {
        Some(auth) => ExplicitAuthBaseline::Preserved {
            auth,
            active_account_key: state.preserved_active_account_key,
        },
        None => ExplicitAuthBaseline::SignedOut,
    }))
}

pub(super) fn official_auth_candidate(registry: &Value) -> Result<Option<(String, Value)>, String> {
    if let Some(state) = read_state()? {
        if let Some(key) = state.official_account_key {
            let item = codex_registry_item_for_key(registry, &key);
            let path = item
                .as_ref()
                .and_then(|item| item.get("snapshotPath"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| snapshot_path_for_key(&key));
            let Some(auth) = read_json_if_exists(&path)? else {
                return Ok(None);
            };
            if !codex_auth_is_real_account_snapshot(&auth) {
                return Ok(None);
            }
            let identity_matches = item
                .as_ref()
                .map(|item| auth_matches_account_item(&auth, item, &key))
                .unwrap_or_else(|| auth_account_key(&auth) == key);
            if !identity_matches {
                return Err(format!(
                    "登录前的 Codex 官方账号快照身份与记录不匹配，未修改当前登录状态：{key}"
                ));
            }
            return Ok(Some((key, auth)));
        }
        if !state.legacy {
            // A saved account is not a live login. Preserve an intentional
            // sign-out that preceded one-click login.
            return Ok(None);
        }
    }
    read_codex_official_auth_restore_candidate(registry)
}

pub(super) fn remove_artifacts() -> Result<(), String> {
    // Only the exact file created by Gaoge, never a user-specified catalog.
    for path in [codex_dir().join(CODEX_MODEL_CATALOG_FILE), state_path()] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "清理 Codex 中转文件失败 {}：{error}",
                    path.display()
                ))
            }
        }
    }
    Ok(())
}

pub(super) fn artifact_paths() -> [PathBuf; 2] {
    [codex_dir().join(CODEX_MODEL_CATALOG_FILE), state_path()]
}

#[cfg(test)]
#[path = "codex_relay_restore_transition_tests.rs"]
mod transition_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_root_filter_drops_every_explicit_route_selector() {
        for key in ["model_provider", "profile", "model_catalog_json"] {
            assert!(!is_restore_root_line_allowed(&format!(
                "{key} = \"external\""
            )));
        }
        assert!(is_restore_root_line_allowed("model = \"gpt-6-astra\""));
        assert!(is_restore_root_line_allowed(
            "model_reasoning_effort = \"high\""
        ));
        assert!(is_restore_root_line_allowed("service_tier = \"priority\""));
    }

    #[test]
    fn restore_config_uses_builtin_official_provider_and_keeps_inactive_personal_provider() {
        let relay_config = r#"
model_provider = "custom"
model = "gpt-5.5"
profile = "custom"
model_catalog_json = "gaoge-model-catalog.json"
model_reasoning_effort = "high"

[model_providers.openai]
name = "Personal OpenAI Override"
base_url = "https://personal.example.invalid/v1"
experimental_bearer_token = "personal-openai-key"

[model_providers.personal]
name = "Personal Gateway"
base_url = "https://personal.example.invalid/v1"
experimental_bearer_token = "personal-key"

[model_providers.custom]
# gaogeaii-managed-provider
name = "Gaoge"
base_url = "https://relay.example.invalid/v1"
experimental_bearer_token = "relay-key"

[plugins."personal@marketplace"]
enabled = true
"#;

        let restored = restore_config_with_state(relay_config, None).expect("relay config should restore");
        assert!(restored.parse::<toml_edit::Document>().is_ok());
        assert!(configured_root_value(&restored, "model_provider").is_none());
        assert!(configured_root_value(&restored, "profile").is_none());
        assert!(configured_root_value(&restored, "model_catalog_json").is_none());
        assert!(!restored.contains("[model_providers.openai]"));
        assert!(!restored.contains("personal-openai-key"));
        assert!(restored.contains("[model_providers.personal]"));
        assert!(restored.contains("personal-key"));
        assert!(!restored.contains("[model_providers.custom]"));
        assert!(!restored.contains("relay-key"));
        assert!(restored.contains("[plugins.\"personal@marketplace\"]"));
        assert!(restored.contains("enabled = true"));
    }

    #[test]
    fn restore_config_without_relay_marker_still_disarms_root_external_provider() {
        let config = r#"
model_provider = "basispoints_local"
model = "gpt-6-astra-basispoints"

[model_providers.basispoints_local]
name = "External local route"
base_url = "http://127.0.0.1:18317/v1"
requires_openai_auth = false
"#;

        let restored = restore_config_with_state(config, None).expect("config should restore");
        assert!(configured_root_value(&restored, "model_provider").is_none());
        assert!(configured_root_value(&restored, "model").is_none());
        assert!(restored.contains("[model_providers.basispoints_local]"));
        assert!(restored.contains("127.0.0.1:18317"));
    }

    #[test]
    fn saved_external_baseline_and_inline_overrides_cannot_reenable_api_mode() {
        let state = RelayRestoreState {
            root_lines: vec![
                "model_provider = \"basispoints_local\"".into(),
                "model = \"external-only-model\"".into(),
                "profile = \"external\"".into(),
            ],
            ..Default::default()
        };
        let restored = restore_config_with_state(r#"
"model_provider" = "basispoints_local"
forced_login_method = "api"
experimental_bearer_token = "relay-key"
model_providers.openai = { base_url = "https://relay.example.invalid/v1", env_key = "RELAY_KEY" }
[plugins."personal@marketplace"]
enabled = true
"#, Some(state)).unwrap();
        let document = restored.parse::<toml_edit::Document>().unwrap();
        for key in ["model_provider", "profile", "model", "forced_login_method", "experimental_bearer_token"] {
            assert!(document.get(key).is_none(), "{key} survived official restore");
        }
        assert!(document.get("model_providers").and_then(|p| p.get("openai")).is_none());
        assert!(restored.contains("personal@marketplace"));
    }
}
