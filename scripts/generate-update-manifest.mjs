import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

const platformDefaults = {
  win: {
    bundleDirs: ['src-tauri/target/release/bundle/nsis'],
    baseUrl: '',
    extensions: ['.exe'],
  },
  mac: {
    bundleDirs: ['src-tauri/target/release/bundle/dmg', 'src-tauri/target/release/bundle/macos'],
    baseUrl: '',
    extensions: ['.dmg', '.tar.gz'],
  },
  linux: {
    bundleDirs: ['src-tauri/target/release/bundle/deb', 'src-tauri/target/release/bundle/appimage'],
    baseUrl: '',
    extensions: ['.appimage', '.deb', '.rpm', '.tar.gz'],
  },
}

const platformPathSegments = new Set(Object.keys(platformDefaults))

function readArg(name) {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function normalizePlatform(value) {
  const platform = (value || process.env.GAOGE_UPDATE_PLATFORM || process.platform).toLowerCase()
  if (['win', 'win32', 'windows'].includes(platform)) return 'win'
  if (['mac', 'macos', 'darwin'].includes(platform)) return 'mac'
  if (['linux'].includes(platform)) return 'linux'
  throw new Error(`Unsupported update platform: ${platform}`)
}

const platform = normalizePlatform(readArg('platform'))
const platformConfig = platformDefaults[platform]
const targetTriple = readArg('target') || process.env.GAOGE_UPDATE_TARGET
const targetReleaseSegment = targetTriple ? path.join('src-tauri/target', targetTriple, 'release') : 'src-tauri/target/release'
const releaseDir = path.resolve(
  rootDir,
  process.env.GAOGE_UPDATE_RELEASE_DIR || path.join('release', platform),
)
const configuredUpdateBaseUrl = (
  readArg('base-url') ||
  process.env.GAOGE_UPDATE_BASE_URL ||
  platformConfig.baseUrl
)
if (!configuredUpdateBaseUrl) {
  throw new Error('Missing update base URL. Pass --base-url or set GAOGE_UPDATE_BASE_URL.')
}
const updateBaseUrl = configuredUpdateBaseUrl.replace(/\/+$/, '')
const platformUpdateBaseUrl = updateBaseUrlForPlatform(updateBaseUrl)
const minimumVersion = (
  readArg('minimum-version') ||
  process.env.GAOGE_UPDATE_MINIMUM_VERSION ||
  process.env.MINIMUM_VERSION ||
  '0.0.0'
).trim()
const bundleDirs = (
  readArg('bundle-dir') ||
  process.env.GAOGE_UPDATE_BUNDLE_DIR ||
  platformConfig.bundleDirs
    .map((dir) => dir.replace('src-tauri/target/release', targetReleaseSegment))
    .join(path.delimiter)
)
  .split(path.delimiter)
  .map((dir) => path.resolve(rootDir, dir))

function installerExtension(fileName) {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.tar.gz')) return '.tar.gz'
  return path.extname(lower)
}

function platformKeyBasesFromTarget() {
  const target = (targetTriple || '').toLowerCase()
  if (!target) return undefined

  if (platform === 'win') {
    if (target.startsWith('aarch64-')) return ['windows-aarch64']
    if (target.startsWith('i686-')) return ['windows-i686']
    if (target.startsWith('x86_64-')) return ['windows-x86_64']
  }

  if (platform === 'mac') {
    if (target === 'universal-apple-darwin') return ['darwin-aarch64', 'darwin-x86_64']
    if (target.startsWith('aarch64-apple-darwin')) return ['darwin-aarch64']
    if (target.startsWith('x86_64-apple-darwin')) return ['darwin-x86_64']
  }

  if (platform === 'linux') {
    if (target.startsWith('aarch64-')) return ['linux-aarch64']
    if (target.startsWith('i686-')) return ['linux-i686']
    if (target.startsWith('x86_64-')) return ['linux-x86_64']
  }

  return undefined
}

function platformKeyBasesFromInstaller(fileName) {
  const targetBases = platformKeyBasesFromTarget()
  if (targetBases) return targetBases

  const lower = fileName.toLowerCase()
  const isArm64 = /arm64|aarch64/.test(lower)
  const isX86 = /_x86|_ia32|i686/.test(lower)

  if (platform === 'win') {
    if (isArm64) return ['windows-aarch64']
    if (isX86) return ['windows-i686']
    return ['windows-x86_64']
  }

  if (platform === 'mac') {
    if (/universal/.test(lower)) return ['darwin-aarch64', 'darwin-x86_64']
    if (isArm64) return ['darwin-aarch64']
    return ['darwin-x86_64']
  }

  if (isArm64) return ['linux-aarch64']
  if (isX86) return ['linux-i686']
  return ['linux-x86_64']
}

function installerNameFromInstaller(fileName) {
  const lower = fileName.toLowerCase()

  if (platform === 'win') {
    if (lower.endsWith('.msi')) return 'msi'
    return 'nsis'
  }

  if (platform === 'mac') {
    if (lower.endsWith('.tar.gz')) return 'app'
    return undefined
  }

  if (lower.endsWith('.deb')) return 'deb'
  if (lower.endsWith('.rpm')) return 'rpm'
  if (lower.endsWith('.appimage') || lower.endsWith('.appimage.tar.gz')) return 'appimage'
  return undefined
}

function platformKeysFromInstaller(fileName) {
  const baseKeys = platformKeyBasesFromInstaller(fileName)
  const installerName = installerNameFromInstaller(fileName)
  if (!installerName) return []

  return baseKeys.flatMap((baseKey) => {
    const keys = [`${baseKey}-${installerName}`]
    if (
      (platform === 'win' && installerName === 'nsis') ||
      (platform === 'mac' && installerName === 'app') ||
      (platform === 'linux' && installerName === 'appimage')
    ) {
      keys.push(baseKey)
    }
    return keys
  })
}

function joinUrl(baseUrl, fileName) {
  return `${baseUrl}/${encodeURIComponent(fileName)}`
}

function pathSegmentsFromUrl(value) {
  try {
    return new URL(value).pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return []
  }
}

function updateBaseUrlForPlatform(value) {
  const baseUrl = value.replace(/\/+$/, '')
  const lastSegment = pathSegmentsFromUrl(baseUrl).at(-1)
  if (lastSegment === platform) return baseUrl
  if (platformPathSegments.has(lastSegment)) {
    throw new Error(`Update base URL ends with ${lastSegment}, but current platform is ${platform}: ${baseUrl}`)
  }
  return `${baseUrl}/${platform}`
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function cleanDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true })
  await ensureDir(dirPath)
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false)
}

