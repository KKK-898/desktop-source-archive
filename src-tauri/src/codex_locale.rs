//! Durable user preference for the native Codex UI locale adapter.
use serde_json::{json, Value};
use std::{fs, path::Path};

pub const SCRIPT: &str = include_str!("codex_locale_runtime.js");
pub const VERSION: u64 = 1;
pub const SETTINGS_FILE: &str = "codex-language.json";

pub fn read_enabled(path: &Path) -> Result<Option<bool>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取中文设置失败：{error}")),
    };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("中文设置格式错误：{error}"))?;
    value
        .get("enabled")
        .and_then(Value::as_bool)
        .map(Some)
        .ok_or_else(|| "中文设置缺少有效的 enabled 字段。".to_string())
}

// A missing preference is initialized by the frontend handshake, so an old
// explicit localStorage=false is migrated before any default-on injection.
pub fn runtime_enabled(path: &Path) -> bool {
    read_enabled(path).ok().flatten().unwrap_or(false)
}

pub fn initialize(path: &Path, legacy_enabled: Option<bool>) -> Result<(bool, bool), String> {
    if let Some(enabled) = read_enabled(path)? {
        return Ok((enabled, false));
    }
    let enabled = legacy_enabled.unwrap_or(true);
    save(path, enabled)?;
    Ok((enabled, true))
}

pub fn save(path: &Path, enabled: bool) -> Result<(), String> {
    super::write_json_pretty_atomic(path, &json!({ "version": 1, "enabled": enabled }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_locale_fresh_install_defaults_on_after_initialization() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("nested").join(SETTINGS_FILE);
        assert!(!runtime_enabled(&path));
        assert_eq!(initialize(&path, None).unwrap(), (true, true));
        assert!(runtime_enabled(&path));
        assert_eq!(initialize(&path, None).unwrap(), (true, false));
    }

    #[test]
    fn codex_locale_legacy_off_migrates_before_runtime_activation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(SETTINGS_FILE);
        assert_eq!(initialize(&path, Some(false)).unwrap(), (false, true));
        assert!(!runtime_enabled(&path));
        assert_eq!(initialize(&path, Some(true)).unwrap(), (false, false));
    }

    #[test]
    fn codex_locale_persisted_preference_wins_over_stale_frontend() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(SETTINGS_FILE);
        save(&path, true).unwrap();
        assert_eq!(initialize(&path, Some(false)).unwrap(), (true, false));
        save(&path, false).unwrap();
        assert_eq!(initialize(&path, None).unwrap(), (false, false));
    }

    #[test]
    fn codex_locale_corrupt_preferences_are_not_silently_overwritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(SETTINGS_FILE);
        fs::write(&path, b"broken").unwrap();
        assert!(initialize(&path, None).is_err());
        assert!(!runtime_enabled(&path));
        assert_eq!(fs::read(&path).unwrap(), b"broken");
    }

    #[test]
    fn codex_locale_invalid_enabled_type_does_not_force_on() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(SETTINGS_FILE);
        fs::write(&path, br#"{"enabled":"false"}"#).unwrap();
        assert!(read_enabled(&path).is_err());
        assert!(!runtime_enabled(&path));
    }

    #[test]
    fn codex_locale_response_does_not_report_stale_runtime_as_applied() {
        let response = super::super::codex_language_response(
            false,
            json!({"version": VERSION, "enabled": true, "ready": true}),
        );
        assert_eq!(response["enabled"], false);
        assert_eq!(response["applied"], false);
        assert_eq!(response["needsRestart"], true);
    }

    #[test]
    fn codex_locale_response_reports_unavailable_runtime_as_pending() {
        let response = super::super::codex_language_response(true, Value::Null);
        assert_eq!(response["applied"], false);
        assert_eq!(response["needsRestart"], true);
        assert_eq!(response["codexClosed"], false);
    }

    #[test]
    fn codex_locale_disable_without_page_keeps_restore_pending() {
        let response = super::super::codex_language_response(false, Value::Null);
        assert_eq!(response["applied"], false);
        assert_eq!(response["needsRestart"], true);
    }

    #[test]
    fn codex_locale_configured_but_restart_pending_is_not_fully_applied() {
        let response = super::super::codex_language_response(
            true,
            json!({"version": VERSION, "enabled": true, "ready": true, "needsRestart": true}),
        );
        assert_eq!(response["applied"], false);
        assert_eq!(response["needsRestart"], true);
        assert!(response["message"].as_str().unwrap().contains("重启"));
    }

    #[test]
    fn codex_locale_only_current_verified_runtime_reports_applied() {
        let ready =
            json!({"version": VERSION, "enabled": true, "ready": true, "needsRestart": false});
        assert_eq!(
            super::super::codex_language_response(true, ready.clone())["applied"],
            true
        );
        let mut stale = ready.clone();
        stale["version"] = json!(0);
        assert_eq!(
            super::super::codex_language_response(true, stale)["applied"],
            false
        );
        let mut disposed = ready;
        disposed["disposed"] = json!(true);
        assert_eq!(
            super::super::codex_language_response(true, disposed)["applied"],
            false
        );
    }
}
