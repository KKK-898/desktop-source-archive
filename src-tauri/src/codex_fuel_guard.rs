//! Confirm ownership of the local paid route before adjusting the desktop's
//! account quota UI. This checks configuration, never an upstream allowance.

use super::{
    configured_provider, configured_root_value, model_provider_value, AggregateLoginState,
    RouterState, CODEX_DIRECT_PROVIDER_ID, CODEX_ROUTER_PROVIDER_NAME,
};
use serde_json::{json, Value};

fn disabled() -> Value {
    json!({ "enabled": false, "provider": "", "baseUrl": "", "mode": "" })
}

fn route_url(value: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(value.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed)
}

fn same_route(left: &url::Url, right: &url::Url) -> bool {
    left.as_str().trim_end_matches('/') == right.as_str().trim_end_matches('/')
}

fn is_official_host(host: &str) -> bool {
    ["openai.com", "chatgpt.com"]
        .iter()
        .any(|official| host == *official || host.ends_with(&format!(".{official}")))
}

/// `aggregate_running` must describe the runtime whose port and token match the
/// aggregate snapshot. The caller reads the current active Codex config each
/// time; cached activation flags alone must never keep this guard enabled.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn status(
    config: &str,
    router: &RouterState,
    aggregate: &AggregateLoginState,
    aggregate_running: bool,
) -> Value {
    // RouterState.enabled refers to the retired local proxy and is always
    // false. The persisted mode plus exact current provider credentials are
    // the ownership check for today's direct relay path.
    if router.mode != "relay"
        || configured_provider(config) != CODEX_DIRECT_PROVIDER_ID
        || configured_root_value(config, "profile").is_some()
    {
        return disabled();
    }
    let field = |name| model_provider_value(config, CODEX_DIRECT_PROVIDER_ID, name);
    if !field("name").is_some_and(|name| name.eq_ignore_ascii_case(CODEX_ROUTER_PROVIDER_NAME))
        || field("wire_api").as_deref() != Some("responses")
        || field("requires_openai_auth").as_deref() != Some("true")
    {
        return disabled();
    }
    let Some(configured_key) =
        field("experimental_bearer_token").filter(|key| !key.trim().is_empty())
    else {
        return disabled();
    };
    let Some(configured_url) = field("base_url").and_then(|value| route_url(&value)) else {
        return disabled();
    };
    let Some(expected_url) = route_url(&router.relay_base_url) else {
        return disabled();
    };
    if router.relay_api_key.trim().is_empty()
        || configured_key != router.relay_api_key
        || !same_route(&configured_url, &expected_url)
        || is_official_host(configured_url.host_str().unwrap_or_default())
    {
        return disabled();
    }

    let mode = if aggregate.enabled {
        // An aggregate endpoint is a live loopback relay, not an arbitrary
        // local API using the same provider label. Require its current token
        // and port, plus a usable default route. A thread may select another
        // model without changing this default, so do not bind to config.model.
        if !aggregate_running
            || aggregate.router_port == 0
            || aggregate.router_token.trim().is_empty()
            || configured_key != aggregate.router_token
            || configured_url.scheme() != "http"
            || configured_url.host_str() != Some("127.0.0.1")
            || configured_url.port() != Some(aggregate.router_port)
            || configured_url.path().trim_end_matches('/') != "/v1"
            || !aggregate.routes.iter().any(|route| {
                route.public_model == aggregate.default_model
                    && !route.api_key.trim().is_empty()
                    && route_url(&route.base_url).is_some()
            })
        {
            return disabled();
        }
        "aggregate"
    } else {
        // A stopped aggregate router must not be mistaken for a direct
        // relay merely because its saved key and URL are still present.
        if configured_url.scheme() != "https" {
            return disabled();
        }
        "relay"
    };

    json!({
        "enabled": true,
        "provider": CODEX_DIRECT_PROVIDER_ID,
        "baseUrl": configured_url.as_str().trim_end_matches('/'),
        "mode": mode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn direct() -> (String, RouterState, AggregateLoginState) {
        let mut router = super::super::default_router_state();
        router.mode = "relay".to_string();
        router.relay_base_url = "https://relay.example.invalid/v1".to_string();
        router.relay_api_key = "fixture-relay-key".to_string();
        let config = super::super::build_codex_direct_config(
            &router.relay_api_key,
            &router.relay_base_url,
            "gpt-5.5",
        );
        (
            config,
            router,
            super::super::default_aggregate_login_state(),
        )
    }

    #[test]
    fn fuel_guard_accepts_current_direct_route_without_returning_credentials() {
        let (config, router, aggregate) = direct();
        assert!(!router.enabled);
        let result = status(&config, &router, &aggregate, false);
        assert_eq!(result["enabled"], true);
        assert_eq!(result["provider"], CODEX_DIRECT_PROVIDER_ID);
        assert_eq!(result["baseUrl"], router.relay_base_url);
        assert_eq!(result["mode"], "relay");
        assert!(!result.to_string().contains(&router.relay_api_key));
    }

    #[test]
    fn fuel_guard_rejects_removed_official_and_changed_routes() {
        let (config, router, aggregate) = direct();
        for changed in [
            String::new(),
            "model_provider = \"openai\"\n".to_string(),
            config.replace("model_provider = \"custom\"", "model_provider = \"other\""),
            config.replace("name = \"Gaoge\"", "name = \"Another provider\""),
            config.replace(
                "requires_openai_auth = true",
                "requires_openai_auth = false",
            ),
            config.replace("wire_api = \"responses\"", "wire_api = \"chat\""),
            config.replace("fixture-relay-key", "rotated-key"),
            config.replace("relay.example.invalid", "other.example.invalid"),
            format!("profile = \"official\"\n{config}"),
        ] {
            assert_eq!(
                status(&changed, &router, &aggregate, false)["enabled"],
                false
            );
        }
        let mut closed = router.clone();
        closed.mode = "official".to_string();
        assert_eq!(
            status(&config, &closed, &aggregate, false)["enabled"],
            false
        );
        let mut missing_key = router;
        missing_key.relay_api_key.clear();
        assert_eq!(
            status(&config, &missing_key, &aggregate, false)["enabled"],
            false
        );
    }

    #[test]
    fn fuel_guard_rejects_unsafe_or_official_endpoints_even_when_saved() {
        let (_, mut router, aggregate) = direct();
        for endpoint in [
            "https://api.openai.com/v1",
            "https://chatgpt.com/backend-api/codex",
            "https://user:password@relay.example.invalid/v1",
            "https://relay.example.invalid/v1?api_key=secret",
            "https://relay.example.invalid/v1#fragment",
            "http://127.0.0.1:25818/v1",
            "file:///tmp/responses",
            "",
        ] {
            router.relay_base_url = endpoint.to_string();
            let config =
                super::super::build_codex_direct_config(&router.relay_api_key, endpoint, "gpt-5.5");
            assert_eq!(status(&config, &router, &aggregate, false), disabled());
        }
    }

    #[test]
    fn fuel_guard_requires_current_live_aggregate_without_binding_thread_model() {
        let (_, mut router, mut aggregate) = direct();
        aggregate.enabled = true;
        aggregate.router_port = 25819;
        aggregate.router_token = "fixture-aggregate-token".to_string();
        aggregate.default_model = "gaoge/openai/test/gpt-5.5".to_string();
        aggregate.routes.push(super::super::AggregateProviderRoute {
            source: Default::default(),
            protocol: Default::default(),
            model_config: Value::Null,
            provider_id: "openai".to_string(),
            provider_name: "OpenAI".to_string(),
            upstream_platform: "openai".to_string(),
            group_id: "test".to_string(),
            group_name: "test".to_string(),
            group_rate_text: String::new(),
            public_model: aggregate.default_model.clone(),
            upstream_model: "gpt-5.5".to_string(),
            base_url: router.relay_base_url.clone(),
            api_key: "fixture-upstream-key".to_string(),
        });
        router.relay_base_url = format!("http://127.0.0.1:{}/v1", aggregate.router_port);
        router.relay_api_key = aggregate.router_token.clone();
        let config = super::super::build_codex_direct_config(
            &router.relay_api_key,
            &router.relay_base_url,
            "gpt-6-astra",
        );
        let result = status(&config, &router, &aggregate, true);
        assert_eq!(result["enabled"], true);
        assert_eq!(result["mode"], "aggregate");
        assert!(!result.to_string().contains(&aggregate.router_token));
        assert_eq!(
            status(&config, &router, &aggregate, false)["enabled"],
            false
        );
        let mut stale = aggregate.clone();
        stale.router_token = "previous-token".to_string();
        assert_eq!(status(&config, &router, &stale, true)["enabled"], false);
        stale = aggregate.clone();
        stale.router_port += 1;
        assert_eq!(status(&config, &router, &stale, true)["enabled"], false);
        stale = aggregate.clone();
        stale.routes.clear();
        assert_eq!(status(&config, &router, &stale, true)["enabled"], false);
        stale = aggregate;
        stale.enabled = false;
        assert_eq!(status(&config, &router, &stale, true)["enabled"], false);
    }
}
