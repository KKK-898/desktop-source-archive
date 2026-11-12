use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn fixture_policy(enabled: bool, models: &[&str], revision: &str) -> Policy {
    validate_policy(&json!({"version":1,"enabled":enabled,"models":models,"revision":revision}))
        .unwrap()
}

fn mock_http(
    status: &str,
    body: Vec<u8>,
) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let (send, receive) = mpsc::channel();
    let status = status.to_string();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(12);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "HTTP mock did not receive a request"
                    );
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("HTTP mock accept failed: {error}"),
            }
        };
        // Windows accepted sockets inherit the listener's nonblocking mode.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let size = stream.read(&mut chunk).unwrap();
            assert!(size > 0, "client disconnected before the request headers");
            request.extend_from_slice(&chunk[..size]);
            assert!(
                request.len() <= 16 * 1024,
                "unexpectedly large request headers"
            );
        }
        send.send(String::from_utf8(request).unwrap()).unwrap();
        let header = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        // An oversized response may be deliberately closed by the bounded reader.
        if stream.write_all(header.as_bytes()).is_ok() {
            let _ = stream.write_all(&body);
        }
    });
    (
        format!("http://{address}/api/v1/desktop/config"),
        receive,
        handle,
    )
}

#[test]
fn desktop_model_support_http_fetch_validates_enabled_disabled_and_server_errors_without_credentials(
) {
    for (status, body, expected) in [
        (
            "200 OK",
            json!({"success":true,"data":{"desktopModelSupport":fixture_policy(true,&["gpt-6-sol","vendor/new:model"],"revision-a")}}),
            Some(true),
        ),
        (
            "200 OK",
            json!({"success":true,"desktopModelSupport":fixture_policy(false,&[],"revision-b")}),
            Some(false),
        ),
        (
            "200 OK",
            json!({"success":true,"data":{"desktopModelSupportError":"unavailable"}}),
            None,
        ),
        (
            "503 Service Unavailable",
            json!({"error":"fixture failure"}),
            None,
        ),
    ] {
        let (url, requests, server) = mock_http(status, serde_json::to_vec(&body).unwrap());
        let actual = fetch(&url);
        let request = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        server.join().unwrap();
        assert!(request.starts_with("GET /api/v1/desktop/config HTTP/1.1\r\n"));
        let lower = request.to_ascii_lowercase();
        assert!(!lower.contains("authorization:"));
        assert!(!lower.contains("cookie:"));
        assert!(!lower.contains("x-api-key:"));
        assert!(lower.contains("cache-control: no-cache, no-store"));
        match expected {
            Some(enabled) => assert_eq!(actual.unwrap().enabled, enabled),
            None => assert!(actual.is_err()),
        }
    }
}

#[test]
fn desktop_model_support_http_fetch_rejects_oversized_and_invalid_json_responses() {
    for body in [
        vec![b' '; MAX_POLICY_BYTES as usize + 1],
        b"not-json".to_vec(),
    ] {
        let oversized = body.len() as u64 > MAX_POLICY_BYTES;
        let (url, requests, server) = mock_http("200 OK", body);
        let error = fetch(&url).unwrap_err();
        requests.recv_timeout(Duration::from_secs(5)).unwrap();
        server.join().unwrap();
        assert!(
            error.contains(if oversized { "过大" } else { "JSON" }),
            "{error}"
        );
    }
}

#[test]
fn desktop_model_support_cache_transition_revokes_previous_selection_and_keeps_admin_order() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("policy.json");
    let url = "https://relay.example.invalid/api/v1/desktop/config";
    let disabled = fixture_policy(false, &[], "disabled");
    resolve_with_cache(url, &path, Ok(disabled.clone())).unwrap();
    assert_eq!(cached_policy(&path, url).unwrap(), Some(disabled));
    let approved = fixture_policy(
        true,
        &["vendor/new-primary", "gpt-6-sol", "gpt-6-astra"],
        "enabled",
    );
    let resolved = resolve_with_cache(url, &path, Ok(approved.clone())).unwrap();
    let request = json!({"model":"removed-model","modelSelectionMode":"locked","modelCatalogSource":"fallback","supportedModels":["removed-model","unapproved-model"],"preserveUserFlag":true});
    let constrained = constrain_request(&request, &resolved);
    assert_eq!(constrained["model"], "vendor/new-primary");
    assert_eq!(
        constrained["supportedModels"],
        json!(["vendor/new-primary", "gpt-6-sol", "gpt-6-astra"])
    );
    assert_eq!(constrained["modelCatalogSource"], "upstream");
    assert_eq!(constrained["preserveUserFlag"], true);
    assert_eq!(request["model"], "removed-model");
    let offline = resolve_with_cache(url, &path, Err("offline".to_string())).unwrap();
    assert_eq!(offline.policy, approved);
    assert!(!offline.warning.is_empty());
}

