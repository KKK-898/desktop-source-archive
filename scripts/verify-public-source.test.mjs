import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArguments, readSourceArchive, validateSnapshot, verifyPublicSource } from './verify-public-source.mjs'

const REPOSITORY = 'KKK-898/desktop-source-archive'
const TAG = 'v1.7.1'
const SOURCE_COMMIT = '1'.repeat(40)
const SOURCE_TREE = '2'.repeat(40)
const PUBLIC_COMMIT = '3'.repeat(40)
const TAG_OBJECT = '4'.repeat(40)
const ROOT = `desktop-source-archive-${PUBLIC_COMMIT}`
const MANIFEST = 'SOURCE_MANIFEST.json'
const REPORT = 'SOURCE_EXPORT_REPORT.json'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)

function snapshot() {
  const files = new Map([
    ['README.md', Buffer.from('Synthetic public source verification fixture.\n')],
    ['src/main.js', Buffer.from('export const version = "1.7.1"\n')],
  ])
  const entries = [...files].map(([name, bytes]) => ({ path: name, sha256: hash(bytes), size: bytes.length }))
  const manifest = { schemaVersion: 1, version: '1.7.1', sourceCommit: SOURCE_COMMIT, sourceTree: SOURCE_TREE, files: entries }
  const report = { schemaVersion: 1, version: '1.7.1', sourceCommit: SOURCE_COMMIT, sourceTree: SOURCE_TREE, sourceMode: 'git-ref', releaseReady: true,
    exclusions: [], replacements: [], checks: [{ name: 'synthetic fixture', ok: true }], rightsFindings: [],
    filesDigest: hash(Buffer.from(entries.map((entry) => `${entry.sha256}  ${entry.size}  ${entry.path}\n`).join(''))) }
  files.set(MANIFEST, json(manifest))
  files.set(REPORT, json(report))
  return files
}

function withSourceReleaseTag(files, tag, version = '1.7.1') {
  const records = new Map([...files].map(([name, bytes]) => [name, sourceItem(bytes)]))
  records.set('package.json', sourceItem(json({ version, ...(tag === undefined ? {} : { sourceReleaseTag: tag }) })))
  rebuildSnapshotMetadata(records)
  return new Map([...records].map(([name, item]) => [name, item.bytes]))
}

function patchJson(files, name, edit) {
  const value = JSON.parse(files.get(name).toString())
  edit(value)
  files.set(name, json(value))
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

// Deliberately permits unsafe entry names so traversal/duplicate defenses are tested.
function zip(entries) {
  const locals = [], central = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name), bytes = item.bytes || Buffer.alloc(0)
    const local = Buffer.alloc(30), directory = Buffer.alloc(46)
    const crc = crc32(bytes)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26)
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x314, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8)
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(bytes.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(((item.mode ?? (item.name.endsWith('/') ? 0o40755 : 0o100644)) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42)
    locals.push(local, name, bytes); central.push(directory, name); offset += local.length + name.length + bytes.length
  }
  const center = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(center.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, center, end])
}

function sourceZip(files, extra = [], root = ROOT) {
  return zip([{ name: `${root}/` }, { name: `${root}/src/` }, ...[...files].map(([name, bytes]) => ({ name: `${root}/${name}`, bytes })), ...extra])
}

async function localFixture(t, files = snapshot()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gaoge-public-source-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [name, bytes] of files) {
    const file = path.join(directory, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes)
  }
  return directory
}

function fakeGitHub(archive, { publicRepo = true, annotated = false, changeTag = false, status = 200, onArchive, tag = TAG } = {}) {
  const calls = []
  let refRequests = 0
  const base = `https://api.github.com/repos/${REPOSITORY}`
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'GET')
    assert.equal(Object.keys(options.headers).some((key) => /authorization|cookie/i.test(key)), false)
    if (status !== 200) return new Response('unavailable', { status })
    if (url === base) return new Response(json({ name: 'desktop-source-archive', full_name: REPOSITORY, private: !publicRepo, visibility: publicRepo ? 'public' : 'private' }))
    if (url === `${base}/git/ref/tags/${tag}`) {
      refRequests += 1
      const sha = changeTag && refRequests > 1 ? '5'.repeat(40) : (annotated ? TAG_OBJECT : PUBLIC_COMMIT)
      return new Response(json({ ref: `refs/tags/${tag}`, object: { type: annotated ? 'tag' : 'commit', sha } }))
    }
    if (url === `${base}/git/tags/${TAG_OBJECT}`) return new Response(json({ sha: TAG_OBJECT, object: { type: 'commit', sha: PUBLIC_COMMIT } }))
    if (url === `https://codeload.github.com/${REPOSITORY}/zip/${PUBLIC_COMMIT}`) {
      if (onArchive) await onArchive()
      return new Response(archive)
    }
    throw new Error(`Unexpected synthetic HTTP request: ${url}`)
  }
  return { fetchImpl, calls }
}

function options(sourceDirectory) { return { repository: REPOSITORY, tag: TAG, sourceDirectory } }

for (const annotated of [false, true]) {
  test(`verifies exact synthetic source using an ${annotated ? 'annotated' : 'lightweight'} public tag and commit archive`, async (t) => {
    const files = snapshot(), directory = await localFixture(t, files)
    const github = fakeGitHub(sourceZip(files), { annotated })
    const result = await verifyPublicSource(options(directory), github)
    assert.deepEqual(result, { verified: true, repository: REPOSITORY, tag: TAG, publicCommit: PUBLIC_COMMIT, sourceCommit: SOURCE_COMMIT, version: '1.7.1', fileCount: 4 })
    assert.equal(github.calls.filter((call) => call.url.endsWith(`/git/ref/tags/${TAG}`)).length, 2)
    assert.ok(github.calls.some((call) => call.url === `https://codeload.github.com/${REPOSITORY}/zip/${PUBLIC_COMMIT}`))
  })
}

