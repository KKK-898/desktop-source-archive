//! Signed, independently installed mobile gateway. No model/account credentials enter this module.
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::read::MultiGzDecoder;
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::State;

const MANIFEST_URL: &str = "https://api.gaogeaii.com/mobile-components/stable.json";
const PUBLIC_KEY: &str = include_str!("../../resources/mobile-component-public-key.txt");
const MAX_MANIFEST: u64 = 256 * 1024;
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    payload: String,
    signature: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    component: String,
    version: String,
    protocol_version: u32,
    min_app_version: String,
    platforms: BTreeMap<String, Artifact>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Artifact {
    url: String,
    sha256: String,
    size: u64,
    unpacked_size: u64,
    executable: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentStatus {
    state: String,
    installed_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    download_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    platform: String,
    compatible: bool,
}

impl Default for ComponentStatus {
    fn default() -> Self {
        Self {
            state: "not_installed".into(),
            installed_version: None,
            latest_version: None,
            update_available: false,
            download_bytes: 0,
            total_bytes: None,
            error: None,
            platform: platform_id(),
            compatible: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct MobileComponentRuntime {
    status: Arc<Mutex<ComponentStatus>>,
    busy: Arc<AtomicBool>,
}

struct Installed {
    manifest: Manifest,
    executable: PathBuf,
}

pub fn platform_id() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}
fn component_root() -> PathBuf {
    super::roaming_app_dir().join("components/mobile-connection")
}
fn executable_name() -> &'static str {
    if cfg!(windows) {
        "gaoge-mobile-gateway.exe"
    } else {
        "gaoge-mobile-gateway"
    }
}

fn plain_version(value: &str) -> Result<semver::Version, String> {
    let parsed = semver::Version::parse(value).map_err(|_| "组件版本格式不正确")?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() || value.len() > 40 {
        return Err("组件版本格式不正确".into());
    }
    Ok(parsed)
}

fn allowed_url(raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "组件下载地址不正确")?;
    let authority = raw
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(""))
        .unwrap_or("");
    if raw.chars().any(char::is_control)
        || raw.contains('\\')
        || authority.contains('@')
        || url.scheme() != "https"
        || url.host_str() != Some("api.gaogeaii.com")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().starts_with("/mobile-components/")
        || url.path().contains('%')
        || raw.contains("/../")
        || raw.contains("/./")
    {
        return Err("组件下载地址不在官方组件目录内".into());
    }
    Ok(url)
}

fn verified_manifest(envelope: &Envelope, public_key: &str) -> Result<Manifest, String> {
    if envelope.payload.len() > MAX_MANIFEST as usize || envelope.signature.len() > 4096 {
        return Err("组件清单过大".into());
    }
    let payload = STANDARD
        .decode(&envelope.payload)
        .map_err(|_| "组件清单编码不正确")?;
    let key_bytes = STANDARD
        .decode(public_key.trim())
        .map_err(|_| "组件签名公钥不可用")?;
    let key_text = std::str::from_utf8(&key_bytes).map_err(|_| "组件签名公钥不可用")?;
    let key = PublicKey::decode(key_text).map_err(|_| "组件签名公钥不可用")?;
    let signature_bytes = STANDARD
        .decode(envelope.signature.trim())
        .map_err(|_| "组件签名编码不正确")?;
    let signature_text = std::str::from_utf8(&signature_bytes).map_err(|_| "组件签名编码不正确")?;
    let signature = Signature::decode(signature_text).map_err(|_| "组件签名格式不正确")?;
    key.verify(&payload, &signature, false)
        .map_err(|_| "组件签名验证失败，已拒绝安装")?;
    // Only signed bytes are interpreted as a manifest.
    let manifest: Manifest =
        serde_json::from_slice(&payload).map_err(|_| "已签名组件清单格式不正确")?;
    if manifest.schema_version != 1 || manifest.component != "mobile-connection" {
        return Err("组件清单类型不支持".into());
    }
    plain_version(&manifest.version)?;
    plain_version(&manifest.min_app_version)?;
    Ok(manifest)
}

fn artifact_for(manifest: &Manifest) -> Result<&Artifact, String> {
    artifact_for_app(manifest, env!("CARGO_PKG_VERSION"))
}

fn artifact_for_app<'a>(manifest: &'a Manifest, app_version: &str) -> Result<&'a Artifact, String> {
    if manifest.protocol_version != 1
        || plain_version(app_version)? < plain_version(&manifest.min_app_version)?
    {
        return Err("此手机组件需要更新主软件后使用".into());
    }
    let artifact = manifest
        .platforms
        .get(&platform_id())
        .ok_or("当前系统尚无可用的手机连接组件")?;
    allowed_url(&artifact.url)?;
    if artifact.executable != executable_name()
        || artifact.size == 0
        || artifact.size > MAX_DOWNLOAD
        || artifact.unpacked_size == 0
        || artifact.unpacked_size > MAX_UNPACKED
        || artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("组件文件信息不正确".into());
    }
    Ok(artifact)
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|_| "无法读取组件安装记录")?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取组件安装记录")?;
    if bytes.len() as u64 > limit {
        return Err("组件安装记录过大".into());
    }
    Ok(bytes)
}

