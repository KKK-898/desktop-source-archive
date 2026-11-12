use super::*;

// A loopback fixture only: these tests never contact a provider or read real keys.
fn serve_image_fixture(body: Vec<u8>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "fixture request timed out");
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            }
        };
        // Windows inherits nonblocking mode from the listening socket.
        // Restore blocking reads and bound both I/O directions for this fixture.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            stream.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
            assert!(headers.len() < 64 * 1024);
        }
        let request = String::from_utf8(headers).unwrap();
        let length = request
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let mut request_body = vec![0u8; length];
        stream.read_exact(&mut request_body).unwrap();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
        stream.write_all(&body).unwrap();
        stream.flush().unwrap();
    });
    (format!("http://{address}"), server)
}

fn fixture_request(base_url: &str, output_dir: &Path) -> Value {
    json!({
        "apiKey": "synthetic-test-key-not-a-secret",
        "baseUrl": base_url,
        "outputDir": output_dir.to_string_lossy(),
        "prompt": "synthetic-prompt-must-not-appear-in-timings",
        "model": GAOGE_IMAGE_MODEL_2_5_FLARE,
        "imageCount": 1,
    })
}

#[test]
fn image_generation_timings_cover_success_without_external_requests() {
    let png_bytes = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4];
    let body = json!({"data": [{"b64_json": general_purpose::STANDARD.encode(png_bytes)}]});
    let (base_url, server) = serve_image_fixture(serde_json::to_vec(&body).unwrap());
    let output_dir = tempfile::tempdir().unwrap();
    let result = tauri::async_runtime::block_on(gaoge_generate_local_image_inner(fixture_request(
        &base_url,
        output_dir.path(),
    )))
    .unwrap();
    server.join().unwrap();
    assert_eq!(result["count"], 1);
    assert_eq!(result["failedCount"], 0);
    let timings = &result["timingsMs"];
    for stage in [
        "preparation",
        "httpRequest",
        "responseBody",
        "responseParse",
        "imageDecode",
        "imageSave",
        "total",
    ] {
        assert!(timings[stage].is_u64(), "missing numeric timing {stage}");
    }
    assert!(timings.as_object().unwrap().values().all(Value::is_u64));
    let image_path = Path::new(result["images"][0]["path"].as_str().unwrap());
    assert_eq!(fs::read(image_path).unwrap(), png_bytes);
}

#[test]
fn image_generation_timings_preserve_parse_failure_stage() {
    let (base_url, server) = serve_image_fixture(b"not-json".to_vec());
    let output_dir = tempfile::tempdir().unwrap();
    let timings = ImageTimings::new();
    let result = tauri::async_runtime::block_on(gaoge_generate_local_image_timed(
        fixture_request(&base_url, output_dir.path()),
        &timings,
    ));
    server.join().unwrap();
    assert!(result.is_err());
    let values = timings.snapshot();
    assert!(values["httpRequest"].is_u64());
    assert!(values["responseBody"].is_u64());
    assert!(values["responseParse"].is_u64());
    assert!(values.get("imageSave").is_none());
}

#[test]
fn image_generation_timings_preserve_save_failure_stage() {
    let output = tempfile::NamedTempFile::new().unwrap();
    let timings = ImageTimings::new();
    assert!(save_local_image_result(output.path(), &[1, 2, 3], "image/png", 0, &timings).is_err());
    assert!(timings.snapshot()["imageSave"].is_u64());
}

#[test]
fn image_generation_timings_are_attached_to_mcp_failure() {
    let output = tauri::async_runtime::block_on(gaoge_image_mcp_call_tool(
        GAOGE_IMAGE_VIEW_TOOL,
        &json!({}),
    ));
    assert_eq!(output["isError"], true);
    assert!(output.get("structuredContent").is_none());
    let timings = &output["_meta"]["timingsMs"];
    assert!(timings["imageView"].is_u64());
    assert!(timings["total"].is_u64());
    assert!(timings.as_object().unwrap().values().all(Value::is_u64));
}

#[test]
fn image_generation_timings_do_not_hide_generation_error_content() {
    let mut output = gaoge_image_mcp_tool_error("synthetic generation failure");
    let before = output["content"].clone();
    attach_gaoge_image_mcp_timings(&mut output, json!({"total": 12}));
    assert!(output.get("structuredContent").is_none());
    assert_eq!(output["content"], before);
    assert_eq!(output["isError"], true);
    assert_eq!(output["_meta"]["timingsMs"]["total"], 12);
}

#[test]
fn image_generation_timings_preserve_generation_metadata() {
    let mut output = json!({"content": [{"type": "text", "text": "generated"}], "structuredContent": {"images": [], "count": 0}, "isError": false});
    attach_gaoge_image_mcp_timings(&mut output, json!({"total": 5}));
    assert_eq!(output["structuredContent"]["count"], 0);
    assert!(output["structuredContent"]["images"].is_array());
    assert_eq!(output["structuredContent"]["timingsMs"]["total"], 5);
}
