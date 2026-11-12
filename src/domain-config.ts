export type RuntimeDomainRole = 'main' | 'backup' | 'temporary'
export type RuntimeDomainScope = 'api' | 'software' | 'admin' | 'image' | 'codex' | 'pay'
export type RuntimeConfigSource = 'remote' | 'cache' | 'builtin'
export type RuntimeServerHealthStatus = 'idle' | 'testing' | 'ok' | 'failed'
export type RuntimeServerLoadLevel = 'smooth' | 'normal' | 'congested' | 'busy' | 'unknown'

export interface RuntimeDomainEndpoint {
  url: string
  enabled: boolean
  note?: string
}

export interface RuntimeDomainItem {
  id: string
  scope: RuntimeDomainScope
  title: string
  name: string
  description?: string
  healthPath?: string
  routeHint?: string
  activeRole: RuntimeDomainRole
  activeUrl: string
  endpoints: Record<RuntimeDomainRole, RuntimeDomainEndpoint>
}

export interface DesktopServerOverrides {
  apiOrigin?: string
  softwareAdminOrigin?: string
  softwareOrigin?: string
  imageOrigin?: string
  payOrigin?: string
  codexOrigin?: string
  openaiBaseUrl?: string
  anthropicBaseUrl?: string
  claudeBaseUrl?: string
  updateBaseUrl?: string
  downloadBaseUrl?: string
  tutorialVideoBaseUrl?: string
  webEntryUrl?: string
  codexInstallerUrl?: string
  codexMacInstallerUrl?: string
  codexLocalePackUrl?: string
  apiBaseUrl?: string
  softwareAdminApiBaseUrl?: string
  smsReceiverApiBaseUrl?: string
}

export interface DesktopServerEntry {
  id: string
  name: string
  rootDomain: string
  enabled?: boolean
  sort?: number
  healthPath?: string
  overrides?: DesktopServerOverrides
}

export interface DesktopServerDirectory {
  version: number
  updatedAt: string
  defaultServerId?: string
  health?: {
    path?: string
    statusPath?: string
    status_path?: string
    method?: 'GET' | 'HEAD'
    timeoutMs?: number
  }
  servers: DesktopServerEntry[]
}

export interface RuntimeServerUrls {
  rootDomain: string
  apiOrigin: string
  softwareAdminOrigin: string
  softwareOrigin: string
  imageOrigin: string
  payOrigin: string
  codexOrigin: string
  apiBaseUrl: string
  softwareAdminApiBaseUrl: string
  smsReceiverApiBaseUrl: string
  openaiBaseUrl: string
  anthropicBaseUrl: string
  claudeBaseUrl: string
  updateBaseUrl: string
  downloadBaseUrl: string
  tutorialVideoBaseUrl: string
  webEntryUrl: string
  codexInstallerUrl: string
  codexMacInstallerUrl: string
  codexLocalePackUrl: string
}

export interface RuntimeServerStatus {
  serverId: string
  status: RuntimeServerHealthStatus
  latencyMs?: number
  httpStatus?: number
  load?: RuntimeServerLoad
  reason?: string
  testedAt?: string
}

export interface RuntimeServerLoad {
  level: RuntimeServerLoadLevel
  label: string
  score?: number
  reason?: string
}

export interface RuntimeServerView extends DesktopServerEntry {
  urls: RuntimeServerUrls
  selected: boolean
  status: RuntimeServerStatus
}

export type RuntimeApiServiceScope = 'core' | 'software-admin'

export interface RuntimeApiCandidate {
  serverId: string
  serverName: string
  baseUrl: string
  selected: boolean
}

