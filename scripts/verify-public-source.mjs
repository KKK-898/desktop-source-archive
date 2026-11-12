import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import yauzl from 'yauzl'

const MANIFEST = 'SOURCE_MANIFEST.json'
const REPORT = 'SOURCE_EXPORT_REPORT.json'
const METADATA = new Set([MANIFEST, REPORT])
const RIGHTS_AUDIT = 'scripts/public-source-audit.json'
const OWNER_EVIDENCE = 'scripts/public-source-docs/owner-release-decision-1.7.1.md'
const OWNER_EVIDENCE_SHA256 = 'a95d09b14f963a65fe2a07e6cd3929a85c83a10185fc7afda4538f2b94f05704'
const OWNER_DECISION_ID = 'gaoge-1.7.1-2026-11-12'
const OWNER_VERSION = '1.7.1'
const BUFFERED_FILES = new Set([...METADATA, RIGHTS_AUDIT, OWNER_EVIDENCE, 'package.json'])
const UNVERIFIED_STATUSES = new Set([
  'unverified-language-pack', 'unverified-embedded-proprietary-native-query',
  'unverified-proprietary-native-code', 'unverified-customer-logo-permission',
  'provider-logo-review-pending', 'unverified-third-party-artwork',
  'declared-original-art-review-pending', 'qq-artwork-rights-review-required',
])
const RIGHTS_PATH = /^(?:resources\/codex-locales\/|theme-resources\/(?:sources|vendor\/codex-qq-2007-assets)\/|src\/assets\/(?:customer-logos|provider-logos)\/|scripts\/fixtures\/codex-(?:ultra-query-[^/]+|aggregate-selection-26\.1103|model-filter-26\.(?:1007|901)|service-tier-gate-26\.915)\.js$|scripts\/codex-plugin-patch\.cjs$)/u
const SHA256 = /^[a-f0-9]{64}$/
const GIT_SHA = /^[a-f0-9]{40}$/
const MAX_ARCHIVE = 256 * 1024 * 1024
const MAX_TOTAL = 512 * 1024 * 1024
const MAX_FILE = 128 * 1024 * 1024
const MAX_FILES = 50_000

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}

function portablePath(value) {
  requireThat(typeof value === 'string' && value.length > 0, 'Empty or non-string source path')
  requireThat(!/[\\\x00-\x1f\x7f<>:"|?*]/u.test(value), `Unsafe source path: ${value}`)
  const segments = value.split('/')
  requireThat(segments.every((part) => part && part !== '.' && part !== '..'
    && part.toLowerCase() !== '.git' && !/[. ]$/u.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)), `Unsafe source path: ${value}`)
  return value
}

function portableKey(value) {
  return value.normalize('NFC').toLowerCase()
}

function expectedDirectories(files) {
  const result = new Set()
  for (const name of files.keys()) {
    const segments = name.split('/')
    for (let count = 1; count < segments.length; count += 1) result.add(segments.slice(0, count).join('/'))
  }
  return result
}

function parseJson(item, label) {
  requireThat(item?.bytes, `Missing ${label}`)
  requireThat(item.size <= 16 * 1024 * 1024, `${label} exceeds metadata size limit`)
  try { return JSON.parse(item.bytes.toString('utf8').replace(/^\uFEFF/u, '')) }
  catch (error) { throw new Error(`Invalid ${label}: ${error.message}`) }
}

function exactKeys(value, names, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort()), `${label}: unexpected or missing fields`)
}