fn no_link(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "组件目录不可访问")?;
    if metadata.file_type().is_symlink() {
        return Err("组件目录不能使用重定向链接".into());
    }
    Ok(())
}

fn installed_at(root: &Path) -> Result<Option<Installed>, String> {
    let receipt = root.join("active.json");
    if !receipt.try_exists().map_err(|_| "无法读取组件安装记录")? {
        return Ok(None);
    }
    if let Some(parent) = root.parent() {
        no_link(parent)?;
    }
    no_link(root)?;
    no_link(&receipt)?;
    let envelope: Envelope = serde_json::from_slice(&bounded_read(&receipt, MAX_MANIFEST)?)
        .map_err(|_| "组件安装记录已损坏")?;
    let manifest = verified_manifest(&envelope, PUBLIC_KEY)?;
    let artifact = artifact_for(&manifest)?;
    let relative = Path::new("versions")
        .join(&manifest.version)
        .join(platform_id())
        .join("runtime");
    let mut checked = root.to_owned();
    for piece in relative.components() {
        checked.push(piece);
        no_link(&checked)?;
    }
    let executable = checked.join(&artifact.executable);
    no_link(&executable)?;
    if !executable.is_file() || !checked.join("_internal/web/assets.json").is_file() {
        return Err("手机连接组件不完整，请重新安装组件".into());
    }
    Ok(Some(Installed {
        manifest,
        executable,
    }))
}

pub fn installed_executable() -> Result<Option<PathBuf>, String> {
    installed_at(&component_root()).map(|value| value.map(|item| item.executable))
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .gzip(false)
        .user_agent(concat!("Gaoge-MobileComponent/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "无法初始化组件下载".to_owned())
}

fn fetch_manifest() -> Result<(Envelope, Manifest), String> {
    let mut response = http_client()?
        .get(allowed_url(MANIFEST_URL)?)
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(|_| "暂时无法连接组件服务器，请稍后重试")?;
    if !response.status().is_success() {
        return Err("组件服务器暂不可用，请稍后重试".into());
    }
    let mut bytes = Vec::new();
    (&mut response)
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "组件清单下载失败")?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("组件清单过大".into());
    }
    let envelope: Envelope =
        serde_json::from_slice(&bytes).map_err(|_| "组件服务器返回的清单格式不正确")?;
    let manifest = verified_manifest(&envelope, PUBLIC_KEY)?;
    Ok((envelope, manifest))
}

impl MobileComponentRuntime {
    fn change(&self, update: impl FnOnce(&mut ComponentStatus)) {
        if let Ok(mut status) = self.status.lock() {
            update(&mut status);
        }
    }

    fn snapshot(&self) -> ComponentStatus {
        let mut status = self
            .status
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        match installed_at(&component_root()) {
            Ok(Some(installed)) => {
                status.installed_version = Some(installed.manifest.version);
                status.compatible = true;
                if status.state == "not_installed" {
                    status.state = "installed".into();
                }
            }
            Ok(None) => {
                status.installed_version = None;
                status.compatible = false;
            }
            Err(error) => {
                if !self.busy.load(Ordering::Acquire) {
                    status.state = "error".into();
                    status.error = Some(error);
                    status.compatible = false;
                }
            }
        }
        status
    }

    fn finish(&self, result: Result<(), String>) {
        self.change(|state| match result {
            Ok(()) => {
                state.state = if state.installed_version.is_some() {
                    "installed"
                } else {
                    "not_installed"
                }
                .into();
                state.error = None;
            }
            Err(error) => {
                state.state = "error".into();
                state.error = Some(error);
            }
        });
        self.busy.store(false, Ordering::Release);
    }

    fn note_latest(&self, root: &Path, manifest: &Manifest) -> Result<(), String> {
        let installed = installed_at(root).ok().flatten();
        let candidate = artifact_for(manifest);
        self.change(|state| {
            state.installed_version = installed
                .as_ref()
                .map(|value| value.manifest.version.clone());
            state.latest_version = Some(manifest.version.clone());
            state.compatible = installed.is_some();
            state.total_bytes = candidate.as_ref().ok().map(|value| value.size);
            state.update_available = candidate.is_ok()
                && installed.as_ref().is_some_and(|value| {
                    plain_version(&manifest.version).ok()
                        > plain_version(&value.manifest.version).ok()
                });
        });
        candidate.map(|_| ())
    }
}

#[tauri::command]
pub fn mobile_component_status(runtime: State<'_, MobileComponentRuntime>) -> ComponentStatus {
    runtime.snapshot()
}

