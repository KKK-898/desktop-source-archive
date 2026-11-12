import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const workflowsDir = path.resolve(rootDir, '.github', 'workflows')

async function readWorkflow(name) {
  return (await fs.readFile(path.join(workflowsDir, name), 'utf8')).replace(/\r\n/g, '\n')
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) {
    throw new Error(`${label} missing: ${needle}`)
  }
}

function assertPlatformMatrix(text, label) {
  for (const [platform, os] of [
    ['win', 'windows-latest'],
    ['mac', 'macos-latest'],
    ['linux', 'ubuntu-22.04'],
  ]) {
    assertIncludes(text, `platform: ${platform}`, `${label} platform matrix`)
    assertIncludes(text, `os: ${os}`, `${label} OS matrix`)
  }
  assertIncludes(text, 'fail-fast: false', `${label} fail-fast setting`)
}

function assertCommonSetup(text, label) {
  assertIncludes(text, 'actions/checkout@v4', `${label} checkout step`)
  assertIncludes(text, 'actions/setup-node@v4', `${label} setup-node step`)
  assertIncludes(text, 'node-version: 22', `${label} Node version`)
  assertIncludes(text, 'cache-dependency-path: package-lock.json', `${label} npm cache path`)
  assertIncludes(text, 'dtolnay/rust-toolchain@stable', `${label} Rust toolchain step`)
  assertIncludes(text, 'libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf', `${label} Linux dependencies`)
  assertIncludes(text, 'run: npm ci', `${label} npm ci step`)
}

