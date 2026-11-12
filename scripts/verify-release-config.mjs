import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'))
const appVersion = packageJson.version

const fakeSignature = [
  'untrusted comment: signature from tauri secret key',
  'VERIFY_RELEASE_CONFIG_FAKE_SIGNATURE',
].join('\n')

async function writeSignedArtifact(dir, name) {
  await fs.mkdir(dir, { recursive: true })
  const artifactPath = path.join(dir, name)
  await fs.writeFile(artifactPath, `fake artifact: ${name}\n`, 'utf8')
  await fs.writeFile(`${artifactPath}.sig`, fakeSignature, 'utf8')
}

async function writeArtifact(dir, name) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), `fake artifact: ${name}\n`, 'utf8')
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false)
}

function runManifest(platform, bundleDir, releaseDir, target) {
  const args = [
    path.join('scripts', 'generate-update-manifest.mjs'),
    '--platform',
    platform,
    '--bundle-dir',
    bundleDir,
  ]

  if (target) {
    args.push('--target', target)
  }

  const result = spawnSync(process.execPath, args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GAOGE_UPDATE_RELEASE_DIR: releaseDir,
      GAOGE_UPDATE_BASE_URL: 'https://example.invalid/updates',
    },
  })

  if (result.status !== 0) {
    throw new Error(
      [
        `Manifest generation failed for ${platform}.`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

function runArtifactVerification(platform, releaseDir) {
  const result = spawnSync(
    process.execPath,
    [
      path.join('scripts', 'verify-release-artifacts.mjs'),
      '--platform',
      platform,
      '--release-dir',
      releaseDir,
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
    },
  )

  if (result.status !== 0) {
    throw new Error(
      [
        `Artifact verification failed for ${platform}.`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
}

async function readManifest(releaseDir) {
  return JSON.parse(await fs.readFile(path.join(releaseDir, 'latest.json'), 'utf8'))
}

function assertKeys(manifest, expectedKeys) {
  const actualKeys = Object.keys(manifest.platforms).sort()
  const expected = [...expectedKeys].sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected manifest keys.\nExpected: ${expected.join(', ')}\nActual: ${actualKeys.join(', ')}`)
  }
}

function assertManifestUrlsUseFile(manifest, expectedFileName) {
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    const rawFileName = path.posix.basename(new URL(entry.url).pathname)
    const fileName = decodeURIComponent(rawFileName)
    if (rawFileName.includes('%20') || rawFileName.includes(' ')) {
      throw new Error(`Manifest entry ${key} must not use a URL with spaces: ${entry.url}`)
    }
    if (fileName !== expectedFileName) {
      throw new Error(`Manifest entry ${key} must use ${expectedFileName}, got ${fileName}`)
    }
  }
}

function assertManifestUrlsUsePlatformDir(manifest, platform) {
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    const segments = new URL(entry.url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (segments.at(-2) !== platform) {
      throw new Error(`Manifest entry ${key} must use /${platform}/ update directory: ${entry.url}`)
    }
  }
}

async function assertFiles(releaseDir, expectedFiles) {
  for (const fileName of expectedFiles) {
    const filePath = path.join(releaseDir, fileName)
    if (!(await pathExists(filePath))) {
      throw new Error(`Missing expected release file: ${filePath}`)
    }
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gaoge-release-config-'))

  const winBundle = path.join(tempRoot, 'win-bundle')
  const winRelease = path.join(tempRoot, 'win-release')
  await writeSignedArtifact(winBundle, `Gaoge Free_${appVersion}_x64-setup.exe`)
  runManifest('win', winBundle, winRelease)
  const winManifest = await readManifest(winRelease)
  assertKeys(winManifest, ['windows-x86_64-nsis', 'windows-x86_64'])
  assertManifestUrlsUseFile(winManifest, 'Gaoge-Free-latest-windows-x64-setup.exe')
  assertManifestUrlsUsePlatformDir(winManifest, 'win')
  await assertFiles(winRelease, ['Gaoge-Free-latest-windows-x64-setup.exe'])
  runArtifactVerification('win', winRelease)

  const macBundle = path.join(tempRoot, 'mac-bundle')
  const macRelease = path.join(tempRoot, 'mac-release')
  await writeSignedArtifact(macBundle, 'Gaoge Free.app.tar.gz')
  await writeArtifact(macBundle, `Gaoge Free_${appVersion}_universal.dmg`)
  runManifest('mac', macBundle, macRelease, 'universal-apple-darwin')
  const macManifest = await readManifest(macRelease)
  assertKeys(macManifest, [
    'darwin-aarch64-app',
    'darwin-aarch64',
    'darwin-x86_64-app',
    'darwin-x86_64',
  ])
  assertManifestUrlsUsePlatformDir(macManifest, 'mac')
  await assertFiles(macRelease, ['Gaoge-Free-latest-macos-universal.dmg'])
  runArtifactVerification('mac', macRelease)

  const linuxBundle = path.join(tempRoot, 'linux-bundle')
  const linuxRelease = path.join(tempRoot, 'linux-release')
  await writeSignedArtifact(linuxBundle, `Gaoge Free_${appVersion}_amd64.AppImage.tar.gz`)
  await writeSignedArtifact(linuxBundle, `Gaoge Free_${appVersion}_amd64.AppImage`)
  await writeSignedArtifact(linuxBundle, `Gaoge Free_${appVersion}_amd64.deb`)
  runManifest('linux', linuxBundle, linuxRelease)
  const linuxManifest = await readManifest(linuxRelease)
  assertKeys(linuxManifest, [
    'linux-x86_64-appimage',
    'linux-x86_64-deb',
    'linux-x86_64',
  ])
  assertManifestUrlsUsePlatformDir(linuxManifest, 'linux')
  await assertFiles(linuxRelease, [
    'Gaoge-Free-latest-linux-x86_64.AppImage',
    'Gaoge-Free-latest-linux-x86_64.deb',
  ])
  runArtifactVerification('linux', linuxRelease)

  await fs.rm(tempRoot, { recursive: true, force: true })
  process.stdout.write('Release config verification passed.\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