// An owner instruction is a bounded publication decision, never proof of third-party rights.
// Keep the unresolved findings visible and bind every retained asset to the original record.
function validateRightsDisclosures(files, report, version, label) {
  const disclosures = report.rightsDisclosures === undefined ? [] : report.rightsDisclosures
  requireThat(Array.isArray(disclosures), `${label}: invalid rightsDisclosures`)
  const hasRightsAssets = [...files.keys()].some((name) => RIGHTS_PATH.test(name))
  const auditFile = files.get(RIGHTS_AUDIT)
  if (!auditFile) {
    requireThat(!hasRightsAssets && disclosures.length === 0, `${label}: missing rights audit for retained assets or disclosures`)
    return
  }
  const audit = parseJson(auditFile, `${label}/${RIGHTS_AUDIT}`)
  requireThat(audit?.schemaVersion === 1 && Array.isArray(audit.items), `${label}: invalid rights audit schema`)
  const auditEntries = new Map(), auditKeys = new Set()
  for (const item of audit.items) {
    requireThat(item && typeof item === 'object' && !Array.isArray(item), `${label}: invalid rights audit item`)
    const name = portablePath(item.path), key = portableKey(name)
    requireThat(!auditKeys.has(key), `${label}: duplicate rights audit path: ${name}`)
    auditKeys.add(key); auditEntries.set(name, item)
    if (!files.has(name)) continue
    requireThat(SHA256.test(item.sha256 || '') && files.get(name).sha256 === item.sha256, `${label}: rights audit asset hash mismatch: ${name}`)
    requireThat(typeof item.reason === 'string' && item.reason.trim(), `${label}: missing rights audit reason: ${name}`)
    if (!['cleared', 'replaced-original'].includes(item.status)) {
      requireThat(UNVERIFIED_STATUSES.has(item.status) && Object.hasOwn(item, 'releaseDecision'), `${label}: unresolved rights audit without valid publication decision: ${name}`)
    } else if (!Object.hasOwn(item, 'releaseDecision')) {
      requireThat(['reviewer', 'reviewDate', 'license'].every((key) => typeof item[key] === 'string' && item[key].trim()),
        `${label}: rights clearance lacks reviewer, date or license: ${name}`)
      requireThat(Array.isArray(item.evidence) && item.evidence.length > 0
        && item.evidence.every((entry) => typeof entry === 'string' && files.has(entry)), `${label}: rights clearance evidence missing from source: ${name}`)
    }
  }
  const hasDecision = audit.items.some((item) => Object.hasOwn(item, 'releaseDecision'))
  const active = disclosures.length > 0 || hasDecision || (files.has(OWNER_EVIDENCE) && hasRightsAssets)
  if (!active) {
    for (const name of files.keys()) requireThat(!RIGHTS_PATH.test(name) || auditEntries.has(name), `${label}: missing path-bound rights audit: ${name}`)
    return
  }
  requireThat(version === OWNER_VERSION, `${label}: owner publication decision does not apply to release version`)
  const evidenceFile = files.get(OWNER_EVIDENCE)
  requireThat(evidenceFile?.bytes && evidenceFile.sha256 === OWNER_EVIDENCE_SHA256
    && createHash('sha256').update(evidenceFile.bytes).digest('hex') === OWNER_EVIDENCE_SHA256, `${label}: owner publication evidence hash mismatch or missing evidence`)
  const blocks = [...evidenceFile.bytes.toString('utf8').matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gu)]
  requireThat(blocks.length === 1, `${label}: invalid owner publication scope block`)
  let scope
  try { scope = JSON.parse(blocks[0][1]) } catch { throw new Error(`${label}: invalid owner publication scope JSON`) }
  exactKeys(scope, ['decisionId', 'version', 'items'], `${label}: owner publication scope`)
  requireThat(scope.decisionId === OWNER_DECISION_ID && scope.version === OWNER_VERSION
    && Array.isArray(scope.items) && scope.items.length === 50, `${label}: invalid owner publication scope identity`)
  const scoped = new Map(), scopeKeys = new Set()
  for (const item of scope.items) {
    const name = portablePath(item.path), key = portableKey(name)
    requireThat(!scopeKeys.has(key) && UNVERIFIED_STATUSES.has(item.status) && SHA256.test(item.sha256 || ''), `${label}: invalid owner publication scope item`)
    scopeKeys.add(key); scoped.set(name, item)
    const actual = files.get(name), audited = auditEntries.get(name)
    requireThat(actual && actual.sha256 === item.sha256, `${label}: owner publication scoped asset missing or changed: ${name}`)
    requireThat(audited && Object.hasOwn(audited, 'releaseDecision'), `${label}: owner publication scoped audit or decision missing: ${name}`)
    const original = { ...audited }; delete original.releaseDecision
    requireThat(isDeepStrictEqual(original, item), `${label}: owner publication original unverified audit changed: ${name}`)
    requireThat(Array.isArray(item.evidence) && item.evidence.every((entry) => typeof entry === 'string' && files.has(entry)),
      `${label}: original provenance evidence missing from source: ${name}`)
  }
  for (const [name, audited] of auditEntries) {
    if (Object.hasOwn(audited, 'releaseDecision')) requireThat(scoped.has(name), `${label}: publication decision outside fixed scope: ${name}`)
  }
  const seen = new Set()
  requireThat(disclosures.length === scoped.size, `${label}: owner publication disclosures incomplete or extra`)
  for (const disclosure of disclosures) {
    exactKeys(disclosure, ['path', 'status', 'reason', 'sha256', 'releaseDecision'], `${label}: rights disclosure`)
    const name = portablePath(disclosure.path), scopedItem = scoped.get(name), audited = auditEntries.get(name)
    requireThat(!seen.has(name) && scopedItem, `${label}: duplicate or out-of-scope rights disclosure: ${name}`)
    seen.add(name)
    requireThat(disclosure.status === scopedItem.status && disclosure.reason === scopedItem.reason
      && disclosure.sha256 === scopedItem.sha256, `${label}: rights disclosure must preserve original unverified status, reason and hash: ${name}`)
    const decision = disclosure.releaseDecision
    exactKeys(decision, ['type', 'decisionId', 'version', 'sha256', 'evidence', 'acknowledgesUnverifiedRights'], `${label}: releaseDecision`)
    requireThat(decision.type === 'owner-directed-publication' && decision.decisionId === OWNER_DECISION_ID
      && decision.version === OWNER_VERSION && decision.sha256 === scopedItem.sha256
      && decision.acknowledgesUnverifiedRights === true, `${label}: invalid or unbound owner publication decision: ${name}`)
    requireThat(Array.isArray(decision.evidence) && decision.evidence.length === 1, `${label}: missing or extra owner publication evidence: ${name}`)
    exactKeys(decision.evidence[0], ['path', 'sha256'], `${label}: publication evidence`)
    requireThat(decision.evidence[0].path === OWNER_EVIDENCE && decision.evidence[0].sha256 === OWNER_EVIDENCE_SHA256,
      `${label}: owner publication evidence hash or path mismatch: ${name}`)
    requireThat(isDeepStrictEqual(audited.releaseDecision, decision), `${label}: audit and disclosure publication decisions differ: ${name}`)
  }
  for (const name of files.keys()) requireThat(!RIGHTS_PATH.test(name) || auditEntries.has(name), `${label}: missing path-bound rights audit: ${name}`)
}