async function main() {
  const platformCheck = await readWorkflow('platform-check.yml')
  const releaseBuild = await readWorkflow('release-build.yml')

  assertIncludes(platformCheck, 'name: Platform Check', 'Platform Check workflow')
  assertIncludes(platformCheck, 'workflow_dispatch:', 'Platform Check manual trigger')
  assertIncludes(platformCheck, 'pull_request:', 'Platform Check PR trigger')
  assertCommonSetup(platformCheck, 'Platform Check')
  assertIncludes(platformCheck, 'run: npm run build', 'Platform Check frontend build')
  assertIncludes(platformCheck, 'run: npm run verify:release', 'Platform Check release verification')
  assertIncludes(platformCheck, 'run: npm run verify:platform', 'Platform Check source verification')
  assertIncludes(platformCheck, 'run: cargo test --manifest-path src-tauri/Cargo.toml', 'Platform Check cargo tests')
  assertIncludes(platformCheck, 'run: npm run test:release-tooling', 'Platform Check release tooling tests')
  assertIncludes(platformCheck, 'run: npm run test:release-remote', 'Platform Check remote publisher tests')
  assertIncludes(platformCheck, 'actions/setup-python@v5', 'Platform Check Python setup')
  assertIncludes(platformCheck, "python-version: '3.14'", 'Platform Check Python version')
  assertIncludes(platformCheck, 'python -m pip install -r mobile-bridge/requirements-relay.txt', 'Platform Check relay dependencies')
  assertIncludes(platformCheck, 'working-directory: mobile-bridge', 'Platform Check mobile fixture directory')
  assertIncludes(platformCheck, 'python -m unittest discover -s tests -p test_phone_relay.py', 'Platform Check isolated mobile relay tests')
  assertIncludes(platformCheck, 'python -m unittest discover -s tests -p test_mobile_controller.py', 'Platform Check isolated controller tests')

  assertIncludes(releaseBuild, 'name: Release Build', 'Release Build workflow')
  assertIncludes(releaseBuild, 'workflow_dispatch:', 'Release Build manual trigger')
  assertPlatformMatrix(releaseBuild, 'Release Build')
  assertCommonSetup(releaseBuild, 'Release Build')
  assertIncludes(releaseBuild, 'rustup target add aarch64-apple-darwin x86_64-apple-darwin', 'Release Build macOS universal targets')
  assertIncludes(releaseBuild, 'run: npm run verify:release', 'Release Build release verification')
  assertIncludes(releaseBuild, 'run: npm run verify:platform', 'Release Build source verification')
  assertIncludes(releaseBuild, 'TAURI_SIGNING_PRIVATE_KEY:', 'Release Build signing key env')
  assertIncludes(releaseBuild, 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD:', 'Release Build signing password env')
  assertIncludes(releaseBuild, 'VITE_GAOGE_BOOTSTRAP_CONFIG_URLS:', 'Release Build OSS directory env')
  assertIncludes(releaseBuild, 'GAOGE_UPDATE_BASE_URL:', 'Release Build update origin env')
  assertIncludes(releaseBuild, 'GAOGE_UPDATE_MINIMUM_VERSION:', 'Release Build minimum version env')
  assertIncludes(releaseBuild, 'run: npm run test:release-remote', 'Release Build remote publisher tests')
  assertIncludes(releaseBuild, 'GAOGE_WINDOWS_SIGNING_REQUIRED: "false"', 'Release Build optional Windows code signing flag')
  assertIncludes(releaseBuild, 'GAOGE_WINDOWS_PFX_BASE64:', 'Release Build Windows PFX secret')
  assertIncludes(releaseBuild, 'GAOGE_WINDOWS_PFX_PASSWORD:', 'Release Build Windows PFX password secret')
  assertIncludes(releaseBuild, 'GAOGE_WINDOWS_CERTIFICATE_THUMBPRINT:', 'Release Build Windows certificate thumbprint secret')
  assertIncludes(releaseBuild, 'GAOGE_WINDOWS_TIMESTAMP_URL:', 'Release Build Windows timestamp URL')
  assertIncludes(releaseBuild, 'name: Prepare verified release tools', 'Release Build tool preparation')
  assertIncludes(releaseBuild, "if: matrix.platform == 'win' || matrix.platform == 'linux'", 'Release Build tool platforms')
  assertIncludes(releaseBuild, 'GH_TOKEN: ${{ github.token }}', 'Release Build official tool API authentication')
  assertIncludes(releaseBuild, 'run: node scripts/prepare-release-tools.mjs', 'Release Build pinned tool preparation')
  if (releaseBuild.indexOf('name: Prepare verified release tools') > releaseBuild.indexOf('name: Build signed release')) {
    throw new Error('Release tool preparation must run before the signed build')
  }
  assertIncludes(releaseBuild, 'run: ${{ matrix.command }}', 'Release Build matrix build command')
  assertIncludes(releaseBuild, 'npm run verify:artifacts -- --platform ${{ matrix.platform }}', 'Release Build artifact verification')
  assertIncludes(releaseBuild, 'actions/upload-artifact@v4', 'Release Build upload artifact')
  assertIncludes(releaseBuild, 'if-no-files-found: error', 'Release Build artifact failure mode')
  assertIncludes(releaseBuild, 'node scripts/verify-mobile-runtime.mjs ${{ matrix.platform }}', 'Release Build lightweight app gate')
  for (const obsolete of ['mobile-gateway:', 'needs: mobile-gateway', 'requirements-desktop.txt', 'runtime-artifact:']) {
    if (releaseBuild.includes(obsolete)) throw new Error('Main app release must not build or download the optional runtime: ' + obsolete)
  }
  const component = await readWorkflow('mobile-components.yml')
  assertIncludes(component, "branches: ['codex/mobile-components-*']", 'Component isolated test branch')
  assertIncludes(component, 'workflow_dispatch:', 'Component manual trigger')
  for (const [runtime, os, architecture] of [
    ['windows-x86_64', 'windows-latest', 'x64'],
    ['macos-aarch64', 'macos-15', 'arm64'],
    ['macos-x86_64', 'macos-15-intel', 'x64'],
  ]) {
    assertIncludes(component, `runtime: ${runtime}\n            os: ${os}\n            python-architecture: ${architecture}`, 'Component native build matrix')
  }
  for (const required of ["python-version: '3.14'", "MACOSX_DEPLOYMENT_TARGET: '11.0'", 'python scripts/prepare-macos-crypto.py',
    'python scripts/build-mobile-bridge.py', 'scripts/test-mobile-runtime.py', 'scripts/build_mobile_bridge_test.py',
    'scripts/mobile_component_release_test.py', 'python -m unittest discover -s tests -v',
    'python scripts/package-mobile-component.py --platform ${{ matrix.runtime }}', 'compression-level: 0', 'if-no-files-found: error']) {
    assertIncludes(component, required, 'Independent component verification')
  }
  if (/TAURI_SIGNING_PRIVATE_KEY|secrets\./.test(component)) throw new Error('Component CI must not receive release signing credentials')
  const macTest = await readWorkflow('mac-mobile-test.yml')
  assertIncludes(macTest, 'python scripts/verify-mac-mobile-test.py', 'Lightweight Mac bundle check')
  if (macTest.includes('needs: mobile-runtime') || macTest.includes('download-artifact@')) throw new Error('Mac test app must not depend on frozen runtime artifacts')

  process.stdout.write('Workflow verification passed.\n')
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
