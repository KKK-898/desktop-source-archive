import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

function readArg(name) {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function readBoolArg(name) {
  const value = readArg(name)
  if (value === undefined) return process.argv.includes(`--${name}`)
  if (String(value).startsWith('--')) return true
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function normalizePlatform(value) {
  const platform = (value || process.env.GAOGE_UPDATE_PLATFORM || process.platform).toLowerCase()
  if (['win', 'win32', 'windows'].includes(platform)) return 'win'
  if (['mac', 'macos', 'darwin'].includes(platform)) return 'mac'
  if (platform === 'linux') return 'linux'
  throw new Error(`Unsupported release platform: ${platform}`)
}

function envFlag(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase())
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''))
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false)
}

function fileNameFromUrl(url) {
  const parsed = new URL(url)
  return decodeURIComponent(path.posix.basename(parsed.pathname))
}

function assertUrlUsesPlatformDirectory(url, platform, key) {
  const parsed = new URL(url)
  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const platformSegment = segments.at(-2)
  if (platformSegment !== platform) {
    throw new Error(`Manifest entry ${key} must point inside /${platform}/ update directory: ${url}`)
  }
}

function expectedBaseKeys(platform) {
  if (platform === 'win') return ['windows-x86_64']
  if (platform === 'mac') return ['darwin-aarch64', 'darwin-x86_64']
  return ['linux-x86_64']
}

function expectedInstallerKeys(platform) {
  if (platform === 'win') return ['windows-x86_64-nsis']
  if (platform === 'mac') return ['darwin-aarch64-app', 'darwin-x86_64-app']
  return ['linux-x86_64-appimage']
}

function expectedArtifactExtensions(platform) {
  if (platform === 'win') return ['.exe']
  if (platform === 'mac') return ['.dmg', '.tar.gz']
  return ['.deb', '.appimage', '.tar.gz']
}

function expectedDownloadAliases(platform) {
  if (platform === 'win') return ['Gaoge-Free-latest-windows-x64-setup.exe']
  if (platform === 'mac') return ['Gaoge-Free-latest-macos-universal.dmg']
  return [
    'Gaoge-Free-latest-linux-x86_64.AppImage',
    'Gaoge-Free-latest-linux-x86_64.deb',
  ]
}

function expectedManifestArtifactName(platform) {
  if (platform === 'win') return 'Gaoge-Free-latest-windows-x64-setup.exe'
  return undefined
}

function extensionOf(fileName) {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.tar.gz')) return '.tar.gz'
  if (lower.endsWith('.appimage')) return '.appimage'
  return path.extname(lower)
}

async function listReleaseArtifacts(releaseDir, platform) {
  const expectedExtensions = expectedArtifactExtensions(platform)
  const entries = await fs.readdir(releaseDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => expectedExtensions.includes(extensionOf(name)))
}

function verifyWindowsAuthenticode(filePath) {
  if (process.platform !== 'win32') {
    throw new Error(`Windows Authenticode verification requires a Windows runner: ${filePath}`)
  }

  const script = [
    '$path = $args[0]',
    '$sig = Get-AuthenticodeSignature -LiteralPath $path',
    'if ($sig.Status -ne "Valid") {',
    '  Write-Error "Invalid Authenticode signature: $path status=$($sig.Status) $($sig.StatusMessage)"',
    '  exit 1',
    '}',
    'Write-Host "Valid Authenticode signature: $path signer=$($sig.SignerCertificate.Subject)"',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script, filePath], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
  })

  if (result.status !== 0) {
    throw new Error(
      [
        `Windows Authenticode verification failed for ${filePath}.`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

async function main() {
  const platform = normalizePlatform(readArg('platform'))
  const requireAuthenticode =
    platform === 'win' &&
    (readBoolArg('require-authenticode') || envFlag('GAOGE_REQUIRE_WINDOWS_AUTHENTICODE'))
  const packageJson = await readJson(path.join(rootDir, 'package.json'))
  const releaseDir = path.resolve(rootDir, readArg('release-dir') || path.join('release', platform))
  const manifestPath = path.join(releaseDir, 'latest.json')

  if (!(await pathExists(manifestPath))) {
    throw new Error(`Missing release manifest: ${manifestPath}`)
  }

  const manifest = await readJson(manifestPath)
  if (manifest.version !== packageJson.version) {
    throw new Error(`Manifest version ${manifest.version} does not match package version ${packageJson.version}`)
  }
  if (!manifest.platforms || typeof manifest.platforms !== 'object') {
    throw new Error('Manifest missing platforms object.')
  }

  const manifestKeys = Object.keys(manifest.platforms)
  for (const key of [...expectedInstallerKeys(platform), ...expectedBaseKeys(platform)]) {
    if (!manifestKeys.includes(key)) {
      throw new Error(`Manifest missing expected platform key: ${key}`)
    }
  }

  const manifestArtifactNames = new Set()
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid manifest entry for ${key}`)
    }
    if (!entry.url || !entry.signature) {
      throw new Error(`Manifest entry ${key} must include url and signature.`)
    }
    assertUrlUsesPlatformDirectory(entry.url, platform, key)
    if (platform === 'win') {
      const expectedFileName = expectedManifestArtifactName(platform)
      const rawFileName = path.posix.basename(new URL(entry.url).pathname)
      if (rawFileName.includes('%20') || rawFileName.includes(' ')) {
        throw new Error(`Windows manifest entry ${key} must not use a URL with spaces: ${entry.url}`)
      }
      if (fileNameFromUrl(entry.url) !== expectedFileName) {
        throw new Error(`Windows manifest entry ${key} must point to stable alias ${expectedFileName}.`)
      }
    }
    const fileName = fileNameFromUrl(entry.url)
    const artifactPath = path.join(releaseDir, fileName)
    const signaturePath = `${artifactPath}.sig`
    if (!(await pathExists(artifactPath))) {
      throw new Error(`Manifest entry ${key} points to missing artifact: ${fileName}`)
    }
    if (!(await pathExists(signaturePath))) {
      throw new Error(`Manifest entry ${key} points to artifact without .sig: ${fileName}`)
    }
    manifestArtifactNames.add(fileName)
  }

  const releaseArtifacts = await listReleaseArtifacts(releaseDir, platform)
  if (releaseArtifacts.length === 0) {
    throw new Error(`No release artifacts found in ${releaseDir}`)
  }
  for (const fileName of manifestArtifactNames) {
    if (!releaseArtifacts.includes(fileName)) {
      throw new Error(`Manifest artifact ${fileName} is not in release artifact list.`)
    }
  }
  for (const fileName of expectedDownloadAliases(platform)) {
    if (!(await pathExists(path.join(releaseDir, fileName)))) {
      throw new Error(`Missing stable download alias: ${fileName}`)
    }
  }

  const windowsAuthenticode = []
  if (requireAuthenticode) {
    for (const fileName of releaseArtifacts.filter((name) => extensionOf(name) === '.exe')) {
      const artifactPath = path.join(releaseDir, fileName)
      verifyWindowsAuthenticode(artifactPath)
      windowsAuthenticode.push(fileName)
    }
    if (windowsAuthenticode.length === 0) {
      throw new Error('Windows Authenticode verification was required but no .exe artifacts were found.')
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        platform,
        releaseDir,
        manifestPath,
        manifestKeys,
        releaseArtifacts,
        downloadAliases: expectedDownloadAliases(platform),
        windowsAuthenticode,
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
