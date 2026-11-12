use super::tests::with_temp_user_home;
use super::*;

#[test]
fn image_credentials_round_trip_preserves_existing_file_format() {
    with_temp_user_home("image-credentials-round-trip", |_| {
        let key = "synthetic-image-key-中文-🔑";
        save_codex_image_tool_credentials_from_request(&json!({
            "imageApiKey": key,
            "imageBaseUrl": "https://images.example.invalid/v1",
        }))
        .unwrap();

        let path = codex_image_tools_settings_path();
        let original = fs::read(&path).unwrap();
        let saved: Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(saved["version"], 1);
        assert!(!String::from_utf8_lossy(&original).contains(key));
        assert!(saved["encryptedApiKey"]
            .as_str()
            .unwrap()
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));

        let loaded = load_codex_image_tool_credentials().unwrap();
        assert_eq!(loaded.api_key, key);
        assert_eq!(loaded.base_url, "https://images.example.invalid/v1");
        assert_eq!(
            fs::read(&path).unwrap(),
            original,
            "reading must not migrate or rewrite credentials"
        );

        // An unrelated login without an image key must retain the saved image credential.
        let unchanged = save_codex_image_tool_credentials_from_request(&json!({})).unwrap();
        assert_eq!(unchanged["updated"], false);
        assert_eq!(unchanged["configured"], true);
        assert_eq!(fs::read(&path).unwrap(), original);
    });
}

#[test]
fn image_credentials_invalid_secret_stops_before_any_upstream_request() {
    with_temp_user_home("image-credentials-invalid-secret", |_| {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let path = codex_image_tools_settings_path();
        let invalid_secret = "synthetic-private-value-that-must-not-appear-in-errors";
        write_json_pretty(
            &path,
            &json!({
                "version": 1,
                "baseUrl": format!("http://{}/v1", listener.local_addr().unwrap()),
                "encryptedApiKey": invalid_secret,
            }),
        )
        .unwrap();
        let original = fs::read(&path).unwrap();

        let response = tauri::async_runtime::block_on(gaoge_image_mcp_call_tool(
            GAOGE_IMAGE_TOOL_2_5_FLARE,
            &json!({ "prompt": "synthetic local test" }),
        ));
        assert_eq!(response["isError"], true);
        let message = response["content"][0]["text"].as_str().unwrap();
        assert!(message.contains("本地生图密钥解密失败"), "{message}");
        assert!(message.contains("生图请求尚未发送"), "{message}");
        assert!(!message.contains(invalid_secret));
        assert!(!message.contains(IMAGE_GENERATION_BUSY_MESSAGE));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert_eq!(fs::read(&path).unwrap(), original);
    });
}

#[test]
fn image_credentials_corrupt_config_does_not_leak_or_replace_content() {
    with_temp_user_home("image-credentials-corrupt-config", |_| {
        let path = codex_image_tools_settings_path();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let corrupt = b"{\"encryptedApiKey\":\"synthetic-private-value\", broken}";
        fs::write(&path, corrupt).unwrap();
        let message = match load_codex_image_tool_credentials() {
            Ok(_) => panic!("corrupt config must fail"),
            Err(message) => message,
        };
        assert!(message.contains("读取本地生图密钥配置失败"), "{message}");
        assert!(!message.contains("synthetic-private-value"));
        assert_eq!(fs::read(&path).unwrap(), corrupt);
    });
}

#[test]
fn image_credentials_missing_config_still_guides_initial_setup() {
    with_temp_user_home("image-credentials-missing-config", |_| {
        let message = match load_codex_image_tool_credentials() {
            Ok(_) => panic!("missing config must fail"),
            Err(message) => message,
        };
        assert!(message.contains("还没有 Image2 Key"), "{message}");
        assert!(!codex_image_tools_settings_path().exists());
    });
}
