//! Identify an unambiguous API-key login before constraining desktop mode.
//! This deliberately depends on live auth, not route or enhancement settings.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const RUNTIME_SCRIPT: &str = include_str!("codex_api_mode_runtime.js");
const PENDING_WARNING: &str = "纯 API 编码模式正在验证，完成前请勿切换到 Work。";
const LOCAL_PROJECTS_PENDING_WARNING: &str =
    "纯 API 的本地项目目录与成员尚未恢复完成，正在重试，尚未确认成功。";
const LOCAL_PROJECTS_SCOPE_WARNING: &str =
    "当前 Codex 的本地项目存储契约尚未验证，本次未改动项目分组。";
const STATUS_MAX_AGE: Duration = Duration::from_secs(15);

struct RecordedStatus {
    revision: u64,
    recorded_at: Instant,
    value: Value,
    verified: bool,
}

static RUNTIME_STATUS: Mutex<Option<RecordedStatus>> = Mutex::new(None);

/// The injected script is the only source of the runtime version.
pub fn runtime_version() -> u64 {
    RUNTIME_SCRIPT
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("var CODEX_API_MODE_RUNTIME_VERSION = ")?
                .strip_suffix(';')?
                .trim()
                .parse::<u64>()
                .ok()
        })
        .unwrap_or(0)
}

/// Require a live monitor and a verified native Coding policy, not just startup.
pub fn healthy(value: &Value, required: bool) -> bool {
    if !required {
        return true;
    }
    let version = runtime_version();
    version > 0
        && value.get("version").and_then(Value::as_u64) == Some(version)
        && value.get("enabled").and_then(Value::as_bool) == Some(true)
        && value.get("ready").and_then(Value::as_bool) == Some(true)
        && value.get("monitoring").and_then(Value::as_bool) == Some(true)
        && value.get("reason").and_then(Value::as_str) == Some("coding")
        && value.get("error").and_then(Value::as_str) == Some("")
        && ["localOnboarding", "localProjects"].into_iter().all(|key| {
            value
                .get(key)
                .is_none_or(|state| state.get("ready").and_then(Value::as_bool) == Some(true))
        })
}

/// Retain only public status fields. Renderer messages and identity data are
/// untrusted and must never reach the cached response or launch warnings.
pub fn record(value: &Value, revision: u64) {
    let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
    let raw_error = value.get("error").and_then(Value::as_str).unwrap_or("");
    let malformed_error = value.get("error").is_some_and(|value| !value.is_string());
    let projects = &value["localProjects"];
    let projects_not_ready = projects["ready"].as_bool() == Some(false);
    let reason = if raw_error.starts_with("Unsupported Codex API mode contract:")
        || raw_error.starts_with("Codex mode asset unavailable:")
        || (version != 0 && version != runtime_version())
    {
        "unsupported-runtime"
    } else if !raw_error.is_empty() || malformed_error {
        "verification-failed"
    } else {
        match value.get("reason").and_then(Value::as_str) {
            Some("coding") => "coding",
            Some("awaiting-bindings") => "awaiting-bindings",
            Some("awaiting-native-auth") | Some("not-api-login") => "awaiting-native-auth",
            Some("awaiting-native-policy") => "awaiting-native-policy",
            Some("awaiting-native-onboarding-state") => "awaiting-native-onboarding-state",
            Some("awaiting-native-local-projects")
                if projects_not_ready
                    && projects["reason"] == "unverified-native-project-scope" =>
            {
                "unsupported-local-project-scope"
            }
            // The cached status retains only the public reason and the ready bit.
            Some("unsupported-local-project-scope") if projects_not_ready => {
                "unsupported-local-project-scope"
            }
            Some("awaiting-native-local-projects") => "awaiting-native-local-projects",
            Some("normalizing-selection") => "normalizing-selection",
            Some("verification-failed") => "verification-failed",
            Some("unsupported-runtime") => "unsupported-runtime",
            _ => "awaiting-runtime",
        }
    };
    let error = match reason {
        "unsupported-runtime" => "当前 Codex 版本的纯 API 编码模式尚未适配，尚未确认成功。",
        "verification-failed" => "纯 API 编码模式验证未通过，尚未确认成功，正在重试。",
        _ => "",
    };
    let mut safe = json!({
        "version": version,
        "enabled": value.get("enabled").and_then(Value::as_bool) == Some(true),
        "ready": value.get("ready").and_then(Value::as_bool) == Some(true),
        "monitoring": value.get("monitoring").and_then(Value::as_bool) == Some(true),
        "reason": reason,
        "error": error,
    });
    for key in ["localOnboarding", "localProjects"] {
        if let Some(local) = value.get(key) {
            safe[key] = json!({"ready": local.get("ready").and_then(Value::as_bool) == Some(true)});
        }
    }
    if value.get("serviceMode").and_then(Value::as_str) == Some("native-observer") {
        safe["serviceMode"] = json!("native-observer");
    }
    if let Ok(mut status) = RUNTIME_STATUS.lock() {
        *status = Some(RecordedStatus {
            revision,
            recorded_at: Instant::now(),
            value: safe,
            verified: healthy(value, true),
        });
    }
}

