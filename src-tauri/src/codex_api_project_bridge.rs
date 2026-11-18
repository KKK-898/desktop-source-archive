//! Scope the API local-project bridge to the active native home and login generation.
use super::*;

fn active_home() -> Result<PathBuf, String> {
    codex_fuel_runtime_config_path()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法确认当前 Codex 本地项目目录。".to_string())
}

fn scope(home: &Path) -> Result<String, String> {
    let canonical =
        fs::canonicalize(home).map_err(|_| "无法确认当前 Codex 本地项目目录。".to_string())?;
    let mut text = canonical.to_string_lossy().replace('\\', "/");
    if let Some(path) = text.strip_prefix("//?/") {
        text = path.to_owned();
    }
    if cfg!(windows) {
        text.make_ascii_lowercase();
    }
    Ok(format!("{:x}", Sha256::digest(text.as_bytes())))
}

fn decorate(mut value: Value, scope: &str, revision: u64) -> Value {
    value["scope"] = json!(scope);
    value["runtimeRevision"] = json!(revision);
    value
}

fn legacy_api_project_state(state: &Value) -> bool {
    !codex_project_compat::has_content_owner_state(state)
        && state.get("electron-account-renderer-state-v1")
            .and_then(Value::as_object)
            .is_some_and(|envelope| envelope.get("owner") == Some(&Value::Null)
                && envelope.get("inactive").is_some_and(Value::is_object))
}

// A cached snapshot, caller's earlier JSON, or absent SQLite file is not proof
// that this request belongs to an audited legacy API session. Pin the actual
// auth and native bytes to one home/generation until publication or CAS.
struct LegacyApiProjectScope<'a> {
    home: &'a Path,
    scope: String,
    revision: u64,
    auth_digest: [u8; 32],
    native_bytes: Vec<u8>,
    native: Value,
}

impl<'a> LegacyApiProjectScope<'a> {
    fn load(home: &'a Path) -> Option<Self> {
        if codex_project_compat::has_native_global_state_db(home) { return None; }
        let revision = current_codex_runtime_revision();
        let scope = scope(home).ok()?;
        let auth = codex_api_local_projects::read_bounded_bytes(&home.join("auth.json")).ok()??;
        if !codex_api_mode::enabled(Some(&serde_json::from_slice(&auth).ok()?)) { return None; }
        let native_bytes = codex_api_local_projects::read_bounded_bytes(&home.join(".codex-global-state.json")).ok()??;
        let native = serde_json::from_slice(&native_bytes).ok()?;
        if !legacy_api_project_state(&native) || codex_project_compat::has_native_global_state_db(home) { return None; }
        Some(Self { home, scope, revision, auth_digest: Sha256::digest(auth).into(), native_bytes, native })
    }

    fn verify(&self) -> Result<(), String> {
        let active = || current_codex_runtime_revision() == self.revision
            && active_home().as_deref() == Ok(self.home)
            && !codex_project_compat::has_native_global_state_db(self.home);
        let read = |name: &str| codex_api_local_projects::read_bounded_bytes(&self.home.join(name)).ok().flatten();
        if !active() || scope(self.home).as_deref() != Ok(self.scope.as_str())
            || !read("auth.json").is_some_and(|bytes| <[u8; 32]>::from(Sha256::digest(bytes)) == self.auth_digest)
            || read(".codex-global-state.json").as_deref() != Some(self.native_bytes.as_slice())
            || !active()
        {
            return Err("当前原生项目范围未验证，未修改本地项目缓存。".into());
        }
        Ok(())
    }

    fn prepare(&self) -> Result<Option<Value>, String> {
        let selected = verified_native_project_source(self.home, &self.native)?;
        let source = selected.as_ref().unwrap_or(&self.native);
        let databases = with_codex_dir(self.home, codex_state_sqlite_paths);
        codex_api_local_projects::prepare_if_current(self.home, source, &databases, &|| self.verify())
    }

    fn decorate(&self, value: Value) -> Value {
        decorate(value, &self.scope, self.revision)
    }
}

