// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--gaoge-image-mcp") {
        if let Err(error) = app_lib::run_gaoge_image_mcp() {
            eprintln!("Gaoge image MCP server failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    app_lib::run();
}