export function validateSnapshot(files, directories, version, label = 'snapshot') {
  requireThat(files instanceof Map && files.size >= 3, `${label}: source files are missing`)
  const manifest = parseJson(files.get(MANIFEST), `${label}/${MANIFEST}`)
  const report = parseJson(files.get(REPORT), `${label}/${REPORT}`)
  for (const [name, metadata] of [[MANIFEST, manifest], [REPORT, report]]) {
    requireThat(metadata?.schemaVersion === 1, `${label}/${name}: unsupported schemaVersion`)
    requireThat(metadata.version === version, `${label}/${name}: version does not match tag`)
    requireThat(GIT_SHA.test(metadata.sourceCommit || '') && GIT_SHA.test(metadata.sourceTree || ''), `${label}/${name}: invalid source commit or tree`)
  }
  requireThat(report.sourceCommit === manifest.sourceCommit && report.sourceTree === manifest.sourceTree,
    `${label}: report and manifest source identity differ`)
  requireThat(report.releaseReady === true && report.sourceMode === 'git-ref', `${label}: export is not release-ready git-ref source`)
  requireThat(Array.isArray(report.checks) && report.checks.length > 0 && report.checks.every((check) => check?.ok === true), `${label}: export checks are incomplete or failing`)
  requireThat(Array.isArray(report.rightsFindings) && report.rightsFindings.length === 0, `${label}: unresolved rights findings`)
  requireThat(SHA256.test(report.filesDigest || ''), `${label}: invalid filesDigest`)
  requireThat(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, `${label}: invalid manifest files`)
  const expected = new Map()
  const keys = new Set()
  for (const entry of manifest.files) {
    requireThat(entry && typeof entry === 'object', `${label}: invalid manifest entry`)
    const name = portablePath(entry.path)
    requireThat(!METADATA.has(name), `${label}: manifest must not list metadata files`)
    const key = portableKey(name)
    requireThat(!keys.has(key), `${label}: duplicate manifest path: ${name}`)
    keys.add(key)
    requireThat(SHA256.test(entry.sha256 || '') && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_FILE,
      `${label}: invalid size or SHA256 for ${name}`)
    expected.set(name, entry)
  }
  const digest = createHash('sha256').update(manifest.files.map((entry) => `${entry.sha256}  ${entry.size}  ${entry.path}\n`).join(''), 'utf8').digest('hex')
  requireThat(report.filesDigest === digest, `${label}: filesDigest mismatch`)
  requireThat(files.size === expected.size + METADATA.size, `${label}: extra or missing source files`)
  for (const [name, actual] of files) {
    portablePath(name)
    if (METADATA.has(name)) continue
    const entry = expected.get(name)
    requireThat(entry, `${label}: undeclared source file: ${name}`)
    requireThat(actual.size === entry.size && actual.sha256 === entry.sha256, `${label}: source content mismatch: ${name}`)
  }
  validateRightsDisclosures(files, report, version, label)
  const allowedDirectories = expectedDirectories(files)
  for (const directory of directories) requireThat(allowedDirectories.has(directory), `${label}: extra directory: ${directory}`)
  return { manifest, report }
}