#[tauri::command]
pub async fn mobile_component_check(
    runtime: State<'_, MobileComponentRuntime>,
) -> Result<ComponentStatus, String> {
    let runtime = runtime.inner().clone();
    if runtime.busy.swap(true, Ordering::AcqRel) {
        return Ok(runtime.snapshot());
    }
    runtime.change(|state| {
        state.state = "checking".into();
        state.error = None;
    });
    let worker = runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = fetch_manifest()
            .and_then(|(_, manifest)| worker.note_latest(&component_root(), &manifest));
        worker.finish(result);
    })
    .await
    .map_err(|_| {
        runtime.finish(Err("组件检查未能完成".into()));
        "组件检查未能完成".to_owned()
    })?;
    Ok(runtime.snapshot())
}

#[tauri::command]
pub fn mobile_component_install(
    runtime: State<'_, MobileComponentRuntime>,
    connection: State<'_, super::mobile_connection::MobileConnectionRuntime>,
) -> ComponentStatus {
    let runtime = runtime.inner().clone();
    if runtime.busy.swap(true, Ordering::AcqRel) {
        return runtime.snapshot();
    }
    runtime.change(|state| {
        state.state = "checking".into();
        state.error = None;
        state.download_bytes = 0;
    });
    let worker = runtime.clone();
    let connection = connection.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            install_component(&worker, &connection)
        }))
        .unwrap_or_else(|_| Err("组件安装未能完成，请重试".into()));
        worker.finish(result);
    });
    runtime.snapshot()
}

fn private_dir(path: &Path) -> Result<(), String> {
    if path.try_exists().map_err(|_| "无法访问组件目录")? {
        no_link(path)?;
        if !path.is_dir() {
            return Err("组件目录被其他文件占用".into());
        }
    } else {
        if let Some(parent) = path.parent() {
            private_dir(parent)?;
        }
        fs::create_dir(path).map_err(|_| "无法创建组件目录")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .map_err(|_| "无法保护组件目录")?;
        }
    }
    Ok(())
}