// Native main54827 derives renderer owners from the ordered user/account pair.
// The return-account baseline is the only authority: never inspect another
// account merely because its inactive state exists or its snapshot is newer.
fn baseline_owner(
    baseline: codex_relay_restore::ExplicitAuthBaseline,
) -> Result<Option<String>, String> {
    use codex_relay_restore::ExplicitAuthBaseline;
    let auth = match baseline {
        ExplicitAuthBaseline::Account(key) => {
            // read_registry repairs damaged files; this recovery selector is
            // strictly read-only and must reject them instead.
            let Some(registry) = read_json_if_exists(&codex_registry_path())? else {
                return Ok(None);
            };
            let Some(items) = registry.get("items").and_then(Value::as_array) else {
                return Ok(None);
            };
            let mut matches = items.iter().filter(|item| {
                item.get("accountKey").and_then(Value::as_str) == Some(key.as_str())
            });
            let Some(item) = matches.next() else {
                return Ok(None);
            };
            if matches.next().is_some() {
                return Ok(None);
            }
            let path = item
                .get("snapshotPath")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| snapshot_path_for_key(&key));
            let Some(auth) = read_json_if_exists(&path)? else {
                return Ok(None);
            };
            if auth_account_key(&auth) != key {
                return Ok(None);
            }
            let identity = codex_auth_identity(&auth);
            if identity.0.is_empty()
                || identity.1.is_empty()
                || item.get("userId").and_then(Value::as_str) != Some(identity.0.as_str())
                || item.get("accountId").and_then(Value::as_str) != Some(identity.1.as_str())
                || item
                    .get("organizationId")
                    .and_then(Value::as_str)
                    .is_some_and(|org| !org.is_empty() && org != identity.2)
            {
                return Ok(None);
            }
            auth
        }
        ExplicitAuthBaseline::Preserved { auth, .. } => auth,
        // An in-place baseline has no saved credentials. Pure API auth cannot
        // prove its former identity, so do not guess from registry metadata.
        ExplicitAuthBaseline::PreservedInPlace { .. }
        | ExplicitAuthBaseline::SignedOut
        | ExplicitAuthBaseline::Unknown => return Ok(None),
    };
    if !codex_auth_is_real_account_snapshot(&auth) {
        return Ok(None);
    }
    let (user, account, _) = codex_auth_identity(&auth);
    if user.is_empty() || account.is_empty() {
        return Ok(None);
    }
    let pair = serde_json::to_vec(&[user, account])
        .map_err(|_| "无法校验原登录的本地项目来源。".to_string())?;
    Ok(Some(format!("{:x}", Sha256::digest(pair))))
}

/// Older API launches already moved project globals into an inactive owner.
/// Recover that exact owner's local data using the saved return identity only.
/// This selects an in-memory migration source; it never changes auth or the
/// native envelope, and consumers still validate the exact home and database.
pub(super) fn verified_native_project_source(
    home: &Path,
    state: &Value,
) -> Result<Option<Value>, String> {
    if codex_project_compat::has_native_global_state_db(home)
        || codex_project_compat::has_content_owner_state(state)
        || state
        .get("local-projects")
        .is_some_and(|catalog| !catalog.is_null())
    {
        return Ok(None);
    }
    // An existing API snapshot owns subsequent edits/deletions. Even a broken
    // snapshot must not be silently replaced with an older account catalog.
    match fs::symlink_metadata(home.join(".gaoge-api-local-projects.json")) {
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法确认已有 API 本地项目缓存，未读取旧账号项目。".to_string()),
    }
    let auth = read_json_if_exists(&home.join("auth.json"))?;
    if !codex_api_mode::enabled(auth.as_ref()) {
        return Ok(None);
    }
    let Some(envelope) = state.get("electron-account-renderer-state-v1") else {
        return Ok(None);
    };
    if envelope.get("owner") != Some(&Value::Null) {
        return Ok(None);
    }
    let Some(inactive) = envelope.get("inactive").and_then(Value::as_object) else {
        return Ok(None);
    };
    let owner = with_codex_dir(home, || {
        codex_relay_restore::explicit_auth_baseline()?
            .map(baseline_owner)
            .transpose()
    })?
    .flatten();
    let Some(owner) = owner else {
        return Ok(None);
    };
    let Some(globals) = inactive.get(&owner).and_then(|saved| saved.get("globals")) else {
        return Ok(None);
    };
    let identity = format!("local:{}", home.to_string_lossy());
    if !globals.get("local-projects").is_some_and(Value::is_object)
        || !globals
            .get("app-server-project-id-by-legacy-project-id-by-host")
            .and_then(|hosts| hosts.get(&identity))
            .is_some_and(Value::is_object)
    {
        return Ok(None);
    }
    Ok(Some(globals.clone()))
}

