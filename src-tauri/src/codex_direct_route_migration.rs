//! Restore the retired ordinary Responses loopback route to its relay domain.
//! Ordinary login uses the configured upstream URL and API key directly.
//! No listeners, authentication files, conversation history, or proxy settings.
use super::*;

fn state_path() -> PathBuf {
    roaming_app_dir().join("codex-response-recovery.json")
}

fn secret_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn valid_upstream(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    let host = url.host_str().unwrap_or_default();
    url.scheme() == "https"
        && !host.is_empty()
        && !matches!(host, "localhost" | "127.0.0.1" | "[::1]")
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && !["openai.com", "chatgpt.com"]
            .iter()
            .any(|official| host == *official || host.ends_with(&format!(".{official}")))
}

struct LegacyRoute {
    endpoint: String,
    token_hash: String,
}

impl LegacyRoute {
    fn load(router: &RouterState) -> Result<Option<Self>, String> {
        if router.mode != "relay"
            || router.relay_api_key.trim().is_empty()
            || !valid_upstream(&router.relay_base_url)
        {
            return Ok(None);
        }
        let Some(saved) = read_json_if_exists(&state_path())? else {
            return Ok(None);
        };
        if saved.get("enabled").and_then(Value::as_bool) != Some(true)
            || saved
                .get("upstream")
                .and_then(Value::as_str)
                .map(|url| url.trim_end_matches('/'))
                != Some(router.relay_base_url.trim_end_matches('/'))
            || saved.get("apiKeyHash").and_then(Value::as_str)
                != Some(secret_hash(&router.relay_api_key).as_str())
        {
            return Ok(None);
        }
        let port = saved
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port > 0)
            .ok_or("旧普通 API 转发端口无效，请重新执行 API 登录。")?;
        let token_hash = saved
            .get("tokenHash")
            .and_then(Value::as_str)
            .filter(|hash| !hash.is_empty())
            .ok_or("旧普通 API 转发凭据校验信息缺失，请重新执行 API 登录。")?;
        Ok(Some(Self {
            endpoint: format!("http://127.0.0.1:{port}/v1"),
            token_hash: token_hash.to_string(),
        }))
    }

    fn owns(&self, config: &str) -> bool {
        configured_provider(config) == CODEX_DIRECT_PROVIDER_ID
            && configured_root_value(config, "profile").is_none()
            && model_provider_value(config, CODEX_DIRECT_PROVIDER_ID, "name")
                .is_some_and(|name| name.eq_ignore_ascii_case(CODEX_ROUTER_PROVIDER_NAME))
            && model_provider_value(config, CODEX_DIRECT_PROVIDER_ID, "wire_api").as_deref()
                == Some("responses")
            && model_provider_value(config, CODEX_DIRECT_PROVIDER_ID, "base_url")
                .is_some_and(|url| url.trim_end_matches('/') == self.endpoint)
            && model_provider_value(
                config,
                CODEX_DIRECT_PROVIDER_ID,
                "experimental_bearer_token",
            )
            .filter(|token| !token.is_empty())
            .is_some_and(|token| secret_hash(&token) == self.token_hash)
    }
}

/// Restore URL and credential together only after the existing client exits.
/// A loopback token must never be sent to the upstream relay.
pub(super) fn restore_direct_after_exit(
    router: &RouterState,
    targets: &[CodexDirTarget],
    exit_confirmed: bool,
) -> Result<usize, String> {
    if !exit_confirmed {
        return Err("尚未确认 Codex 退出，未修改普通 API 路由。".to_string());
    }
    let Some(legacy) = LegacyRoute::load(router)? else {
        return Ok(0);
    };
    let mut candidates = Vec::new();
    for target in targets {
        let path = target.dir.join("config.toml");
        let existing = read_text_if_exists(&path)?;
        if !legacy.owns(&existing) {
            continue;
        }
        let mut document = existing
            .parse::<toml_edit::Document>()
            .map_err(|error| error.to_string())?;
        document["model_providers"][CODEX_DIRECT_PROVIDER_ID]["base_url"] =
            toml_edit::value(router.relay_base_url.trim_end_matches('/'));
        document["model_providers"][CODEX_DIRECT_PROVIDER_ID]["experimental_bearer_token"] =
            toml_edit::value(&router.relay_api_key);
        candidates.push((path, existing, document.to_string()));
    }
    if candidates.is_empty() {
        return Ok(0);
    }
    let state_snapshot = OptionalFileSnapshot::capture(state_path())?;
    let mut applied: Vec<(OptionalFileSnapshot, PathBuf, String)> = Vec::new();
    let result = (|| {
        for (path, existing, next) in candidates {
            let snapshot = OptionalFileSnapshot::capture(path.clone())?;
            write_codex_config_atomic(&path, Some(&existing), &next)?;
            applied.push((snapshot, path, next));
        }
        write_json_pretty(&state_path(), &json!({"version": 1, "enabled": false}))?;
        Ok(applied.len())
    })();
    if let Err(error) = result {
        let mut errors = vec![error];
        for (snapshot, path, candidate) in applied.iter().rev() {
            if let Err(error) = rollback_codex_config_if_candidate(snapshot, path, candidate) {
                errors.push(error);
            }
        }
        if let Err(error) = state_snapshot.restore() {
            errors.push(error);
        }
        return Err(errors.join("; "));
    }
    bump_codex_runtime_revision();
    result
}

pub(super) fn restore_startup(router: &RouterState) -> Result<(), String> {
    // Never revive the retired listener or replace a live client's credentials.
    // The explicit restart path also migrates before launching Codex.
    if router.mode == "relay" && list_running_codex_app_dirs().is_empty() {
        restore_direct_after_exit(router, &codex_route_targets(), true)?;
    }
    Ok(())
}