/// Native marks these two atoms as shared between renderer owners. The new
/// account-scoped bootstrap accidentally omits even shared atoms for API auth.
/// Return only real completion evidence; never copy an account's renderer map.
pub fn local_onboarding(state: Option<&Value>) -> Option<Value> {
    let atoms = state?.get("electron-persisted-atom-state")?.as_object()?;
    if atoms
        .get("electron:onboarding-projectless-completed")?
        .as_bool()
        != Some(true)
    {
        return None;
    }
    let completed_at = atoms.get("last_completed_onboarding")?.as_u64()?;
    if completed_at == 0 || completed_at > 253_402_300_799 {
        return None;
    }
    Some(json!({"projectlessCompleted": true, "completedAt": completed_at}))
}

/// A new launch must not inherit successful verification from an old process.
pub fn reset() {
    if let Ok(mut status) = RUNTIME_STATUS.lock() {
        *status = None;
    }
}

pub fn status(required: bool, revision: u64) -> Value {
    let mut result = json!({
        "requested": required,
        "enabled": required,
        "ready": false,
        "verified": false,
        "monitoring": false,
        "version": runtime_version(),
        "reason": if required { "awaiting-runtime" } else { "disabled" },
        "error": "",
        "warnings": if required { vec![PENDING_WARNING] } else { vec![] },
    });
    if !required {
        return result;
    }
    let Ok(status) = RUNTIME_STATUS.lock() else {
        return result;
    };
    let Some(recorded) = status.as_ref().filter(|status| {
        status.revision == revision && status.recorded_at.elapsed() <= STATUS_MAX_AGE
    }) else {
        return result;
    };
    let verified = recorded.verified && healthy(&recorded.value, true);
    result["version"] = recorded.value["version"].clone();
    result["monitoring"] = recorded.value["monitoring"].clone();
    result["reason"] = recorded.value["reason"].clone();
    result["error"] = recorded.value["error"].clone();
    for name in ["localOnboarding", "localProjects", "serviceMode"] {
        if let Some(value) = recorded.value.get(name) {
            result[name] = value.clone();
        }
    }
    result["ready"] = json!(verified);
    result["verified"] = json!(verified);
    let error = recorded.value["error"].as_str().unwrap_or("");
    result["warnings"] = if verified {
        json!([])
    } else if !error.is_empty() {
        json!([error])
    } else if recorded.value["reason"] == "unsupported-local-project-scope" {
        json!([LOCAL_PROJECTS_SCOPE_WARNING])
    } else if recorded.value["reason"] == "awaiting-native-local-projects" {
        json!([LOCAL_PROJECTS_PENDING_WARNING])
    } else {
        json!([PENDING_WARNING])
    };
    result
}

// These also cover imported ChatGPT session shapes. A partial identity must
// not be treated as an API-only login merely because its tokens are missing.
const ACCOUNT_EVIDENCE_FIELDS: &[&str] = &[
    "access_token",
    "accessToken",
    "id_token",
    "idToken",
    "refresh_token",
    "refreshToken",
    "account",
    "account_id",
    "accountId",
    "chatgpt_account_id",
    "chatgptAccountId",
    "user",
    "user_id",
    "userId",
    "chatgpt_user_id",
    "chatgptUserId",
    "email",
    "principal",
    "session",
    "organization_id",
    "organizationId",
    "chatgpt_organization_id",
    "chatgpt_org_id",
    "https://api.openai.com/auth",
];

