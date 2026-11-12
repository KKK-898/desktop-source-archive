use base64::{engine::general_purpose, Engine as _};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use url::Url;
use zip::ZipArchive;

const THEME_SCHEMA_VERSION: u32 = 1;
const THEME_CATALOG_MAX_BYTES: usize = 2 * 1024 * 1024;
const THEME_PACKAGE_MAX_BYTES: usize = 15 * 1024 * 1024;
const THEME_BACKGROUND_MAX_BYTES: usize = 8 * 1024 * 1024;
const THEME_PREVIEW_MAX_BYTES: usize = 2 * 1024 * 1024;
const THEME_JSON_MAX_BYTES: usize = 64 * 1024;
const THEME_TEXT_MAX_BYTES: usize = 256 * 1024;
const THEME_DOWNLOAD_EVENT: &str = "gaoge-codex-theme-download-status";
const THEME_REQUIRED_FILES: [&str; 5] = [
    "theme.json",
    "background.webp",
    "preview.webp",
    "LICENSE.txt",
    "NOTICE.txt",
];
const BUILTIN_THEME_IDS: [&str; 10] = [
    "aurora-valley",
    "ink-mountains",
    "neon-harbor",
    "qq-retro",
    "deepspace-star",
    "deepspace-dawn",
    "dragonball-super-saiyan",
    "dalao-dianyan",
    "wuthering-echo",
    "genshin-dawn",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeBackground {
    pub file: String,
    pub position_x: u8,
    pub position_y: u8,
    pub overlay_opacity: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeColors {
    pub accent: String,
    pub secondary: String,
    pub surface: String,
    pub text: String,
    pub muted: String,
    pub border: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeEffects {
    pub panel_opacity: f32,
    pub panel_blur: u8,
    pub radius: u8,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeSource {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub repository: String,
    #[serde(default)]
    pub commit: String,
    #[serde(default)]
    pub original_path: String,
    #[serde(default)]
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub platforms: Vec<String>,
    #[serde(default = "default_theme_runtime")]
    pub runtime: String,
    pub appearance: String,
    pub background: ThemeBackground,
    pub preview: String,
    pub colors: ThemeColors,
    pub effects: ThemeEffects,
    pub source: ThemeSource,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemeCatalogItem {
    id: String,
    name: String,
    version: String,
    author: String,
    description: String,
    style: String,
    platforms: Vec<String>,
    #[serde(default = "default_theme_runtime")]
    runtime: String,
    appearance: String,
    package: String,
    preview: String,
    sha256: String,
    size_bytes: u64,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    source_label: String,
    #[serde(default)]
    source: ThemeSource,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemeCatalog {
    schema_version: u32,
    #[serde(default)]
    generated_at: String,
    themes: Vec<ThemeCatalogItem>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThemeState {
    #[serde(default)]
    active_theme_id: String,
    #[serde(default)]
    debug_port: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThemeRuntimePayload {
    pub id: String,
    pub version: String,
    pub signature: String,
    pub name: String,
    pub runtime: String,
    pub appearance: String,
    pub background_data_url: String,
    pub background: ThemeBackground,
    pub colors: ThemeColors,
    pub effects: ThemeEffects,
}

static THEME_RUNTIME_PAYLOAD_CACHE: Lazy<Mutex<Option<(String, CodexThemeRuntimePayload)>>> =
    Lazy::new(|| Mutex::new(None));

fn invalidate_theme_runtime_payload_cache(theme_id: Option<&str>) {
    let Ok(mut cache) = THEME_RUNTIME_PAYLOAD_CACHE.lock() else {
        return;
    };
    if theme_id.is_none()
        || cache
            .as_ref()
            .is_some_and(|(cached_id, _)| Some(cached_id.as_str()) == theme_id)
    {
        *cache = None;
    }
}

fn default_true() -> bool {
    true
}

fn default_theme_runtime() -> String {
    "wallpaper".to_string()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn app_data_root() -> PathBuf {
    if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"))
            .join("Gaoge Free")
    } else if cfg!(target_os = "macos") {
        home_dir()
            .join("Library")
            .join("Application Support")
            .join("Gaoge Free")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join(".config"))
            .join("gaoge-free")
    }
}

fn theme_root() -> PathBuf {
    app_data_root().join("codex-themes")
}

fn installed_root() -> PathBuf {
    theme_root().join("installed")
}

fn theme_state_path() -> PathBuf {
    theme_root().join("state.json")
}

fn catalog_cache_path() -> PathBuf {
    theme_root().join("catalog-cache.json")
}

fn temp_root() -> PathBuf {
    theme_root().join("temp")
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("主题路径缺少父目录：{}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建主题目录失败 {}：{error}", parent.display()))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    ensure_parent(path)?;
    let data =
        serde_json::to_vec_pretty(value).map_err(|error| format!("序列化主题数据失败：{error}"))?;
    let temp = path.with_extension(format!("tmp-{}", now_millis()));
    let previous = path.with_extension(format!("previous-{}", now_millis()));
    fs::write(&temp, data)
        .map_err(|error| format!("写入主题临时文件失败 {}：{error}", temp.display()))?;
    if path.exists() {
        fs::rename(path, &previous)
            .map_err(|error| format!("暂存旧主题数据失败 {}：{error}", path.display()))?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        let rollback_error = if previous.exists() {
            fs::rename(&previous, path).err()
        } else {
            None
        };
        let _ = fs::remove_file(&temp);
        return Err(match rollback_error {
            Some(rollback) => format!(
                "提交主题数据失败 {}：{error}；恢复旧数据也失败：{rollback}",
                path.display()
            ),
            None => format!("提交主题数据失败 {}：{error}", path.display()),
        });
    }
    if previous.exists() {
        let _ = fs::remove_file(previous);
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let data =
        fs::read(path).map_err(|error| format!("读取主题数据失败 {}：{error}", path.display()))?;
    serde_json::from_slice(&data)
        .map_err(|error| format!("解析主题数据失败 {}：{error}", path.display()))
}

fn read_state() -> ThemeState {
    read_json(&theme_state_path()).unwrap_or_default()
}

fn write_state(state: &ThemeState) -> Result<(), String> {
    write_json(&theme_state_path(), state)
}

fn valid_theme_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn valid_semver(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 6 && part.bytes().all(|b| b.is_ascii_digit())
        })
}

fn valid_hex_color(value: &str) -> bool {
    let value = value.strip_prefix('#').unwrap_or("");
    matches!(value.len(), 6 | 8) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_platform(value: &str) -> bool {
    matches!(value, "windows" | "macos")
}

fn valid_catalog_resource_path(value: &str, prefix: &str, extension: &str) -> bool {
    value.starts_with(prefix)
        && value.ends_with(extension)
        && value.len() <= 180
        && !value.contains("..")
        && !value.contains('\\')
        && !value.contains(':')
        && !value.contains('?')
        && !value.contains('#')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
}

fn current_theme_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "unsupported"
    }
}

fn validate_manifest(manifest: &ThemeManifest) -> Result<(), String> {
    if manifest.schema_version != THEME_SCHEMA_VERSION {
        return Err(format!(
            "主题 schemaVersion 必须为 {THEME_SCHEMA_VERSION}。"
        ));
    }
    if !valid_theme_id(&manifest.id) {
        return Err("主题 ID 必须为 3-64 位小写字母、数字或连字符。".to_string());
    }
    if !(1..=40).contains(&manifest.name.chars().count()) {
        return Err("主题名称必须为 1-40 个字符。".to_string());
    }
    if !(1..=40).contains(&manifest.author.chars().count()) {
        return Err("主题作者必须为 1-40 个字符。".to_string());
    }
    if manifest.description.chars().count() > 180 {
        return Err("主题简介不能超过 180 个字符。".to_string());
    }
    if !valid_semver(&manifest.version) {
        return Err("主题版本必须使用 x.y.z 格式。".to_string());
    }
    if manifest.platforms.is_empty()
        || manifest.platforms.len() > 2
        || !manifest.platforms.iter().all(|item| valid_platform(item))
    {
        return Err("主题 platforms 只能包含 windows 和 macos。".to_string());
    }
    if !matches!(manifest.appearance.as_str(), "light" | "dark" | "system") {
        return Err("主题 appearance 只能为 light、dark 或 system。".to_string());
    }
    if !matches!(manifest.runtime.as_str(), "wallpaper" | "qq-retro") {
        return Err("主题 runtime 只能为 wallpaper 或 qq-retro。".to_string());
    }
    if manifest.runtime == "qq-retro" && manifest.id != "qq-retro" {
        return Err("QQ 复古运行时只能由内置 qq-retro 主题使用。".to_string());
    }
    if manifest.background.file != "background.webp" || manifest.preview != "preview.webp" {
        return Err("主题图片文件必须为 background.webp 和 preview.webp。".to_string());
    }
    if manifest.background.position_x > 100 || manifest.background.position_y > 100 {
        return Err("主题背景位置必须在 0-100 之间。".to_string());
    }
    if !(0.0..=0.85).contains(&manifest.background.overlay_opacity) {
        return Err("主题背景遮罩必须在 0-0.85 之间。".to_string());
    }
    for (name, value) in [
        ("accent", &manifest.colors.accent),
        ("secondary", &manifest.colors.secondary),
        ("surface", &manifest.colors.surface),
        ("text", &manifest.colors.text),
        ("muted", &manifest.colors.muted),
        ("border", &manifest.colors.border),
    ] {
        if !valid_hex_color(value) {
            return Err(format!("主题颜色 {name} 必须为 #RRGGBB 或 #RRGGBBAA。"));
        }
    }
    if !(0.45..=1.0).contains(&manifest.effects.panel_opacity)
        || manifest.effects.panel_blur > 24
        || manifest.effects.radius > 12
    {
        return Err("主题面板透明度、模糊或圆角参数超出允许范围。".to_string());
    }
    if !matches!(
        manifest.source.kind.as_str(),
        "original" | "community" | "custom"
    ) || manifest.source.repository.len() > 300
        || manifest.source.commit.len() > 80
        || manifest.source.original_path.len() > 300
        || (!manifest.source.sha256.is_empty()
            && (manifest.source.sha256.len() != 64
                || !manifest
                    .source
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())))
    {
        return Err("主题素材来源字段无效。".to_string());
    }
    Ok(())
}

fn webp_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    if data.len() < 30 || &data[0..4] != b"RIFF" || &data[8..12] != b"WEBP" {
        return Err("主题图片不是有效的 WebP 文件。".to_string());
    }
    match &data[12..16] {
        b"VP8X" if data.len() >= 30 => {
            let width = 1 + u32::from_le_bytes([data[24], data[25], data[26], 0]);
            let height = 1 + u32::from_le_bytes([data[27], data[28], data[29], 0]);
            Ok((width, height))
        }
        b"VP8L" if data.len() >= 25 && data[20] == 0x2f => {
            let bits = u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
            Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8 " if data.len() >= 30 && data[23..26] == [0x9d, 0x01, 0x2a] => {
            let width = u16::from_le_bytes([data[26], data[27]]) & 0x3fff;
            let height = u16::from_le_bytes([data[28], data[29]]) & 0x3fff;
            Ok((u32::from(width), u32::from(height)))
        }
        _ => Err("无法识别主题 WebP 图片尺寸。".to_string()),
    }
}

fn validate_image(data: &[u8], preview: bool) -> Result<(u32, u32), String> {
    let limit = if preview {
        THEME_PREVIEW_MAX_BYTES
    } else {
        THEME_BACKGROUND_MAX_BYTES
    };
    if data.is_empty() || data.len() > limit {
        return Err(format!(
            "{}大小必须在 1 字节到 {}MB 之间。",
            if preview { "预览图" } else { "背景图" },
            limit / 1024 / 1024
        ));
    }
    let (width, height) = webp_dimensions(data)?;
    if width > 7680 || height > 4320 {
        return Err("主题图片不能超过 7680×4320。".to_string());
    }
    if !preview && (width < 1280 || height < 720) {
        return Err("主题背景图不能低于 1280×720。".to_string());
    }
    if preview && (width < 640 || height < 360) {
        return Err("主题预览图不能低于 640×360。".to_string());
    }
    Ok((width, height))
}

fn zip_entry_name(path: &Path) -> Result<String, String> {
    let mut components = path.components();
    let Some(Component::Normal(name)) = components.next() else {
        return Err("主题 ZIP 包含非法路径。".to_string());
    };
    if components.next().is_some() {
        return Err("主题 ZIP 文件必须全部位于根目录。".to_string());
    }
    name.to_str()
        .map(str::to_string)
        .ok_or_else(|| "主题 ZIP 文件名不是有效 UTF-8。".to_string())
}

fn validate_and_extract_package_bytes(
    bytes: &[u8],
    destination: &Path,
) -> Result<ThemeManifest, String> {
    if bytes.is_empty() || bytes.len() > THEME_PACKAGE_MAX_BYTES {
        return Err("主题 ZIP 必须小于 15MB。".to_string());
    }
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("读取主题 ZIP 失败：{error}"))?;
    if archive.len() != THEME_REQUIRED_FILES.len() {
        return Err("主题 ZIP 必须且只能包含五个规范文件。".to_string());
    }

    let allowed = THEME_REQUIRED_FILES.into_iter().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut files = HashMap::<String, Vec<u8>>::new();
    let mut total_uncompressed = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取主题 ZIP 条目失败：{error}"))?;
        if entry.is_dir() {
            return Err("主题 ZIP 不允许包含目录。".to_string());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("主题 ZIP 不允许包含符号链接。".to_string());
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "主题 ZIP 包含路径穿越条目。".to_string())?;
        let name = zip_entry_name(&enclosed)?;
        if !allowed.contains(name.as_str()) || !seen.insert(name.clone()) {
            return Err(format!("主题 ZIP 包含非法或重复文件：{name}"));
        }
        let entry_size =
            usize::try_from(entry.size()).map_err(|_| "主题 ZIP 解压大小异常。".to_string())?;
        total_uncompressed = total_uncompressed
            .checked_add(entry_size)
            .ok_or_else(|| "主题 ZIP 解压大小溢出。".to_string())?;
        if total_uncompressed > THEME_PACKAGE_MAX_BYTES * 2 {
            return Err("主题 ZIP 解压后体积过大。".to_string());
        }
        let file_limit = match name.as_str() {
            "theme.json" => THEME_JSON_MAX_BYTES,
            "background.webp" => THEME_BACKGROUND_MAX_BYTES,
            "preview.webp" => THEME_PREVIEW_MAX_BYTES,
            _ => THEME_TEXT_MAX_BYTES,
        };
        if entry_size > file_limit {
            return Err(format!("主题文件 {name} 超过大小限制。"));
        }
        let mut data = Vec::with_capacity(entry_size);
        entry
            .read_to_end(&mut data)
            .map_err(|error| format!("解压主题文件 {name} 失败：{error}"))?;
        files.insert(name, data);
    }
    if seen.len() != allowed.len() {
        return Err("主题 ZIP 缺少必要文件。".to_string());
    }

    let manifest: ThemeManifest = serde_json::from_slice(
        files
            .get("theme.json")
            .ok_or_else(|| "主题 ZIP 缺少 theme.json。".to_string())?,
    )
    .map_err(|error| format!("解析 theme.json 失败：{error}"))?;
    validate_manifest(&manifest)?;
    validate_image(
        files
            .get("background.webp")
            .ok_or_else(|| "主题 ZIP 缺少背景图。".to_string())?,
        false,
    )?;
    validate_image(
        files
            .get("preview.webp")
            .ok_or_else(|| "主题 ZIP 缺少预览图。".to_string())?,
        true,
    )?;
    for name in ["LICENSE.txt", "NOTICE.txt"] {
        let text = std::str::from_utf8(
            files
                .get(name)
                .ok_or_else(|| format!("主题 ZIP 缺少 {name}。"))?,
        )
        .map_err(|_| format!("{name} 必须使用 UTF-8 编码。"))?;
        if text.trim().is_empty() {
            return Err(format!("{name} 不能为空。"));
        }
    }

    fs::create_dir_all(destination)
        .map_err(|error| format!("创建主题解压目录失败 {}：{error}", destination.display()))?;
    for (name, data) in files {
        fs::write(destination.join(name), data)
            .map_err(|error| format!("写入主题文件失败：{error}"))?;
    }
    Ok(manifest)
}