async function readLocalSnapshot(sourceDirectory) {
  requireThat(typeof sourceDirectory === 'string' && path.isAbsolute(sourceDirectory), 'source-directory must be absolute')
  const root = await lstat(sourceDirectory)
  requireThat(root.isDirectory() && !root.isSymbolicLink(), 'source-directory must be a real directory, not a symlink')
  const files = new Map(), directories = new Set(), seen = new Set()
  let total = 0
  async function walk(relative = '') {
    const entries = await readdir(path.join(sourceDirectory, relative), { withFileTypes: true })
    for (const entry of entries) {
      const name = portablePath(relative ? `${relative}/${entry.name}` : entry.name)
      const key = portableKey(name)
      requireThat(!seen.has(key), `Local snapshot has duplicate/colliding path: ${name}`)
      seen.add(key)
      requireThat(seen.size <= MAX_FILES * 2, 'Local snapshot has too many entries')
      const fullPath = path.join(sourceDirectory, ...name.split('/'))
      const stat = await lstat(fullPath)
      requireThat(!stat.isSymbolicLink(), `Local symlinks are not allowed: ${name}`)
      if (stat.isDirectory()) { directories.add(name); await walk(name); continue }
      requireThat(stat.isFile(), `Local special files are not allowed: ${name}`)
      requireThat(stat.size <= MAX_FILE, `Local source file is too large: ${name}`)
      const hash = createHash('sha256'), chunks = []
      let size = 0
      for await (const chunk of createReadStream(fullPath)) {
        size += chunk.length
        total += chunk.length
        requireThat(size <= MAX_FILE && total <= MAX_TOTAL, 'Local source exceeds size limit')
        hash.update(chunk)
        if (BUFFERED_FILES.has(name)) chunks.push(chunk)
      }
      requireThat(size === stat.size, `Local source changed while reading: ${name}`)
      files.set(name, { size, sha256: hash.digest('hex'), ...(BUFFERED_FILES.has(name) ? { bytes: Buffer.concat(chunks) } : {}) })
      requireThat(files.size <= MAX_FILES, 'Local snapshot has too many files')
    }
  }
  await walk()
  return { files, directories }
}

export function readSourceArchive(buffer, rootName) {
  requireThat(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= MAX_ARCHIVE, 'Invalid public source archive size')
  portablePath(rootName)
  requireThat(!rootName.includes('/'), 'Invalid archive root name')
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) { reject(openError); return }
      const files = new Map(), directories = new Set(), seen = new Set()
      let failed = false, total = 0, entries = 0
      function fail(error) { if (!failed) { failed = true; zip.close(); reject(error) } }
      zip.on('error', fail)
      zip.on('entry', (entry) => {
        try {
          requireThat(++entries <= MAX_FILES * 2, 'Public archive has too many entries')
          requireThat(!(entry.generalPurposeBitFlag & 1), 'Encrypted public archive entries are not allowed')
          const isDirectory = entry.fileName.endsWith('/')
          const rawName = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName
          portablePath(rawName)
          requireThat(rawName === rootName || rawName.startsWith(`${rootName}/`), 'Public archive has an unexpected root')
          requireThat(rawName !== rootName || isDirectory, 'Archive root must be a directory')
          const key = portableKey(rawName)
          requireThat(!seen.has(key), `Duplicate archive entry: ${rawName}`)
          seen.add(key)
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000
          requireThat(mode === 0 || mode === (isDirectory ? 0x4000 : 0x8000), `Archive symlink or special entry: ${rawName}`)
          const name = rawName === rootName ? '' : rawName.slice(rootName.length + 1)
          if (isDirectory) {
            requireThat(entry.uncompressedSize === 0, `Archive directory has data: ${rawName}`)
            if (name) directories.add(name)
            zip.readEntry()
            return
          }
          requireThat(name && entry.uncompressedSize <= MAX_FILE, `Archive file is too large: ${rawName}`)
          requireThat(entry.compressionMethod === 0 || entry.compressionMethod === 8, 'Unsupported archive compression')
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) { fail(streamError); return }
            const hash = createHash('sha256'), chunks = []
            let size = 0
            stream.on('error', fail)
            stream.on('data', (chunk) => {
              if (failed) return
              size += chunk.length
              total += chunk.length
              if (size > MAX_FILE || total > MAX_TOTAL) { stream.destroy(new Error('Public source exceeds size limit')); return }
              hash.update(chunk)
              if (BUFFERED_FILES.has(name)) chunks.push(chunk)
            })
            stream.on('end', () => {
              if (failed) return
              if (size !== entry.uncompressedSize) { fail(new Error(`Archive size mismatch: ${name}`)); return }
              files.set(name, { size, sha256: hash.digest('hex'), ...(BUFFERED_FILES.has(name) ? { bytes: Buffer.concat(chunks) } : {}) })
              if (files.size > MAX_FILES) { fail(new Error('Public archive has too many files')); return }
              zip.readEntry()
            })
          })
        } catch (error) { fail(error) }
      })
      zip.on('end', () => { if (!failed) resolve({ files, directories }) })
      zip.readEntry()
    })
  })
}