struct Staging {
    path: PathBuf,
    parent: PathBuf,
    preserve_recovery: bool,
}
impl Staging {
    fn create(root: &Path) -> Result<Self, String> {
        if let Some(parent) = root.parent() {
            if parent.exists() {
                no_link(parent)?;
            }
        }
        private_dir(root)?;
        let parent = root.canonicalize().map_err(|_| "组件目录不可访问")?;
        let path = parent.join(format!(".staging-{:032x}", rand::random::<u128>()));
        private_dir(&path)?;
        Ok(Self {
            path,
            parent,
            preserve_recovery: true,
        })
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        // Retain recovery files if filesystem errors prevented a rollback.
        if self.preserve_recovery && self.path.join("previous").exists() {
            return;
        }
        // This is our unique scratch directory, never a settings or active version directory.
        if self.path.parent() == Some(self.parent.as_path())
            && self
                .path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".staging-"))
            && no_link(&self.path).is_ok()
            && self
                .path
                .canonicalize()
                .ok()
                .is_some_and(|path| path.starts_with(&self.parent))
        {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn download_archive(
    runtime: &MobileComponentRuntime,
    artifact: &Artifact,
    destination: &Path,
) -> Result<(), String> {
    runtime.change(|state| {
        state.state = "downloading".into();
        state.total_bytes = Some(artifact.size);
    });
    let mut response = http_client()?
        .get(allowed_url(&artifact.url)?)
        .send()
        .map_err(|_| "组件下载失败，请检查网络后重试")?;
    if !response.status().is_success() {
        return Err("组件下载服务器暂不可用".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size != artifact.size)
    {
        return Err("组件下载大小与签名清单不符".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "无法保存组件下载文件")?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|_| "组件下载中断，请重试")?;
        if read == 0 {
            break;
        }
        count = count.checked_add(read as u64).ok_or("组件下载过大")?;
        if count > artifact.size {
            return Err("组件下载超过签名清单的大小".into());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| "无法保存组件下载文件，请检查磁盘空间")?;
        hash.update(&buffer[..read]);
        runtime.change(|state| state.download_bytes = count);
    }
    output.sync_all().map_err(|_| "无法保存组件下载文件")?;
    runtime.change(|state| state.state = "verifying".into());
    verify_download(count, &format!("{:x}", hash.finalize()), artifact)
}

fn verify_download(size: u64, sha256: &str, artifact: &Artifact) -> Result<(), String> {
    if size != artifact.size || sha256 != artifact.sha256.to_ascii_lowercase() {
        return Err("组件文件校验失败，原组件未更改".into());
    }
    Ok(())
}

fn archive_path(raw: &str) -> Result<PathBuf, String> {
    let value = raw.trim_end_matches('/');
    if value.is_empty()
        || value.len() > 2048
        || value.contains(['\\', ':', '\0'])
        || value.chars().any(char::is_control)
    {
        return Err("组件归档包含不安全的路径".into());
    }
    let pieces: Vec<_> = value.split('/').collect();
    if pieces.len() > 64
        || pieces.first() != Some(&"runtime")
        || pieces.iter().any(|piece| {
            piece.is_empty() || *piece == "." || *piece == ".." || piece.ends_with([' ', '.'])
        })
    {
        return Err("组件归档路径超出 runtime 目录".into());
    }
    Ok(pieces.iter().collect())
}

fn safe_link_target(link: &Path, raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty()
        || raw.len() > 2048
        || raw.starts_with('/')
        || raw.contains(['\\', ':', '\0'])
        || raw.chars().any(char::is_control)
    {
        return Err("组件归档包含不安全的链接".into());
    }
    let mut resolved = link.parent().ok_or("组件链接位置不正确")?.to_path_buf();
    for piece in raw.split('/') {
        match piece {
            "" | "." => (),
            ".." => {
                if resolved == Path::new("runtime") || !resolved.pop() {
                    return Err("组件链接逃出 runtime 目录".into());
                }
            }
            other => resolved.push(other),
        }
    }
    if !resolved.starts_with("runtime") {
        return Err("组件链接逃出 runtime 目录".into());
    }
    Ok(resolved)
}

fn parse_pax(
    bytes: &[u8],
    path: &mut Option<String>,
    link: &mut Option<String>,
) -> Result<(), String> {
    let mut cursor = 0;
    while cursor < bytes.len() {
        let rest = &bytes[cursor..];
        let space = rest
            .iter()
            .position(|byte| *byte == b' ')
            .ok_or("组件归档扩展记录不正确")?;
        let length: usize = std::str::from_utf8(&rest[..space])
            .ok()
            .and_then(|value| value.parse().ok())
            .ok_or("组件归档扩展长度不正确")?;
        if length <= space + 2 || length > rest.len() || rest[length - 1] != b'\n' {
            return Err("组件归档扩展长度不正确".into());
        }
        let record = std::str::from_utf8(&rest[space + 1..length - 1])
            .map_err(|_| "组件归档路径编码不正确")?;
        let (key, value) = record.split_once('=').ok_or("组件归档扩展记录不正确")?;
        match key {
            "path" => {
                if path.replace(value.into()).is_some() {
                    return Err("组件归档路径重复定义".into());
                }
            }
            "linkpath" => {
                if link.replace(value.into()).is_some() {
                    return Err("组件归档链接重复定义".into());
                }
            }
            "mtime" | "atime" | "ctime" | "uid" | "gid" | "uname" | "gname" => (),
            _ => return Err("组件归档包含不支持的扩展记录".into()),
        }
        cursor += length;
    }
    Ok(())
}

fn unpack_archive(archive: &Path, destination: &Path, declared_size: u64) -> Result<(), String> {
    let input = File::open(archive).map_err(|_| "无法读取组件归档")?;
    // Extra bounded space covers tar headers/padding, never arbitrarily expanded gzip data.
    let expanded_limit = declared_size + 64 * 1024 * 1024;
    let mut archive = tar::Archive::new(MultiGzDecoder::new(input).take(expanded_limit + 1));
    let mut pending_path = None;
    let mut pending_link = None;
    let mut links = Vec::new();
    let mut seen = HashSet::new();
    let mut count = 0usize;
    let mut unpacked = 0u64;
    for entry in archive.entries().map_err(|_| "组件归档无法读取")?.raw(true) {
        count += 1;
        if count > MAX_ENTRIES {
            return Err("组件归档文件过多".into());
        }
        let mut entry = entry.map_err(|_| "组件归档不完整")?;
        let kind = entry.header().entry_type();
        let size = entry.header().size().map_err(|_| "组件归档大小不正确")?;
        if kind.is_pax_local_extensions() || kind.is_gnu_longname() || kind.is_gnu_longlink() {
            if size > 16 * 1024 {
                return Err("组件归档扩展记录过大".into());
            }
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|_| "组件归档扩展记录不完整")?;
            if kind.is_pax_local_extensions() {
                parse_pax(&data, &mut pending_path, &mut pending_link)?;
            } else {
                let value = std::str::from_utf8(&data)
                    .map_err(|_| "组件归档路径编码不正确")?
                    .trim_end_matches(['\0', '\n'])
                    .to_owned();
                let previous = if kind.is_gnu_longname() {
                    pending_path.replace(value)
                } else {
                    pending_link.replace(value)
                };
                if previous.is_some() {
                    return Err("组件归档路径重复定义".into());
                }
            }
            continue;
        }
        let raw_path = pending_path.take().map(Ok).unwrap_or_else(|| {
            String::from_utf8(entry.path_bytes().into_owned())
                .map_err(|_| "组件归档路径编码不正确".to_owned())
        })?;
        let relative = archive_path(&raw_path)?;
        if !seen.insert(relative.clone()) {
            return Err("组件归档包含重复路径".into());
        }
        let output = destination.join(&relative);
        let link_name = pending_link.take();
        if kind.is_dir() {
            if size != 0 || link_name.is_some() {
                return Err("组件目录记录不正确".into());
            }
            private_dir(&output)?;
        } else if kind.is_file() {
            if link_name.is_some() {
                return Err("组件文件记录不正确".into());
            }
            unpacked = unpacked.checked_add(size).ok_or("组件解压大小超限")?;
            if unpacked > declared_size {
                return Err("组件解压大小超过签名清单".into());
            }
            private_dir(output.parent().ok_or("组件文件目录不正确")?)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)
                .map_err(|_| "无法写入组件文件")?;
            let written = std::io::copy(&mut entry, &mut file).map_err(|_| "组件文件解压失败")?;
            if written != size {
                return Err("组件文件不完整".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = entry.header().mode().map_err(|_| "组件文件权限不正确")? & 0o755;
                fs::set_permissions(&output, fs::Permissions::from_mode(mode))
                    .map_err(|_| "无法设置组件文件权限")?;
            }
        } else if kind.is_symlink() {
            if size != 0 {
                return Err("组件链接记录不正确".into());
            }
            let raw = link_name
                .or_else(|| {
                    entry
                        .link_name_bytes()
                        .and_then(|value| String::from_utf8(value.into_owned()).ok())
                })
                .ok_or("组件链接目标不正确")?;
            safe_link_target(&relative, &raw)?;
            links.push((relative, raw));
        } else {
            return Err("组件归档包含硬链接、设备或不支持的文件类型".into());
        }
    }
    // A tar reader can stop at its zero blocks before the gzip trailer. Drain the
    // bounded decoder so every gzip member's CRC and the expansion limit apply.
    let mut decoder = archive.into_inner();
    std::io::copy(&mut decoder, &mut std::io::sink()).map_err(|_| "组件压缩文件校验失败")?;
    if decoder.limit() == 0 {
        return Err("组件压缩文件展开大小超限".into());
    }
    if pending_path.is_some() || pending_link.is_some() || unpacked != declared_size {
        return Err("组件归档解压结果与清单不符".into());
    }
    let link_paths: HashSet<_> = links.iter().map(|(path, _)| path.clone()).collect();
    for path in &seen {
        let mut parent = path.parent();
        while let Some(value) = parent {
            if link_paths.contains(value) {
                return Err("组件归档试图通过链接写入文件".into());
            }
            parent = value.parent();
        }
    }
    for (relative, target) in &links {
        let output = destination.join(relative);
        private_dir(output.parent().ok_or("组件链接目录不正确")?)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, &output).map_err(|_| "无法创建组件运行库链接")?;
        #[cfg(not(unix))]
        {
            let _ = target;
            return Err("此系统的组件不允许符号链接".into());
        }
    }
    let root = destination
        .join("runtime")
        .canonicalize()
        .map_err(|_| "组件缺少 runtime 目录")?;
    for (relative, _) in &links {
        let target = destination
            .join(relative)
            .canonicalize()
            .map_err(|_| "组件运行库链接已损坏")?;
        if !target.starts_with(&root) {
            return Err("组件运行库链接逃出安装目录".into());
        }
    }
    Ok(())
}