fn theme_dir(theme_id: &str) -> PathBuf {
    installed_root().join(theme_id)
}

fn installed_manifest(theme_id: &str) -> Result<ThemeManifest, String> {
    if !valid_theme_id(theme_id) {
        return Err("主题 ID 无效。".to_string());
    }
    let manifest: ThemeManifest = read_json(&theme_dir(theme_id).join("theme.json"))?;
    validate_manifest(&manifest)?;
    if manifest.id != theme_id {
        return Err("主题目录和 theme.json 的 ID 不一致。".to_string());
    }
    Ok(manifest)
}

fn installed_manifests() -> (Vec<ThemeManifest>, Vec<String>) {
    let mut manifests = Vec::new();
    let mut warnings = Vec::new();
    let Ok(entries) = fs::read_dir(installed_root()) else {
        return (manifests, warnings);
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        match installed_manifest(&id) {
            Ok(manifest) => manifests.push(manifest),
            Err(error) => warnings.push(format!("{id}: {error}")),
        }
    }
    manifests.sort_by(|left, right| left.name.cmp(&right.name));
    (manifests, warnings)
}

fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parts = |value: &str| {
        value
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    parts(left).cmp(&parts(right))
}

fn normalized_download_base(download_base_url: &str) -> Result<Url, String> {
    let value = download_base_url.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err("当前服务器没有配置主题下载地址。".to_string());
    }
    let url = Url::parse(value).map_err(|error| format!("主题下载地址无效：{error}"))?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "::1" | "localhost"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("主题下载地址必须使用 HTTPS。".to_string());
    }
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("主题下载地址不能包含账号、查询参数或片段。".to_string());
    }
    Ok(url)
}