fn has_material(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        // A malformed token or identity field is ambiguous, not proof that
        // the account is absent. Preserve native mode for these shapes.
        _ => true,
    }
}

/// Whether the actual auth document unambiguously represents API-only login.
/// The caller must pass freshly read auth for the desktop's active Codex home.
pub fn enabled(auth: Option<&Value>) -> bool {
    let Some(auth) = auth.and_then(Value::as_object) else {
        return false;
    };
    if !auth
        .get("OPENAI_API_KEY")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
    {
        return false;
    }
    match auth.get("auth_mode") {
        None => {}
        Some(Value::String(mode)) if mode == "apikey" => {}
        _ => return false,
    }
    if ACCOUNT_EVIDENCE_FIELDS
        .iter()
        .any(|field| auth.get(*field).is_some_and(has_material))
    {
        return false;
    }
    match auth.get("tokens") {
        None | Some(Value::Null) => true,
        // Unknown nonempty token fields can also belong to a newer account
        // schema. Only an entirely empty token document is safe to classify.
        Some(Value::Object(tokens)) => !tokens.values().any(has_material),
        _ => false,
    }
}

/// Prepare the native desktop preference before the first renderer starts.
/// Runtime verification remains necessary: a saved preference is not proof
/// that the live account policy or all renderer scopes have selected Codex.
fn coding_startup_config(config: &str) -> Result<String, String> {
    let mut document = config
        .parse::<toml_edit::Document>()
        .map_err(|_| "纯 API 模式准备失败：config.toml 格式无效，已保留原文件。".to_string())?;
    if document.get("desktop").is_none() {
        document.insert("desktop", toml_edit::Item::Table(toml_edit::Table::new()));
    }
    let desktop = document
        .get_mut("desktop")
        .and_then(toml_edit::Item::as_table_like_mut)
        .ok_or_else(|| "纯 API 模式准备失败：desktop 必须是配置表，已保留原文件。".to_string())?;
    if desktop
        .get("conversationDetailMode")
        .and_then(toml_edit::Item::as_str)
        == Some("STEPS_COMMANDS")
    {
        return Ok(config.to_string());
    }
    let mut mode = toml_edit::Value::from("STEPS_COMMANDS");
    if let Some(previous) = desktop
        .get("conversationDetailMode")
        .and_then(toml_edit::Item::as_value)
    {
        *mode.decor_mut() = previous.decor().clone();
    }
    desktop.insert("conversationDetailMode", toml_edit::Item::Value(mode));
    Ok(document.to_string())
}

/// Only the active desktop home is prepared. Official, mixed, loading and
/// missing auth documents never qualify merely because a relay is configured.
pub fn prepare_startup(config_path: &std::path::Path) -> Result<bool, String> {
    let auth_path = config_path.with_file_name("auth.json");
    let auth = crate::read_json_if_exists(&auth_path)?;
    if !enabled(auth.as_ref()) {
        return Ok(false);
    }
    let existing = crate::read_text_if_exists(config_path)?;
    let prepared = coding_startup_config(&existing)?;
    if prepared == existing {
        return Ok(false);
    }
    if crate::read_json_if_exists(&auth_path)? != auth {
        return Err("纯 API 模式准备期间登录状态发生变化，请重试。".to_string());
    }
    crate::write_codex_config_atomic(config_path, Some(&existing), &prepared)?;
    Ok(true)
}