export interface RuntimeDomainConfig {
  version: number
  source: RuntimeConfigSource
  sourceEntry?: string
  activeRole: RuntimeDomainRole
  selectedServerId?: string
  selectedServer?: RuntimeServerView
  relayOrigin: string
  apiOrigin: string
  apiBaseUrl: string
  softwareOrigin: string
  softwareAdminOrigin: string
  softwareAdminApiBaseUrl: string
  smsReceiverApiBaseUrl: string
  openaiBaseUrl: string
  anthropicBaseUrl: string
  claudeBaseUrl: string
  imageOrigin: string
  codexOrigin: string
  payOrigin: string
  updateBaseUrl: string
  downloadBaseUrl: string
  tutorialVideoBaseUrl: string
  webEntryUrl: string
  codexInstallerUrl: string
  codexMacInstallerUrl: string
  codexLocalePackUrl: string
  compat: {
    current: string
    openai: string
    anthropic: string
    imageGenerations: string
    imageEdits: string
  }
  domains: Partial<Record<RuntimeDomainScope, RuntimeDomainItem>>
  items: RuntimeDomainItem[]
  updatedAt: string
  warning?: string
}

interface CachedDirectory {
  directory: DesktopServerDirectory
  sourceEntry?: string
  cachedAt: string
}

export const RUNTIME_SERVER_CHANGED_EVENT = 'gaoge-runtime-server-changed'

const DIRECTORY_CACHE_KEY = 'gaoge_desktop_server_directory_v1'
const SELECTED_SERVER_KEY = 'gaoge_desktop_selected_server_id'
const HEALTH_CACHE_KEY = 'gaoge_desktop_server_health_v1'
const DEFAULT_HEALTH_PATH = '/api/v1/desktop/ping'
const DEFAULT_STATUS_PATH = '/api/v1/desktop/status'
const DEFAULT_REQUEST_TIMEOUT_MS = 5000

let serverDirectory: DesktopServerDirectory | null = null
let directorySource: RuntimeConfigSource = 'builtin'
let directorySourceEntry = ''
let serverStatusById = readHealthCache()
let initialized = false
let runtimeConfig: RuntimeDomainConfig = buildUnavailableRuntimeConfig('Runtime server directory has not loaded.')

function cleanUrl(value: unknown) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function cleanPath(value: unknown) {
  const path = String(value || '').trim()
  if (!path) return ''
  return `/${path.replace(/^\/+/, '')}`.replace(/\/+$/, '')
}

function appendPath(origin: string, path: string) {
  const base = cleanUrl(origin)
  const suffix = String(path || '').trim().replace(/^\/+/, '')
  if (!base) return suffix ? `/${suffix}` : ''
  return suffix ? `${base}/${suffix}`.replace(/\/+$/, '') : base
}

function readEnvValue(key: string) {
  return String(import.meta.env?.[key] || '').trim()
}

function parseUrlList(value: string) {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function bootstrapConfigUrls() {
  return [
    ...parseUrlList(readEnvValue('VITE_GAOGE_BOOTSTRAP_CONFIG_URLS')),
    ...parseUrlList(readEnvValue('VITE_GAOGE_CONFIG_DIRECTORY_URLS')),
    readEnvValue('VITE_GAOGE_CONFIG_MAIN_URL'),
    readEnvValue('VITE_GAOGE_CONFIG_BACKUP_URL'),
  ].map(cleanUrl).filter(Boolean)
}

function safeStorageGet(key: string) {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeStorageSet(key: string, value: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Ignore private mode or disabled storage.
  }
}

function safeStorageRemove(key: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    // Ignore private mode or disabled storage.
  }
}

function normalizeRootDomain(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`)
    return url.hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase()
  }
}

function normalizeOrigin(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`)
    return `${url.protocol}//${url.host}`.replace(/\/+$/, '')
  } catch {
    return cleanUrl(raw)
  }
}