fn child_url(base: &Url, relative: &str) -> Result<Url, String> {
    let relative = relative.trim_start_matches('/');
    if relative.contains("..") || relative.contains('\\') {
        return Err("主题目录包含非法相对地址。".to_string());
    }
    let base_text = format!("{}/", base.as_str().trim_end_matches('/'));
    let root = Url::parse(&base_text).map_err(|error| format!("主题基础地址无效：{error}"))?;
    let url = root
        .join(relative)
        .map_err(|error| format!("拼接主题地址失败：{error}"))?;
    if url.scheme() != root.scheme()
        || url.host_str() != root.host_str()
        || url.port_or_known_default() != root.port_or_known_default()
        || !url.path().starts_with(root.path())
    {
        return Err("主题资源地址越过当前服务器目录。".to_string());
    }
    Ok(url)
}

fn catalog_url(base: &Url) -> Result<Url, String> {
    child_url(base, "themes/catalog.json")
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("Gaoge-Free-Codex-Themes/1")
        .build()
        .map_err(|error| format!("创建主题下载客户端失败：{error}"))
}

fn fetch_catalog(download_base_url: &str) -> Result<(ThemeCatalog, Url), String> {
    let base = normalized_download_base(download_base_url)?;
    let url = catalog_url(&base)?;
    let response = http_client()?
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|error| format!("连接主题目录失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("获取主题目录失败：{error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > THEME_CATALOG_MAX_BYTES as u64)
    {
        return Err("主题目录文件超过 2MB。".to_string());
    }
    let mut data = Vec::new();
    response
        .take(THEME_CATALOG_MAX_BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|error| format!("读取主题目录失败：{error}"))?;
    if data.len() > THEME_CATALOG_MAX_BYTES {
        return Err("主题目录文件超过 2MB。".to_string());
    }
    let catalog: ThemeCatalog =
        serde_json::from_slice(&data).map_err(|error| format!("解析主题目录失败：{error}"))?;
    validate_catalog(&catalog, &base)?;
    write_json(&catalog_cache_path(), &catalog)?;
    Ok((catalog, base))
}

fn validate_catalog(catalog: &ThemeCatalog, base: &Url) -> Result<(), String> {
    if catalog.schema_version != THEME_SCHEMA_VERSION {
        return Err("主题目录 schemaVersion 不受支持。".to_string());
    }
    if catalog.themes.len() > 200 {
        return Err("主题目录条目过多。".to_string());
    }
    let mut ids = HashSet::new();
    for item in &catalog.themes {
        if !valid_theme_id(&item.id) || !ids.insert(item.id.as_str()) {
            return Err(format!("主题目录包含非法或重复 ID：{}", item.id));
        }
        if !(1..=40).contains(&item.name.chars().count())
            || !(1..=40).contains(&item.author.chars().count())
            || item.description.chars().count() > 180
            || item.style.chars().count() > 30
            || item.source_label.chars().count() > 50
            || item.platforms.is_empty()
            || item.platforms.len() > 2
            || !item.platforms.iter().all(|value| valid_platform(value))
            || !matches!(item.runtime.as_str(), "wallpaper" | "qq-retro")
            || !matches!(item.appearance.as_str(), "light" | "dark" | "system")
        {
            return Err(format!("主题目录条目 {} 的展示字段无效。", item.id));
        }
        if !valid_semver(&item.version)
            || item.sha256.len() != 64
            || !item.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || item.size_bytes == 0
            || item.size_bytes > THEME_PACKAGE_MAX_BYTES as u64
            || !valid_catalog_resource_path(&item.package, "packages/", ".zip")
            || !valid_catalog_resource_path(&item.preview, "previews/", ".webp")
            || item.source.repository.len() > 300
            || item.source.commit.len() > 80
            || item.source.original_path.len() > 300
            || (!item.source.sha256.is_empty()
                && (item.source.sha256.len() != 64
                    || !item
                        .source
                        .sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit())))
        {
            return Err(format!("主题目录条目 {} 的版本、哈希或大小无效。", item.id));
        }
        child_url(base, &format!("themes/{}", item.package))?;
        child_url(base, &format!("themes/{}", item.preview))?;
    }
    Ok(())
}