/// Reuse an already valid API login without discarding native metadata.
/// Account evidence still wins: a mixed ChatGPT/API document must be replaced
/// only by the explicit login flow, never mistaken for the same API identity.
pub fn matches_api_key(auth: Option<&Value>, api_key: &str) -> bool {
    enabled(auth)
        && auth
            .and_then(|value| value.get("OPENAI_API_KEY"))
            .and_then(Value::as_str)
            == Some(api_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    static STATUS_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn api_startup_normalizes_native_preference_and_preserves_comments_and_unrelated_settings() {
        let original = "# user config\nmodel = \"custom-model\"\n[desktop] # native settings\nconversationDetailMode = \"STEPS_PROSE\" # keep this comment\ncustomSetting = true\n[mcp_servers.example]\ncommand = \"example\"\n";
        let prepared = coding_startup_config(original).unwrap();
        let parsed = prepared.parse::<toml_edit::Document>().unwrap();
        assert_eq!(
            parsed["desktop"]["conversationDetailMode"].as_str(),
            Some("STEPS_COMMANDS")
        );
        assert_eq!(parsed["model"].as_str(), Some("custom-model"));
        assert_eq!(parsed["desktop"]["customSetting"].as_bool(), Some(true));
        assert_eq!(
            parsed["mcp_servers"]["example"]["command"].as_str(),
            Some("example")
        );
        for comment in ["# user config", "# native settings", "# keep this comment"] {
            assert!(prepared.contains(comment));
        }
        assert_eq!(coding_startup_config(&prepared).unwrap(), prepared);
    }

    #[test]
    fn api_startup_supports_inline_and_missing_desktop_tables_but_rejects_corruption() {
        for original in [
            "",
            "model = \"custom\"\n",
            "desktop = { conversationDetailMode = \"STEPS_PROSE\", other = true }\n",
        ] {
            let prepared = coding_startup_config(original).unwrap();
            let parsed = prepared.parse::<toml_edit::Document>().unwrap();
            assert_eq!(
                parsed["desktop"]["conversationDetailMode"].as_str(),
                Some("STEPS_COMMANDS")
            );
        }
        for original in [
            "desktop = false\n",
            "desktop = \"broken\"\n",
            "[desktop\n",
            "[[desktop]]\n",
        ] {
            assert!(coding_startup_config(original).is_err());
        }
    }

    #[test]
    fn api_startup_prepares_only_confirmed_api_home_and_keeps_auth_bytes() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("config.toml");
        let auth = home.path().join("auth.json");
        let original = "[desktop]\nconversationDetailMode = \"STEPS_PROSE\"\n";
        for value in [
            json!({"auth_mode":"chatgpt","tokens":{"access_token":"fixture-token"}}),
            json!({"OPENAI_API_KEY":"fixture-key","tokens":{"account_id":"fixture-account"}}),
            json!({"auth_mode":"chatgpt","OPENAI_API_KEY":"fixture-key"}),
            json!({}),
        ] {
            std::fs::write(&auth, value.to_string()).unwrap();
            std::fs::write(&config, original).unwrap();
            assert!(!prepare_startup(&config).unwrap());
            assert_eq!(std::fs::read_to_string(&config).unwrap(), original);
        }
        let identity = "{\n  \"auth_mode\": \"apikey\", \"OPENAI_API_KEY\": \"fixture-key\", \"metadata\": {\"native\": true}\n}\n";
        std::fs::write(&auth, identity).unwrap();
        assert!(prepare_startup(&config).unwrap());
        assert_eq!(std::fs::read_to_string(&auth).unwrap(), identity);
        assert!(!prepare_startup(&config).unwrap());
        assert_eq!(std::fs::read_to_string(&auth).unwrap(), identity);
    }

    #[test]
    fn api_startup_missing_auth_is_untouched_and_invalid_config_is_never_overwritten() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("config.toml");
        assert!(!prepare_startup(&config).unwrap());
        assert!(!config.exists());
        std::fs::write(
            home.path().join("auth.json"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"fixture-key"}"#,
        )
        .unwrap();
        assert!(prepare_startup(&config).unwrap());
        for invalid in ["[desktop", "desktop = false\n"] {
            std::fs::write(&config, invalid).unwrap();
            assert!(prepare_startup(&config).is_err());
            assert_eq!(std::fs::read_to_string(&config).unwrap(), invalid);
        }
    }

    #[test]
    fn local_projects_health_requires_verified_native_catalog_and_persistence() {
        with_status_test(|| {
            for ready in [
                json!(true),
                json!(false),
                json!(null),
                json!("true"),
                json!(1),
            ] {
                let mut runtime = verified_runtime();
                runtime["localProjects"] =
                    json!({"ready":ready,"catalog":"private-project-data","scope":"private-home"});
                let expected = ready == json!(true);
                assert_eq!(healthy(&runtime, true), expected);
                record(&runtime, 79);
                let recorded = status(true, 79);
                assert_eq!(recorded["verified"], expected);
                assert_eq!(recorded["localProjects"], json!({"ready":expected}));
                assert!(!recorded.to_string().contains("private-"));
                record(&recorded, 79);
                assert_eq!(status(true, 79), recorded);
            }
        });
    }

    #[test]
    fn verified_scope_limitation_has_a_static_warning_and_survives_sanitization() {
        with_status_test(|| {
            let mut raw = verified_runtime();
            raw["reason"] = json!("awaiting-native-local-projects");
            raw["localProjects"] = json!({"ready":false, "reason":"unverified-native-project-scope",
                "scope":"private-owner", "error":"private-path"});
            record(&raw, 31);
            let public = status(true, 31);
            assert_eq!(public["reason"], "unsupported-local-project-scope");
            assert_eq!(public["warnings"], json!([LOCAL_PROJECTS_SCOPE_WARNING]));
            assert_eq!(public["localProjects"], json!({"ready":false}));
            assert_eq!(public["ready"], false);
            assert_eq!(public["verified"], false);
            assert!(!public.to_string().contains("private-"));
            record(&public, 31);
            assert_eq!(status(true, 31), public);

            for (reason, local, expected) in [
                (
                    "awaiting-native-local-projects",
                    json!({"ready":false,"reason":"unknown-native-project-owner"}),
                    "awaiting-native-local-projects",
                ),
                (
                    "awaiting-native-local-projects",
                    json!({"ready":"false","reason":"unverified-native-project-scope"}),
                    "awaiting-native-local-projects",
                ),
                (
                    "unsupported-local-project-scope",
                    json!({"ready":true}),
                    "awaiting-runtime",
                ),
            ] {
                raw["reason"] = json!(reason);
                raw["localProjects"] = local;
                record(&raw, 31);
                let result = status(true, 31);
                assert_eq!(result["reason"], expected);
                assert_eq!(result["verified"], false);
                assert_ne!(result["warnings"], json!([LOCAL_PROJECTS_SCOPE_WARNING]));
            }
        });
    }

    #[test]
    fn coding_success_cannot_hide_incomplete_shared_onboarding_restore() {
        let mut runtime = verified_runtime();
        runtime["localOnboarding"] = json!({"ready": false});
        assert!(!healthy(&runtime, true));
        runtime["localOnboarding"] = json!({"ready": true});
        assert!(healthy(&runtime, true));
    }

    #[test]
    fn local_onboarding_status_sanitization_preserves_strict_health_across_round_trips() {
        with_status_test(|| {
            let cases = [
                (None, true),
                (
                    Some(
                        json!({"ready": true, "reason": "private-completion-reason", "accountId": "private-account"}),
                    ),
                    true,
                ),
                (Some(json!({"ready": false})), false),
                (Some(Value::Null), false),
                (Some(json!([])), false),
                (Some(json!(true)), false),
                (Some(json!({})), false),
                (Some(json!({"ready": "true"})), false),
                (Some(json!({"ready": 1})), false),
                (Some(json!({"ready": null})), false),
            ];
            for (local, expected) in cases {
                let mut runtime = verified_runtime();
                if let Some(value) = &local {
                    runtime["localOnboarding"] = value.clone();
                }
                assert_eq!(healthy(&runtime, true), expected, "raw status: {local:?}");
                record(&runtime, 71);
                let first = status(true, 71);
                assert_eq!(first["ready"], expected, "recorded status: {local:?}");
                assert_eq!(first["verified"], expected);
                assert_eq!(healthy(&first, true), expected);
                assert!(!first.to_string().contains("private-"));
                if local.is_some() {
                    assert_eq!(first["localOnboarding"], json!({"ready": expected}));
                } else {
                    assert!(first.get("localOnboarding").is_none());
                }
                record(&first, 71);
                assert_eq!(
                    status(true, 71),
                    first,
                    "sanitizing again must neither promote nor degrade health: {local:?}"
                );
            }
        });
    }

    #[test]
    fn runtime_service_mode_only_retains_the_known_public_observer_label() {
        with_status_test(|| {
            for mode in [
                json!("native-observer"),
                json!("private-mode"),
                Value::Null,
                json!(true),
                json!({"accountId":"private-account"}),
            ] {
                let mut runtime = verified_runtime();
                runtime["serviceMode"] = mode.clone();
                record(&runtime, 72);
                let current = status(true, 72);
                assert_eq!(current["verified"], true);
                assert!(!current.to_string().contains("private-"));
                if mode == "native-observer" {
                    assert_eq!(current["serviceMode"], "native-observer");
                } else {
                    assert!(current.get("serviceMode").is_none());
                }
                record(&current, 72);
                assert_eq!(status(true, 72), current);
            }
        });
    }

    #[test]
    fn local_onboarding_requires_both_native_shared_completion_atoms() {
        let completed = json!({"electron-persisted-atom-state": {
            "electron:onboarding-projectless-completed": true,
            "last_completed_onboarding": 1794134871,
            "electron:onboarding-role-state": {"accountId": "private-account"},
            "private-session": "never-export"
        }});
        assert_eq!(
            local_onboarding(Some(&completed)),
            Some(json!({
                "projectlessCompleted": true, "completedAt": 1794134871
            }))
        );
        for invalid in [
            Value::Null,
            json!({}),
            json!({"electron-persisted-atom-state": []}),
            json!({"electron-persisted-atom-state": {"electron:onboarding-projectless-completed": true}}),
        ] {
            assert!(local_onboarding(Some(&invalid)).is_none());
        }
        for flag in [Value::Null, json!(false), json!("true"), json!(1)] {
            let mut state = completed.clone();
            state["electron-persisted-atom-state"]["electron:onboarding-projectless-completed"] =
                flag;
            assert!(local_onboarding(Some(&state)).is_none());
        }
        for time in [
            Value::Null,
            json!(0),
            json!(-1),
            json!("1794134871"),
            json!(1.25),
            json!(253_402_300_800_u64),
        ] {
            let mut state = completed.clone();
            state["electron-persisted-atom-state"]["last_completed_onboarding"] = time;
            assert!(local_onboarding(Some(&state)).is_none());
        }
        assert!(local_onboarding(None).is_none());
    }

    fn verified_runtime() -> Value {
        json!({
            "version": runtime_version(),
            "enabled": true,
            "ready": true,
            "monitoring": true,
            "reason": "coding",
            "error": "",
        })
    }

    fn with_status_test(test: impl FnOnce()) {
        let _lock = STATUS_TEST_LOCK.lock().unwrap();
        reset();
        test();
        reset();
    }

    #[test]
    fn health_requires_current_runtime_and_native_coding_verification() {
        assert!(runtime_version() > 0);
        assert!(healthy(&verified_runtime(), true));
        for field in ["enabled", "ready", "monitoring"] {
            for value in [json!(false), json!(null), json!("true")] {
                let mut runtime = verified_runtime();
                runtime[field] = value;
                assert!(!healthy(&runtime, true));
            }
        }
        for (field, value) in [
            ("version", json!(runtime_version() + 1)),
            ("reason", json!("awaiting-native-policy")),
            ("reason", json!(null)),
            ("error", json!("failed")),
            ("error", json!(null)),
        ] {
            let mut runtime = verified_runtime();
            runtime[field] = value;
            assert!(!healthy(&runtime, true));
        }
        for field in [
            "version",
            "enabled",
            "ready",
            "monitoring",
            "reason",
            "error",
        ] {
            let mut runtime = verified_runtime();
            runtime.as_object_mut().unwrap().remove(field);
            assert!(!healthy(&runtime, true));
        }
    }

    #[test]
    fn inactive_api_guard_does_not_require_or_report_runtime_success() {
        for runtime in [json!(null), json!({}), verified_runtime()] {
            assert!(healthy(&runtime, false));
        }
        with_status_test(|| {
            record(&verified_runtime(), 1);
            let disabled = status(false, 1);
            assert_eq!(disabled["requested"], false);
            assert_eq!(disabled["enabled"], false);
            assert_eq!(disabled["verified"], false);
            assert_eq!(disabled["reason"], "disabled");
            assert_eq!(disabled["warnings"], json!([]));
        });
    }

    #[test]
    fn unrecorded_reset_and_stale_revisions_remain_pending() {
        with_status_test(|| {
            let pending = status(true, 5);
            assert_eq!(pending["ready"], false);
            assert_eq!(pending["verified"], false);
            assert_eq!(pending["warnings"], json!([PENDING_WARNING]));
            record(&verified_runtime(), 4);
            assert_eq!(status(true, 5), pending);
            record(&verified_runtime(), 5);
            assert_eq!(status(true, 5)["verified"], true);
            reset();
            assert_eq!(status(true, 5), pending);
        });
    }

    #[test]
    fn same_revision_verified_runtime_is_ready_without_warning() {
        with_status_test(|| {
            record(&verified_runtime(), 9);
            let current = status(true, 9);
            assert_eq!(current["ready"], true);
            assert_eq!(current["verified"], true);
            assert_eq!(current["monitoring"], true);
            assert_eq!(current["reason"], "coding");
            assert_eq!(current["warnings"], json!([]));
        });
    }

    #[test]
    fn expired_verification_returns_to_pending_until_refreshed() {
        with_status_test(|| {
            record(&verified_runtime(), 9);
            assert_eq!(status(true, 9)["verified"], true);
            {
                let mut cached = RUNTIME_STATUS.lock().unwrap();
                cached.as_mut().unwrap().recorded_at -= Duration::from_secs(16);
            }
            let expired = status(true, 9);
            assert_eq!(expired["ready"], false);
            assert_eq!(expired["verified"], false);
            assert_eq!(expired["monitoring"], false);
            assert_eq!(expired["reason"], "awaiting-runtime");
            assert_eq!(expired["warnings"], json!([PENDING_WARNING]));
            record(&verified_runtime(), 9);
            assert_eq!(status(true, 9)["verified"], true);
        });
    }

    #[test]
    fn cached_errors_never_expose_renderer_messages_or_identity() {
        with_status_test(|| {
            for (error, expected_reason) in [
                ("private-value", "verification-failed"),
                (
                    "Codex mode asset unavailable: private-value",
                    "unsupported-runtime",
                ),
                (
                    "Unsupported Codex API mode contract: private-value",
                    "unsupported-runtime",
                ),
            ] {
                let mut runtime = verified_runtime();
                runtime["error"] = json!(error);
                runtime["accountId"] = json!("private-account");
                runtime["OPENAI_API_KEY"] = json!("private-api-key");
                runtime["warnings"] = json!(["private-warning"]);
                record(&runtime, 10);
                let current = status(true, 10);
                assert_eq!(current["verified"], false);
                assert_eq!(current["reason"], expected_reason);
                assert!(current["error"].as_str().unwrap().contains("尚未确认成功"));
                assert!(!current.to_string().contains("private-"));
                assert!(current.get("accountId").is_none());
                assert!(current.get("OPENAI_API_KEY").is_none());
            }
        });
    }

    #[test]
    fn malformed_or_pending_runtime_cannot_become_verified_by_sanitizing() {
        with_status_test(|| {
            let mut missing_error = verified_runtime();
            missing_error.as_object_mut().unwrap().remove("error");
            record(&missing_error, 11);
            assert_eq!(status(true, 11)["verified"], false);
            for reason in [
                "awaiting-bindings",
                "awaiting-native-auth",
                "awaiting-native-policy",
                "normalizing-selection",
            ] {
                let mut runtime = verified_runtime();
                runtime["reason"] = json!(reason);
                record(&runtime, 11);
                let current = status(true, 11);
                assert_eq!(current["verified"], false);
                assert_eq!(current["warnings"], json!([PENDING_WARNING]));
            }
            record(&json!({ "reason": "private-reason" }), 11);
            assert_eq!(status(true, 11)["reason"], "awaiting-runtime");
            assert!(!status(true, 11).to_string().contains("private-reason"));
        });
    }

    #[test]
    fn incompatible_runtime_version_reports_unsuccessful_adaptation() {
        with_status_test(|| {
            let mut runtime = verified_runtime();
            runtime["version"] = json!(runtime_version() + 1);
            record(&runtime, 12);
            let current = status(true, 12);
            assert_eq!(current["ready"], false);
            assert_eq!(current["reason"], "unsupported-runtime");
            assert!(current["warnings"][0]
                .as_str()
                .unwrap()
                .contains("尚未适配"));
        });
    }

    fn api_auth() -> Value {
        json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "example-api-key" })
    }

    #[test]
    fn matching_api_login_preserves_native_metadata_and_legacy_shape() {
        let auth = json!({
            "auth_mode": "apikey", "OPENAI_API_KEY": "example-api-key",
            "tokens": null, "last_refresh": "native-value",
            "native_metadata": { "schema": 2 }
        });
        let before = auth.clone();
        assert!(matches_api_key(Some(&auth), "example-api-key"));
        assert_eq!(auth, before);
        assert!(matches_api_key(
            Some(&json!({
                "OPENAI_API_KEY": "example-api-key", "last_refresh": null
            })),
            "example-api-key"
        ));
        assert!(!matches_api_key(Some(&auth), "different-key"));
        assert!(!matches_api_key(None, "example-api-key"));
        assert!(!matches_api_key(
            Some(&json!({
                "auth_mode": "apikey", "OPENAI_API_KEY": "example-api-key",
                "tokens": { "account_id": "real-account" }
            })),
            "example-api-key"
        ));
    }

    #[test]
    fn enables_explicit_and_legacy_api_key_login() {
        assert!(enabled(Some(&api_auth())));
        assert!(enabled(Some(
            &json!({ "OPENAI_API_KEY": " example-api-key " })
        )));
        assert!(enabled(Some(&json!({
            "auth_mode": "apikey",
            "OPENAI_API_KEY": "example-api-key",
            "last_refresh": null,
            "unrelated_metadata": { "version": 1 }
        }))));
    }

    #[test]
    fn rejects_missing_or_non_object_auth() {
        assert!(!enabled(None));
        for auth in [
            json!(null),
            json!(false),
            json!(7),
            json!("invalid"),
            json!([]),
            json!({}),
        ] {
            assert!(!enabled(Some(&auth)));
        }
    }

    #[test]
    fn requires_nonempty_string_api_key() {
        for key in [
            json!(null),
            json!(""),
            json!(" \r\n\t"),
            json!(false),
            json!(7),
            json!([]),
            json!({}),
        ] {
            let mut auth = api_auth();
            auth["OPENAI_API_KEY"] = key;
            assert!(!enabled(Some(&auth)));
        }
        assert!(!enabled(Some(&json!({ "auth_mode": "apikey" }))));
    }

    #[test]
    fn requires_absent_or_exact_api_auth_mode() {
        for mode in [
            json!(null),
            json!(""),
            json!("chatgpt"),
            json!("chatgptAuthTokens"),
            json!("APIKEY"),
            json!(" apikey "),
            json!(false),
            json!(7),
            json!([]),
            json!({}),
        ] {
            let mut auth = api_auth();
            auth["auth_mode"] = mode;
            assert!(!enabled(Some(&auth)));
        }
    }

    #[test]
    fn accepts_null_and_empty_token_fields() {
        for tokens in [
            json!(null),
            json!({}),
            json!({ "access_token": null, "id_token": "", "refresh_token": " \t", "account_id": null }),
        ] {
            let mut auth = api_auth();
            auth["tokens"] = tokens;
            assert!(enabled(Some(&auth)));
        }
    }

    #[test]
    fn preserves_native_and_mixed_chatgpt_logins() {
        for field in [
            "access_token",
            "id_token",
            "refresh_token",
            "account_id",
            "future_account_token",
        ] {
            let mut mixed = api_auth();
            mixed["tokens"] = json!({});
            mixed["tokens"][field] = json!("account-material");
            assert!(!enabled(Some(&mixed)));
            mixed["OPENAI_API_KEY"] = Value::Null;
            assert!(!enabled(Some(&mixed)));
        }
        assert!(!enabled(Some(&json!({
            "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
            "tokens": { "access_token": "account-material" }
        }))));
    }

    #[test]
    fn rejects_malformed_token_containers_and_values() {
        for tokens in [json!(""), json!(false), json!(7), json!([])] {
            let mut auth = api_auth();
            auth["tokens"] = tokens;
            assert!(!enabled(Some(&auth)));
        }
        for value in [json!(false), json!(7), json!([]), json!({})] {
            let mut auth = api_auth();
            auth["tokens"] = json!({ "access_token": value });
            assert!(!enabled(Some(&auth)));
        }
    }

    #[test]
    fn preserves_partial_account_evidence_without_tokens() {
        for field in ACCOUNT_EVIDENCE_FIELDS {
            for value in [
                json!("account-material"),
                json!(false),
                json!(7),
                json!([]),
                json!({}),
            ] {
                let mut auth = api_auth();
                auth[*field] = value;
                assert!(!enabled(Some(&auth)), "identity field {field}");
            }
        }
    }

    #[test]
    fn ignores_null_or_blank_identity_fields_without_mutating_auth() {
        let mut auth = api_auth();
        for (index, field) in ACCOUNT_EVIDENCE_FIELDS.iter().enumerate() {
            auth[*field] = if index % 2 == 0 {
                Value::Null
            } else {
                json!(" \t")
            };
        }
        let original = auth.clone();
        assert!(enabled(Some(&auth)));
        assert_eq!(auth, original);
    }
}
