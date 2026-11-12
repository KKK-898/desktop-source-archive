#[path = "build_support/deployment_config.rs"]
mod deployment_config;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build_support/deployment_config.rs");
    println!("cargo:rerun-if-changed=../.env.local");
    for key in deployment_config::DEPLOYMENT_KEYS
        .into_iter()
        .chain(deployment_config::CI_KEYS)
    {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let configuration = deployment_config::resolve(
        |key| match std::env::var(key) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(std::env::VarError::NotUnicode(_)) => {
                Err(format!("Deployment variable {key} must use UTF-8"))
            }
        },
        || {
            let manifest = std::env::var_os("CARGO_MANIFEST_DIR")
                .ok_or("Cargo manifest directory is unavailable")?;
            let local = std::path::Path::new(&manifest)
                .parent()
                .ok_or("Cargo manifest directory has no parent")?
                .join(".env.local");
            match std::fs::read_to_string(local) {
                Ok(content) => Ok(Some(content)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(_) => Err("Cannot read local deployment configuration as UTF-8".to_owned()),
            }
        },
    )
    .unwrap_or_else(|error| panic!("Invalid build deployment configuration: {error}"));
    for (key, value) in configuration {
        println!("cargo:rustc-env={key}={value}");
    }
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    tauri_build::build()
}