#[cfg(debug_assertions)]
fn load_development_catalog(base: &Url) -> Result<(ThemeCatalog, PathBuf), String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "无法定位本地开发主题目录。".to_string())?
        .join("release")
        .join("themes");
    let catalog: ThemeCatalog = read_json(&root.join("catalog.json"))?;
    validate_catalog(&catalog, base)?;
    Ok((catalog, root))
}

fn load_catalog_with_cache(
    download_base_url: &str,
) -> Result<(ThemeCatalog, Url, String, String, Option<PathBuf>), String> {
    match fetch_catalog(download_base_url) {
        Ok((catalog, base)) => Ok((catalog, base, "remote".to_string(), String::new(), None)),
        Err(error) => {
            let base = normalized_download_base(download_base_url)?;
            #[cfg(debug_assertions)]
            if let Ok((catalog, root)) = load_development_catalog(&base) {
                return Ok((catalog, base, "development".to_string(), error, Some(root)));
            }
            if let Ok(catalog) = read_json::<ThemeCatalog>(&catalog_cache_path()) {
                validate_catalog(&catalog, &base)?;
                return Ok((catalog, base, "cache".to_string(), error, None));
            }
            Err(error)
        }
    }
}

fn preview_revision(path: &str, version: &str) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() { return None; }
    let stamp = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{version}-{stamp}-{}", metadata.len()))
}