test('rejects private repositories even when synthetic authenticated-style content would be available', async (t) => {
  const files = snapshot(), directory = await localFixture(t, files), github = fakeGitHub(sourceZip(files), { publicRepo: false })
  await assert.rejects(verifyPublicSource(options(directory), github), /not explicitly public/)
  assert.equal(github.calls.length, 1)
})

for (const status of [401, 403, 404, 500]) {
  test(`rejects anonymous GitHub access failure HTTP ${status}`, async (t) => {
    const files = snapshot(), directory = await localFixture(t, files)
    await assert.rejects(verifyPublicSource(options(directory), fakeGitHub(sourceZip(files), { status })), new RegExp(`HTTP ${status}`))
  })
}

for (const [name, mutate, pattern] of [
  ['development snapshot', (f) => patchJson(f, REPORT, (r) => { r.publicationKind = 'development-snapshot' }), /development snapshot/],
  ['development manifest', (f) => patchJson(f, MANIFEST, (r) => { r.publicationKind = 'development-snapshot' }), /development snapshot/],
  ['privacy maintenance report', (f) => patchJson(f, REPORT, (r) => { r.publicationKind = 'privacy-maintenance'; r.releaseReady = true }), /privacy maintenance snapshot/],
  ['privacy maintenance manifest', (f) => patchJson(f, MANIFEST, (r) => { r.publicationKind = 'privacy-maintenance' }), /privacy maintenance snapshot/],
  ['releaseReady false', (f) => patchJson(f, REPORT, (r) => { r.releaseReady = false }), /not release-ready/],
  ['working-tree review', (f) => patchJson(f, REPORT, (r) => { r.sourceMode = 'working-tree' }), /not release-ready/],
  ['failed checks', (f) => patchJson(f, REPORT, (r) => { r.checks[0].ok = false }), /checks.*failing/],
  ['empty checks', (f) => patchJson(f, REPORT, (r) => { r.checks = [] }), /checks.*incomplete/],
  ['unresolved rights', (f) => patchJson(f, REPORT, (r) => { r.rightsFindings = [{ path: 'sample.png', status: 'unresolved' }] }), /unresolved rights/],
  ['wrong version', (f) => patchJson(f, MANIFEST, (r) => { r.version = '1.7.0' }), /version does not match/],
  ['source identity mismatch', (f) => patchJson(f, REPORT, (r) => { r.sourceTree = '6'.repeat(40) }), /source identity differ/],
  ['wrong filesDigest', (f) => patchJson(f, REPORT, (r) => { r.filesDigest = 'f'.repeat(64) }), /filesDigest mismatch/],
  ['duplicate manifest entries', (f) => patchJson(f, MANIFEST, (r) => { r.files.push(r.files[0]) }), /duplicate manifest/],
  ['self-listed manifest', (f) => patchJson(f, MANIFEST, (r) => { r.files.push({ path: MANIFEST, size: 0, sha256: '0'.repeat(64) }) }), /must not list metadata/],
  ['extra local file', (f) => f.set('unlisted.txt', Buffer.from('extra')), /extra or missing/],
  ['wrong actual local bytes', (f) => f.set('README.md', Buffer.from('tampered')), /content mismatch/],
]) {
  test(`rejects ${name} before any network request`, async (t) => {
    const files = snapshot(); mutate(files)
    const directory = await localFixture(t, files)
    await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => { assert.fail('must validate local source before network') } }), pattern)
  })
}

test('rejects .git directory in the source snapshot before making network requests', async (t) => {
  const directory = await localFixture(t)
  await mkdir(path.join(directory, '.git'))
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => assert.fail('unexpected request') }), /Unsafe source path/)
})

test('rejects extra local empty directories not represented by source files', async (t) => {
  const directory = await localFixture(t)
  await mkdir(path.join(directory, 'unlisted-empty'))
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => assert.fail('unexpected request') }), /extra directory/)
})

test('rejects local directory junctions and symlinks without traversing them', async (t) => {
  const directory = await localFixture(t), target = await mkdtemp(path.join(os.tmpdir(), 'gaoge-source-outside-'))
  t.after(() => rm(target, { recursive: true, force: true }))
  await symlink(target, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => assert.fail('unexpected request') }), /symlinks are not allowed/)
})

for (const [name, mutate, pattern] of [
  ['extra remote file', (f) => f.set('remote-extra', Buffer.from('extra')), /extra or missing/],
  ['missing remote file', (f) => f.delete('README.md'), /extra or missing/],
  ['remote content changed without manifest update', (f) => f.set('README.md', Buffer.from('changed')), /content mismatch/],
  ['report bytes changed despite equivalent metadata', (f) => f.set(REPORT, Buffer.from(JSON.stringify(JSON.parse(f.get(REPORT))))), /file differs|metadata bytes differ/],
]) {
  test(`rejects ${name}`, async (t) => {
    const files = snapshot(), directory = await localFixture(t, files); mutate(files)
    await assert.rejects(verifyPublicSource(options(directory), fakeGitHub(sourceZip(files))), pattern)
  })
}

