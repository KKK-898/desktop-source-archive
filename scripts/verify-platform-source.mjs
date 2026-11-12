import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

async function readText(relativePath) {
  return fs.readFile(path.join(rootDir, relativePath), 'utf8')
}

async function findThemeComponentPath() {
  const componentsDir = path.join(rootDir, 'src', 'components')
  const entries = await fs.readdir(componentsDir)
  const preferredFileName = '新版主题.vue'
  const preferredEntry = entries.find(
    (entry) => entry.normalize('NFC') === preferredFileName.normalize('NFC'),
  )
  if (preferredEntry) {
    return path.join(componentsDir, preferredEntry)
  }

  for (const entry of entries.filter((file) => file.endsWith('.vue'))) {
    const filePath = path.join(componentsDir, entry)
    const content = await fs.readFile(filePath, 'utf8')
    if (
      content.includes('const currentMigrationWindowsDownloadUrl') &&
      content.includes('submitAccountChange({') &&
      content.includes('new-theme-invoice')
    ) {
      return filePath
    }
  }

  const fileName = entries.find((entry) => entry.endsWith('.vue') && entry.includes('主题'))
  if (!fileName) {
    throw new Error('Could not find theme Vue component in src/components.')
  }
  return path.join(componentsDir, fileName)
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`)
  }
}

function assertNotIncludes(text, needle, label) {
  if (text.includes(needle)) {
    throw new Error(`${label} must not include: ${needle}`)
  }
}

function assertRegex(text, regex, label) {
  if (!regex.test(text)) {
    throw new Error(`${label} missing pattern: ${regex}`)
  }
}

function assertEquals(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch. Expected ${expected}, got ${actual}`)
  }
}

function packageVersionFromCargoLock(lockText) {
  const match = /\[\[package\]\]\s+name = "gaoge-free"\s+version = "([^"]+)"/.exec(lockText)
  if (!match) {
    throw new Error('Could not find gaoge-free package version in Cargo.lock.')
  }
  return match[1]
}