async function copyFileToDir(sourcePath, targetDir) {
  const targetPath = path.join(targetDir, path.basename(sourcePath))
  await fs.copyFile(sourcePath, targetPath)
  return targetPath
}

async function collectReleaseArtifacts(bundlePaths, version) {
  const artifacts = []
  for (const bundlePath of bundlePaths) {
    if (!(await pathExists(bundlePath))) continue
    const entries = await fs.readdir(bundlePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const fullPath = path.join(bundlePath, entry.name)
      const signaturePath = `${fullPath}.sig`
      const isVersionedArtifact = entry.name.includes(version)
      const isMacUpdaterArchive =
        platform === 'mac' &&
        entry.name.toLowerCase().endsWith('.app.tar.gz') &&
        await pathExists(signaturePath)
      if (!isVersionedArtifact && !isMacUpdaterArchive) continue
      const extension = installerExtension(entry.name)
      if (!platformConfig.extensions.includes(extension)) continue
      const stat = await fs.stat(fullPath)
      artifacts.push({
        fullPath,
        name: entry.name,
        mtimeMs: stat.mtimeMs,
        signed: await pathExists(signaturePath),
        signaturePath,
      })
    }
  }

  artifacts.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return artifacts
}

function manifestPriority(fileName) {
  const lower = fileName.toLowerCase()
  if (platform === 'mac') {
    return lower.endsWith('.tar.gz') ? 20 : 0
  }
  if (platform === 'linux') {
    if (lower.endsWith('.appimage.tar.gz')) return 30
    if (lower.endsWith('.appimage')) return 20
    if (lower.endsWith('.deb') || lower.endsWith('.rpm')) return 10
    return 0
  }
  return lower.endsWith('.exe') ? 20 : 0
}

function compareManifestCandidates(left, right) {
  const priorityDelta = manifestPriority(right.name) - manifestPriority(left.name)
  if (priorityDelta !== 0) return priorityDelta
  return right.mtimeMs - left.mtimeMs
}

function preferSignedThenFresh(left, right) {
  if (left.signed !== right.signed) return left.signed ? -1 : 1
  return right.mtimeMs - left.mtimeMs
}

function latestInstallerPerManifestKey(installers) {
  const latest = new Map()
  const candidates = [...installers].sort(compareManifestCandidates)
  for (const installer of candidates) {
    for (const manifestKey of platformKeysFromInstaller(installer.name)) {
      if (!latest.has(manifestKey)) {
        latest.set(manifestKey, { ...installer, manifestKey })
      }
    }
  }
  return [...latest.values()]
}

