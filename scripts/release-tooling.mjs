import { pathToFileURL } from 'node:url'

const PLATFORM_SEGMENT = {
  windows: 'win',
  darwin: 'mac',
  linux: 'linux',
}

export function normalizeReleaseVersion(value, label = 'version') {
  const version = String(value || '').trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${label} must use x.y.z format: ${value}`)
  }
  return version
}

export function compareVersions(left, right) {
  const a = normalizeReleaseVersion(left).split('.').map(Number)
  const b = normalizeReleaseVersion(right).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function requiredString(value, label) {
  const text = String(value || '').trim()
  if (!text) throw new Error(`Missing ${label}`)
  return text
}

function validateHttpsUrl(value, label) {
  const text = requiredString(value, label).replace(/\/+$/, '')
  const parsed = new URL(text)
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`)
  return text
}

function optionalIdentityFile(value, label) {
  const text = String(value || '').trim()
  if (/[\0\r\n"]/u.test(text)) throw new Error(`${label} contains invalid characters`)
  return text
}

function containsSecretKey(value) {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) => {
    if (/password|private.?key|token|secret/i.test(key)) return true
    return containsSecretKey(child)
  })
}

export function validateReleaseConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('Release config must be an object')
  if (containsSecretKey(input)) throw new Error('Release config must not contain passwords, tokens, private keys, or secrets')

  const bootstrapConfigUrls = [...new Set((input.bootstrapConfigUrls || []).map((value, index) => (
    validateHttpsUrl(value, `bootstrapConfigUrls[${index}]`)
  )))]
  if (!bootstrapConfigUrls.length) throw new Error('At least one bootstrapConfigUrl is required')

  const sshHosts = input.sshHosts && typeof input.sshHosts === 'object' ? input.sshHosts : {}
  const normalizedHosts = Object.fromEntries(Object.entries(sshHosts).map(([id, host]) => {
    const port = Number(host?.port || 22)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SSH port for ${id}`)
    return [requiredString(id, 'ssh host id'), {
      host: requiredString(host?.host, `sshHosts.${id}.host`),
      port,
      user: requiredString(host?.user, `sshHosts.${id}.user`),
      identityFile: optionalIdentityFile(host?.identityFile, `sshHosts.${id}.identityFile`),
    }]
  }))
  if (!Object.keys(normalizedHosts).length) throw new Error('At least one sshHost is required')

  const mirrorIds = new Set()
  const updateMirrors = (input.updateMirrors || []).map((mirror, index) => {
    const id = requiredString(mirror?.id, `updateMirrors[${index}].id`)
    if (mirrorIds.has(id)) throw new Error(`Duplicate update mirror id: ${id}`)
    mirrorIds.add(id)
    const sshHost = requiredString(mirror?.sshHost, `updateMirrors[${index}].sshHost`)
    if (!normalizedHosts[sshHost]) throw new Error(`Unknown sshHost ${sshHost} for mirror ${id}`)
    const remoteRoot = requiredString(mirror?.remoteRoot, `updateMirrors[${index}].remoteRoot`)
    if (!remoteRoot.startsWith('/')) throw new Error(`remoteRoot must be absolute for mirror ${id}`)
    return {
      id,
      sshHost,
      publicBaseUrl: validateHttpsUrl(mirror?.publicBaseUrl, `updateMirrors[${index}].publicBaseUrl`),
      remoteRoot: remoteRoot.replace(/\/+$/, ''),
    }
  })
  if (!updateMirrors.length) throw new Error('At least one updateMirror is required')

  return {
    bootstrapConfigUrls,
    buildRepo: requiredString(input.buildRepo, 'buildRepo'),
    buildBranch: requiredString(input.buildBranch || 'master', 'buildBranch'),
    sourceBranch: requiredString(input.sourceBranch || 'main', 'sourceBranch'),
    sshHosts: normalizedHosts,
    updateMirrors,
  }
}

function normalizedOverrides(value) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(Object.entries(source)
    .filter(([, child]) => child !== undefined && child !== null && String(child).trim() !== '')
    .sort(([left], [right]) => left.localeCompare(right)))
}

export function canonicalServerDirectory(payload) {
  const source = payload && typeof payload === 'object' && payload.data ? payload.data : payload
  if (!source || typeof source !== 'object' || !Array.isArray(source.servers) || source.servers.length === 0) {
    throw new Error('Runtime server directory has no servers')
  }
  return JSON.stringify({
    version: Number(source.version || 1),
    defaultServerId: String(source.defaultServerId || source.default_server_id || ''),
    servers: source.servers.map((server) => ({
      id: String(server.id || ''),
      name: String(server.name || server.title || ''),
      rootDomain: String(server.rootDomain || server.root_domain || ''),
      enabled: server.enabled !== false,
      sort: Number(server.sort || 0),
      overrides: normalizedOverrides(server.overrides),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  })
}

export function buildMirrorManifest(manifest, publicBaseUrl, minimumVersion) {
  const base = validateHttpsUrl(publicBaseUrl, 'publicBaseUrl')
  const version = normalizeReleaseVersion(manifest?.version, 'manifest.version')
  const minimum = normalizeReleaseVersion(minimumVersion || manifest?.minimumVersion || '0.0.0', 'minimumVersion')
  if (compareVersions(minimum, version) > 0) throw new Error('minimumVersion cannot be newer than release version')
  const platforms = {}
  for (const [key, entry] of Object.entries(manifest?.platforms || {})) {
    const family = key.split('-')[0]
    const segment = PLATFORM_SEGMENT[family]
    if (!segment) throw new Error(`Unsupported manifest platform key: ${key}`)
    const signature = requiredString(entry?.signature, `platforms.${key}.signature`)
    const fileName = decodeURIComponent(new URL(requiredString(entry?.url, `platforms.${key}.url`)).pathname.split('/').pop())
    platforms[key] = {
      signature,
      url: `${base}/${segment}/${encodeURIComponent(fileName).replace(/%2F/gi, '/')}`,
    }
  }
  if (!Object.keys(platforms).length) throw new Error('Manifest has no platforms')
  return {
    ...manifest,
    version,
    minimumVersion: minimum,
    platforms,
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stderr.write('release-tooling.mjs is a library; use one-click-release.ps1 for publishing.\n')
  process.exitCode = 1
}