fn isolated_self_check(binary: &Path, workspace: &Path) -> Result<(), String> {
    private_dir(workspace)?;
    let home = workspace.join("home");
    private_dir(&home)?;
    let mut command = super::hidden_command(binary);
    command
        .arg("self-check")
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if ["CODEX_", "OPENAI_", "ANTHROPIC_", "PYTHON", "PYINSTALLER"]
            .iter()
            .any(|prefix| upper.starts_with(prefix))
        {
            command.env_remove(key);
        }
    }
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
    ] {
        command.env(key, &home);
    }
    command
        .env("CODEX_HOME", workspace.join("absent-codex"))
        .env("PYINSTALLER_RESET_ENVIRONMENT", "1");
    let mut child = command.spawn().map_err(|_| "手机组件无法在当前系统启动")?;
    let stdout = child.stdout.take().ok_or("组件自检输出不可用")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(45);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("手机组件自检超时或未正常退出".into());
            }
        }
    };
    if !status.success() {
        return Err("手机组件自检失败，原组件未更改".into());
    }
    let output = receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "组件自检输出超时")?
        .map_err(|_| "组件自检输出不可读取")?;
    if output.len() > 16 * 1024 || workspace.join("absent-codex").exists() {
        return Err("组件自检行为不符合要求".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output).map_err(|_| "组件自检结果不正确")?;
    if value != serde_json::json!({"ok": true, "check": "mobile-runtime-imports-and-resources"}) {
        return Err("组件自检未通过".into());
    }
    Ok(())
}

fn install_component(
    runtime: &MobileComponentRuntime,
    connection: &super::mobile_connection::MobileConnectionRuntime,
) -> Result<(), String> {
    let _connection_guard = connection.begin_component_update()?;
    let (envelope, manifest) = fetch_manifest()?;
    install_verified_at(runtime, &component_root(), envelope, manifest)
}