fn relay_fixture(
    directory: &Path,
    catalog_override: Option<&Path>,
) -> (CodexDirTarget, RouterState, PathBuf, String) {
    fs::create_dir_all(directory).unwrap();
    let target = CodexDirTarget {
        dir: directory.to_path_buf(),
        source: "policy-test",
        primary: true,
    };
    let mut router = default_router_state();
    router.mode = "relay".into();
    router.relay_base_url = "https://relay.example.invalid/v1".into();
    router.relay_api_key = "fixture-key-not-real".into();
    let catalog =
        write_codex_model_catalog(directory, &["removed-model".into(), "gpt-6-sol".into()])
            .unwrap()
            .path;
    let selected_path = catalog_override.unwrap_or(&catalog);
    let config=format!("{}\n# user comment must remain\n[custom_user_section]\nkeep = true\nlabel = 'original value'\n",build_codex_direct_config_with_catalog(&router.relay_api_key,&router.relay_base_url,"removed-model",Some(selected_path),None));
    fs::write(directory.join("config.toml"), &config).unwrap();
    (target, router, catalog, config)
}

#[test]
fn desktop_model_support_prepare_rewrite_rejects_a_catalog_in_another_directory() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("unmanaged");
    fs::create_dir_all(&external).unwrap();
    let external_catalog = external.join(CODEX_MODEL_CATALOG_FILE);
    fs::write(&external_catalog, b"external user file").unwrap();
    let (target, router, catalog, config) =
        relay_fixture(&temp.path().join("managed"), Some(&external_catalog));
    let prior_catalog = fs::read(&catalog).unwrap();
    assert!(prepare_rewrite(
        &target,
        &router,
        &fixture_policy(true, &["gpt-6-sol"], "new")
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(target.dir.join("config.toml")).unwrap(),
        config
    );
    assert_eq!(fs::read(&catalog).unwrap(), prior_catalog);
    assert_eq!(fs::read(&external_catalog).unwrap(), b"external user file");
}

#[test]
fn desktop_model_support_apply_rewrite_preserves_user_configuration_and_admin_order() {
    let temp = tempfile::tempdir().unwrap();
    let (target, router, catalog, config) = relay_fixture(temp.path(), None);
    let policy = fixture_policy(true, &["vendor/new-primary", "gpt-6-sol"], "new");
    let rewrite = prepare_rewrite(&target, &router, &policy).unwrap().unwrap();
    apply_rewrites(&[rewrite]).unwrap();
    let saved = fs::read_to_string(target.dir.join("config.toml")).unwrap();
    assert!(saved.contains("# user comment must remain"));
    assert!(saved.contains("label = 'original value'"));
    let mut before = config.parse::<toml_edit::Document>().unwrap();
    before["model"] = toml_edit::value("vendor/new-primary");
    assert_eq!(
        saved,
        before.to_string(),
        "Only the root model selection may change"
    );
    assert_eq!(
        codex_catalog_model_names(&read_json_if_exists(&catalog).unwrap().unwrap()),
        policy.models
    );
    let again = prepare_rewrite(&target, &router, &policy).unwrap().unwrap();
    assert_eq!(
        again.old_config, again.config,
        "Keep the user-selected model if still allowed"
    );
    apply_rewrites(&[again]).unwrap();
    assert_eq!(
        fs::read_to_string(target.dir.join("config.toml")).unwrap(),
        saved
    );
}

#[test]
fn desktop_model_support_apply_rewrite_refuses_concurrent_config_or_catalog_edits() {
    for edit_catalog in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let (target, router, catalog, config) = relay_fixture(temp.path(), None);
        let old_catalog = fs::read(&catalog).unwrap();
        let rewrite = prepare_rewrite(
            &target,
            &router,
            &fixture_policy(true, &["gpt-6-sol"], "new"),
        )
        .unwrap()
        .unwrap();
        let changed_config = format!("{config}\n# newer user edit\n");
        let changed_catalog = b"{\"models\":[],\"user_edit\":true}";
        if edit_catalog {
            fs::write(&catalog, changed_catalog).unwrap();
        } else {
            fs::write(target.dir.join("config.toml"), &changed_config).unwrap();
        }
        let error = apply_rewrites(&[rewrite]).unwrap_err();
        assert!(error.contains("其他程序"), "{error}");
        assert_eq!(
            fs::read_to_string(target.dir.join("config.toml")).unwrap(),
            if edit_catalog { config } else { changed_config }
        );
        assert_eq!(
            fs::read(&catalog).unwrap(),
            if edit_catalog {
                changed_catalog.to_vec()
            } else {
                old_catalog
            }
        );
    }
}