function deriveOrigin(prefix: string, rootDomain: string) {
  return rootDomain ? `https://${prefix}.${rootDomain}` : ''
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function normalizeOverrides(value: unknown): DesktopServerOverrides {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    apiOrigin: normalizeOrigin(firstString(record, ['apiOrigin', 'api_origin'])),
    softwareAdminOrigin: normalizeOrigin(firstString(record, ['softwareAdminOrigin', 'software_admin_origin'])),
    softwareOrigin: normalizeOrigin(firstString(record, ['softwareOrigin', 'software_origin'])),
    imageOrigin: normalizeOrigin(firstString(record, ['imageOrigin', 'image_origin'])),
    payOrigin: normalizeOrigin(firstString(record, ['payOrigin', 'pay_origin'])),
    codexOrigin: normalizeOrigin(firstString(record, ['codexOrigin', 'codex_origin'])),
    openaiBaseUrl: cleanUrl(firstString(record, ['openaiBaseUrl', 'openai_base_url'])),
    anthropicBaseUrl: cleanUrl(firstString(record, ['anthropicBaseUrl', 'anthropic_base_url'])),
    claudeBaseUrl: cleanUrl(firstString(record, ['claudeBaseUrl', 'claude_base_url'])),
    updateBaseUrl: cleanUrl(firstString(record, ['updateBaseUrl', 'update_base_url'])),
    downloadBaseUrl: cleanUrl(firstString(record, ['downloadBaseUrl', 'download_base_url'])),
    tutorialVideoBaseUrl: cleanUrl(firstString(record, ['tutorialVideoBaseUrl', 'tutorial_video_base_url'])),
    webEntryUrl: cleanUrl(firstString(record, ['webEntryUrl', 'web_entry_url'])),
    codexInstallerUrl: cleanUrl(firstString(record, ['codexInstallerUrl', 'codex_installer_url'])),
    codexMacInstallerUrl: cleanUrl(firstString(record, ['codexMacInstallerUrl', 'codex_mac_installer_url'])),
    codexLocalePackUrl: cleanUrl(firstString(record, ['codexLocalePackUrl', 'codex_locale_pack_url'])),
    apiBaseUrl: cleanUrl(firstString(record, ['apiBaseUrl', 'api_base_url'])),
    softwareAdminApiBaseUrl: cleanUrl(firstString(record, ['softwareAdminApiBaseUrl', 'software_admin_api_base_url'])),
    smsReceiverApiBaseUrl: cleanUrl(firstString(record, ['smsReceiverApiBaseUrl', 'sms_receiver_api_base_url'])),
  }
}

function normalizeServer(value: unknown): DesktopServerEntry | null {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const id = String(record.id || '').trim()
  const name = String(record.name || record.title || id).trim()
  const rootDomain = normalizeRootDomain(record.rootDomain || record.root_domain)
  if (!id || !name || !rootDomain) return null
  return {
    id,
    name,
    rootDomain,
    enabled: record.enabled !== false,
    sort: Number.isFinite(Number(record.sort)) ? Number(record.sort) : 0,
    healthPath: cleanPath(record.healthPath || record.health_path),
    overrides: normalizeOverrides(record.overrides),
  }
}

function normalizeDirectory(payload: unknown) {
  const data = payload && typeof payload === 'object' && 'data' in payload
    ? (payload as Record<string, unknown>).data
    : payload
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {}
  const servers = Array.isArray(record.servers)
    ? record.servers.map(normalizeServer).filter(Boolean) as DesktopServerEntry[]
    : []
  if (!servers.length) throw new Error('Runtime server directory has no servers.')
  const healthRecord = record.health && typeof record.health === 'object'
    ? record.health as Record<string, unknown>
    : {}
  return {
    version: Number(record.version || 1),
    updatedAt: String(record.updatedAt || record.updated_at || new Date().toISOString()),
    defaultServerId: String(record.defaultServerId || record.default_server_id || '').trim(),
    health: {
      path: cleanPath(healthRecord.path) || DEFAULT_HEALTH_PATH,
      method: String(healthRecord.method || 'GET').toUpperCase() === 'HEAD' ? 'HEAD' as const : 'GET' as const,
      timeoutMs: Number(healthRecord.timeoutMs || healthRecord.timeout_ms || DEFAULT_REQUEST_TIMEOUT_MS),
    },
    servers: servers.sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name)),
  } satisfies DesktopServerDirectory
}