fn install_verified_at(
    runtime: &MobileComponentRuntime,
    root: &Path,
    envelope: Envelope,
    manifest: Manifest,
) -> Result<(), String> {
    runtime.note_latest(root, &manifest)?;
    let artifact = artifact_for(&manifest)?;
    if let Some(installed) = installed_at(root).ok().flatten() {
        if plain_version(&manifest.version)? <= plain_version(&installed.manifest.version)? {
            return Ok(());
        }
    }
    let mut staging = Staging::create(root)?;
    let archive = staging.path.join("component.tar.gz");
    download_archive(runtime, artifact, &archive)?;
    let unpacked = staging.path.join("unpacked");
    private_dir(&unpacked)?;
    runtime.change(|state| state.state = "installing".into());
    unpack_archive(&archive, &unpacked, artifact.unpacked_size)?;
    let binary = unpacked.join("runtime").join(&artifact.executable);
    if !binary.is_file()
        || fs::symlink_metadata(&binary)
            .map_err(|_| "组件主程序缺失")?
            .file_type()
            .is_symlink()
    {
        return Err("组件主程序缺失或格式不正确".into());
    }
    isolated_self_check(&binary, &staging.path.join("check"))?;
    let version_root = root.join("versions").join(&manifest.version);
    private_dir(&version_root)?;
    let destination = version_root.join(platform_id());
    let receipt = serde_json::to_value(envelope).map_err(|_| "无法保存组件记录")?;
    activate_version(
        &unpacked,
        &destination,
        &staging.path.join("previous"),
        || {
            super::write_json_pretty_atomic(&root.join("active.json"), &receipt)
                .map_err(|_| "无法启用手机组件，原组件仍保留".into())
        },
    )?;
    staging.preserve_recovery = false;
    runtime.change(|state| {
        state.installed_version = Some(manifest.version.clone());
        state.update_available = false;
        state.compatible = true;
    });
    Ok(())
}

