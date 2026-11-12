use base64::{engine::general_purpose, Engine as _};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn run_image_mcp_requests(codex_home: &Path, requests: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gaoge-free"))
        .arg("--gaoge-image-mcp")
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn gaoge image MCP server");
    {
        let mut stdin = child.stdin.take().expect("MCP stdin");
        for request in requests {
            serde_json::to_writer(&mut stdin, request).expect("serialize MCP request");
            stdin.write_all(b"\n").expect("write MCP newline");
        }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait().expect("poll MCP server") {
            Some(_) => break,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                panic!("Gaoge image MCP server did not exit after stdin closed");
            }
        }
    }
    let output = child.wait_with_output().expect("read MCP output");
    assert!(
        output.status.success(),
        "MCP server failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("UTF-8 MCP output")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("JSON-RPC response"))
        .collect()
}

#[test]
fn image_mcp_binary_completes_handshake_and_lists_image_tools_and_preview_ui() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_gaoge-free"))
        .arg("--gaoge-image-mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn gaoge image MCP server");

    {
        let mut stdin = child.stdin.take().expect("MCP stdin");
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2025-06-18","capabilities":{{}},"clientInfo":{{"name":"test","version":"1"}}}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":3,"method":"resources/list","params":{{}}}}"#
        )
        .unwrap();
        writeln!(
            stdin,
            r#"{{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{{"uri":"ui://gaoge-image/image-preview.html"}}}}"#
        )
        .unwrap();
    }

    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait().expect("poll MCP server") {
            Some(_) => break,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                panic!("Gaoge image MCP server did not exit after stdin closed");
            }
        }
    }

    let output = child.wait_with_output().expect("read MCP output");
    assert!(
        output.status.success(),
        "MCP server failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = String::from_utf8(output.stdout)
        .expect("UTF-8 MCP output")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("JSON-RPC response"))
        .collect::<Vec<_>>();

    assert_eq!(responses.len(), 4);
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "gaoge-image");
    let tools = responses[1]["result"]["tools"]
        .as_array()
        .expect("tools array");
    let names = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "gaoge_generate_image_2",
            "gaoge_generate_image_2_5_flare",
            "gaoge_generate_image_2_5_sunburst",
            "gaoge_generate_image_2_6_flare",
            "gaoge_generate_image_2_6_sunburst",
            "gaoge_view_generated_image",
        ]
    );
    assert_eq!(
        responses[2]["result"]["resources"][0]["uri"],
        "ui://gaoge-image/image-preview.html"
    );
    assert_eq!(
        responses[3]["result"]["contents"][0]["mimeType"],
        "text/html;profile=mcp-app"
    );
    let ui_html = responses[3]["result"]["contents"][0]["text"]
        .as_str()
        .expect("UI HTML resource");
    assert!(ui_html.contains("ui/notifications/tool-result"));
    assert!(ui_html.contains("resources/read"));
}

#[test]
fn image_mcp_persists_generated_resource_across_server_restarts() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let codex_home = std::env::temp_dir().join(format!(
        "gaoge-image-mcp-restart-{}-{unique}",
        std::process::id()
    ));
    fs::create_dir_all(&codex_home).unwrap();
    let image_path = codex_home.join("official-history.png");
    let image_base64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGMIWHDnPyWYYdSAUQNGDRguBgAAjJXLH15wN5kAAAAASUVORK5CYII=";
    let image_bytes = general_purpose::STANDARD.decode(image_base64).unwrap();
    fs::write(&image_path, image_bytes).unwrap();

    let first = run_image_mcp_requests(
        &codex_home,
        &[
            serde_json::json!({
              "jsonrpc": "2.0",
              "id": 1,
              "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}
            }),
            serde_json::json!({
              "jsonrpc": "2.0",
              "id": 2,
              "method": "tools/call",
              "params": {
                "name": "gaoge_view_generated_image",
                "arguments": {"image_path": image_path.to_string_lossy(), "question": "inspect"}
              }
            }),
        ],
    );
    let viewed = &first[1]["result"];
    assert!(viewed.get("structuredContent").is_none());
    assert!(viewed["_meta"]["timingsMs"]["total"].is_number());
    assert_eq!(viewed["isError"], false);
    assert_eq!(viewed["content"][1]["type"], "image");
    assert_eq!(viewed["content"][1]["mimeType"], "image/png");
    assert_eq!(viewed["content"][1]["data"], image_base64);
    assert_eq!(viewed["_meta"]["registeredFromPath"], true);
    assert!(viewed["_meta"].get("imageProvidedToModel").is_none());
    let resource_uri = viewed["_meta"]["resourceUri"]
        .as_str()
        .expect("persisted resource URI")
        .to_string();
    assert!(codex_home.join("gaoge-image-resources.json").exists());

    let second = run_image_mcp_requests(
        &codex_home,
        &[
            serde_json::json!({
              "jsonrpc": "2.0",
              "id": 3,
              "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}
            }),
            serde_json::json!({
              "jsonrpc": "2.0",
              "id": 4,
              "method": "resources/read",
              "params": {"uri": resource_uri}
            }),
        ],
    );
    assert_eq!(second[1]["result"]["contents"][0]["mimeType"], "image/png");
    assert_eq!(
        second[1]["result"]["contents"][0]["blob"],
        image_base64
    );

    let _ = fs::remove_dir_all(&codex_home);
}