function readHealthCache() {
  try {
    const raw = safeStorageGet(HEALTH_CACHE_KEY)
    if (!raw) return new Map<string, RuntimeServerStatus>()
    const parsed = JSON.parse(raw) as RuntimeServerStatus[]
    return new Map(parsed.map((item) => [item.serverId, item]))
  } catch {
    return new Map<string, RuntimeServerStatus>()
  }
}

function writeHealthCache() {
  safeStorageSet(HEALTH_CACHE_KEY, JSON.stringify([...serverStatusById.values()]))
}

function readCachedDirectory(): CachedDirectory | null {
  try {
    const raw = safeStorageGet(DIRECTORY_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedDirectory
    return {
      directory: normalizeDirectory(parsed.directory),
      sourceEntry: String(parsed.sourceEntry || '').trim(),
      cachedAt: String(parsed.cachedAt || ''),
    }
  } catch {
    return null
  }
}

function writeCachedDirectory(directory: DesktopServerDirectory, sourceEntry: string) {
  safeStorageSet(DIRECTORY_CACHE_KEY, JSON.stringify({
    directory,
    sourceEntry,
    cachedAt: new Date().toISOString(),
  } satisfies CachedDirectory))
}

function selectedServerIdFromStorage() {
  return String(safeStorageGet(SELECTED_SERVER_KEY) || '').trim()
}

function enabledServers(directory: DesktopServerDirectory | null) {
  return (directory?.servers || []).filter((server) => server.enabled !== false)
}

function chooseServer(directory: DesktopServerDirectory | null, explicitId = '') {
  const servers = enabledServers(directory)
  if (!servers.length) return null
  const selectedId = explicitId || selectedServerIdFromStorage()
  return (
    servers.find((server) => server.id === selectedId)
    || servers.find((server) => server.id === directory?.defaultServerId)
    || servers[0]
  )
}

function deriveServerUrls(server: DesktopServerEntry): RuntimeServerUrls {
  const overrides = server.overrides || {}
  const apiOrigin = normalizeOrigin(overrides.apiOrigin) || deriveOrigin('api', server.rootDomain)
  const softwareAdminOrigin = normalizeOrigin(overrides.softwareAdminOrigin) || deriveOrigin('ruanjianhoutai', server.rootDomain)
  const softwareOrigin = normalizeOrigin(overrides.softwareOrigin) || deriveOrigin('ruanjian', server.rootDomain)
  const imageOrigin = normalizeOrigin(overrides.imageOrigin) || deriveOrigin('image', server.rootDomain)
  const payOrigin = normalizeOrigin(overrides.payOrigin) || deriveOrigin('pay', server.rootDomain)
  const codexOrigin = normalizeOrigin(overrides.codexOrigin) || deriveOrigin('codex', server.rootDomain)
  const openaiBaseUrl = cleanUrl(overrides.openaiBaseUrl || appendPath(apiOrigin, '/v1'))
  const anthropicBaseUrl = cleanUrl(overrides.anthropicBaseUrl || overrides.claudeBaseUrl || apiOrigin)
  const updateBaseUrl = cleanUrl(overrides.updateBaseUrl || appendPath(apiOrigin, '/gaogeaii/updates'))
  // Public installers are promoted atomically with the updater artifacts. Keep
  // download buttons on that verified release origin unless a server explicitly
  // provides a separate, equally managed download mirror.
  const downloadBaseUrl = cleanUrl(overrides.downloadBaseUrl || updateBaseUrl)
  return {
    rootDomain: server.rootDomain,
    apiOrigin,
    softwareAdminOrigin,
    softwareOrigin,
    imageOrigin,
    payOrigin,
    codexOrigin,
    apiBaseUrl: cleanUrl(overrides.apiBaseUrl || appendPath(apiOrigin, '/api/v1')),
    softwareAdminApiBaseUrl: cleanUrl(overrides.softwareAdminApiBaseUrl || appendPath(softwareAdminOrigin, '/api')),
    smsReceiverApiBaseUrl: cleanUrl(overrides.smsReceiverApiBaseUrl || overrides.softwareAdminApiBaseUrl || appendPath(softwareAdminOrigin, '/api')),
    openaiBaseUrl,
    anthropicBaseUrl,
    claudeBaseUrl: cleanUrl(overrides.claudeBaseUrl || anthropicBaseUrl),
    updateBaseUrl,
    downloadBaseUrl,
    tutorialVideoBaseUrl: cleanUrl(overrides.tutorialVideoBaseUrl || appendPath(apiOrigin, '/gaogeaii/tutorial-videos')),
    webEntryUrl: cleanUrl(overrides.webEntryUrl || appendPath(apiOrigin, '/login')),
    codexInstallerUrl: cleanUrl(overrides.codexInstallerUrl || appendPath(apiOrigin, '/gaogeaii/codex/win/Codex-Quick-Installer.zip')),
    codexMacInstallerUrl: cleanUrl(overrides.codexMacInstallerUrl || appendPath(apiOrigin, '/gaogeaii/codex/mac/Codex-Quick-Installer.dmg')),
    codexLocalePackUrl: cleanUrl(overrides.codexLocalePackUrl || appendPath(apiOrigin, '/gaogeaii/codex-locales/zh-CN.pak')),
  }
}

function statusForServer(serverId: string): RuntimeServerStatus {
  return serverStatusById.get(serverId) || { serverId, status: 'idle' }
}

function serverView(server: DesktopServerEntry, selectedId = ''): RuntimeServerView {
  return {
    ...server,
    urls: deriveServerUrls(server),
    selected: server.id === selectedId,
    status: statusForServer(server.id),
  }
}

function endpoint(url: string, note = ''): RuntimeDomainEndpoint {
  return { url: cleanUrl(url), enabled: Boolean(cleanUrl(url)), note }
}

function domainItem(scope: RuntimeDomainScope, title: string, url: string): RuntimeDomainItem {
  return {
    id: `domain-${scope}`,
    scope,
    title,
    name: title,
    activeRole: 'main',
    activeUrl: cleanUrl(url),
    endpoints: {
      main: endpoint(url, 'Selected runtime server'),
      backup: endpoint('', 'Managed by OSS server directory'),
      temporary: endpoint('', 'Managed by OSS server directory'),
    },
  }
}

function itemsFromServer(urls: RuntimeServerUrls) {
  return [
    domainItem('api', 'Web / API', urls.apiOrigin),
    domainItem('software', 'Software Site', urls.softwareOrigin),
    domainItem('admin', 'Software Admin', urls.softwareAdminOrigin),
    domainItem('image', 'Image Site', urls.imageOrigin),
    domainItem('codex', 'Codex Subscription', urls.codexOrigin),
    domainItem('pay', 'Payment Site', urls.payOrigin),
  ]
}

function buildUnavailableRuntimeConfig(warning: string): RuntimeDomainConfig {
  return {
    version: 1,
    source: 'builtin',
    activeRole: 'main',
    relayOrigin: '',
    apiOrigin: '',
    apiBaseUrl: '',
    softwareOrigin: '',
    softwareAdminOrigin: '',
    softwareAdminApiBaseUrl: '',
    smsReceiverApiBaseUrl: '',
    openaiBaseUrl: '',
    anthropicBaseUrl: '',
    claudeBaseUrl: '',
    imageOrigin: '',
    codexOrigin: '',
    payOrigin: '',
    updateBaseUrl: '',
    downloadBaseUrl: '',
    tutorialVideoBaseUrl: '',
    webEntryUrl: '',
    codexInstallerUrl: '',
    codexMacInstallerUrl: '',
    codexLocalePackUrl: '',
    compat: {
      current: '',
      openai: '',
      anthropic: '',
      imageGenerations: '',
      imageEdits: '',
    },
    domains: {},
    items: [],
    updatedAt: new Date().toISOString(),
    warning,
  }
}

function buildRuntimeConfig(warning = '') {
  const selected = chooseServer(serverDirectory)
  if (!serverDirectory || !selected) {
    runtimeConfig = buildUnavailableRuntimeConfig(warning || 'Runtime server directory is unavailable.')
    return runtimeConfig
  }

  const selectedView = serverView(selected, selected.id)
  const urls = selectedView.urls
  const items = itemsFromServer(urls)
  const domains = Object.fromEntries(items.map((item) => [item.scope, item])) as RuntimeDomainConfig['domains']
  runtimeConfig = {
    version: serverDirectory.version,
    source: directorySource,
    sourceEntry: directorySourceEntry || undefined,
    activeRole: 'main',
    selectedServerId: selected.id,
    selectedServer: selectedView,
    relayOrigin: urls.apiOrigin,
    apiOrigin: urls.apiOrigin,
    apiBaseUrl: urls.apiBaseUrl,
    softwareOrigin: urls.softwareOrigin,
    softwareAdminOrigin: urls.softwareAdminOrigin,
    softwareAdminApiBaseUrl: urls.softwareAdminApiBaseUrl,
    smsReceiverApiBaseUrl: urls.smsReceiverApiBaseUrl,
    openaiBaseUrl: urls.openaiBaseUrl,
    anthropicBaseUrl: urls.anthropicBaseUrl,
    claudeBaseUrl: urls.claudeBaseUrl,
    imageOrigin: urls.imageOrigin,
    codexOrigin: urls.codexOrigin,
    payOrigin: urls.payOrigin,
    updateBaseUrl: urls.updateBaseUrl,
    downloadBaseUrl: urls.downloadBaseUrl,
    tutorialVideoBaseUrl: urls.tutorialVideoBaseUrl,
    webEntryUrl: urls.webEntryUrl,
    codexInstallerUrl: urls.codexInstallerUrl,
    codexMacInstallerUrl: urls.codexMacInstallerUrl,
    codexLocalePackUrl: urls.codexLocalePackUrl,
    compat: {
      current: urls.anthropicBaseUrl,
      openai: urls.openaiBaseUrl,
      anthropic: urls.anthropicBaseUrl,
      imageGenerations: appendPath(urls.openaiBaseUrl, '/images/generations'),
      imageEdits: appendPath(urls.openaiBaseUrl, '/images/edits'),
    },
    domains,
    items,
    updatedAt: serverDirectory.updatedAt,
    warning,
  }
  return runtimeConfig
}

function emitServerChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(RUNTIME_SERVER_CHANGED_EVENT, {
    detail: {
      config: runtimeConfig,
      server: runtimeConfig.selectedServer,
      servers: getRuntimeServers(),
    },
  }))
}