fn theme_item_json(
    manifest: &ThemeManifest,
    remote: Option<&ThemeCatalogItem>,
    base: Option<&Url>,
    active_theme_id: &str,
    development_root: Option<&Path>,
) -> Value {
    let installed = theme_dir(&manifest.id).is_dir();
    let local_preview = if installed {
        theme_dir(&manifest.id)
            .join("preview.webp")
            .to_string_lossy()
            .to_string()
    } else {
        remote
            .and_then(|item| development_root.map(|root| root.join(&item.preview)))
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let preview_url = remote
        .and_then(|item| {
            base.and_then(|root| child_url(root, &format!("themes/{}", item.preview)).ok())
        })
        .map(|url| url.to_string())
        .unwrap_or_default();
    let remote_version = remote.map(|item| item.version.as_str()).unwrap_or("");
    let preview_revision = preview_revision(&local_preview, &manifest.version)
        .unwrap_or_else(|| remote.map(|item| item.sha256.clone()).unwrap_or_else(|| manifest.version.clone()));
    json!({
      "id": manifest.id,
      "name": manifest.name,
      "version": manifest.version,
      "remoteVersion": remote_version,
      "author": manifest.author,
      "description": manifest.description,
      "style": remote.map(|item| item.style.as_str()).unwrap_or("自定义"),
      "platforms": manifest.platforms,
      "runtime": manifest.runtime,
      "appearance": manifest.appearance,
      "sizeBytes": remote.map(|item| item.size_bytes).unwrap_or(0),
      "sourceLabel": remote.map(|item| item.source_label.as_str()).filter(|value| !value.is_empty()).unwrap_or(if manifest.source.kind == "custom" { "自定义主题" } else { "社区素材" }),
      "source": manifest.source,
      "enabled": remote.map(|item| item.enabled).unwrap_or(true),
      "installed": installed,
      "custom": manifest.source.kind == "custom",
      "active": manifest.id == active_theme_id,
      "updateAvailable": installed && !remote_version.is_empty() && compare_versions(remote_version, &manifest.version).is_gt(),
      "previewPath": local_preview,
      "previewUrl": preview_url,
      "previewRevision": preview_revision,
    })
}

pub fn list_themes(download_base_url: &str) -> Result<Value, String> {
    let (installed, mut warnings) = installed_manifests();
    let active_theme_id = read_state().active_theme_id;
    let mut by_id = installed
        .iter()
        .map(|manifest| (manifest.id.clone(), manifest.clone()))
        .collect::<HashMap<_, _>>();
    let mut items = Vec::new();
    let mut catalog_source = "none".to_string();
    let mut catalog_error = String::new();
    match load_catalog_with_cache(download_base_url) {
        Ok((catalog, base, source, warning, development_root)) => {
            catalog_source = source;
            if !warning.is_empty() {
                warnings.push(warning.clone());
                catalog_error = warning;
            }
            for remote in catalog.themes.iter().filter(|item| item.enabled) {
                let manifest = by_id.remove(&remote.id).unwrap_or_else(|| ThemeManifest {
                    schema_version: THEME_SCHEMA_VERSION,
                    id: remote.id.clone(),
                    name: remote.name.clone(),
                    version: remote.version.clone(),
                    author: remote.author.clone(),
                    description: remote.description.clone(),
                    platforms: remote.platforms.clone(),
                    runtime: remote.runtime.clone(),
                    appearance: remote.appearance.clone(),
                    background: ThemeBackground {
                        file: "background.webp".to_string(),
                        position_x: 50,
                        position_y: 50,
                        overlay_opacity: 0.28,
                    },
                    preview: "preview.webp".to_string(),
                    colors: ThemeColors {
                        accent: "#22d3ee".to_string(),
                        secondary: "#60a5fa".to_string(),
                        surface: "#111827".to_string(),
                        text: "#f8fafc".to_string(),
                        muted: "#94a3b8".to_string(),
                        border: "#334155".to_string(),
                    },
                    effects: ThemeEffects {
                        panel_opacity: 0.88,
                        panel_blur: 10,
                        radius: 8,
                    },
                    source: remote.source.clone(),
                });
                items.push(theme_item_json(
                    &manifest,
                    Some(remote),
                    Some(&base),
                    &active_theme_id,
                    development_root.as_deref(),
                ));
            }
        }
        Err(error) => {
            catalog_error = error.clone();
            warnings.push(error);
        }
    }
    for manifest in by_id.into_values() {
        items.push(theme_item_json(
            &manifest,
            None,
            None,
            &active_theme_id,
            None,
        ));
    }
    Ok(json!({
      "schemaVersion": THEME_SCHEMA_VERSION,
      "catalogSource": catalog_source,
      "catalogError": catalog_error,
      "activeThemeId": active_theme_id,
      "themes": items,
      "warnings": warnings,
      "storagePath": theme_root().to_string_lossy(),
      "platform": current_theme_platform(),
    }))
}

fn emit_download_status(app: &AppHandle, payload: Value) {
    let _ = app.emit(THEME_DOWNLOAD_EVENT, payload);
}

fn download_theme_package(
    app: &AppHandle,
    base: &Url,
    item: &ThemeCatalogItem,
) -> Result<Vec<u8>, String> {
    let url = child_url(base, &format!("themes/{}", item.package))?;
    emit_download_status(
        app,
        json!({"themeId": item.id, "state": "downloading", "downloadedBytes": 0, "totalBytes": item.size_bytes, "progress": 0}),
    );
    let mut response = http_client()?
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "application/zip,application/octet-stream",
        )
        .send()
        .map_err(|error| format!("下载主题失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载主题失败：{error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > THEME_PACKAGE_MAX_BYTES as u64)
    {
        return Err("主题 ZIP 超过 15MB。".to_string());
    }
    let total = response.content_length().unwrap_or(item.size_bytes);
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|error| format!("读取主题下载数据失败：{error}"))?;
        if read == 0 {
            break;
        }
        if bytes.len() + read > THEME_PACKAGE_MAX_BYTES {
            return Err("主题 ZIP 超过 15MB。".to_string());
        }
        bytes.extend_from_slice(&buffer[..read]);
        let progress = if total > 0 {
            ((bytes.len() as u64 * 100) / total).min(99)
        } else {
            0
        };
        emit_download_status(
            app,
            json!({"themeId": item.id, "state": "downloading", "downloadedBytes": bytes.len(), "totalBytes": total, "progress": progress}),
        );
    }
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if !actual_hash.eq_ignore_ascii_case(&item.sha256) {
        return Err("主题包 SHA-256 校验失败。".to_string());
    }
    Ok(bytes)
}

