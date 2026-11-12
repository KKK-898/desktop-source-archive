import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
export const CLI_VERSION = '2.11.2';
export const NSIS_REQUIRED = Object.freeze([
  'makensis.exe', 'Bin/makensis.exe', 'Stubs/lzma-x86-unicode',
  'Stubs/lzma_solid-x86-unicode', 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll',
  'Include/MUI2.nsh', 'Include/FileFunc.nsh', 'Include/x64.nsh',
  'Include/nsDialogs.nsh', 'Include/WinMessages.nsh', 'Include/Win/COM.nsh',
  'Include/Win/Propkey.nsh', 'Include/Win/RestartManager.nsh',
]);
export const WINDOWS_ASSETS = Object.freeze([
  Object.freeze({
    name: 'nsis-3.11.zip', size: 2361546,
    url: 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip',
    api: 'https://api.github.com/repos/tauri-apps/binary-releases/releases/assets/317051073',
    sha256: 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1',
    sha1: 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d',
  }),
  Object.freeze({
    name: 'nsis_tauri_utils.dll', size: 34304,
    url: 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll',
    api: 'https://api.github.com/repos/tauri-apps/nsis-tauri-utils/releases/assets/345882097',
    sha256: '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709',
    sha1: '75197fee3c6a814fe035788d1c34ead39349b860',
  }),
]);

export class IntegrityError extends Error {}
export function verifyBytes(asset, bytes) {
  if (bytes.length !== asset.size) throw new IntegrityError(`${asset.name}: unexpected byte count`);
  for (const algorithm of ['sha256', 'sha1']) {
    if (!asset[algorithm]) continue;
    const actual = createHash(algorithm).update(bytes).digest('hex');
    if (actual !== asset[algorithm].toLowerCase()) throw new IntegrityError(`${asset.name}: ${algorithm} mismatch`);
  }
  if (!asset.sha256) throw new IntegrityError(`${asset.name}: pinned SHA256 required`);
  return bytes;
}

const DOWNLOAD_HOSTS = new Set(['github.com', 'api.github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com']);
async function requestOfficial(asset, entry, fetchImpl, signal, token) {
  let current = entry === 0 ? asset.url : asset.api;
  for (let hop = 0; hop <= 5; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
      throw new IntegrityError('Release tools require an approved official HTTPS download host');
    }
    const headers = {
      Accept: (entry === 1 ? asset.apiAccept : asset.accept) ?? 'application/octet-stream',
      'User-Agent': 'gaoge-release-tools', 'X-GitHub-Api-Version': '2022-11-28',
    };
    // Authenticate only the fixed API entry, never a redirect or ordinary download URL.
    if (entry === 1 && hop === 0 && parsed.hostname === 'api.github.com' && token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchImpl(current, { redirect: 'manual', signal, headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || hop === 5) throw new Error('Official download redirect limit exceeded');
    current = new URL(location, current).href;
  }
}
export async function fetchVerified(asset, options = {}) {
  const { fetchImpl = fetch, attempts = 2, timeoutMs = 20000, retryDelayMs = 500,
    sleep = pause, log = console.log } = options;
  assert(Number.isInteger(attempts) && attempts > 0 && attempts <= 3);
  assert(timeoutMs > 0 && timeoutMs <= 60000);
  let lastError;
  for (const entry of [0, 1]) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('download deadline exceeded')), timeoutMs);
      let reader;
      try {
        const response = await requestOfficial(asset, entry, fetchImpl, controller.signal, options.token);
        if (!response.ok) {
          await response.body?.cancel();
          throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status });
        }
        if (!response.body) throw new Error('empty response stream');
        reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > asset.size) throw new IntegrityError(`${asset.name}: response exceeds pinned size`);
          chunks.push(Buffer.from(value));
        }
        const bytes = verifyBytes(asset, Buffer.concat(chunks, size));
        log(`${asset.name}: verified from official entry ${entry + 1}`);
        return bytes;
      } catch (error) {
        if (error instanceof IntegrityError) throw error;
        lastError = error;
        log(`${asset.name}: entry ${entry + 1}, attempt ${attempt}/${attempts} failed (${controller.signal.aborted ? 'timeout' : error.httpStatus ? `HTTP ${error.httpStatus}` : 'request error'})`);
      } finally {
        clearTimeout(timer);
        await reader?.cancel().catch(() => {});
      }
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  throw new Error(`${asset.name}: official entries exhausted`, { cause: lastError });
}