/// Runs after offline membership recovery, before restarting the native client.
/// The caller recorded official auth before replacing it. Only that explicit
/// transition may merge an official baseline; API restarts keep their edits.
pub(super) fn prepare_for_login(was_official: bool) -> Result<(), String> {
    let home = active_home()?;
    if !was_official {
        if let Some(grant) = LegacyApiProjectScope::load(&home) {
            grant.prepare()?;
        }
        return Ok(());
    }
    if codex_project_compat::has_native_global_state_db(&home) {
        return Ok(());
    }
    let Some(source) = read_json_if_exists(&home.join(".codex-global-state.json"))? else {
        return Ok(());
    };
    if codex_project_compat::has_content_owner_state(&source) {
        return Ok(());
    }
    let selected = verified_native_project_source(&home, &source)?;
    let source = selected.as_ref().unwrap_or(&source);
    let databases = with_codex_dir(&home, codex_state_sqlite_paths);
    codex_api_local_projects::capture_with_databases(&home, source, &databases)?;
    Ok(())
}

// A read-only grant for the reviewed native shared-store path. This never
// reads or exports the legacy cache, nor treats a SQLite filename as proof of
// project ownership. The renderer must independently verify its exact native
// contract, hydration, signed-out API owner and project RPC readback.
fn native_shared_grant(home: &Path) -> Result<Option<Value>, String> {
    let revision = current_codex_runtime_revision();
    let Some(auth_bytes) = codex_api_local_projects::read_bounded_bytes(&home.join("auth.json"))? else { return Ok(None); };
    let auth: Value = match serde_json::from_slice(&auth_bytes) { Ok(value) => value, Err(_) => return Ok(None) };
    if !codex_api_mode::enabled(Some(&auth)) { return Ok(None); }
    let native_shared = codex_project_compat::has_native_global_state_db(home)
        || codex_api_local_projects::read_bounded_bytes(&home.join(".codex-global-state.json"))?
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .is_some_and(|state| state["electron-renderer-content-owner"] == "signed-out");
    if !native_shared { return Ok(None); }
    let home_scope = scope(home)?;
    if active_home()?.as_path() != home || current_codex_runtime_revision() != revision
        || codex_api_local_projects::read_bounded_bytes(&home.join("auth.json"))?.as_deref() != Some(auth_bytes.as_slice()) {
        return Ok(None);
    }
    Ok(Some(decorate(json!({"version":1,"storage":"native-shared"}), &home_scope, revision)))
}

/// Called before launch as well as by the status poll. Preparation only seeds
/// a missing dedicated snapshot; it never replaces API edits with disk globals.
pub(super) fn runtime_payload(native_state: Option<&Value>) -> Result<Value, String> {
    let home = active_home()?;
    if let Some(grant) = native_shared_grant(&home)? { return Ok(grant); }
    let unavailable = || Ok(decorate(json!({
        "version": 1, "unavailable": true, "reason": "unverified-native-project-scope"
    }), &scope(&home)?, current_codex_runtime_revision()));
    if native_state.is_some_and(|state| !legacy_api_project_state(state)) { return unavailable(); }
    let Some(grant) = LegacyApiProjectScope::load(&home) else { return unavailable(); };
    let snapshot = grant.prepare();
    if grant.verify().is_err() {
        return unavailable();
    }
    let snapshot = snapshot?.unwrap_or_else(|| json!({
        "version": 1, "revision": 0,
        "globals": {"local-projects": {}, "electron-saved-workspace-roots": [], "electron-workspace-root-labels": {}},
        "memberships": {"assignments": {}, "projectlessThreadIds": []}
    }));
    Ok(grant.decorate(snapshot))
}