test('rejects internally consistent substituted public source against actual local files', async (t) => {
  const local = snapshot(), directory = await localFixture(t, local), remote = snapshot()
  remote.set('README.md', Buffer.from('Substituted public snapshot\n'))
  patchJson(remote, MANIFEST, (m) => { const item = m.files.find((x) => x.path === 'README.md'); item.size = remote.get('README.md').length; item.sha256 = hash(remote.get('README.md')) })
  const manifest = JSON.parse(remote.get(MANIFEST))
  patchJson(remote, REPORT, (r) => { r.filesDigest = hash(Buffer.from(manifest.files.map((entry) => `${entry.sha256}  ${entry.size}  ${entry.path}\n`).join(''))) })
  await assert.rejects(verifyPublicSource(options(directory), fakeGitHub(sourceZip(remote))), /file differs/)
})

for (const [name, extra, pattern] of [
  ['traversal', { name: `${ROOT}/../outside.txt`, bytes: Buffer.from('bad') }, /invalid relative path|Unsafe source path/],
  ['backslash traversal', { name: `${ROOT}\\outside.txt`, bytes: Buffer.from('bad') }, /invalid characters|Unsafe source path/],
  ['absolute path', { name: '/outside.txt', bytes: Buffer.from('bad') }, /absolute path|Unsafe source path/],
  ['duplicate file', { name: `${ROOT}/README.md`, bytes: Buffer.from('duplicate') }, /Duplicate archive entry/],
  ['case-colliding file', { name: `${ROOT}/readme.md`, bytes: Buffer.from('duplicate') }, /Duplicate archive entry/],
  ['symlink', { name: `${ROOT}/link`, bytes: Buffer.from('README.md'), mode: 0o120777 }, /symlink or special/],
  ['extra empty directory', { name: `${ROOT}/extra/` }, /extra directory/],
  ['git metadata', { name: `${ROOT}/.git/config`, bytes: Buffer.from('synthetic') }, /Unsafe source path/],
  ['another archive root', { name: 'another-root/file.txt', bytes: Buffer.from('bad') }, /unexpected root/],
]) {
  test(`rejects public archive ${name}`, async (t) => {
    const files = snapshot(), directory = await localFixture(t, files)
    await assert.rejects(verifyPublicSource(options(directory), fakeGitHub(sourceZip(files, [extra]))), pattern)
  })
}

test('rejects a public tag that changes after the pinned commit is downloaded', async (t) => {
  const files = snapshot(), directory = await localFixture(t, files)
  await assert.rejects(verifyPublicSource(options(directory), fakeGitHub(sourceZip(files), { changeTag: true })), /tag changed/)
})

test('rejects a local snapshot modified while public files are downloaded', async (t) => {
  const files = snapshot(), directory = await localFixture(t, files)
  const github = fakeGitHub(sourceZip(files), { onArchive: () => writeFile(path.join(directory, 'README.md'), 'changed in flight') })
  await assert.rejects(verifyPublicSource(options(directory), github), /content mismatch|changed during verification/)
})

test('rejects malformed ZIP bytes', async () => {
  await assert.rejects(readSourceArchive(Buffer.from('not a zip'), ROOT))
})

test('rejects malformed input and parses only the documented CLI arguments', () => {
  const sourceDirectory = path.resolve(os.tmpdir(), 'synthetic-source')
  assert.deepEqual(parseArguments(['--repository', REPOSITORY, '--tag=v1.7.1', `--source-directory=${sourceDirectory}`]), options(sourceDirectory))
  assert.throws(() => parseArguments(['--repository', REPOSITORY]), /Missing --tag/)
  assert.throws(() => parseArguments(['--token', 'not-supported']), /Unknown argument/)
  assert.throws(() => parseArguments(['--repository=x/y', '--repository=a/b']), /Duplicate argument/)
  assert.throws(() => parseArguments(['--tag', '--repository']), /Missing value/)
})

test('never interprets arbitrary repository URLs as fetch destinations', async () => {
  await assert.rejects(verifyPublicSource({ repository: 'https://example.invalid/a/b', tag: TAG, sourceDirectory: '/unused' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /owner\/repository/)
  await assert.rejects(verifyPublicSource({ repository: REPOSITORY, tag: '../branch', sourceDirectory: '/unused' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /vX.Y.Z/)
  await assert.rejects(verifyPublicSource({ repository: REPOSITORY, tag: TAG, sourceDirectory: 'relative' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /must be absolute/)
})

test('rejects a repository identity mismatch even if the API calls it public', async (t) => {
  const directory = await localFixture(t)
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => new Response(json({ name: 'elsewhere', full_name: 'owner/elsewhere', private: false, visibility: 'public' })) }), /identity mismatch/)
})

test('rejects GitHub redirects rather than following to an untrusted location', async (t) => {
  const directory = await localFixture(t)
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => new Response(null, { status: 302, headers: { Location: 'https://example.invalid/private' } }) }), /HTTP 302/)
})

test('rejects malformed GitHub API JSON', async (t) => {
  const directory = await localFixture(t)
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => new Response('<html>error</html>') }), /Invalid public GitHub JSON/)
})

test('rejects oversized API Content-Length before consuming its body', async (t) => {
  const directory = await localFixture(t)
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(8 * 1024 * 1024) } }) }), /exceeds size limit/)
})

test('rejects tags referencing non-commit and non-tag Git objects', async (t) => {
  const files = snapshot(), directory = await localFixture(t, files), github = fakeGitHub(sourceZip(files))
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: (url, init) => url.includes('/git/ref/tags/')
    ? Promise.resolve(new Response(json({ ref: `refs/tags/${TAG}`, object: { type: 'blob', sha: PUBLIC_COMMIT } }))) : github.fetchImpl(url, init) }), /does not reference a commit/)
})

