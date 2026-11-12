import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const repoRoot = rootDir

function runGit(args) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
  })
}

async function pathExists(filePath) {
  return fs.access(filePath).then(() => true, () => false)
}

function addCheck(checks, name, ok, detail) {
  checks.push({ name, ok, detail })
}

async function main() {
  const checks = []

  const remoteResult = runGit(['remote', '-v'])
  const remoteOutput = remoteResult.stdout.trim()
  addCheck(
    checks,
    'git remote',
    remoteResult.status === 0 && remoteOutput.length > 0,
    remoteOutput || 'No git remote configured in repository root.',
  )

  const branchResult = runGit(['branch', '--show-current'])
  const branch = branchResult.stdout.trim()
  addCheck(
    checks,
    'git branch',
    branchResult.status === 0 && branch.length > 0,
    branch || 'No current git branch detected.',
  )

  for (const workflow of ['platform-check.yml', 'release-build.yml']) {
    const workflowPath = path.join(repoRoot, '.github', 'workflows', workflow)
    addCheck(checks, `workflow ${workflow}`, await pathExists(workflowPath), workflowPath)
  }

  for (const script of [
    'verify-platform-source.mjs',
    'verify-workflows.mjs',
    'verify-release-config.mjs',
    'verify-release-artifacts.mjs',
    'generate-update-manifest.mjs',
    'one-click-release.ps1',
    'remote-release.py',
    'remote_release_test.py',
    'setup-update-mirrors.py',
    'release-tooling.mjs',
    'release-tooling.test.mjs',
    'sign-windows.ps1',
  ]) {
    const scriptPath = path.join(rootDir, 'scripts', script)
    addCheck(checks, `script ${script}`, await pathExists(scriptPath), scriptPath)
  }

  for (const config of ['.release.local.example.json']) {
    const configPath = path.join(rootDir, config)
    addCheck(checks, `config ${config}`, await pathExists(configPath), configPath)
  }

  addCheck(
    checks,
    'TAURI_SIGNING_PRIVATE_KEY',
    Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY),
    process.env.TAURI_SIGNING_PRIVATE_KEY ? 'present in environment' : 'missing from local environment; configure as GitHub Actions secret for Release Build',
  )
  addCheck(
    checks,
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD),
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ? 'present in environment' : 'missing from local environment; configure as GitHub Actions secret for Release Build',
  )
  addCheck(
    checks,
    'Windows Authenticode signing',
    Boolean(
      (process.env.GAOGE_WINDOWS_PFX_BASE64 && process.env.GAOGE_WINDOWS_PFX_PASSWORD) ||
        process.env.GAOGE_WINDOWS_CERTIFICATE_THUMBPRINT,
    ),
    [
      'configure GAOGE_WINDOWS_PFX_BASE64 + GAOGE_WINDOWS_PFX_PASSWORD',
      'or configure GAOGE_WINDOWS_CERTIFICATE_THUMBPRINT on the Windows signing runner',
    ].join('; '),
  )

  const hardFailures = checks.filter(
    (check) =>
      !check.ok &&
      ![
        'TAURI_SIGNING_PRIVATE_KEY',
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
        'Windows Authenticode signing',
      ].includes(check.name),
  )
  const secretWarnings = checks.filter(
    (check) =>
      !check.ok &&
      [
        'TAURI_SIGNING_PRIVATE_KEY',
        'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
        'Windows Authenticode signing',
      ].includes(check.name),
  )

  process.stdout.write(`${JSON.stringify({ ok: hardFailures.length === 0, checks }, null, 2)}\n`)

  if (hardFailures.length > 0) {
    process.stderr.write(
      `Release readiness has blocking failures: ${hardFailures.map((check) => check.name).join(', ')}\n`,
    )
    process.exitCode = 1
    return
  }

  if (secretWarnings.length > 0) {
    process.stderr.write(
      `Release readiness warning: signing secrets are not present locally. This is OK for Platform Check, but Release Build needs GitHub Actions secrets.\n`,
    )
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