async function fetchJsonWithTimeout(url: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    window.clearTimeout(timeout)
  }
}

async function loadRemoteDirectory() {
  const entries = bootstrapConfigUrls()
  let lastError = ''
  for (const entry of entries) {
    try {
      const directory = normalizeDirectory(await fetchJsonWithTimeout(entry))
      serverDirectory = directory
      directorySource = 'remote'
      directorySourceEntry = entry
      writeCachedDirectory(directory, entry)
      return buildRuntimeConfig()
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError || 'No bootstrap config URLs configured.')
}

function loadCachedDirectory(warning: string) {
  const cached = readCachedDirectory()
  if (!cached) return false
  serverDirectory = cached.directory
  directorySource = 'cache'
  directorySourceEntry = cached.sourceEntry || 'cache'
  buildRuntimeConfig(warning)
  return true
}

export async function initializeDomainConfig() {
  if (initialized) return runtimeConfig
  initialized = true

  try {
    return await loadRemoteDirectory()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (loadCachedDirectory(`Using cached server directory because bootstrap loading failed: ${reason}`)) {
      return runtimeConfig
    }
    serverDirectory = null
    directorySource = 'builtin'
    directorySourceEntry = ''
    return buildRuntimeConfig(`Runtime server directory unavailable: ${reason}`)
  }
}

export async function refreshRuntimeServerDirectory() {
  initialized = true
  try {
    const config = await loadRemoteDirectory()
    emitServerChanged()
    return config
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (loadCachedDirectory(`Using cached server directory because refresh failed: ${reason}`)) {
      emitServerChanged()
      return runtimeConfig
    }
    serverDirectory = null
    directorySource = 'builtin'
    directorySourceEntry = ''
    const config = buildRuntimeConfig(`Runtime server directory unavailable: ${reason}`)
    emitServerChanged()
    return config
  }
}

export function getRuntimeDomainConfig() {
  return runtimeConfig
}

export function getRuntimeConfigSource() {
  return runtimeConfig.source
}

export function getRuntimeServers() {
  const selectedId = runtimeConfig.selectedServerId || ''
  return enabledServers(serverDirectory).map((server) => serverView(server, selectedId))
}

export function getRuntimeApiCandidates(scope: RuntimeApiServiceScope): RuntimeApiCandidate[] {
  const candidates = getRuntimeServers()
    .map((server) => ({
      serverId: server.id,
      serverName: server.name,
      baseUrl: scope === 'software-admin' ? server.urls.softwareAdminApiBaseUrl : server.urls.apiBaseUrl,
      selected: server.selected,
    }))
    .filter((candidate) => Boolean(candidate.baseUrl))
    .sort((left, right) => Number(right.selected) - Number(left.selected))

  const seen = new Set<string>()
  const unique = candidates.filter((candidate) => {
    const normalized = candidate.baseUrl.trim().replace(/\/+$/, '')
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    candidate.baseUrl = normalized
    return true
  })

  if (unique.length > 0) return unique
  const fallbackBaseUrl = scope === 'software-admin'
    ? runtimeConfig.softwareAdminApiBaseUrl
    : runtimeConfig.apiBaseUrl
  return fallbackBaseUrl ? [{
    serverId: runtimeConfig.selectedServerId || 'runtime',
    serverName: runtimeConfig.selectedServer?.name || '当前线路',
    baseUrl: fallbackBaseUrl.trim().replace(/\/+$/, ''),
    selected: true,
  }] : []
}

export function getSelectedRuntimeServer() {
  return runtimeConfig.selectedServer
}

export function getStoredRuntimeServerId() {
  return selectedServerIdFromStorage()
}

export function hasStoredRuntimeServerSelection() {
  return Boolean(selectedServerIdFromStorage())
}

function loadLabelForLevel(level: RuntimeServerLoadLevel) {
  if (level === 'smooth') return '流畅'
  if (level === 'normal') return '正常'
  if (level === 'congested') return '拥堵'
  if (level === 'busy') return '繁忙'
  return '未测试'
}

function normalizeRuntimeServerLoad(payload: unknown): RuntimeServerLoad | undefined {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : record
  const rawLoad = data.load && typeof data.load === 'object' ? data.load as Record<string, unknown> : {}
  const rawLevel = String(rawLoad.level || rawLoad.status || '').trim().toLowerCase()
  const level = (['smooth', 'normal', 'congested', 'busy'].includes(rawLevel) ? rawLevel : 'unknown') as RuntimeServerLoadLevel
  const rawScore = Number(rawLoad.score)
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : undefined
  return {
    level,
    label: String(rawLoad.label || loadLabelForLevel(level)).trim() || loadLabelForLevel(level),
    score,
    reason: String(rawLoad.reason || '').trim() || undefined,
  }
}

async function fetchRuntimeServerLoad(statusUrl: string, timeoutMs: number): Promise<RuntimeServerLoad | undefined> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    return normalizeRuntimeServerLoad(await response.json())
  } catch {
    return undefined
  } finally {
    window.clearTimeout(timeout)
  }
}