function firstArtifact(artifacts, predicate) {
  return [...artifacts].filter(predicate).sort(preferSignedThenFresh)[0]
}

function downloadAliasSpecs(artifacts) {
  if (platform === 'win') {
    const installer = firstArtifact(artifacts, (artifact) => artifact.name.toLowerCase().endsWith('.exe'))
    return installer
      ? [{ artifact: installer, aliasName: 'Gaoge-Free-latest-windows-x64-setup.exe' }]
      : []
  }

  if (platform === 'mac') {
    const dmg = firstArtifact(artifacts, (artifact) => artifact.name.toLowerCase().endsWith('.dmg'))
    const appArchive = firstArtifact(artifacts, (artifact) => artifact.name.toLowerCase().endsWith('.tar.gz'))
    const artifact = dmg || appArchive
    return artifact
      ? [{ artifact, aliasName: dmg ? 'Gaoge-Free-latest-macos-universal.dmg' : 'Gaoge-Free-latest-macos-universal.app.tar.gz' }]
      : []
  }

  const appImage = firstArtifact(artifacts, (artifact) => {
    const lower = artifact.name.toLowerCase()
    return lower.endsWith('.appimage') && !lower.endsWith('.appimage.tar.gz')
  })
  const deb = firstArtifact(artifacts, (artifact) => artifact.name.toLowerCase().endsWith('.deb'))
  return [
    appImage ? { artifact: appImage, aliasName: 'Gaoge-Free-latest-linux-x86_64.AppImage' } : undefined,
    deb ? { artifact: deb, aliasName: 'Gaoge-Free-latest-linux-x86_64.deb' } : undefined,
  ].filter(Boolean)
}

async function copyDownloadAlias(spec, targetDir) {
  const aliasPath = path.join(targetDir, spec.aliasName)
  await fs.copyFile(spec.artifact.fullPath, aliasPath)

  let signaturePath
  if (spec.artifact.signed) {
    signaturePath = `${aliasPath}.sig`
    await fs.copyFile(spec.artifact.signaturePath, signaturePath)
  }

  return { sourceName: spec.artifact.name, aliasName: spec.aliasName, aliasPath, signaturePath }
}

function manifestFileNameForInstaller(installer, aliases) {
  if (platform !== 'win') return path.basename(installer.fullPath)

  const alias = aliases.find((item) => item.sourceName === installer.name)
  return alias?.aliasName || path.basename(installer.fullPath)
}

async function main() {
  const packageJson = await readJson(path.join(rootDir, 'package.json'))
  const releaseArtifacts = await collectReleaseArtifacts(bundleDirs, packageJson.version)
  const signedArtifacts = releaseArtifacts.filter((artifact) => artifact.signed)
  const installers = latestInstallerPerManifestKey(signedArtifacts)

  if (releaseArtifacts.length === 0) {
    throw new Error(`No ${platform} release artifact found in ${bundleDirs.join(', ')}`)
  }
  if (installers.length === 0) {
    throw new Error(`No signed ${platform} updater artifact found in ${bundleDirs.join(', ')}`)
  }

  await cleanDir(releaseDir)
  const platforms = {}
  const artifacts = []
  const downloadAliases = []

  for (const artifact of releaseArtifacts) {
    const copiedInstallerPath = await copyFileToDir(artifact.fullPath, releaseDir)
    const copiedSignaturePath = artifact.signed
      ? await copyFileToDir(artifact.signaturePath, releaseDir)
      : undefined
    artifacts.push({ installerPath: copiedInstallerPath, signaturePath: copiedSignaturePath })
  }

  for (const aliasSpec of downloadAliasSpecs(releaseArtifacts)) {
    downloadAliases.push(await copyDownloadAlias(aliasSpec, releaseDir))
  }

  for (const installer of installers) {
    const signaturePath = `${installer.fullPath}.sig`
    const signature = (await fs.readFile(signaturePath, 'utf8')).trim()
    if (!signature) {
      throw new Error(`Empty updater signature: ${signaturePath}`)
    }

    const fileName = manifestFileNameForInstaller(installer, downloadAliases)
    platforms[installer.manifestKey] = {
      signature,
      url: joinUrl(platformUpdateBaseUrl, fileName),
    }
  }

  const manifest = {
    version: packageJson.version,
    minimumVersion: minimumVersion || '0.0.0',
    notes: process.env.GAOGE_UPDATE_NOTES || `${packageJson.name} ${packageJson.version}`,
    pub_date: new Date().toISOString(),
    platforms,
  }

  const manifestPath = path.join(releaseDir, 'latest.json')
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        platform,
        releaseDir,
        manifestPath,
        artifacts,
        downloadAliases,
      },
      null,
      2,
    )}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