test('rejects cyclic annotated tags', async (t) => {
  const files = snapshot(), directory = await localFixture(t, files), github = fakeGitHub(sourceZip(files), { annotated: true })
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: (url, init) => url.includes('/git/tags/')
    ? Promise.resolve(new Response(json({ sha: TAG_OBJECT, object: { type: 'tag', sha: TAG_OBJECT } }))) : github.fetchImpl(url, init) }), /Cyclic annotated/)
})

test('rejects changed tag object even when its final commit stays the same', async (t) => {
  const files = snapshot(), directory = await localFixture(t, files), github = fakeGitHub(sourceZip(files), { annotated: true })
  let refs = 0
  const secondTag = '7'.repeat(40)
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: (url, init) => {
    if (url.includes('/git/ref/tags/')) { refs += 1; return Promise.resolve(new Response(json({ ref: `refs/tags/${TAG}`, object: { type: 'tag', sha: refs > 1 ? secondTag : TAG_OBJECT } }))) }
    if (url.endsWith(`/git/tags/${secondTag}`)) return Promise.resolve(new Response(json({ sha: secondTag, object: { type: 'commit', sha: PUBLIC_COMMIT } })))
    return github.fetchImpl(url, init)
  } }), /tag changed/)
})

test('rejects unsupported metadata schemas even when both metadata files agree', async (t) => {
  const files = snapshot()
  patchJson(files, MANIFEST, (m) => { m.schemaVersion = 2 }); patchJson(files, REPORT, (r) => { r.schemaVersion = 2 })
  const directory = await localFixture(t, files)
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => assert.fail('unexpected request') }), /unsupported schemaVersion/)
})

test('rejects unsafe manifest paths without trusting their declared hashes', () => {
  const files = snapshot()
  patchJson(files, MANIFEST, (m) => { m.files[0].path = '../README.md' })
  const actual = new Map([...files].map(([name, bytes]) => [name, { size: bytes.length, sha256: hash(bytes), bytes }]))
  assert.throws(() => validateSnapshot(actual, new Set(['src']), '1.7.1'), /Unsafe source path/)
})