export function assertChild(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Cache operation escaped its declared root');
  }
}
async function exists(target) {
  try { return await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function rejectLink(target) {
  const stat = await exists(target);
  if (stat?.isSymbolicLink()) throw new Error('Refusing a symbolic link at the cache destination');
  return stat;
}
export async function verifyNsisTree(root, pluginAsset) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('NSIS extraction root must be a real directory');
  const physicalRoot = await fs.realpath(root);
  for (const relative of NSIS_REQUIRED) {
    const target = path.join(root, relative);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`NSIS required file is invalid: ${relative}`);
    assertChild(physicalRoot, await fs.realpath(target));
  }
  verifyBytes(pluginAsset, await fs.readFile(path.join(root, NSIS_REQUIRED[4])));
}
export async function expandZip(archive, destination) {
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:GAOGE_TOOLS_ARCHIVE -DestinationPath $env:GAOGE_TOOLS_DESTINATION -Force"], {
    windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GAOGE_TOOLS_ARCHIVE: archive, GAOGE_TOOLS_DESTINATION: destination },
  });
}
export async function defaultCacheRoot(platform = process.platform) {
  if (platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)'], { windowsHide: true, timeout: 30000 });
    const localAppData = stdout.trim();
    if (!path.isAbsolute(localAppData)) throw new Error('Windows LocalApplicationData must be absolute');
    return path.join(localAppData, 'tauri');
  }
  if (platform === 'linux') {
    const xdg = process.env.XDG_CACHE_HOME;
    return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.cache'), 'tauri');
  }
  throw new Error(`No release tool preparation is defined for ${platform}`);
}