async function anonymousRequest(fetchImpl, url, maxBytes) {
  const parsed = new URL(url)
  requireThat(parsed.protocol === 'https:' && ['api.github.com', 'codeload.github.com'].includes(parsed.hostname)
    && !parsed.username && !parsed.password && !parsed.port, 'Only fixed HTTPS GitHub endpoints are allowed')
  const response = await fetchImpl(url, {
    method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(90_000),
    headers: { Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/zip', 'User-Agent': 'Gaoge-Public-Source-Verifier', 'X-GitHub-Api-Version': '2022-11-28' },
  })
  requireThat(response?.ok && response.status === 200, `Public source request failed: ${parsed.pathname} (HTTP ${response?.status ?? 'unknown'})`)
  requireThat(!response.redirected && (!response.url || response.url === url), 'Unexpected public source redirect')
  const length = response.headers?.get('content-length')
  requireThat(!length || (/^\d+$/.test(length) && Number(length) <= maxBytes), 'Public response exceeds size limit')
  requireThat(response.body && typeof response.body.getReader === 'function', 'Missing public response body')
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      requireThat(size <= maxBytes, 'Public response exceeds size limit')
      chunks.push(Buffer.from(value))
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}

async function apiJson(fetchImpl, url) {
  const bytes = await anonymousRequest(fetchImpl, url, 4 * 1024 * 1024)
  try { return JSON.parse(bytes.toString('utf8')) }
  catch { throw new Error(`Invalid public GitHub JSON: ${new URL(url).pathname}`) }
}

async function resolveTag(fetchImpl, repository, tag) {
  const base = `https://api.github.com/repos/${repository}`
  const ref = await apiJson(fetchImpl, `${base}/git/ref/tags/${encodeURIComponent(tag)}`)
  requireThat(ref.ref === `refs/tags/${tag}`, 'GitHub tag response does not match requested tag')
  const initial = ref.object
  let object = initial
  const visited = new Set()
  for (let depth = 0; depth < 8; depth += 1) {
    requireThat(GIT_SHA.test(object?.sha || ''), 'Invalid GitHub tag object SHA')
    requireThat(!visited.has(object.sha), 'Cyclic annotated GitHub tag')
    visited.add(object.sha)
    if (object.type === 'commit') return { commit: object.sha, refSha: initial.sha, refType: initial.type }
    requireThat(object.type === 'tag', 'GitHub tag does not reference a commit')
    const annotated = await apiJson(fetchImpl, `${base}/git/tags/${object.sha}`)
    requireThat(annotated.sha === object.sha, 'Annotated tag SHA does not match request')
    object = annotated.object
  }
  throw new Error('Too many nested annotated tags')
}

function equalFiles(left, right, label) {
  requireThat(left.size === right.size, `${label}: extra or missing files`)
  for (const [name, actual] of left) {
    const expected = right.get(name)
    requireThat(expected && expected.size === actual.size && expected.sha256 === actual.sha256, `${label}: file differs: ${name}`)
    if (METADATA.has(name)) requireThat(actual.bytes.equals(expected.bytes), `${label}: metadata bytes differ: ${name}`)
  }
}

function validateSourceReleaseTag(files, tag, version, label) {
  const item = files.get('package.json')
  const buildRevision = tag !== `v${version}`
  requireThat(item || !buildRevision, `${label}: build revision requires package.json sourceReleaseTag`)
  if (!item) return // Legacy base tags may predate release-source metadata.
  const metadata = parseJson(item, `${label} package.json`)
  requireThat(metadata && typeof metadata === 'object' && !Array.isArray(metadata), `${label}: invalid package.json`)
  requireThat(metadata.version === version, `${label}: package version does not match release tag`)
  if (!Object.hasOwn(metadata, 'sourceReleaseTag')) {
    requireThat(!buildRevision, `${label}: build revision requires package.json sourceReleaseTag`)
    return
  }
  requireThat(typeof metadata.sourceReleaseTag === 'string' && metadata.sourceReleaseTag === tag, `${label}: package sourceReleaseTag does not match selected release tag`)
}

export async function verifyPublicSource({ repository, tag, sourceDirectory }, { fetchImpl = globalThis.fetch } = {}) {
  requireThat(typeof repository === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)
    && !repository.endsWith('.git') && !repository.includes('..'), 'repository must be a GitHub owner/repository, not a URL')
  const releaseTag = typeof tag === 'string' && /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-build\.[1-9]\d*)?$/.exec(tag)
  requireThat(releaseTag && releaseTag[0] === tag, 'tag must use vX.Y.Z or vX.Y.Z-build.N format, where N is a positive integer')
  const version = releaseTag[1]
  const local = await readLocalSnapshot(sourceDirectory)
  const { manifest } = validateSnapshot(local.files, local.directories, version, 'local')
  validateSourceReleaseTag(local.files, tag, version, 'local')
  const info = await apiJson(fetchImpl, `https://api.github.com/repos/${repository}`)
  requireThat(info?.private === false && info.visibility === 'public', 'GitHub source repository is not explicitly public')
  requireThat(typeof info.full_name === 'string' && info.full_name.toLowerCase() === repository.toLowerCase()
    && typeof info.name === 'string' && info.name.toLowerCase() === repository.split('/')[1].toLowerCase(), 'GitHub repository identity mismatch')
  const pinned = await resolveTag(fetchImpl, repository, tag)
  const archive = await anonymousRequest(fetchImpl, `https://codeload.github.com/${repository}/zip/${pinned.commit}`, MAX_ARCHIVE)
  const remote = await readSourceArchive(archive, `${info.name}-${pinned.commit}`)
  validateSnapshot(remote.files, remote.directories, version, 'public')
  validateSourceReleaseTag(remote.files, tag, version, 'public')
  equalFiles(local.files, remote.files, 'Public source and local snapshot')
  const unchanged = await resolveTag(fetchImpl, repository, tag)
  requireThat(unchanged.commit === pinned.commit && unchanged.refSha === pinned.refSha && unchanged.refType === pinned.refType, 'Public tag changed during verification')
  const finalLocal = await readLocalSnapshot(sourceDirectory)
  validateSnapshot(finalLocal.files, finalLocal.directories, version, 'local recheck')
  validateSourceReleaseTag(finalLocal.files, tag, version, 'local recheck')
  equalFiles(local.files, finalLocal.files, 'Local snapshot changed during verification')
  return { verified: true, repository: info.full_name, tag, publicCommit: pinned.commit, sourceCommit: manifest.sourceCommit, version, fileCount: remote.files.size }
}

export function parseArguments(args) {
  const options = {}
  const names = { '--repository': 'repository', '--tag': 'tag', '--source-directory': 'sourceDirectory' }
  for (let index = 0; index < args.length; index += 1) {
    const [flag, ...inline] = args[index].split('=')
    requireThat(Object.hasOwn(names, flag), `Unknown argument: ${flag}`)
    const name = names[flag]
    requireThat(!Object.hasOwn(options, name), `Duplicate argument: ${flag}`)
    const value = inline.length ? inline.join('=') : args[++index]
    requireThat(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `Missing value for ${flag}`)
    options[name] = value
  }
  for (const [flag, name] of Object.entries(names)) requireThat(Object.hasOwn(options, name), `Missing ${flag}`)
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(() => verifyPublicSource(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`Public source verification failed: ${error.message}\n`); process.exitCode = 1 })
}