export function selectRuntimeServer(id: string) {
  const target = enabledServers(serverDirectory).find((server) => server.id === id)
  if (!target) throw new Error('Selected server is unavailable.')
  safeStorageSet(SELECTED_SERVER_KEY, target.id)
  buildRuntimeConfig()
  emitServerChanged()
  return runtimeConfig
}

export async function testRuntimeServers() {
  const directory = serverDirectory
  const servers = enabledServers(directory)
  if (!directory || !servers.length) return []
  const health = directory.health || {}
  const timeoutMs = Number(health.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS)

  await Promise.all(servers.map(async (server) => {
    const urls = deriveServerUrls(server)
    const path = server.healthPath || health.path || DEFAULT_HEALTH_PATH
    const healthUrl = appendPath(urls.apiOrigin, path || DEFAULT_HEALTH_PATH)
    const statusPath = cleanPath(health.statusPath || health.status_path || DEFAULT_STATUS_PATH)
    const statusUrl = appendPath(urls.apiOrigin, statusPath || DEFAULT_STATUS_PATH)
    const start = performance.now()
    serverStatusById.set(server.id, { serverId: server.id, status: 'testing', testedAt: new Date().toISOString() })
    try {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
      let httpStatus = 0
      let latencyMs = 0
      let load: RuntimeServerLoad | undefined
      try {
        const response = await fetch(healthUrl, {
          method: health.method || 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        })
        httpStatus = response.status
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
      } finally {
        window.clearTimeout(timeout)
      }
      latencyMs = Math.max(1, Math.round(performance.now() - start))
      load = await fetchRuntimeServerLoad(statusUrl, timeoutMs)
      serverStatusById.set(server.id, {
        serverId: server.id,
        status: 'ok',
        latencyMs,
        httpStatus,
        load,
        testedAt: new Date().toISOString(),
      })
    } catch (error) {
      serverStatusById.set(server.id, {
        serverId: server.id,
        status: 'failed',
        latencyMs: Math.max(1, Math.round(performance.now() - start)),
        reason: error instanceof Error ? error.message : String(error),
        testedAt: new Date().toISOString(),
      })
    }
  }))

  writeHealthCache()
  buildRuntimeConfig(runtimeConfig.warning)
  emitServerChanged()
  return getRuntimeServers()
}