async function main() {
  const packageJson = JSON.parse(await readText('package.json'))
  const packageLock = JSON.parse(await readText('package-lock.json'))
  const newThemeVue = await fs.readFile(await findThemeComponentPath(), 'utf8')
  const invitationDownloadVue = await readText('src/components/InvitationDownloadPage.vue')
  const domainConfig = await readText('src/domain-config.ts')
  const apiTs = await readText('src/api.ts')
  const crossPlatformReleaseDoc = await readText('docs/cross-platform-release.md')
  const remoteUpdatesDoc = await readText('docs/remote-updates.md')
  const cargoToml = await readText('src-tauri/Cargo.toml')
  const cargoLock = await readText('src-tauri/Cargo.lock')
  const libRs = await readText('src-tauri/src/lib.rs')
  const generateUpdateManifest = await readText('scripts/generate-update-manifest.mjs')
  const oneClickRelease = await readText('scripts/one-click-release.ps1')
  const tauriConfig = JSON.parse(await readText('src-tauri/tauri.conf.json'))
  const tauriWindowsConfig = JSON.parse(await readText('src-tauri/tauri.windows.conf.json'))
  const tauriMacConfig = JSON.parse(await readText('src-tauri/tauri.macos.conf.json'))
  const tauriLinuxConfig = JSON.parse(await readText('src-tauri/tauri.linux.conf.json'))
  const windowsSignScript = await readText('scripts/sign-windows.ps1')
  const releaseWorkflow = await fs
    .readFile(path.resolve(rootDir, '.github/workflows/release-build.yml'), 'utf8')
    .catch(() => '')
  const platformWorkflow = await fs
    .readFile(path.resolve(rootDir, '.github/workflows/platform-check.yml'), 'utf8')
    .catch(() => '')

  assertEquals(packageLock.version, packageJson.version, 'package-lock root version')
  assertEquals(packageLock.packages?.['']?.version, packageJson.version, 'package-lock package version')
  assertEquals(tauriConfig.version, packageJson.version, 'Tauri config version')
  assertRegex(cargoToml, new RegExp(`^version = "${packageJson.version.replaceAll('.', '\\.')}"$`, 'm'), 'Cargo.toml app version')
  assertEquals(packageVersionFromCargoLock(cargoLock), packageJson.version, 'Cargo.lock app version')
  assertIncludes(libRs, `GaogeAii/${packageJson.version}`, 'Rust user agent version')

  assertIncludes(packageJson.scripts['dist:win'] || '', 'tauri build --bundles nsis --ci', 'Windows build script')
  assertIncludes(packageJson.scripts['dist:mac'] || '', '--target universal-apple-darwin', 'macOS build script')
  assertIncludes(packageJson.scripts['dist:linux'] || '', '--bundles deb,appimage', 'Linux build script')
  assertIncludes(packageJson.scripts['verify:release'] || '', 'verify-release-config.mjs', 'release verification script')
  assertIncludes(packageJson.scripts['verify:artifacts'] || '', 'verify-release-artifacts.mjs', 'artifact verification script')
  assertIncludes(packageJson.scripts['verify:workflows'] || '', 'verify-workflows.mjs', 'workflow verification script')
  assertIncludes(packageJson.scripts['verify:readiness'] || '', 'verify-release-readiness.mjs', 'release readiness script')
  assertIncludes(packageJson.scripts['verify:local'] || '', 'cargo check --manifest-path src-tauri/Cargo.toml', 'local verification aggregate script')
  assertIncludes(generateUpdateManifest, 'Missing update base URL', 'release manifest requires injected update origin')

  assertIncludes(tauriConfig.plugins.updater.endpoints[0], 'https://example.invalid/gaogeaii/updates/win/latest.json', 'default updater placeholder feed')
  assertIncludes(tauriWindowsConfig.plugins.updater.endpoints[0], 'https://example.invalid/gaogeaii/updates/win/latest.json', 'Windows updater placeholder feed')
  assertIncludes(tauriMacConfig.plugins.updater.endpoints[0], 'https://example.invalid/gaogeaii/updates/mac/latest.json', 'macOS updater placeholder feed')
  assertIncludes(tauriLinuxConfig.plugins.updater.endpoints[0], 'https://example.invalid/gaogeaii/updates/linux/latest.json', 'Linux updater placeholder feed')
  assertIncludes(libRs, 'const UPDATE_FEED_BASE_URL: &str = "";', 'Rust update feed has no business fallback')
  assertIncludes(JSON.stringify(tauriWindowsConfig.bundle.targets), 'nsis', 'Windows bundle target')
  assertEquals(tauriWindowsConfig.bundle.windows.digestAlgorithm, 'sha256', 'Windows code signing digest')
  assertIncludes(tauriWindowsConfig.bundle.windows.timestampUrl, 'timestamp', 'Windows code signing timestamp URL')
  assertIncludes(JSON.stringify(tauriWindowsConfig.bundle.windows.signCommand), 'sign-windows.ps1', 'Windows code signing command')
  assertIncludes(JSON.stringify(tauriWindowsConfig.bundle.windows.signCommand), '%1', 'Windows code signing target placeholder')
  assertIncludes(windowsSignScript, 'signtool.exe', 'Windows signing script SignTool lookup')
  assertIncludes(windowsSignScript, 'verify", "/pa", "/v"', 'Windows signing script Authenticode verification')
  assertIncludes(windowsSignScript, 'GAOGE_WINDOWS_PFX_BASE64', 'Windows signing script PFX secret')
  assertIncludes(windowsSignScript, 'GAOGE_WINDOWS_CERTIFICATE_THUMBPRINT', 'Windows signing script certificate thumbprint')
  assertIncludes(JSON.stringify(tauriMacConfig.bundle.targets), 'dmg', 'macOS bundle target')
  assertIncludes(JSON.stringify(tauriLinuxConfig.bundle.targets), 'appimage', 'Linux bundle target')

  for (const platformId of ['win', 'mac', 'linux']) {
    assertIncludes(libRs, `"${platformId}"`, `Rust platform id ${platformId}`)
  }
  for (const opener of ['rundll32.exe', '"open"', 'xdg-open']) {
    assertIncludes(libRs, opener, `payment opener ${opener}`)
  }
  assertRegex(libRs, /fn roaming_app_dir\(\)[\s\S]*target_os = "windows"[\s\S]*target_os = "macos"[\s\S]*XDG_CONFIG_HOME/, 'cross-platform roaming app dir')
  assertRegex(libRs, /fn local_app_data_dir\(\)[\s\S]*target_os = "windows"[\s\S]*target_os = "macos"[\s\S]*XDG_DATA_HOME/, 'cross-platform local app data dir')
  assertRegex(libRs, /fn update_feed_url\(\)[\s\S]*current_platform_id\(\)/, 'dynamic update feed url')

  assertIncludes(newThemeVue, 'Gaoge-Free-latest-windows-x64-setup.exe', 'Windows stable download URL')
  assertIncludes(newThemeVue, 'Gaoge-Free-latest-macos-universal.dmg', 'macOS stable download URL')
  assertIncludes(newThemeVue, 'Gaoge-Free-latest-linux-x86_64.AppImage', 'Linux stable download URL')
  assertIncludes(newThemeVue, 'url: currentMigrationMacDownloadUrl()', 'macOS download button enabled')
  assertIncludes(newThemeVue, 'url: currentMigrationLinuxDownloadUrl()', 'Linux download button enabled')
  assertIncludes(invitationDownloadVue, 'Gaoge-Free-latest-windows-x64-setup.exe', 'invitation Windows stable download URL')
  assertIncludes(invitationDownloadVue, 'Gaoge-Free-latest-macos-universal.dmg', 'invitation macOS stable download URL')
  assertIncludes(invitationDownloadVue, 'Gaoge-Free-latest-linux-x86_64.AppImage', 'invitation Linux stable download URL')
  assertIncludes(domainConfig, 'overrides.downloadBaseUrl || updateBaseUrl', 'downloads default to verified update origin')
  assertIncludes(oneClickRelease, 'Get-StableDownloadAliases', 'release checks stable download aliases')
  assertIncludes(oneClickRelease, 'Stable download alias is unavailable', 'release fails when a stable download alias is missing')
  assertIncludes(newThemeVue, '支付后会自动到账，如果有延迟等待一分钟。', 'recharge auto-credit warning')
  assertIncludes(apiTs, 'old_password: string', 'change password old_password request field')
  assertIncludes(apiTs, 'current_password?: string', 'change password compatibility current_password request field')
  assertIncludes(apiTs, 'export interface SubmitAccountChangeRequest', 'account change request interface')
  assertIncludes(apiTs, 'old_password?: string', 'account change old_password request field')
  assertIncludes(apiTs, 'current_password?: string', 'account change current_password compatibility field')
  assertIncludes(apiTs, "'/v1/desktop/account-change'", 'desktop account change endpoint')
  assertIncludes(newThemeVue, 'submitAccountChange({', 'account change submission')
  assertIncludes(newThemeVue, 'old_password: payload.oldPassword || undefined', 'account change old_password payload')
  assertIncludes(newThemeVue, 'current_password: payload.oldPassword || undefined', 'account change current_password compatibility payload')
  assertIncludes(newThemeVue, 'new_password: payload.newPassword || undefined', 'account change new_password payload')
  const removedRouterNeedles = [
    ['CODEX', 'ROUTER', 'HOST'].join('_'),
    ['CODEX', 'ROUTER', 'PORT'].join('_'),
    ['network', 'route', 'mode'].join('_'),
    ['network', 'Route', 'Mode'].join(''),
    ['tiny', 'http'].join('_'),
    String(25817 + 1),
  ]
  for (const removedRouterNeedle of removedRouterNeedles) {
    assertNotIncludes(libRs, removedRouterNeedle, 'Removed Codex local router residue')
  }
  assertRegex(
    libRs,
    /fn ensure_aggregate_router_runtime[\s\S]*TcpListener::bind\(\("127\.0\.0\.1", state\.router_port\)\)[\s\S]*TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/,
    'Aggregate model router loopback-only binding',
  )
  assertRegex(
    libRs,
    /fn handle_aggregate_router_request[\s\S]*aggregate_request_authorized\(&headers, &token\)/,
    'Aggregate model router authorization gate',
  )
  assertIncludes(
    libRs,
    '"routerBaseUrl": if state.router_port > 0 { format!("http://127.0.0.1:{}/v1", state.router_port)',
    'Aggregate model router public loopback status',
  )
  assertIncludes(libRs, 'CODEX_MAC_INSTALLER_URL', 'macOS Codex installer URL')
  assertIncludes(libRs, 'macos-dmg-manual', 'macOS Codex manual install strategy')
  assertIncludes(libRs, 'Linux 暂无 Codex 离线安装包', 'Linux Codex installer unavailable message')
  assertIncludes(libRs, 'Linux 暂无安装包', 'Linux Codex installer unavailable error')
  assertIncludes(crossPlatformReleaseDoc, 'Gaoge-Free-latest-macos-universal.dmg', 'cross-platform release stable macOS alias documentation')
  assertIncludes(crossPlatformReleaseDoc, 'Gaoge-Free-latest-linux-x86_64.deb', 'cross-platform release stable Linux deb alias documentation')
  assertIncludes(remoteUpdatesDoc, 'Gaoge-Free-latest-windows-x64-setup.exe', 'remote update stable Windows alias documentation')
  assertIncludes(remoteUpdatesDoc, 'Gaoge-Free-latest-macos-universal.dmg', 'remote update stable macOS alias documentation')
  assertIncludes(remoteUpdatesDoc, 'Gaoge-Free-latest-linux-x86_64.AppImage', 'remote update stable Linux alias documentation')
  assertIncludes(remoteUpdatesDoc, 'release/<platform>/latest.json', 'remote update platform release documentation')

  if (releaseWorkflow) {
    assertIncludes(releaseWorkflow, 'Verify release artifacts', 'release workflow artifact gate')
    assertIncludes(releaseWorkflow, 'GAOGE_UPDATE_BASE_URL', 'release workflow injectable update origin')
    assertIncludes(releaseWorkflow, 'GAOGE_UPDATE_MINIMUM_VERSION: ${{ vars.GAOGE_UPDATE_MINIMUM_VERSION }}', 'release workflow minimum supported version')
    assertIncludes(releaseWorkflow, 'GAOGE_WINDOWS_SIGNING_REQUIRED: "false"', 'release workflow optional Windows signing flag')
    assertIncludes(releaseWorkflow, 'npm run verify:artifacts -- --platform ${{ matrix.platform }}', 'release workflow artifact verification')
    assertIncludes(releaseWorkflow, 'rustup target add aarch64-apple-darwin x86_64-apple-darwin', 'release workflow macOS universal targets')
  }
  if (platformWorkflow) {
    assertIncludes(platformWorkflow, 'name: Platform Check', 'platform check workflow name')
    assertIncludes(platformWorkflow, 'cargo test --manifest-path src-tauri/Cargo.toml', 'platform check Rust gate')
    assertIncludes(platformWorkflow, 'npm run test:release-tooling', 'platform check release tooling gate')
  }

  process.stdout.write('Platform source verification passed.\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