export async function installPrepared(cacheRoot, stageRoot, entries, rename = fs.rename) {
  const moved = [];
  try {
    for (const [index, entry] of entries.entries()) {
      assertChild(stageRoot, entry.source);
      assertChild(cacheRoot, entry.destination);
      await rejectLink(entry.destination);
      const change = { ...entry, backup: path.join(stageRoot, `backup-${index}`), oldMoved: false, newMoved: false };
      moved.push(change);
      if (await exists(entry.destination)) {
        assertChild(stageRoot, change.backup);
        await rename(entry.destination, change.backup);
        change.oldMoved = true;
      }
      await rename(entry.source, entry.destination);
      change.newMoved = true;
    }
  } catch (error) {
    for (const change of moved.reverse()) {
      try {
        if (change.newMoved) await rename(change.destination, change.source);
        if (change.oldMoved) await rename(change.backup, change.destination);
      } catch (rollbackError) {
        error.preserveStage = true;
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
}

export async function prepareTools(options = {}) {
  const platform = options.platform ?? process.platform;
  const assets = options.assets ?? (platform === 'win32' ? WINDOWS_ASSETS : LINUX_ASSETS);
  if (!['win32', 'linux'].includes(platform)) throw new Error('Only Windows and Linux need this preparation');
  const configuredRoot = options.cacheRoot ?? await defaultCacheRoot(platform);
  if (!path.isAbsolute(configuredRoot)) throw new Error('Tool cache must be absolute');
  await fs.mkdir(configuredRoot, { recursive: true });
  const cacheRoot = await fs.realpath(configuredRoot);
  const names = platform === 'win32' ? ['NSIS'] : assets.map(asset => asset.cacheName);
  for (const name of names) {
    if (!name || name !== path.basename(name)) throw new Error('Invalid tool cache filename');
    await rejectLink(path.join(cacheRoot, name));
  }
  const stageRoot = await fs.mkdtemp(path.join(cacheRoot, '.gaoge-release-tools-'));
  let preserveStage = false;
  try {
    const downloaded = [];
    for (const asset of assets) {
      const bytes = await fetchVerified(asset, options);
      const target = path.join(stageRoot, asset.name);
      assertChild(stageRoot, target);
      await fs.writeFile(target, bytes, { flag: 'wx' });
      downloaded.push(target);
    }
    let entries;
    if (platform === 'win32') {
      const extractRoot = path.join(stageRoot, 'extracted');
      await (options.extractArchive ?? expandZip)(downloaded[0], extractRoot);
      const nsisRoot = path.join(extractRoot, 'nsis-3.11');
      const pluginPath = path.join(nsisRoot, NSIS_REQUIRED[4]);
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.copyFile(downloaded[1], pluginPath);
      await verifyNsisTree(nsisRoot, assets[1]);
      entries = [{ source: nsisRoot, destination: path.join(cacheRoot, 'NSIS') }];
    } else {
      entries = downloaded.map((source, index) => ({ source, destination: path.join(cacheRoot, assets[index].cacheName) }));
      for (const [index, entry] of entries.entries()) await (options.chmod ?? fs.chmod)(entry.source, assets[index].mode ?? 0o770);
    }
    await installPrepared(cacheRoot, stageRoot, entries, options.rename);
    (options.log ?? console.log)(`Prepared verified Tauri ${CLI_VERSION} tools for ${platform}`);
    return { platform, cacheRoot, installed: names, runtimeFile: platform === 'linux' ? path.join(cacheRoot, 'runtime-x86_64') : undefined };
  } catch (error) {
    preserveStage = Boolean(error.preserveStage);
    if (preserveStage) (options.log ?? console.log)(`Rollback needs attention; original cache backup retained in ${stageRoot}`);
    throw error;
  } finally {
    if (!preserveStage) {
      assertChild(cacheRoot, stageRoot);
      if (!path.basename(stageRoot).startsWith('.gaoge-release-tools-')) throw new Error('Unexpected temporary directory');
      await fs.rm(stageRoot, { recursive: true, force: true });
    }
  }
}

export async function verifyProject(root) {
  const readJson = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
  const [lock, installed, config] = await Promise.all([
    readJson('package-lock.json'), readJson('node_modules/@tauri-apps/cli/package.json'), readJson('src-tauri/tauri.conf.json'),
  ]);
  if (lock.packages?.['node_modules/@tauri-apps/cli']?.version !== CLI_VERSION || installed.version !== CLI_VERSION) {
    throw new Error(`Tool pins only support @tauri-apps/cli ${CLI_VERSION}; review pins before upgrading`);
  }
  if (config.bundle?.useLocalToolsDir) throw new Error('This preparation requires the default Tauri tools cache');
}

export const LINUX_ASSETS = Object.freeze([
  Object.freeze({
    name: 'AppRun-x86_64', cacheName: 'AppRun-x86_64', size: 31552,
    url: 'https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64',
    api: 'https://api.github.com/repos/tauri-apps/binary-releases/releases/assets/274691722',
    sha256: 'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f',
  }),
  Object.freeze({
    name: 'linuxdeploy-x86_64.AppImage', cacheName: 'linuxdeploy-x86_64.AppImage', size: 13264064,
    url: 'https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage',
    api: 'https://api.github.com/repos/tauri-apps/binary-releases/releases/assets/182515537',
    // Legacy asset metadata has no digest. Pin computed from the exact official asset on 2026-11-09.
    sha256: 'e762bea85c8eb0d4b3508d46e5c1f037f717d0f9303ae3b4aafc8b04991fa1ef',
  }),
  Object.freeze({
    name: 'linuxdeploy-plugin-gtk.sh', cacheName: 'linuxdeploy-plugin-gtk.sh', size: 14622,
    url: 'https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/dda522bce37387f1b853d9095713bfaa924c8423/linuxdeploy-plugin-gtk.sh',
    api: 'https://api.github.com/repos/tauri-apps/linuxdeploy-plugin-gtk/git/blobs/7735e3a962b66fc8010311da41daeb7c2e0bd369',
    apiAccept: 'application/vnd.github.raw+json',
    sha256: '7804c9eef13e59bf2783aad9882ef9db8f3f3f9e8d631874b1d348d550a3693f',
  }),
  Object.freeze({
    name: 'linuxdeploy-plugin-gstreamer.sh', cacheName: 'linuxdeploy-plugin-gstreamer.sh', size: 4857,
    url: 'https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/2a2e67491c32995a3f279ad0ecbe77abd512b42a/linuxdeploy-plugin-gstreamer.sh',
    api: 'https://api.github.com/repos/tauri-apps/linuxdeploy-plugin-gstreamer/git/blobs/0db47bac65b3ebff1d69ef6edcb2b60d5af968b7',
    apiAccept: 'application/vnd.github.raw+json',
    sha256: 'c107b49d84edbffc6ab226ed1007e0626a4f7aa2c3a36b7782bef62351d49e94',
  }),
  Object.freeze({
    name: 'linuxdeploy-plugin-appimage-x86_64.AppImage', cacheName: 'linuxdeploy-plugin-appimage.AppImage', size: 16488952,
    url: 'https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-x86_64.AppImage',
    api: 'https://api.github.com/repos/linuxdeploy/linuxdeploy-plugin-appimage/releases/assets/602435573',
    sha256: '49d6a17160675a6bd1781699aae6bdf7692d98552e02a3671d2183d10547842e',
  }),
  Object.freeze({
    name: 'runtime-x86_64', cacheName: 'runtime-x86_64', size: 944632, mode: 0o644,
    url: 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64',
    api: 'https://api.github.com/repos/AppImage/type2-runtime/releases/assets/657374641',
    sha256: '617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46',
  }),]);

export async function exportRuntimeEnvironment(result, environmentFile) {
  if (result.platform !== 'linux') return;
  if (!environmentFile || !path.isAbsolute(environmentFile)) throw new Error('Linux CI preparation requires an absolute GITHUB_ENV file');
  if (!result.runtimeFile || !path.isAbsolute(result.runtimeFile) || /[\r\n]/.test(result.runtimeFile)) throw new Error('Invalid Linux runtime path');
  await fs.appendFile(environmentFile, `LDAI_RUNTIME_FILE=${result.runtimeFile}\n`, 'utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.arch !== 'x64') throw new Error('Release tool pins currently support x64 build hosts only');
    if (process.platform === 'linux' && (!process.env.GITHUB_ENV || !path.isAbsolute(process.env.GITHUB_ENV))) {
      throw new Error('Linux CI preparation requires GITHUB_ENV to pass the pinned runtime to the build');
    }
    await verifyProject(process.cwd());
    const result = await prepareTools({ token: process.env.GH_TOKEN });
    await exportRuntimeEnvironment(result, process.env.GITHUB_ENV);
  } catch (error) {
    console.error(`[release-tools] ${error.message}`);
    process.exitCode = 1;
  }
}