fn read_local_theme_package(
    app: &AppHandle,
    root: &Path,
    item: &ThemeCatalogItem,
) -> Result<Vec<u8>, String> {
    let path = root.join(&item.package);
    let bytes = fs::read(&path)
        .map_err(|error| format!("读取本地开发主题包失败 {}：{error}", path.display()))?;
    if bytes.is_empty()
        || bytes.len() > THEME_PACKAGE_MAX_BYTES
        || bytes.len() as u64 != item.size_bytes
    {
        return Err("本地开发主题包大小与目录不一致。".to_string());
    }
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if !actual_hash.eq_ignore_ascii_case(&item.sha256) {
        return Err("本地开发主题包 SHA-256 校验失败。".to_string());
    }
    emit_download_status(
        app,
        json!({"themeId": item.id, "state": "downloading", "downloadedBytes": bytes.len(), "totalBytes": bytes.len(), "progress": 99}),
    );
    Ok(bytes)
}

fn replace_theme_dir(temp: &Path, theme_id: &str) -> Result<(), String> {
    let destination = theme_dir(theme_id);
    let previous = installed_root().join(format!(".replace-{}-{}", theme_id, now_millis()));
    cleanup_temp(&previous);
    if destination.exists() {
        fs::rename(&destination, &previous)
            .map_err(|error| format!("暂存旧主题失败 {}：{error}", destination.display()))?;
    }
    ensure_parent(&destination)?;
    if let Err(error) = fs::rename(temp, &destination) {
        let rollback_error = if previous.exists() {
            fs::rename(&previous, &destination).err()
        } else {
            None
        };
        return Err(match rollback_error {
            Some(rollback) => format!(
                "安装主题失败 {}：{error}；恢复旧主题也失败：{rollback}",
                destination.display()
            ),
            None => format!("安装主题失败 {}：{error}", destination.display()),
        });
    }
    cleanup_temp(&previous);
    Ok(())
}