test('verifies the real exporter schema using only a synthetic temporary Git repository', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'gaoge-exporter-integration-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const exporter = fileURLToPath(new URL('./export_public_source.py', import.meta.url))
  const python = String.raw`
import importlib.util, json, os, pathlib, subprocess, sys
spec = importlib.util.spec_from_file_location("source_export_fixture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
base = pathlib.Path(sys.argv[2])
root = base / "synthetic-repository"
root.mkdir()
# Ignore user Git hooks/configuration and never set a remote or use real assets.
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
files = {p: "Synthetic source fixture only.\n" for p in module.REQUIRED}
files.update({p: "Synthetic public replacement.\n" for p in module.REPLACEMENTS.values()})
files.update({
  "package.json": json.dumps({"name": "synthetic-source-fixture", "version": "1.7.1", "license": "AGPL-3.0-only"}),
  "package-lock.json": json.dumps({"version": "1.7.1", "lockfileVersion": 3, "packages": {"": {"version": "1.7.1", "license": "AGPL-3.0-only"}}}),
  "src-tauri/Cargo.toml": '[package]\nname = "synthetic-source-fixture"\nversion = "1.7.1"\nlicense = "AGPL-3.0-only"\n',
  "src-tauri/tauri.conf.json": json.dumps({"version": "1.7.1", "bundle": {"resources": [], "icon": []}}),
  "scripts/public-source-audit.json": json.dumps({"schemaVersion": 1, "items": []}),
  "src/main.js": 'export const version = "1.7.1";\n',
})
for name, content in files.items():
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")
def git(*args):
    return subprocess.run(["git", "-C", str(root), "-c", "core.autocrlf=false", *args], check=True, capture_output=True)
git("init", "--quiet")
git("add", "--all")
git("-c", "user.name=Synthetic Source Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic exporter compatibility fixture")
print(json.dumps(module.export(root, base / "clean-export", ref="HEAD")))
`
  const result = JSON.parse(execFileSync('python', ['-B', '-c', python, exporter, base], { encoding: 'utf8', timeout: 30_000 }))
  assert.equal(result.ReleaseReady, true)
  assert.equal(result.Version, '1.7.1')
  const files = new Map()
  async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${relative}/`)
      else files.set(relative, await readFile(path.join(directory, entry.name)))
    }
  }
  await collect(result.SourceDirectory)
  const report = JSON.parse(files.get(REPORT).toString())
  const manifest = JSON.parse(files.get(MANIFEST).toString())
  assert.equal(report.filesDigest, hash(Buffer.from(manifest.files.map((file) => `${file.sha256}  ${file.size}  ${file.path}\n`).join(''))))
  assert.equal(manifest.sourceCommit, result.SourceCommit)
  assert.ok(report.checks.length > 1)
  assert.ok(report.replacements.length > 0)
  const verified = await verifyPublicSource(options(result.SourceDirectory), fakeGitHub(sourceZip(files)))
  assert.equal(verified.verified, true)
  assert.equal(verified.sourceCommit, result.SourceCommit)
  assert.equal(verified.publicCommit, PUBLIC_COMMIT)
  assert.notEqual(verified.publicCommit, verified.sourceCommit)
  assert.equal(verified.fileCount, manifest.files.length + 2)
})


const RIGHTS_AUDIT = 'scripts/public-source-audit.json'
const OWNER_EVIDENCE = 'scripts/public-source-docs/owner-release-decision-1.7.1.md'
const OWNER_EVIDENCE_SHA256 = 'a95d09b14f963a65fe2a07e6cd3929a85c83a10185fc7afda4538f2b94f05704'
const evidenceBytes = await readFile(new URL('./public-source-docs/owner-release-decision-1.7.1.md', import.meta.url))
const evidenceScope = JSON.parse([...evidenceBytes.toString('utf8').matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gu)][0][1])

function sourceItem(bytes) { return { size: bytes.length, sha256: hash(bytes), bytes } }
function editSnapshotJson(files, name, edit) {
  const value = JSON.parse(files.get(name).bytes.toString('utf8'))
  edit(value)
  files.set(name, sourceItem(json(value)))
}
function rebuildSnapshotMetadata(files) {
  const entries = [...files].filter(([name]) => ![MANIFEST, REPORT].includes(name))
    .map(([name, file]) => ({ path: name, sha256: file.sha256, size: file.size }))
  editSnapshotJson(files, MANIFEST, (manifest) => { manifest.files = entries })
  editSnapshotJson(files, REPORT, (report) => { report.filesDigest = hash(Buffer.from(entries.map((entry) => `${entry.sha256}  ${entry.size}  ${entry.path}\n`).join(''))) })
}

// These unit fixtures use the fixed public decision record, but never read/copy the
// actual artwork, logos, locale pack, or native excerpts. Asset hash metadata stubs
// exercise validateSnapshot after the hashing stage; archive/local hashing is
// independently covered by the synthetic end-to-end tests above.
function ownerPublicationSnapshot() {
  assert.equal(hash(evidenceBytes), OWNER_EVIDENCE_SHA256)
  const files = new Map([...snapshot()].map(([name, bytes]) => [name, sourceItem(bytes)]))
  const decisions = evidenceScope.items.map((item) => ({
    type: 'owner-directed-publication', decisionId: 'gaoge-1.7.1-2026-11-12', version: '1.7.1', sha256: item.sha256,
    evidence: [{ path: OWNER_EVIDENCE, sha256: OWNER_EVIDENCE_SHA256 }], acknowledgesUnverifiedRights: true,
  }))
  const audit = { schemaVersion: 1, items: evidenceScope.items.map((item, index) => ({ ...structuredClone(item), releaseDecision: structuredClone(decisions[index]) })) }
  const disclosures = evidenceScope.items.map((item, index) => ({ path: item.path, status: item.status, reason: item.reason, sha256: item.sha256, releaseDecision: structuredClone(decisions[index]) }))
  for (const item of evidenceScope.items) files.set(item.path, { size: 1, sha256: item.sha256 })
  for (const item of evidenceScope.items) {
    for (const name of item.evidence) if (!files.has(name)) files.set(name, sourceItem(Buffer.from('Synthetic presence-only provenance evidence fixture.\n')))
  }
  files.set(OWNER_EVIDENCE, sourceItem(evidenceBytes))
  files.set(RIGHTS_AUDIT, sourceItem(json(audit)))
  editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures = disclosures })
  rebuildSnapshotMetadata(files)
  return files
}

function editDecisionBoth(files, edit) {
  editSnapshotJson(files, RIGHTS_AUDIT, (audit) => edit(audit.items[0].releaseDecision))
  editSnapshotJson(files, REPORT, (report) => edit(report.rightsDisclosures[0].releaseDecision))
}

function editOriginalBoth(files, key, value) {
  editSnapshotJson(files, RIGHTS_AUDIT, (audit) => { audit.items[0][key] = value })
  editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[0][key] = value })
}

test('retains all 50 exact unverified disclosures under the version-bound owner publication decision', () => {
  const files = ownerPublicationSnapshot()
  const result = validateSnapshot(files, new Set(), '1.7.1')
  assert.equal(result.report.rightsDisclosures.length, 50)
  assert.equal(result.report.rightsFindings.length, 0)
  assert.deepEqual(result.report.rightsDisclosures.map(({ path, sha256, status, reason }) => ({ path, sha256, status, reason })),
    evidenceScope.items.map(({ path, sha256, status, reason }) => ({ path, sha256, status, reason })))
  assert.equal(result.report.rightsDisclosures.some((item) => ['cleared', 'verified', 'replaced-original'].includes(item.status)), false)
})

const ownerMutationCases = [
  ['missing disclosure list', (files) => editSnapshotJson(files, REPORT, (report) => { delete report.rightsDisclosures }), /disclosures incomplete/],
  ['empty disclosure list', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures = [] }), /disclosures incomplete/],
  ['non-array disclosures', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures = {} }), /invalid rightsDisclosures/],
  ['null disclosures', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures = null }), /invalid rightsDisclosures/],
  ['one dropped disclosure', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures.pop() }), /disclosures incomplete/],
  ['duplicate disclosure with same count', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[1] = report.rightsDisclosures[0] }), /duplicate or out-of-scope/],
  ['extra disclosure', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures.push(report.rightsDisclosures[0]) }), /disclosures incomplete or extra/],
  ['out-of-scope disclosure', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[0].path = 'src/main.js' }), /duplicate or out-of-scope/],
  ['fake verified disclosure status', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[0].status = 'verified' }), /preserve original unverified/],
  ['fake cleared disclosure status', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[0].status = 'cleared' }), /preserve original unverified/],
  ['hidden reason in disclosure', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[0].reason = 'Verified safe' }), /preserve original unverified/],
  ['changed disclosure asset hash', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[0].sha256 = '0'.repeat(64) }), /preserve original unverified/],
  ['unrecognized disclosure verified flag', (files) => editSnapshotJson(files, REPORT, (report) => { report.rightsDisclosures[0].verified = true }), /unexpected or missing fields/],
  ['unrecognized decision verified flag', (files) => editDecisionBoth(files, (decision) => { decision.verified = true }), /unexpected or missing fields/],
  ['unknown decision type', (files) => editDecisionBoth(files, (decision) => { decision.type = 'rights-cleared' }), /invalid or unbound/],
  ['wrong decision id', (files) => editDecisionBoth(files, (decision) => { decision.decisionId = 'gaoge-1.7.2-2026-11-12' }), /invalid or unbound/],
  ['wrong decision release version', (files) => editDecisionBoth(files, (decision) => { decision.version = '1.7.2' }), /invalid or unbound/],
  ['wrong decision asset hash', (files) => editDecisionBoth(files, (decision) => { decision.sha256 = '0'.repeat(64) }), /invalid or unbound/],
  ['missing unknown acknowledgement', (files) => editDecisionBoth(files, (decision) => { delete decision.acknowledgesUnverifiedRights }), /unexpected or missing fields/],
  ['false unknown acknowledgement', (files) => editDecisionBoth(files, (decision) => { decision.acknowledgesUnverifiedRights = false }), /invalid or unbound/],
  ['string unknown acknowledgement', (files) => editDecisionBoth(files, (decision) => { decision.acknowledgesUnverifiedRights = 'true' }), /invalid or unbound/],
  ['missing decision evidence', (files) => editDecisionBoth(files, (decision) => { decision.evidence = [] }), /missing or extra owner publication evidence/],
  ['extra decision evidence', (files) => editDecisionBoth(files, (decision) => { decision.evidence.push(decision.evidence[0]) }), /missing or extra owner publication evidence/],
  ['different evidence path', (files) => editDecisionBoth(files, (decision) => { decision.evidence[0].path = 'README.md' }), /evidence hash or path mismatch/],
  ['different evidence hash', (files) => editDecisionBoth(files, (decision) => { decision.evidence[0].sha256 = '0'.repeat(64) }), /evidence hash or path mismatch/],
  ['evidence verified flag', (files) => editDecisionBoth(files, (decision) => { decision.evidence[0].verified = true }), /unexpected or missing fields/],
  ['audit/report decision disagreement', (files) => editSnapshotJson(files, RIGHTS_AUDIT, (audit) => { audit.items[0].releaseDecision.sha256 = '0'.repeat(64) }), /decisions differ/],
  ['missing audit', (files) => files.delete(RIGHTS_AUDIT), /missing rights audit/],
  ['missing scoped audit record', (files) => editSnapshotJson(files, RIGHTS_AUDIT, (audit) => { audit.items.pop() }), /scoped audit or decision missing/],
  ['duplicate audit record', (files) => editSnapshotJson(files, RIGHTS_AUDIT, (audit) => { audit.items.push(audit.items[0]) }), /duplicate rights audit/],
  ['all decision records removed from audit', (files) => editSnapshotJson(files, RIGHTS_AUDIT, (audit) => { for (const item of audit.items) delete item.releaseDecision }), /unresolved rights audit without valid publication decision/],
  ['removed scope asset', (files) => files.delete(evidenceScope.items[0].path), /scoped asset missing or changed/],
  ['changed original asset bytes hash', (files) => { files.get(evidenceScope.items[0].path).sha256 = '0'.repeat(64) }, /rights audit asset hash mismatch/],
  ['self-consistent substituted asset', (files) => {
    files.get(evidenceScope.items[0].path).sha256 = '0'.repeat(64)
    editOriginalBoth(files, 'sha256', '0'.repeat(64))
    editDecisionBoth(files, (decision) => { decision.sha256 = '0'.repeat(64) })
  }, /scoped asset missing or changed/],
  ['missing pinned evidence document', (files) => files.delete(OWNER_EVIDENCE), /evidence hash mismatch or missing evidence/],
  ['modified pinned evidence bytes', (files) => files.set(OWNER_EVIDENCE, sourceItem(Buffer.concat([evidenceBytes, Buffer.from('\nchanged')]))), /evidence hash mismatch or missing evidence/],
  ['forged evidence metadata with modified bytes', (files) => { files.get(OWNER_EVIDENCE).bytes = Buffer.from('forged scope'); files.get(OWNER_EVIDENCE).size = 12 }, /evidence hash mismatch or missing evidence/],
  ['fake cleared original audit and disclosure', (files) => editOriginalBoth(files, 'status', 'cleared'), /original unverified audit changed/],
  ['fake replaced-original audit and disclosure', (files) => editOriginalBoth(files, 'status', 'replaced-original'), /original unverified audit changed/],
  ['fake verified original audit and disclosure', (files) => editOriginalBoth(files, 'status', 'verified'), /unresolved rights audit without valid publication decision/],
  ['edited original unverified reason in both records', (files) => editOriginalBoth(files, 'reason', 'All rights checked and cleared'), /original unverified audit changed/],
  ['edited original provenance evidence', (files) => editSnapshotJson(files, RIGHTS_AUDIT, (audit) => { audit.items[0].evidence = [{ path: 'README.md', sha256: files.get('README.md').sha256 }] }), /original unverified audit changed/],
  ['unknown asset outside original decision scope', (files) => {
    const first = evidenceScope.items[0]
    files.set('src/assets/provider-logos/new-brand.svg', { size: 1, sha256: first.sha256 })
    editSnapshotJson(files, RIGHTS_AUDIT, (audit) => { audit.items.push({ ...structuredClone(audit.items[0]), path: 'src/assets/provider-logos/new-brand.svg' }) })
  }, /publication decision outside fixed scope/],
  ['additional unaudited rights asset', (files) => files.set('src/assets/provider-logos/new-brand.svg', { size: 1, sha256: '0'.repeat(64) }), /missing path-bound rights audit/],
  ['missing original provenance evidence', (files) => files.delete(evidenceScope.items.find((item) => item.evidence.length > 0).evidence[0]), /original provenance evidence missing/],
]
for (const [name, mutate, expected] of ownerMutationCases) {
  test(`rejects owner publication ${name} even with refreshed source metadata`, () => {
    const files = ownerPublicationSnapshot()
    mutate(files); rebuildSnapshotMetadata(files)
    assert.throws(() => validateSnapshot(files, new Set(), '1.7.1'), expected)
  })
}

test('rejects reusing the complete owner decision for a different manifest/report release', () => {
  const files = ownerPublicationSnapshot()
  editSnapshotJson(files, MANIFEST, (manifest) => { manifest.version = '1.7.2' })
  editSnapshotJson(files, REPORT, (report) => { report.version = '1.7.2' })
  assert.throws(() => validateSnapshot(files, new Set(), '1.7.2'), /does not apply to release version/)
})

test('archive reader preserves audit and pinned evidence bytes for independent rights validation', async () => {
  const bytes = new Map([...snapshot(), [RIGHTS_AUDIT, json({ schemaVersion: 1, items: [] })], [OWNER_EVIDENCE, evidenceBytes]])
  const { files } = await readSourceArchive(sourceZip(bytes), ROOT)
  assert.deepEqual(files.get(RIGHTS_AUDIT).bytes, bytes.get(RIGHTS_AUDIT))
  assert.deepEqual(files.get(OWNER_EVIDENCE).bytes, evidenceBytes)
  assert.equal(files.get(OWNER_EVIDENCE).sha256, OWNER_EVIDENCE_SHA256)
})

test('validates an empty declared audit end to end without requiring unknown disclosures', async (t) => {
  const files = snapshot()
  files.set(RIGHTS_AUDIT, json({ schemaVersion: 1, items: [] }))
  const actual = new Map([...files].map(([name, bytes]) => [name, sourceItem(bytes)]))
  rebuildSnapshotMetadata(actual)
  const snapshotBytes = new Map([...actual].map(([name, file]) => [name, file.bytes]))
  const directory = await localFixture(t, snapshotBytes)
  const verified = await verifyPublicSource(options(directory), fakeGitHub(sourceZip(snapshotBytes)))
  assert.equal(verified.verified, true)
})


for (const [label, changes, message] of [
  ['unsubstantiated cleared label', { status: 'cleared', evidence: [] }, /rights clearance lacks/],
  ['unsubstantiated original replacement', { status: 'replaced-original', evidence: [] }, /rights clearance lacks/],
  ['clearance without evidence', { status: 'cleared', reviewer: 'Synthetic reviewer', reviewDate: '2026-11-12', license: 'Synthetic fixture only', evidence: [] }, /rights clearance evidence missing/],
  ['unknown without owner decision', { status: 'provider-logo-review-pending', evidence: [] }, /without valid publication decision/],
]) {
  test(`rejects ${label} independently of a claimed passing report`, () => {
    const files = new Map([...snapshot()].map(([name, bytes]) => [name, sourceItem(bytes)]))
    const asset = 'src/assets/provider-logos/synthetic.svg', bytes = Buffer.from('<svg>Synthetic fixture</svg>')
    files.set(asset, sourceItem(bytes))
    files.set(RIGHTS_AUDIT, sourceItem(json({ schemaVersion: 1, items: [{ path: asset, sha256: hash(bytes), reason: 'Synthetic review fixture', ...changes }] })))
    rebuildSnapshotMetadata(files)
    assert.throws(() => validateSnapshot(files, new Set(), '1.7.1'), message)
  })
}


for (const annotated of [false, true]) {
  test(`build revision tag retains base-version audit and exact public bytes (${annotated ? 'annotated' : 'lightweight'})`, async (t) => {
    const tag = 'v1.7.1-build.2'
    const files = withSourceReleaseTag(snapshot(), tag), directory = await localFixture(t, files)
    const github = fakeGitHub(sourceZip(files), { annotated, tag })
    const result = await verifyPublicSource({ ...options(directory), tag }, github)
    assert.deepEqual(result, { verified: true, repository: REPOSITORY, tag, publicCommit: PUBLIC_COMMIT, sourceCommit: SOURCE_COMMIT, version: '1.7.1', fileCount: 5 })
    assert.equal(github.calls.filter(call => call.url.endsWith(`/git/ref/tags/${tag}`)).length, 2)
    assert.ok(!github.calls.some(call => call.url.endsWith(`/git/ref/tags/${TAG}`)))
  })
}

for (const tag of ['v1.7.1-build.0', 'v1.7.1-build.02', 'v1.7.1-build.-2', 'v1.7.1-build.2.1', 'v1.7.1-build.2-extra', 'v1.7.1-build.2\n', 'V1.7.1-build.2', 'v1.7.1-rc.2']) {
  test(`rejects malformed build revision ${JSON.stringify(tag)} before reading source or networking`, async () => {
    await assert.rejects(verifyPublicSource({ repository: REPOSITORY, tag, sourceDirectory: '/unused' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /tag must use vX.Y.Z/)
  })
}

test('a build revision cannot substitute a different base release version', async (t) => {
  const directory = await localFixture(t)
  await assert.rejects(verifyPublicSource({ ...options(directory), tag: 'v1.7.2-build.2' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /version/i)
})

test('build revision CLI preserves its exact immutable tag', () => {
  const sourceDirectory = path.resolve(os.tmpdir(), 'synthetic-source')
  assert.deepEqual(parseArguments(['--repository', REPOSITORY, '--tag=v1.7.1-build.2', `--source-directory=${sourceDirectory}`]), { ...options(sourceDirectory), tag: 'v1.7.1-build.2' })
})



async function ownerPublicationBytes() {
  const records = ownerPublicationSnapshot()
  for (const [name, item] of records) {
    if (item.bytes) continue
    const bytes = await readFile(new URL(`../${name}`, import.meta.url))
    assert.equal(hash(bytes), item.sha256, `real audited fixture must retain exact bytes: ${name}`)
    records.set(name, sourceItem(bytes))
  }
  rebuildSnapshotMetadata(records)
  return new Map([...records].map(([name, item]) => [name, item.bytes]))
}

test('build revision preserves all 50 exact owner disclosures and pinned evidence end to end', async (t) => {
  const tag = 'v1.7.1-build.2'
  const files = withSourceReleaseTag(await ownerPublicationBytes(), tag), directory = await localFixture(t, files)
  const github = fakeGitHub(sourceZip(files), { tag })
  const result = await verifyPublicSource({ ...options(directory), tag }, github)
  assert.equal(result.version, '1.7.1')
  assert.equal(result.tag, tag)
  assert.equal(result.fileCount, files.size)
  assert.equal(JSON.parse(files.get(REPORT)).rightsDisclosures.length, 50)
})

test('build revision still rejects modified pinned owner evidence even with refreshed file metadata', async (t) => {
  const files = ownerPublicationSnapshot()
  files.set(OWNER_EVIDENCE, sourceItem(Buffer.concat([evidenceBytes, Buffer.from('\nmodified')])))
  rebuildSnapshotMetadata(files)
  assert.throws(() => validateSnapshot(files, new Set(), '1.7.1'), /evidence hash mismatch/)
  const bytes = withSourceReleaseTag(await ownerPublicationBytes(), 'v1.7.1-build.2')
  bytes.set(OWNER_EVIDENCE, Buffer.concat([evidenceBytes, Buffer.from('\nmodified')]))
  const directory = await localFixture(t, bytes)
  await assert.rejects(verifyPublicSource({ ...options(directory), tag: 'v1.7.1-build.2' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /evidence|mismatch/i)
})


for (const declared of [undefined, 'v1.7.1', 'v1.7.1-build.3', 'v1.7.2-build.2', '', null, 2]) {
  test(`build revision rejects missing or mismatched package sourceReleaseTag ${JSON.stringify(declared)}`, async (t) => {
    const files = withSourceReleaseTag(snapshot(), declared), directory = await localFixture(t, files)
    await assert.rejects(verifyPublicSource({ ...options(directory), tag: 'v1.7.1-build.2' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /sourceReleaseTag/)
  })
}

test('build revision cannot use a package-free legacy snapshot', async (t) => {
  const directory = await localFixture(t)
  await assert.rejects(verifyPublicSource({ ...options(directory), tag: 'v1.7.1-build.2' }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /sourceReleaseTag/)
})

for (const declared of [undefined, TAG]) {
  test(`legacy base tag permits ${declared === undefined ? 'absent' : 'matching'} package sourceReleaseTag`, async (t) => {
    const files = withSourceReleaseTag(snapshot(), declared), directory = await localFixture(t, files)
    const result = await verifyPublicSource(options(directory), fakeGitHub(sourceZip(files)))
    assert.equal(result.version, '1.7.1')
    assert.equal(result.tag, TAG)
  })
}

test('legacy base tag cannot claim another release source tag', async (t) => {
  const files = withSourceReleaseTag(snapshot(), 'v1.7.1-build.2'), directory = await localFixture(t, files)
  await assert.rejects(verifyPublicSource(options(directory), { fetchImpl: async () => assert.fail('unexpected fetch') }), /sourceReleaseTag/)
})

test('source-release metadata never bypasses package version consistency', async (t) => {
  const tag = 'v1.7.1-build.2'
  const files = withSourceReleaseTag(snapshot(), tag, '1.7.2'), directory = await localFixture(t, files)
  await assert.rejects(verifyPublicSource({ ...options(directory), tag }, { fetchImpl: async () => assert.fail('unexpected fetch') }), /package version/)
})

test('the installed source and license links reference the immutable package release tag', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const component = await readFile(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
  assert.equal(metadata.version, '1.7.1')
  assert.equal(metadata.sourceReleaseTag, 'v1.7.1-build.2')
  assert.ok(component.includes('const releaseSourceUrl = `https://github.com/KKK-898/desktop-source-archive/tree/${packageMetadata.sourceReleaseTag}`'))
  assert.ok(component.includes('const releaseLicenseUrl = `https://github.com/KKK-898/desktop-source-archive/blob/${packageMetadata.sourceReleaseTag}/LICENSE`'))
  assert.ok(!component.includes('/tree/v${packageMetadata.version}'))
  assert.ok(!component.includes('/blob/v${packageMetadata.version}/LICENSE'))
})