/// Prefer native quit so its pending global-state writes can flush before the
/// existing forced-stop fallback. Never contact an arbitrary browser page or
/// quit an official session through an old API grant.
#[cfg(not(test))]
pub(super) fn request_graceful_native_exit() {
    let request = (|| -> Result<bool, String> {
        let home = active_home()?;
        let auth = read_json_if_exists(&home.join("auth.json"))?;
        if !codex_api_mode::enabled(auth.as_ref())
            || probe_running_codex_app_dirs_with_additional_target(None)?.is_empty()
        {
            return Ok(false);
        }
        let target = query_cdp_targets(codex_runtime_debug_port())?
            .into_iter()
            .find(|target| target.target_type == "page" && cdp_page_target_priority(target) <= 1)
            .ok_or_else(|| "当前 API 原生页面不可用。".to_string())?;
        let websocket = target
            .web_socket_debugger_url
            .as_deref()
            .ok_or_else(|| "当前 API 原生连接不可用。".to_string())?;
        let expected =
            json!({"scope":scope(&home)?,"runtimeRevision":current_codex_runtime_revision()});
        let script = format!("(() => {{ const runtime = window.__gaogeCodexApiModeRuntime; return runtime?.requestGracefulExit?.({expected}) ?? {{ requested: false }}; }})()");
        Ok(cdp_evaluate_script(websocket, &script)?
            .get("requested")
            .and_then(Value::as_bool)
            == Some(true))
    })();
    if request != Ok(true) {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut stopped_checks = 0u8;
    while Instant::now() < deadline {
        match probe_running_codex_app_dirs_with_additional_target(None) {
            Ok(running) if running.is_empty() => {
                stopped_checks += 1;
                if stopped_checks >= 2 {
                    return;
                }
            }
            Ok(_) => stopped_checks = 0,
            Err(_) => return,
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
pub(super) fn request_graceful_native_exit() {}

/// The caller has confirmed native exit and still holds the foreground
/// configure lock. Preserve edits made just before shutdown without waiting
/// for the renderer poll; a native account-scoped receipt proves full hydration.
pub(super) fn finalize_after_native_exit() -> Result<(), String> {
    let home = active_home()?;
    if !home.is_dir() {
        return Ok(());
    }
    let auth = read_json_if_exists(&home.join("auth.json"))?;
    if !codex_api_mode::enabled(auth.as_ref()) {
        return Ok(());
    }
    codex_api_local_projects::finalize_native_state(&home, &scope(&home)?)?;
    Ok(())
}

pub(super) fn commit(payload: &Value) -> Result<Value, String> {
    // This is a short background save. Never block a foreground login waiting
    // for renderer verification: it retries after the switch finishes.
    let _guard = try_lock_recover(
        &CODEX_CONFIGURE_LOCK,
        "正在切换登录配置，本地项目稍后保存。",
    )?;
    let home = active_home()?;
    let grant = LegacyApiProjectScope::load(&home).ok_or("当前原生项目范围未验证，未修改本地项目缓存。")?;
    if payload.get("runtimeRevision").and_then(Value::as_u64) != Some(grant.revision)
        || payload.get("scope").and_then(Value::as_str) != Some(grant.scope.as_str())
    {
        return Err("本地项目保存来源已失效，未修改缓存。".to_string());
    }
    let expected = payload
        .get("expectedRevision")
        .and_then(Value::as_u64)
        .ok_or_else(|| "本地项目保存版本无效。".to_string())?;
    let globals = payload
        .get("globals")
        .ok_or_else(|| "本地项目目录缺失。".to_string())?;
    let memberships = payload
        .get("memberships")
        .ok_or_else(|| "本地项目成员状态缺失。".to_string())?;
    let saved = codex_api_local_projects::commit_if_current(&home, &grant.native,
        expected, globals, memberships, &|| grant.verify())?;
    grant.verify()?;
    Ok(json!({"ok": true, "apiLocalProjects": grant.decorate(saved)}))
}

#[cfg(test)]
#[path = "codex_api_project_bridge_tests.rs"]
mod tests;
