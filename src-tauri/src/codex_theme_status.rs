//! Verified theme selection and renderer state, independent of user files.
use super::codex_themes::CodexThemeRuntimePayload;
use serde_json::{json, Value};

pub const RUNTIME_VERSION: u64 = 3;

pub fn verified(runtime: &Value, theme: Option<&CodexThemeRuntimePayload>) -> bool {
    if runtime["version"].as_u64() != Some(RUNTIME_VERSION)
        || runtime["ready"].as_bool() != Some(true)
        || runtime["applied"].as_bool() != Some(true)
        || runtime["error"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
    {
        return false;
    }
    match theme {
        Some(theme) => {
            runtime["enabled"].as_bool() == Some(true)
                && runtime["id"].as_str() == Some(theme.id.as_str())
                && runtime["themeVersion"].as_str() == Some(theme.version.as_str())
                && !theme.signature.is_empty()
                && runtime["signature"].as_str() == Some(theme.signature.as_str())
        }
        None => runtime["enabled"].as_bool() == Some(false) && runtime["id"].as_str() == Some(""),
    }
}

pub fn response(theme: Option<&CodexThemeRuntimePayload>, runtime: Value) -> Value {
    let selected = theme.map(|theme| theme.id.as_str()).unwrap_or("");
    let applied = verified(&runtime, theme);
    let error = runtime["error"].as_str().unwrap_or("");
    json!({
        "selectedThemeId": selected,
        "appliedThemeId": if applied { selected } else { "" },
        "runtimeReady": applied,
        "applied": applied,
        "needsRestart": !applied,
        "runtimeError": error,
        "state": if applied { "applied" } else if !error.is_empty() { "error" } else if runtime.is_null() { "unavailable" } else { "pending" },
        "status": if applied { "applied" } else if !error.is_empty() { "error" } else if runtime.is_null() { "unavailable" } else { "pending" },
        "runtime": runtime,
    })
}

pub fn decorate_catalog(catalog: &mut Value, status: &Value) {
    let selected = status["selectedThemeId"].as_str().unwrap_or("");
    let applied = status["runtimeReady"].as_bool() == Some(true);
    if let Some(items) = catalog["themes"].as_array_mut() {
        for item in items {
            let is_selected = item["id"].as_str() == Some(selected);
            if let Some(object) = item.as_object_mut() {
                object.insert("active".into(), json!(is_selected));
                object.insert("applied".into(), json!(is_selected && applied));
                object.insert("pending".into(), json!(is_selected && !applied));
            }
        }
    }
    if let Some(object) = catalog.as_object_mut() {
        object.insert("runtime".into(), status.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CodexThemeRuntimePayload {
        CodexThemeRuntimePayload {
            id: "theme-one".into(),
            version: "1.1.0".into(),
            signature: "content-new".into(),
            name: "Sample".into(),
            runtime: "wallpaper".into(),
            appearance: "dark".into(),
            background_data_url: String::new(),
            background: super::super::codex_themes::ThemeBackground {
                file: "background.webp".into(),
                position_x: 50,
                position_y: 50,
                overlay_opacity: 0.3,
            },
            colors: super::super::codex_themes::ThemeColors {
                accent: String::new(),
                secondary: String::new(),
                surface: String::new(),
                text: String::new(),
                muted: String::new(),
                border: String::new(),
            },
            effects: super::super::codex_themes::ThemeEffects {
                panel_opacity: 0.8,
                panel_blur: 10,
                radius: 8,
            },
        }
    }

    fn ready() -> Value {
        json!({"version": RUNTIME_VERSION, "enabled": true, "ready": true, "applied": true,
            "id": "theme-one", "themeVersion": "1.1.0", "signature": "content-new", "error": ""})
    }

    #[test]
    fn theme_status_requires_current_content_and_actual_ready() {
        let theme = sample();
        assert!(verified(&ready(), Some(&theme)));
        for (key, value) in [
            ("version", json!(1)),
            ("version", json!(2)),
            ("id", json!("theme-other")),
            ("themeVersion", json!("1.0.0")),
            ("signature", json!("content-old")),
            ("ready", json!(false)),
            ("applied", json!(false)),
            ("enabled", json!(false)),
            ("error", json!("image-decode-failed")),
        ] {
            let mut runtime = ready();
            runtime[key] = value;
            assert!(
                !verified(&runtime, Some(&theme)),
                "unexpected success for {key}"
            );
        }
    }

    #[test]
    fn theme_status_unknown_and_old_payload_remain_pending() {
        let theme = sample();
        let response = response(Some(&theme), Value::Null);
        assert_eq!(response["selectedThemeId"], "theme-one");
        assert_eq!(response["appliedThemeId"], "");
        assert_eq!(response["runtimeReady"], false);
        assert_eq!(response["needsRestart"], true);
        assert_eq!(response["state"], "unavailable");
    }

    #[test]
    fn theme_status_restoration_requires_verified_cleanup() {
        assert!(!verified(&Value::Null, None));
        assert!(!verified(&ready(), None));
        assert!(verified(
            &json!({"version": RUNTIME_VERSION, "enabled": false, "ready": true,
            "applied": true, "id": "", "error": ""}),
            None
        ));
    }

    #[test]
    fn theme_status_catalog_keeps_selection_separate_from_application() {
        let theme = sample();
        let mut catalog = json!({"themes":[{"id":"theme-one","active":true,"updateAvailable":true},{"id":"theme-two"}]});
        decorate_catalog(&mut catalog, &response(Some(&theme), Value::Null));
        assert_eq!(catalog["themes"][0]["active"], true);
        assert_eq!(catalog["themes"][0]["applied"], false);
        assert_eq!(catalog["themes"][0]["pending"], true);
        assert_eq!(catalog["themes"][0]["updateAvailable"], true);
        decorate_catalog(&mut catalog, &response(Some(&theme), ready()));
        assert_eq!(catalog["themes"][0]["applied"], true);
        assert_eq!(catalog["themes"][0]["pending"], false);
        assert_eq!(catalog["themes"][1]["applied"], false);
    }
}