fn cleanup_temp(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

pub fn install_theme(
    app: &AppHandle,
    download_base_url: &str,
    theme_id: &str,
) -> Result<Value, String> {
    if !valid_theme_id(theme_id) {
        return Err("主题 ID 无效。".to_string());
    }
    let (catalog, base, _, _, development_root) = load_catalog_with_cache(download_base_url)?;
    let item = catalog
        .themes
        .iter()
        .find(|item| item.id == theme_id && item.enabled)
        .ok_or_else(|| "当前主题目录中没有这个可下载主题。".to_string())?;
    let result = (|| {
        let bytes = match development_root.as_deref() {
            Some(root) => read_local_theme_package(app, root, item)?,
            None => download_theme_package(app, &base, item)?,
        };
        let temp = temp_root().join(format!("install-{}-{}", theme_id, now_millis()));
        cleanup_temp(&temp);
        let manifest = match validate_and_extract_package_bytes(&bytes, &temp) {
            Ok(manifest) => manifest,
            Err(error) => {
                cleanup_temp(&temp);
                return Err(error);
            }
        };
        if manifest.id != item.id || manifest.version != item.version {
            cleanup_temp(&temp);
            return Err("主题包内容与远程目录不一致。".to_string());
        }
        replace_theme_dir(&temp, theme_id)?;
        invalidate_theme_runtime_payload_cache(Some(theme_id));
        Ok(json!({
          "installed": true,
          "themeId": theme_id,
          "manifest": manifest,
          "status": list_themes(download_base_url)?,
        }))
    })();
    match &result {
        Ok(_) => emit_download_status(
            app,
            json!({"themeId": theme_id, "state": "completed", "progress": 100}),
        ),
        Err(error) => emit_download_status(
            app,
            json!({"themeId": theme_id, "state": "error", "error": error}),
        ),
    }
    result
}

pub fn import_theme(file_path: &str, replace: bool) -> Result<Value, String> {
    let path = PathBuf::from(file_path.trim());
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != Some("zip".to_string())
    {
        return Err("请选择 ZIP 格式的主题包。".to_string());
    }
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("读取主题包失败 {}：{error}", path.display()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > THEME_PACKAGE_MAX_BYTES as u64
    {
        return Err("主题 ZIP 必须小于 15MB。".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("读取主题包失败：{error}"))?;
    let temp = temp_root().join(format!("import-{}", now_millis()));
    cleanup_temp(&temp);
    let mut manifest = match validate_and_extract_package_bytes(&bytes, &temp) {
        Ok(manifest) => manifest,
        Err(error) => {
            cleanup_temp(&temp);
            return Err(error);
        }
    };
    if BUILTIN_THEME_IDS.contains(&manifest.id.as_str()) {
        cleanup_temp(&temp);
        return Err("自定义主题不能使用内置主题 ID。".to_string());
    }
    let destination = theme_dir(&manifest.id);
    if destination.exists() && !replace {
        cleanup_temp(&temp);
        return Ok(json!({
          "imported": false,
          "replaceRequired": true,
          "themeId": manifest.id,
          "themeName": manifest.name,
        }));
    }
    manifest.source.kind = "custom".to_string();
    manifest.source.repository.clear();
    manifest.source.commit.clear();
    manifest.source.original_path.clear();
    manifest.source.sha256.clear();
    manifest.runtime = "wallpaper".to_string();
    write_json(&temp.join("theme.json"), &manifest)?;
    replace_theme_dir(&temp, &manifest.id)?;
    invalidate_theme_runtime_payload_cache(Some(&manifest.id));
    Ok(json!({
      "imported": true,
      "replaceRequired": false,
      "themeId": manifest.id,
      "manifest": manifest,
    }))
}

pub fn activate_theme(theme_id: &str) -> Result<Value, String> {
    let manifest = installed_manifest(theme_id)?;
    if !manifest
        .platforms
        .iter()
        .any(|platform| platform == current_theme_platform())
    {
        return Err("这个主题不支持当前操作系统。".to_string());
    }
    write_state(&ThemeState {
        active_theme_id: theme_id.to_string(),
        debug_port: None,
    })?;
    invalidate_theme_runtime_payload_cache(None);
    Ok(json!({"active": true, "themeId": theme_id, "manifest": manifest}))
}

pub fn deactivate_theme() -> Result<Value, String> {
    write_state(&ThemeState::default())?;
    invalidate_theme_runtime_payload_cache(None);
    Ok(json!({"active": false, "themeId": ""}))
}

pub fn remove_theme(theme_id: &str) -> Result<Value, String> {
    if !valid_theme_id(theme_id) {
        return Err("主题 ID 无效。".to_string());
    }
    if read_state().active_theme_id == theme_id {
        return Err("当前正在使用这个主题，请先恢复原生主题或切换其他主题。".to_string());
    }
    let destination = theme_dir(theme_id);
    if !destination.exists() {
        return Ok(json!({"removed": false, "themeId": theme_id}));
    }
    fs::remove_dir_all(&destination)
        .map_err(|error| format!("删除本地主题失败 {}：{error}", destination.display()))?;
    invalidate_theme_runtime_payload_cache(Some(theme_id));
    Ok(json!({"removed": true, "themeId": theme_id}))
}

pub fn theme_enabled() -> bool {
    !read_state().active_theme_id.is_empty()
}

pub fn active_theme_id() -> Option<String> {
    let theme_id = read_state().active_theme_id;
    (!theme_id.is_empty()).then_some(theme_id)
}

pub fn theme_debug_port() -> Option<u16> {
    read_state().debug_port.filter(|port| *port > 1)
}

pub fn set_theme_applied(debug_port: u16) -> Result<(), String> {
    let mut state = read_state();
    if state.active_theme_id.is_empty() {
        return Err("当前没有启用主题。".to_string());
    }
    state.debug_port = Some(debug_port);
    write_state(&state)
}

pub fn active_theme_runtime_payload() -> Result<Option<CodexThemeRuntimePayload>, String> {
    let state = read_state();
    if state.active_theme_id.is_empty() {
        return Ok(None);
    }
    // Keep one guard through loading and publication. An update invalidating
    // this cache must finish after any older in-flight load, never before it.
    let mut cache = THEME_RUNTIME_PAYLOAD_CACHE.lock()
        .map_err(|_| "主题缓存正在恢复，请重试。".to_string())?;
    if let Some((cached_id, payload)) = cache.as_ref() {
        if cached_id == &state.active_theme_id {
            return Ok(Some(payload.clone()));
        }
    }
    let manifest = installed_manifest(&state.active_theme_id)?;
    let background_path = theme_dir(&manifest.id).join("background.webp");
    let background = fs::read(&background_path).map_err(|error| {
        format!(
            "读取当前主题背景失败 {}：{error}",
            background_path.display()
        )
    })?;
    validate_image(&background, false)?;
    let runtime = if manifest.id == "qq-retro" {
        "qq-retro".to_string()
    } else {
        manifest.runtime.clone()
    };
    let mut signature = Sha256::new();
    signature.update(serde_json::to_vec(&manifest).map_err(|error| format!("读取主题版本失败：{error}"))?);
    signature.update(&background);
    let payload = CodexThemeRuntimePayload {
        id: manifest.id,
        version: manifest.version,
        signature: format!("{:x}", signature.finalize()),
        name: manifest.name,
        runtime,
        appearance: manifest.appearance,
        background_data_url: format!(
            "data:image/webp;base64,{}",
            general_purpose::STANDARD.encode(background)
        ),
        background: manifest.background,
        colors: manifest.colors,
        effects: manifest.effects,
    };
    *cache = Some((state.active_theme_id, payload.clone()));
    Ok(Some(payload))
}

pub fn disable_after_failure(error: impl Into<String>) -> String {
    let error = error.into();
    match deactivate_theme() {
        Ok(_) => error,
        Err(cleanup_error) => format!("{error} 清理主题启用状态失败：{cleanup_error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn theme_preview_revision_changes_after_same_version_file_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let preview = temp.path().join("preview.webp");
        fs::write(&preview, b"old-preview").unwrap();
        let path = preview.to_str().unwrap();
        let first = preview_revision(path, "1.0.0").unwrap();
        assert_eq!(preview_revision(path, "1.0.0").unwrap(), first);
        fs::write(&preview, b"replacement-preview").unwrap();
        assert_ne!(preview_revision(path, "1.0.0").unwrap(), first);
        assert!(preview_revision(temp.path().join("missing.webp").to_str().unwrap(), "1.0.0").is_none());
    }

    fn zip_with_entries(names: &[&str]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in names {
            writer.start_file(*name, options).unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn theme_ids_are_strict_and_portable() {
        assert!(valid_theme_id("deepspace-star"));
        assert!(!valid_theme_id("../escape"));
        assert!(!valid_theme_id("Uppercase"));
        assert!(!valid_theme_id("-leading"));
        assert!(ThemeState::default().active_theme_id.is_empty());
        assert!(ThemeState::default().debug_port.is_none());
    }

    #[test]
    fn catalog_child_urls_cannot_escape_selected_server() {
        let base = Url::parse("https://example.test/gaogeaii/updates/").unwrap();
        assert!(child_url(&base, "themes/catalog.json").is_ok());
        assert!(child_url(&base, "../other.zip").is_err());
        assert!(child_url(&base, "themes\\other.zip").is_err());
        assert!(valid_catalog_resource_path(
            "packages/theme-1.0.0.zip",
            "packages/",
            ".zip"
        ));
        assert!(!valid_catalog_resource_path(
            "https://other.test/theme.zip",
            "packages/",
            ".zip"
        ));
        assert!(!valid_catalog_resource_path(
            "packages/../theme.zip",
            "packages/",
            ".zip"
        ));
    }

    #[test]
    fn theme_zip_rejects_path_traversal_and_executable_entries() {
        let destination = std::env::temp_dir().join(format!("gaoge-theme-test-{}", now_millis()));
        let traversal = zip_with_entries(&[
            "theme.json",
            "background.webp",
            "preview.webp",
            "LICENSE.txt",
            "../NOTICE.txt",
        ]);
        assert!(validate_and_extract_package_bytes(&traversal, &destination).is_err());

        let executable = zip_with_entries(&[
            "theme.json",
            "background.webp",
            "preview.webp",
            "LICENSE.txt",
            "theme.js",
        ]);
        assert!(validate_and_extract_package_bytes(&executable, &destination).is_err());
        cleanup_temp(&destination);
    }

    #[test]
    fn theme_zip_rejects_incomplete_root_files_and_oversized_archives() {
        let destination = std::env::temp_dir().join(format!("gaoge-theme-test-{}", now_millis()));
        let incomplete = zip_with_entries(&[
            "theme.json",
            "background.webp",
            "preview.webp",
            "LICENSE.txt",
        ]);
        assert!(validate_and_extract_package_bytes(&incomplete, &destination).is_err());
        assert!(validate_and_extract_package_bytes(
            &vec![0u8; THEME_PACKAGE_MAX_BYTES + 1],
            &destination
        )
        .is_err());
        cleanup_temp(&destination);
    }

    #[test]
    fn manifest_rejects_executable_style_values() {
        let mut manifest = ThemeManifest {
            schema_version: 1,
            id: "safe-theme".to_string(),
            name: "Safe".to_string(),
            version: "1.0.0".to_string(),
            author: "Gaoge".to_string(),
            description: String::new(),
            platforms: vec!["windows".to_string(), "macos".to_string()],
            runtime: "wallpaper".to_string(),
            appearance: "dark".to_string(),
            background: ThemeBackground {
                file: "background.webp".to_string(),
                position_x: 50,
                position_y: 50,
                overlay_opacity: 0.3,
            },
            preview: "preview.webp".to_string(),
            colors: ThemeColors {
                accent: "#22d3ee".to_string(),
                secondary: "#60a5fa".to_string(),
                surface: "#111827".to_string(),
                text: "#f8fafc".to_string(),
                muted: "#94a3b8".to_string(),
                border: "#334155".to_string(),
            },
            effects: ThemeEffects {
                panel_opacity: 0.88,
                panel_blur: 10,
                radius: 8,
            },
            source: ThemeSource {
                kind: "custom".to_string(),
                ..ThemeSource::default()
            },
        };
        assert!(validate_manifest(&manifest).is_ok());
        manifest.runtime = "qq-retro".to_string();
        assert!(validate_manifest(&manifest).is_err());
        manifest.runtime = "wallpaper".to_string();
        manifest.colors.accent = "url(https://bad.invalid)".to_string();
        assert!(validate_manifest(&manifest).is_err());
    }
}