fn activate_version(
    staged: &Path,
    destination: &Path,
    backup: &Path,
    save_receipt: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let existed = destination.exists();
    if existed {
        no_link(destination)?;
        fs::rename(destination, backup).map_err(|_| "无法保留现有手机组件")?;
    }
    if fs::rename(staged, destination).is_err() {
        if existed {
            let _ = fs::rename(backup, destination);
        }
        return Err("无法保存已验证的手机组件".into());
    }
    if let Err(error) = save_receipt() {
        // Roll back paths as well as keeping the old atomic receipt untouched.
        if fs::rename(destination, staged).is_ok() && existed {
            let _ = fs::rename(backup, destination);
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
pub fn install_official_for_test(root: &Path) -> Result<serde_json::Value, String> {
    let runtime = MobileComponentRuntime::default();
    let (envelope, manifest) = fetch_manifest()?;
    install_verified_at(&runtime, root, envelope, manifest)?;
    let installed = installed_at(root)?.ok_or("隔离组件没有启用")?;
    Ok(
        serde_json::json!({"version": installed.manifest.version, "executable": installed.executable, "compatible": true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest {
            schema_version: 1,
            component: "mobile-connection".into(),
            version: "1.0.0".into(),
            protocol_version: 1,
            min_app_version: "1.6.6".into(),
            platforms: BTreeMap::from([(
                platform_id(),
                Artifact {
                    url: "https://api.gaogeaii.com/mobile-components/1.0.0/test.tar.gz".into(),
                    sha256: format!("{:x}", Sha256::digest(b"ok")),
                    size: 2,
                    unpacked_size: 2,
                    executable: executable_name().into(),
                },
            )]),
        }
    }

    fn archive(directory: &Path, entries: &[(&str, u8, &[u8], Option<&str>)]) -> PathBuf {
        let path = directory.join("fixture.tar.gz");
        let gzip = flate2::write::GzEncoder::new(
            File::create(&path).unwrap(),
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(gzip);
        for (name, kind, bytes, link) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::new(*kind));
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            // Deliberately allow hostile paths to reach our extractor in these fixtures.
            header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
            if let Some(target) = link {
                header.set_link_name(target).unwrap();
            }
            header.set_cksum();
            builder.append(&header, *bytes).unwrap();
        }
        builder.finish().unwrap();
        drop(builder);
        path
    }

    #[test]
    fn urls_cannot_redirect_authority_or_escape_official_directory() {
        assert!(allowed_url(MANIFEST_URL).is_ok());
        for bad in [
            "http://api.gaogeaii.com/mobile-components/stable.json",
            "https://api.gaogeaii.com.evil.test/mobile-components/a",
            "https://api.gaogeaii.com:8443/mobile-components/a",
            "https://@api.gaogeaii.com/mobile-components/a",
            "https://x:secret@api.gaogeaii.com/mobile-components/a",
            "https://api.gaogeaii.com/mobile-components/../a",
            "https://api.gaogeaii.com/mobile-components/%2e%2e/a",
            "https://api.gaogeaii.com/mobile-components/a?url=evil",
            "https://api.gaogeaii.com/mobile-components/a#x",
        ] {
            assert!(allowed_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tampered_signature_is_rejected_before_manifest_json_is_parsed() {
        let envelope = Envelope {
            payload: STANDARD.encode(b"this is not json"),
            signature: STANDARD.encode(b"forged signature"),
        };
        let error = verified_manifest(&envelope, PUBLIC_KEY).unwrap_err();
        assert!(error.contains("签名"));
        assert!(!error.contains("已签名组件清单"));
    }

    #[test]
    fn archive_digest_and_size_must_both_match() {
        let manifest = manifest();
        let artifact = artifact_for(&manifest).unwrap();
        assert!(verify_download(2, &artifact.sha256, artifact).is_ok());
        assert!(verify_download(3, &artifact.sha256, artifact).is_err());
        assert!(verify_download(2, &format!("{:x}", Sha256::digest(b"no")), artifact).is_err());
    }

    #[test]
    fn cached_component_remains_compatible_after_main_app_upgrade() {
        let mut manifest = manifest();
        assert!(artifact_for_app(&manifest, "1.6.6").is_ok());
        assert!(artifact_for_app(&manifest, "1.7.0").is_ok());
        assert!(artifact_for_app(&manifest, "1.6.5").is_err());
        manifest.protocol_version = 2;
        assert!(artifact_for_app(&manifest, "1.7.0").is_err());
    }

    #[test]
    fn failed_activation_preserves_old_receipt_and_existing_directory() {
        let fixture = tempfile::tempdir().unwrap();
        let old = fixture.path().join("active");
        let staged = fixture.path().join("new");
        let backup = fixture.path().join("backup");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&staged).unwrap();
        fs::write(old.join("gateway"), b"old").unwrap();
        fs::write(staged.join("gateway"), b"new").unwrap();
        let receipt = fixture.path().join("active.json");
        fs::write(&receipt, b"old signed receipt").unwrap();
        assert!(
            activate_version(&staged, &old, &backup, || Err("simulated full disk".into())).is_err()
        );
        assert_eq!(fs::read(old.join("gateway")).unwrap(), b"old");
        assert_eq!(fs::read(&receipt).unwrap(), b"old signed receipt");
        assert!(!backup.exists());
    }

    #[test]
    fn successful_repair_cleans_backup_but_failed_rollback_keeps_recovery_files() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("component");
        let mut staging = Staging::create(&root).unwrap();
        let staged = staging.path.join("unpacked");
        let destination = root.join("existing");
        fs::create_dir(&staged).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(staged.join("gateway"), b"new").unwrap();
        fs::write(destination.join("gateway"), b"damaged").unwrap();
        activate_version(
            &staged,
            &destination,
            &staging.path.join("previous"),
            || Ok(()),
        )
        .unwrap();
        staging.preserve_recovery = false;
        let scratch = staging.path.clone();
        drop(staging);
        assert!(!scratch.exists());
        assert_eq!(fs::read(destination.join("gateway")).unwrap(), b"new");
        let recovery = Staging::create(&root).unwrap();
        fs::create_dir(recovery.path.join("previous")).unwrap();
        let scratch = recovery.path.clone();
        drop(recovery);
        assert!(scratch.join("previous").is_dir());
    }

    #[test]
    fn extraction_rejects_escape_hardlinks_devices_and_excess_bytes() {
        for (name, kind, data, link, size) in [
            ("runtime/../../escape", b'0', &b"x"[..], None, 1),
            ("/runtime/escape", b'0', &b"x"[..], None, 1),
            ("runtime/hard", b'1', &b""[..], Some("runtime/a"), 0),
            ("runtime/device", b'3', &b""[..], None, 0),
            ("runtime/oversize", b'0', &b"too long"[..], None, 2),
            ("runtime/link", b'2', &b""[..], Some("../../outside"), 0),
        ] {
            let fixture = tempfile::tempdir().unwrap();
            let input = archive(fixture.path(), &[(name, kind, data, link)]);
            let output = fixture.path().join("out");
            fs::create_dir(&output).unwrap();
            assert!(unpack_archive(&input, &output, size).is_err(), "{name}");
            assert!(!fixture.path().join("escape").exists());
        }
    }

    #[test]
    fn extraction_supports_bounded_pax_paths_and_rejects_link_parent_writes() {
        let fixture = tempfile::tempdir().unwrap();
        let name = format!("runtime/{}", "long-".repeat(30));
        let mut record = format!(" path={name}\n");
        let length = (record.len() + (record.len() + 4).to_string().len()).to_string();
        record = format!("{length}{record}");
        assert_eq!(record.len(), length.parse::<usize>().unwrap());
        let input = archive(
            fixture.path(),
            &[
                ("pax", b'x', record.as_bytes(), None),
                ("short", b'0', b"ok", None),
            ],
        );
        let output = fixture.path().join("out");
        fs::create_dir(&output).unwrap();
        unpack_archive(&input, &output, 2).unwrap();
        assert_eq!(fs::read(output.join(name)).unwrap(), b"ok");
        let second = tempfile::tempdir().unwrap();
        let input = archive(
            second.path(),
            &[
                ("runtime/link", b'2', b"", Some("real")),
                ("runtime/link/file", b'0', b"ok", None),
            ],
        );
        let output = second.path().join("out");
        fs::create_dir(&output).unwrap();
        assert!(unpack_archive(&input, &output, 2).is_err());
    }

    #[test]
    fn extraction_reads_gzip_trailer_and_bounds_data_after_tar_end() {
        let fixture = tempfile::tempdir().unwrap();
        let input = archive(fixture.path(), &[("runtime/data", b'0', b"ok", None)]);
        let mut bytes = fs::read(&input).unwrap();
        let crc_offset = bytes.len() - 8;
        bytes[crc_offset] ^= 1;
        fs::write(&input, bytes).unwrap();
        let output = fixture.path().join("bad-crc");
        fs::create_dir(&output).unwrap();
        assert!(unpack_archive(&input, &output, 2).is_err());

        let input = archive(fixture.path(), &[("runtime/data", b'0', b"ok", None)]);
        let append = OpenOptions::new().append(true).open(&input).unwrap();
        let mut extra = flate2::write::GzEncoder::new(append, flate2::Compression::fast());
        let chunk = [0u8; 64 * 1024];
        for _ in 0..1024 {
            extra.write_all(&chunk).unwrap();
        }
        extra.finish().unwrap();
        let output = fixture.path().join("expansion");
        fs::create_dir(&output).unwrap();
        assert!(unpack_archive(&input, &output, 2).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn extraction_preserves_safe_framework_symlinks_and_executable_bits() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = tempfile::tempdir().unwrap();
        let input = archive(
            fixture.path(),
            &[
                ("runtime/Versions/3.14/Python", b'0', b"ok", None),
                ("runtime/Versions/Current", b'2', b"", Some("3.14")),
                ("runtime/Python", b'2', b"", Some("Versions/Current/Python")),
            ],
        );
        let output = fixture.path().join("out");
        fs::create_dir(&output).unwrap();
        unpack_archive(&input, &output, 2).unwrap();
        assert!(output.join("runtime/Versions/Current").is_symlink());
        assert!(output.join("runtime/Python").is_symlink());
        assert_eq!(fs::read(output.join("runtime/Python")).unwrap(), b"ok");
        assert_ne!(
            fs::metadata(output.join("runtime/Python"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn extraction_rejects_link_cycles_and_escape_after_real_link_resolution() {
        for entries in [
            vec![
                ("runtime/data", b'0', &b"ok"[..], None),
                ("runtime/a", b'2', b"", Some("b")),
                ("runtime/b", b'2', b"", Some("a")),
            ],
            vec![
                ("runtime/data", b'0', &b"ok"[..], None),
                ("runtime/deep/alias", b'2', b"", Some("..")),
                (
                    "runtime/escape",
                    b'2',
                    b"",
                    Some("deep/alias/../../outside"),
                ),
            ],
        ] {
            let fixture = tempfile::tempdir().unwrap();
            fs::write(fixture.path().join("outside"), b"untouched").unwrap();
            let input = archive(fixture.path(), &entries);
            let output = fixture.path().join("out");
            fs::create_dir(&output).unwrap();
            assert!(unpack_archive(&input, &output, 2).is_err());
            assert_eq!(
                fs::read(fixture.path().join("outside")).unwrap(),
                b"untouched"
            );
        }
    }

    #[test]
    #[ignore = "Downloads the signed public component into a temporary test directory only"]
    fn official_download_isolated_and_offline_reuse() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("components/mobile-connection");
        // Mirror the production sibling layout with fake configuration only.
        let settings = fixture.path().join("mobile-connection");
        fs::create_dir(&settings).unwrap();
        let sentinels = [
            ("mobile-settings.json", &b"isolated settings sentinel"[..]),
            (
                "relay-registration.secure.json",
                &b"isolated encrypted registration sentinel"[..],
            ),
        ];
        for (name, bytes) in sentinels {
            fs::write(settings.join(name), bytes).unwrap();
        }
        let report = install_official_for_test(&root).unwrap();
        let receipt = fs::read(root.join("active.json")).unwrap();
        let first = installed_at(&root).unwrap().unwrap();
        let executable = fs::read(&first.executable).unwrap();
        // A fresh manager reuses the cached signed manifest and installed files.
        // This invokes the actual same-version installation path without fetching
        // a manifest, and must not enter the archive download/self-check path.
        let envelope: Envelope = serde_json::from_slice(&receipt).unwrap();
        let manifest = verified_manifest(&envelope, PUBLIC_KEY).unwrap();
        let fresh_runtime = MobileComponentRuntime::default();
        install_verified_at(&fresh_runtime, &root, envelope, manifest).unwrap();
        let second = installed_at(&root).unwrap().unwrap();
        assert_eq!(first.executable, second.executable);
        assert_eq!(fresh_runtime.status.lock().unwrap().download_bytes, 0);
        assert_eq!(fs::read(root.join("active.json")).unwrap(), receipt);
        assert_eq!(fs::read(&second.executable).unwrap(), executable);
        for (name, bytes) in sentinels {
            assert_eq!(fs::read(settings.join(name)).unwrap(), bytes);
        }
        assert!(report["compatible"].as_bool().unwrap());
        println!(
            "Verified isolated signed install, same-version reuse without download, and unchanged settings: {}",
            report["version"]
        );
    }
}