#[test]
fn desktop_model_support_apply_rewrites_rolls_back_prior_target_without_overwriting_later_user_edit(
) {
    let temp = tempfile::tempdir().unwrap();
    let (first, router, first_catalog, first_config) =
        relay_fixture(&temp.path().join("first"), None);
    let (second, _, second_catalog, second_config) =
        relay_fixture(&temp.path().join("second"), None);
    let policy = fixture_policy(true, &["gpt-6-sol"], "new");
    let first_before = fs::read(&first_catalog).unwrap();
    let second_before = fs::read(&second_catalog).unwrap();
    let rewrites = [
        prepare_rewrite(&first, &router, &policy).unwrap().unwrap(),
        prepare_rewrite(&second, &router, &policy).unwrap().unwrap(),
    ];
    let user_edit = format!("{second_config}\n# concurrent change\n");
    fs::write(second.dir.join("config.toml"), &user_edit).unwrap();
    assert!(apply_rewrites(&rewrites).is_err());
    assert_eq!(
        fs::read_to_string(first.dir.join("config.toml")).unwrap(),
        first_config
    );
    assert_eq!(fs::read(&first_catalog).unwrap(), first_before);
    assert_eq!(
        fs::read_to_string(second.dir.join("config.toml")).unwrap(),
        user_edit
    );
    assert_eq!(fs::read(&second_catalog).unwrap(), second_before);
}

#[test]
fn desktop_model_support_refuses_a_new_policy_if_its_cache_cannot_be_persisted() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("policy.json");
    fs::create_dir_all(&path).unwrap();
    let marker = path.join("keep.txt");
    fs::write(&marker, "unrelated existing data").unwrap();
    let error = resolve_with_cache(
        "https://control.invalid/api/v1/desktop/config",
        &path,
        Ok(fixture_policy(true, &["gpt-6-sol"], "new-revision")),
    )
    .unwrap_err();
    assert!(error.contains("持久保存"), "{error}");
    assert!(path.is_dir());
    assert_eq!(
        fs::read_to_string(marker).unwrap(),
        "unrelated existing data"
    );
}

#[test]
fn desktop_model_support_disabled_does_not_adopt_an_unmanaged_locked_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let (target, router, catalog, config) = relay_fixture(temp.path(), None);
    let original_catalog = fs::read(&catalog).unwrap();
    let disabled = fixture_policy(false, &[], "disabled");
    assert!(prepare_rewrite(&target, &router, &disabled)
        .unwrap()
        .is_none());
    assert_eq!(
        fs::read_to_string(target.dir.join("config.toml")).unwrap(),
        config
    );
    assert_eq!(fs::read(catalog).unwrap(), original_catalog);
    assert_eq!(
        configured_root_value(&config, "model").as_deref(),
        Some("removed-model")
    );
}

#[test]
fn desktop_model_support_disabling_restores_original_catalog_model_and_preserves_later_user_settings(
) {
    let temp = tempfile::tempdir().unwrap();
    let (target, router, catalog, config) = relay_fixture(temp.path(), None);
    let original_catalog = read_json_if_exists(&catalog).unwrap().unwrap();
    let enabled = fixture_policy(true, &["gpt-6-sol", "vendor/new-model"], "enabled");
    let adoption = prepare_rewrite(&target, &router, &enabled)
        .unwrap()
        .unwrap();
    apply_rewrites(&[adoption]).unwrap();
    let applied = fs::read_to_string(target.dir.join("config.toml")).unwrap();
    assert_eq!(
        configured_root_value(&applied, "model").as_deref(),
        Some("gpt-6-sol")
    );
    let applied_catalog = read_json_if_exists(&catalog).unwrap().unwrap();
    assert_eq!(
        applied_catalog["gaogeDesktopModelSupport"]["previousCatalog"],
        original_catalog
    );
    assert_eq!(
        applied_catalog["gaogeDesktopModelSupport"]["previousModel"],
        "removed-model"
    );
    let later = format!("{applied}\n[added_after_policy]\nretain_me = 'user choice'\n");
    fs::write(target.dir.join("config.toml"), &later).unwrap();
    let restore = prepare_rewrite(&target, &router, &fixture_policy(false, &[], "disabled"))
        .unwrap()
        .unwrap();
    apply_rewrites(&[restore]).unwrap();
    let restored = fs::read_to_string(target.dir.join("config.toml")).unwrap();
    let mut expected = later.parse::<toml_edit::Document>().unwrap();
    expected["model"] = toml_edit::value("removed-model");
    assert_eq!(restored, expected.to_string());
    assert!(restored.contains("retain_me = 'user choice'"));
    assert!(restored.contains("# user comment must remain"));
    assert_eq!(
        configured_root_value(&restored, "model"),
        configured_root_value(&config, "model")
    );
    assert_eq!(
        read_json_if_exists(&catalog).unwrap().unwrap(),
        original_catalog
    );
    assert!(
        prepare_rewrite(&target, &router, &fixture_policy(false, &[], "disabled"))
            .unwrap()
            .is_none(),
        "Restoration releases policy ownership"
    );
}