#[test]
fn image26_mcp_gif_resource_round_trip_preserves_both_animation_frames() {
    let codex_home = tempfile::tempdir().unwrap();
    let gif_base64 = "R0lGODlhQABAAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFFAAAACwAAAAAQABAAAACRYyPqcvtD6OctNqLs968+w+G4kiW5omm6sq27gvH8kzX9o3n+s73/g8MCofEovGITCqXzKbzCY1Kp9Sq9YrNarfcrjdQAAAh+QQFFAAAACwAAAAAQABAAIBMaXEAAP8CRYyPqcvtD6OctNqLs968+w+G4kiW5omm6sq27gvH8kzX9o3n+s73/g8MCofEovGITCqXzKbzCY1Kp9Sq9YrNarfcrjdQAAA7";
    let image_path = codex_home.path().join("animation.gif");
    let bytes = general_purpose::STANDARD.decode(gif_base64).unwrap();
    fs::write(&image_path, &bytes).unwrap();
    let first = run_image_mcp_requests(codex_home.path(), &[serde_json::json!({
        "jsonrpc":"2.0", "id":1,"method":"tools/call",
        "params":{"name":"gaoge_view_generated_image","arguments":{"image_path":image_path}}
    })]);
    assert_eq!(first[0]["result"]["isError"], false);
    assert_eq!(first[0]["result"]["content"][1]["mimeType"], "image/gif");
    assert_eq!(first[0]["result"]["content"][1]["data"], gif_base64);
    let uri = first[0]["result"]["_meta"]["resourceUri"].as_str().unwrap();
    let second = run_image_mcp_requests(codex_home.path(), &[serde_json::json!({
        "jsonrpc":"2.0", "id":2,"method":"resources/read", "params":{"uri":uri}
    })]);
    assert_eq!(second[0]["result"]["contents"][0]["mimeType"], "image/gif");
    assert_eq!(second[0]["result"]["contents"][0]["blob"], gif_base64);
    assert_eq!(fs::read(image_path).unwrap(), bytes);
}

#[test]
fn image26_mcp_startup_refreshes_only_its_existing_integration_without_relogin() {
    let codex_home = tempfile::tempdir().unwrap();
    let binary_name = Path::new(env!("CARGO_BIN_EXE_gaoge-free")).file_name().unwrap().to_string_lossy();
    fs::write(codex_home.path().join("config.toml"),
        format!("[mcp_servers.gaoge_image]\ncommand = \"old-directory/{binary_name}\"\nargs = [\"--gaoge-image-mcp\"]\ntool_timeout_sec = 900\n")).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_gaoge-free"))
        .arg("--gaoge-image-mcp")
        .env("CODEX_HOME", codex_home.path())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().expect("start MCP process");
    let mut input = child.stdin.take().unwrap();
    writeln!(input, "{}", serde_json::json!({
        "jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}
    })).unwrap();
    input.flush().unwrap();
    let skill = codex_home.path().join("skills/gaoge-image/SKILL.md");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !skill.exists() && Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() { break; }
        thread::sleep(Duration::from_millis(25));
    }
    let installed = fs::read_to_string(&skill).ok();
    drop(input);
    let exit_deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() && Instant::now() < exit_deadline {
        thread::sleep(Duration::from_millis(25));
    }
    if child.try_wait().unwrap().is_none() { let _ = child.kill(); }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(installed.expect("managed skill installed while MCP was alive").contains("gaoge_generate_image_2_6_flare"));
    let config = fs::read_to_string(codex_home.path().join("config.toml")).unwrap();
    assert!(config.contains("tool_timeout_sec = 900"));
    let response: Value = serde_json::from_str(String::from_utf8(output.stdout).unwrap().lines().next().unwrap()).unwrap();
    assert_eq!(response["result"]["serverInfo"]["name"], "gaoge-image");
}