export function clearRuntimeServerSelection() {
  safeStorageRemove(SELECTED_SERVER_KEY)
  buildRuntimeConfig()
  emitServerChanged()
  return runtimeConfig
}

export function getApiBaseUrl() {
  return runtimeConfig.apiBaseUrl
}

export function getRelayOrigin() {
  return runtimeConfig.relayOrigin
}

export function getSoftwareOrigin() {
  return runtimeConfig.softwareOrigin
}

export function getSoftwareAdminOrigin() {
  return runtimeConfig.softwareAdminOrigin
}

export function getSoftwareAdminApiBaseUrl() {
  return runtimeConfig.softwareAdminApiBaseUrl
}

export function getSmsReceiverApiBaseUrl() {
  return runtimeConfig.smsReceiverApiBaseUrl
}

export function getOpenAIBaseUrl() {
  return runtimeConfig.openaiBaseUrl
}

export function getAnthropicBaseUrl() {
  return runtimeConfig.anthropicBaseUrl
}

export function getClaudeBaseUrl() {
  return runtimeConfig.claudeBaseUrl
}

export function getUpdateBaseUrl() {
  return runtimeConfig.updateBaseUrl
}

export function getDownloadBaseUrl() {
  return runtimeConfig.downloadBaseUrl
}

export function getTutorialVideoBaseUrl() {
  return runtimeConfig.tutorialVideoBaseUrl
}

export function getWebEntryUrl() {
  return runtimeConfig.webEntryUrl
}

export function getImageGenerationsUrl() {
  return runtimeConfig.compat.imageGenerations
}

export function getImageEditsUrl() {
  return runtimeConfig.compat.imageEdits
}

export function getPayOrigin() {
  return runtimeConfig.payOrigin
}

export function getCodexInstallerUrl() {
  return runtimeConfig.codexInstallerUrl
}

export function getCodexMacInstallerUrl() {
  return runtimeConfig.codexMacInstallerUrl
}

export function getCodexLocalePackUrl() {
  return runtimeConfig.codexLocalePackUrl
}