#[test]
fn desktop_model_support_control_endpoint_preserves_the_configured_api_path_and_rejects_unsafe_urls(
) {
    assert_eq!(
        policy_endpoint("https://control.invalid/custom/api/v1").unwrap(),
        "https://control.invalid/custom/api/v1/desktop/config"
    );
    assert_eq!(
        policy_endpoint("https://control.invalid/custom/api/v1/").unwrap(),
        "https://control.invalid/custom/api/v1/desktop/config"
    );
    assert_eq!(
        policy_endpoint("https://control.invalid:9443/api/v1").unwrap(),
        "https://control.invalid:9443/api/v1/desktop/config"
    );
    for unsafe_url in [
        "https://user:secret@control.invalid/api/v1",
        "https://user@control.invalid/api/v1",
        "https://control.invalid/api/v1?secret=value",
        "https://control.invalid/api/v1#fragment",
        "http://control.invalid/api/v1",
        "file:///api/v1",
        "not a url",
    ] {
        assert!(policy_endpoint(unsafe_url).is_err(), "{unsafe_url}");
    }
}

#[test]
fn desktop_model_support_filters_known_media_without_changing_policy_syntax_validation() {
    let policy = fixture_policy(
        true,
        &[
            "Image-2.5-Flare",
            "vendor/new-model",
            "gpt-image-2",
            "gpt-6-sol",
        ],
        "mixed",
    );
    assert_eq!(
        policy.models.len(),
        4,
        "Media identifiers are syntactically valid policy entries"
    );
    let resolved = usable(Resolution {
        policy,
        warning: "cached-policy-warning".into(),
    })
    .unwrap();
    assert_eq!(resolved.policy.models, ["vendor/new-model", "gpt-6-sol"]);
    assert!(resolved.warning.contains("cached-policy-warning"));
    assert!(resolved.warning.contains("2 个纯生图模型"));
    let media_only = fixture_policy(true, &["Image-2.5-Flare", "gpt-image-2"], "media-only");
    let error = usable(Resolution {
        policy: media_only,
        warning: String::new(),
    })
    .unwrap_err();
    assert!(error.contains("不会回退全量模型"), "{error}");
    let disabled = fixture_policy(false, &["Image-2.5-Flare"], "disabled");
    assert_eq!(
        usable(Resolution {
            policy: disabled.clone(),
            warning: String::new()
        })
        .unwrap()
        .policy,
        disabled
    );
}

#[test]
fn desktop_model_support_successful_all_media_policy_never_reuses_an_old_disabled_cache() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("policy.json");
    let scope = "https://control.invalid/custom/api/v1/desktop/config\nhttps://relay.invalid/v1";
    let disabled = fixture_policy(false, &[], "old-disabled");
    resolve_with_cache(scope, &path, Ok(disabled.clone())).unwrap();
    let before = fs::read(&path).unwrap();
    let unusable = fixture_policy(true, &["Image-2.5-Flare", "gpt-image-2"], "new-enabled");
    let error = resolve_received(scope, &path, Ok(unusable)).unwrap_err();
    assert!(error.contains("不会回退全量模型"), "{error}");
    assert_eq!(
        fs::read(&path).unwrap(),
        before,
        "Authoritative rejection must not rewrite cache"
    );
    assert_eq!(cached_policy(&path, scope).unwrap(), Some(disabled));
}

#[test]
fn desktop_model_support_disabled_policy_leaves_external_catalog_path_and_locked_model_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let external = temp.path().join("user-owned");
    fs::create_dir_all(&external).unwrap();
    let external_catalog = external.join(CODEX_MODEL_CATALOG_FILE);
    fs::write(&external_catalog, b"external user-owned catalog").unwrap();
    let (target, router, managed_catalog, original_config) =
        relay_fixture(&temp.path().join("managed"), Some(&external_catalog));
    let managed_before = fs::read(&managed_catalog).unwrap();
    assert!(
        prepare_rewrite(&target, &router, &fixture_policy(false, &[], "disabled"))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        fs::read_to_string(target.dir.join("config.toml")).unwrap(),
        original_config
    );
    assert_eq!(fs::read(managed_catalog).unwrap(), managed_before);
    assert_eq!(
        fs::read(external_catalog).unwrap(),
        b"external user-owned catalog"
    );
}
