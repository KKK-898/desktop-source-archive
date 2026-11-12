interface ImportMetaEnv {
  readonly VITE_GAOGE_BOOTSTRAP_CONFIG_URLS?: string
  readonly VITE_GAOGE_CONFIG_DIRECTORY_URLS?: string
  readonly VITE_GAOGE_CONFIG_MAIN_URL?: string
  readonly VITE_GAOGE_CONFIG_BACKUP_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface GaogeDesktopApiRequest {
  path: string
  method?: string
  token?: string
  baseUrl?: string
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

interface GaogeDesktopApiResponse {
  ok: boolean
  status: number
  payload: unknown
}

interface GaogeDesktopApiTransportError {
  kind?: 'timeout' | 'dns' | 'tls' | 'connect' | 'response' | 'request' | 'client' | 'invalid_request' | string
  message?: string
  retryable?: boolean
  elapsedMs?: number
  host?: string
}

interface GaogeDesktopErrorReportRequest {
  [key: string]: unknown
}

interface GaogeDesktopErrorReportResponse {
  accepted: boolean
}

interface GaogeDesktopLocalLoginRequest {
  email: string
  password: string
  rememberPassword?: boolean
  autoLogin?: boolean
}

interface GaogeDesktopSavedLoginResponse {
  saved: boolean
  email?: string
  password?: string
  savedAt?: string
  rememberPassword?: boolean
  autoLogin?: boolean
  encryptionAvailable: boolean
  reason?: string
}

interface GaogeDesktopClearLoginResponse {
  cleared: boolean
}

interface GaogeDesktopAuthSessionRequest {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  expiresIn?: number
  tokenType?: string
  user?: unknown
  persist?: boolean
  apiBaseUrl?: string
}

interface GaogeDesktopAuthSessionResponse {
  saved: boolean
  active?: boolean
  apiBaseUrl?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  expiresIn?: number
  tokenType?: string
  user?: unknown
  savedAt?: string | number
  encryptionAvailable: boolean
  reason?: string
}

interface GaogeDesktopMainWindowRestoredEvent {
  source?: string
  restoredAt?: number
}

interface GaogeDesktopCodexAccountTokenStatus {
  code: string
  accessTokenExpiresAt?: number | null
  idTokenExpiresAt?: number | null
  hasRefreshToken?: boolean
}

interface GaogeDesktopCodexUsageWindow {
  usedPercent?: number | null
  remainingPercent?: number | null
  windowMinutes?: number | null
  resetsAt?: number | null
}

interface GaogeDesktopCodexAccount {
  accountKey: string
  userId?: string
  accountId?: string
  organizationId?: string
  email: string
  alias: string
  accountName: string
  workspaceName: string
  profileName: string
  plan: string
  authMode: string
  hasActiveSubscription: boolean
  subscriptionExpiresAt: number | null
  subscriptionWillRenew: boolean | null
  createdAt: number | null
  lastUsedAt: number | null
  primaryWindow: GaogeDesktopCodexUsageWindow | null
  secondaryWindow: GaogeDesktopCodexUsageWindow | null
  usageSource: string
  tokenStatus: GaogeDesktopCodexAccountTokenStatus
  hasFullSessionJson?: boolean
  loginState?: string
  requiresReauth?: boolean
  reauthReason?: string
  canSwitch?: boolean
  isLiveCurrent?: boolean
  isActive: boolean
}

interface GaogeDesktopCodexAccountsState {
  authPath: string
  registryPath: string
  activeAccountKey: string
  savedActiveAccountKey?: string
  currentAccount: GaogeDesktopCodexAccount | null
  accounts: GaogeDesktopCodexAccount[]
}

interface GaogeDesktopCodexFuelAccountCheck {
  canStart: boolean
  currentAccount: GaogeDesktopCodexAccount | null
  reason: 'ready' | 'missing' | 'invalid'
}

interface GaogeDesktopCodexAccountRefreshResult {
  accountKey?: string
  email?: string
  refreshed?: boolean
  reason?: string
  message?: string
  tokenStatus?: GaogeDesktopCodexAccountTokenStatus | null
}

interface GaogeDesktopCodexAccountSnapshotsRefreshResponse {
  refreshed: GaogeDesktopCodexAccountRefreshResult[]
  failed: GaogeDesktopCodexAccountRefreshResult[]
  skipped: GaogeDesktopCodexAccountRefreshResult[]
  activeLiveRefreshed: boolean
  state: GaogeDesktopCodexAccountsState
}

interface GaogeDesktopCodexSessionStats {
  codexDir: string
  sessionCount: number
  sizeBytes: number
  roots: string[]
  indexPath: string
  statePath: string
  source: 'directory' | 'session_index' | 'state_sqlite'
  directorySessionCount: number
  indexSessionCount: number
  sqliteSessionCount: number
  warnings: string[]
}

interface GaogeDesktopCodexAccountsImportResponse {
  cancelled: boolean
  imported: GaogeDesktopCodexAccount[]
  state: GaogeDesktopCodexAccountsState
}

interface GaogeDesktopCodexAccountsExportResponse {
  cancelled: boolean
  filePath: string
  count: number
}

interface GaogeDesktopCodexAccountAddFromSessionRequest {
  sessionJson: string
  overwriteExisting?: boolean
  setActive?: boolean
}

interface GaogeDesktopCodexOauthLoginStartResponse {
  loginId: string
  authUrl: string
  authorizationUrl?: string
  redirectUri: string
  scope: string
  expiresAt: number
  expiresIn: number
}

interface GaogeDesktopCodexOauthLoginCompleteRequest {
  loginId: string
  callbackUrl: string
  overwriteExisting?: boolean
  setActive?: boolean
}

interface GaogeDesktopCodexAccountAddCurrentResponse {
  account: GaogeDesktopCodexAccount
  state: GaogeDesktopCodexAccountsState
}

interface GaogeDesktopCodexOauthLoginCompleteResponse extends GaogeDesktopCodexAccountAddCurrentResponse {
  activated?: boolean
  router?: GaogeDesktopCodexRouterSettings
  relayPreserved?: boolean
  aggregate?: GaogeDesktopAggregateLoginStatus
  sessionSync?: GaogeDesktopSessionSyncResponse
  launch?: GaogeDesktopCodexLaunchResult
  enhancements?: {
    plugin: GaogeDesktopCodexEnhancementResult
    sessionDelete: GaogeDesktopCodexEnhancementResult
    theme: GaogeDesktopCodexEnhancementResult
  }
  warnings?: string[]
  codexClosed?: boolean
  codexLaunched?: boolean
  hasRefreshToken?: boolean
  tokenStatus?: GaogeDesktopCodexAccountTokenStatus
  warning?: string | null
}

interface GaogeDesktopCodexAccountActivateRequest {
  accountKey: string
  preserveRelay?: boolean
}

interface GaogeDesktopCodexAccountSessionIdentifyRequest {
  accountKey: string
}

interface GaogeDesktopCodexAccountSessionIdentifyResponse {
  accountKey: string
  email: string
  displayName: string
  sessionJson: string
  sessionSource?: string
  sessionUrl?: string
  isFullSessionJson?: boolean
  tokenStatus: GaogeDesktopCodexAccountTokenStatus
  account: GaogeDesktopCodexAccount
}

interface GaogeDesktopOfficialChatgptSessionIdentifyResponse extends GaogeDesktopCodexAccountSessionIdentifyResponse {
  state: GaogeDesktopCodexAccountsState
  loginWindowShown?: boolean
}

interface GaogeDesktopOfficialChatgptSessionTextRequest {
  sessionJson: string
}

interface GaogeDesktopOfficialChatgptSessionTextResponse extends GaogeDesktopOfficialChatgptSessionIdentifyResponse {}

interface GaogeDesktopCodexAccountActivateResponse extends GaogeDesktopCodexAccountsState {
  codexClosed: boolean
  codexLaunched?: boolean
  codexLaunchQueued?: boolean
  needsRestart: boolean
  router?: GaogeDesktopCodexRouterSettings
  relayPreserved?: boolean
  aggregate?: GaogeDesktopAggregateLoginStatus
  sessionSync?: GaogeDesktopSessionSyncResponse
  launch?: GaogeDesktopCodexLaunchResult
  enhancements?: {
    plugin: GaogeDesktopCodexEnhancementResult
    sessionDelete: GaogeDesktopCodexEnhancementResult
    theme: GaogeDesktopCodexEnhancementResult
  }
  warnings?: string[]
}

interface GaogeDesktopCodexAccountDeleteRequest {
  accountKey: string
  force?: boolean
}

interface GaogeDesktopCodexAccountDeleteResponse {
  deletedAccountKey: string
  snapshotDeleted: boolean
  sessionSnapshotDeleted?: boolean
  forced?: boolean
  codexWasRunning?: boolean
  codexClosed?: boolean
  liveAuthDeleted?: boolean
  state: GaogeDesktopCodexAccountsState
}

interface GaogeDesktopCodexModelsRequest {
  modelPolicyApiBaseUrl?: string
  applyDesktopModelSupport?: boolean
  apiKey: string
  baseUrl?: string
  allowFallback?: boolean
}

interface GaogeDesktopCodexModelsResponse {
  models: string[]
  baseUrl: string
  endpoint?: string
  latencyMs?: number
  fallback?: boolean
  message?: string
}

interface GaogeDesktopProviderLatencyRequest {
  tool: 'codex' | 'claude'
  apiKey: string
  baseUrl?: string
  model?: string
  wireApi?: 'responses' | 'messages'
}

interface GaogeDesktopProviderLatencyResponse {
  ok: boolean
  latencyMs?: number
  modelUsed?: string
  message?: string
}

interface GaogeDesktopCodexRequest {
  modelPolicyApiBaseUrl?: string
  apiKey: string
  imageApiKey?: string
  imageBaseUrl?: string
  accountKey?: string
  baseUrl?: string
  providerName?: string
  model?: string
  modelSelectionOrigin?: 'automatic' | 'user'
  modelSelectionMode?: 'upstream' | 'locked'
  modelCatalogSource?: 'upstream' | 'fallback'
  supportedModels?: string[]
  mode?: 'relay' | 'official'
  forceApiMode?: boolean
  requireCurrentChatgptAccount?: boolean
  enhanceModelPicker?: boolean
}

type GaogeAggregateProtocol = 'responses' | 'chatCompletions' | 'anthropicMessages'
interface GaogeAggregateModelConfig {
  contextWindow?: number | null
  autoCompactPercent?: number | null
  fast?: 'inherit' | 'supported' | 'unsupported'
}
interface GaogeAggregateGroupSettings {
  providerId: string
  groupId: string
  protocol: GaogeAggregateProtocol
  modelSettings: Record<string, GaogeAggregateModelConfig>
}
interface GaogeAggregateExternalProvider {
  id: string
  enabled?: boolean
  source?: 'custom'
  vendor: string
  name: string
  baseUrl: string
  protocol: GaogeAggregateProtocol
  apiKey: string
  keyConfigured?: boolean
  models: string[]
  modelSettings: Record<string, GaogeAggregateModelConfig>
}
interface GaogeAggregatePreset {
  id: string
  name: string
  baseUrl: string
  protocol: GaogeAggregateProtocol
  model?: string
  modelList?: string[]
  category?: string
}
interface GaogeAggregateModelMetadata {
  slug: string
  provider: string
  contextWindow?: number | null
  maxContextWindow?: number | null
  source: string
  sourceRevision?: string
  metadata: Record<string, unknown>
}
interface GaogeAggregateSettings {
  version?: number
  groups: GaogeAggregateGroupSettings[]
  providers: GaogeAggregateExternalProvider[]
  presets: GaogeAggregatePreset[]
  modelCatalog: GaogeAggregateModelMetadata[]
}

interface GaogeDesktopAggregateGroupRequest {
  id: number | string
  name: string
  rateText?: string
  platform?: string
  apiKey: string
  baseUrl?: string
  models: string[]
}

interface GaogeDesktopAggregateProviderRequest {
  id: string
  name: string
  baseUrl: string
  groups: GaogeDesktopAggregateGroupRequest[]
}

interface GaogeDesktopAggregateLoginRequest {
  providers: GaogeDesktopAggregateProviderRequest[]
  defaultModel?: string
  imageApiKey?: string
  imageBaseUrl?: string
}

interface GaogeDesktopAggregateModelStatus {
  publicModel: string
  upstreamModel: string
}

interface GaogeDesktopAggregateGroupStatus {
  id: string
  name: string
  rateText: string
  keyConfigured: boolean
  models: GaogeDesktopAggregateModelStatus[]
}

interface GaogeDesktopAggregateProviderStatus {
  id: string
  name: string
  baseUrl: string
  keyConfigured: boolean
  groups: GaogeDesktopAggregateGroupStatus[]
  models: GaogeDesktopAggregateModelStatus[]
}

interface GaogeDesktopAggregateLoginStatus {
  enabled: boolean
  running: boolean
  routerBaseUrl: string
  defaultModel: string
  defaultModelOrigin?: 'automatic' | 'user'
  providerCount: number
  groupCount: number
  modelCount: number
  providers: GaogeDesktopAggregateProviderStatus[]
  updatedAt: number
}

interface GaogeDesktopCodexEnhancementResult {
  requested: boolean
  applied: boolean
  enabled: boolean
  runtimeEnabled?: boolean
  degraded?: boolean
  disabledAfterFailure: boolean
  error?: string
}

interface GaogeDesktopCodexUltraResult {
  /** Runtime generation and freshness only; never raw configuration or credentials. */
  runtimeVersion?: number
  observationFresh?: boolean
  observationAgeMs?: number | null
  connectionState?: 'unknown' | 'connected' | 'disconnected'
  requested?: boolean
  enabled?: boolean
  ready?: boolean
  verified?: boolean
  reason?: string
  error?: string | null
  warnings?: string[]
}

interface GaogeDesktopCodexNativeFastResult {
  /** Observed native Fast entry state; preparation alone is not verification. */
  version?: number
  enabled?: boolean
  ready?: boolean
  verified?: boolean
  compiled?: boolean
  installed?: boolean
  phase?: 'disabled' | 'pending' | 'preparing' | 'prepared' | 'armed' | 'compiled' | 'unsupported'
  reason?: string
  needsRestart?: boolean
  method?: string
  error?: string | null
  warnings?: string[]
}

interface GaogeDesktopCodexLaunchFeedback {
  warnings?: string[]
  apiMode?: GaogeDesktopCodexUltraResult | null
  ultra?: GaogeDesktopCodexUltraResult | null
  nativeFast?: GaogeDesktopCodexNativeFastResult | null
  appPatch?: GaogeDesktopPluginAppPatch
  launch?: GaogeDesktopCodexLaunchResult
}

interface GaogeDesktopCodexLaunchResult {
  launched: boolean
  apiMode?: GaogeDesktopCodexUltraResult | null
  ready?: boolean
  launchAccepted?: boolean
  launchConfirmed?: boolean
  launchQueued?: boolean
  background?: boolean
  runtimePending?: boolean
  ultra?: GaogeDesktopCodexUltraResult | null
  nativeFast?: GaogeDesktopCodexNativeFastResult | null
  needsRestart?: boolean
  method: 'cdp' | 'normal' | 'fallback-normal' | 'none' | string
  appPath?: string
  debugPort?: number
  warnings?: string[]
  injection?: unknown
  codexClosed?: boolean
  plugin: GaogeDesktopCodexEnhancementResult
  sessionDelete: GaogeDesktopCodexEnhancementResult
  theme: GaogeDesktopCodexEnhancementResult
  activeThemeId?: string
  pluginBootstrap?: {
    configured?: boolean
    marketplaceCount?: number
    pluginCount?: number
  } | null
}

interface GaogeDesktopCodexRestartResponse {
  routeConfigured: boolean
  launch: GaogeDesktopCodexLaunchResult
  enhancements: {
    plugin: GaogeDesktopCodexEnhancementResult
    sessionDelete: GaogeDesktopCodexEnhancementResult
    theme: GaogeDesktopCodexEnhancementResult
  }
  warnings?: string[]
  ultra?: GaogeDesktopCodexUltraResult | null
  nativeFast?: GaogeDesktopCodexNativeFastResult | null
  appPatch?: GaogeDesktopPluginAppPatch
  codexClosed: boolean
  codexLaunched: boolean
  codexLaunchQueued?: boolean
  appPath?: string
  needsRestart: boolean
}

interface GaogeDesktopCodexLaunchTarget {
  source: 'manual' | 'auto' | 'none'
  platform: string
  manualPath: string
  manualValid: boolean
  autoDetectedPath: string
  effectivePath: string
  appDir: string
  valid: boolean
  warning?: string
  cancelled?: boolean
  restart?: GaogeDesktopCodexLaunchResult | null
}

interface GaogeDesktopCodexResponse {
  codexDirs?: import('./image-tools-status').ImageToolsTargetStatus[]
  routeConfigured?: boolean
  configPath: string
  backupPath: string | null
  model: string
  displayModel?: string
  provider: string
  apiAuthCreated?: boolean
  forceApiMode?: boolean
  providerScopedToken?: boolean
  nativeModelFallback?: boolean
  modelCatalogPath?: string
  modelCatalogMode?: 'upstream' | 'locked'
  modelCatalogSource?: 'upstream' | 'fallback'
  modelCatalogModels?: string[]
  modelCatalogWarning?: string
  desktopModelSupportEnabled?: boolean
  desktopModelSupportRevision?: string
  routeWarning?: string
  imageTools?: {
    configured?: boolean
    updated?: boolean
    settingsPath?: string
  }
  imageToolsWarning?: string
  sessionSync?: GaogeDesktopSessionSyncResponse
  router: GaogeDesktopCodexRouterSettings
  appPatch?: GaogeDesktopPluginAppPatch
  ultra?: GaogeDesktopCodexUltraResult | null
  nativeFast?: GaogeDesktopCodexNativeFastResult | null
  launch?: GaogeDesktopCodexLaunchResult
  enhancements?: {
    plugin: GaogeDesktopCodexEnhancementResult
    sessionDelete: GaogeDesktopCodexEnhancementResult
    theme: GaogeDesktopCodexEnhancementResult
  }
  warnings?: string[]
  codexClosed: boolean
  codexLaunched?: boolean
  codexLaunchQueued?: boolean
  needsRestart: boolean
  aggregate?: GaogeDesktopAggregateLoginStatus
}

interface GaogeDesktopCodexAuthCleanup {
  changed: boolean
  expectedAccountKey?: string
  reason?: string
  restored?: boolean
  removed?: boolean
  restoredAccountKey?: string
  backupPath?: string | null
}

interface GaogeDesktopCodexDisableRequest {
  forceOfficial?: boolean
}

interface GaogeDesktopCodexAuthVerification {
  status: 'verified' | 'pending' | 'failed' | 'not-required'
  scope?: 'local-auth-file'
  codexDir?: string
  nativeSessionVerified?: boolean
  expectedAccountKey?: string | null
  reason: string
  checkedAfterLaunch: boolean
}

interface GaogeDesktopCodexDisableResponse {
  authVerification?: GaogeDesktopCodexAuthVerification
  configPath: string
  backupPath: string | null
  authCleanup?: GaogeDesktopCodexAuthCleanup
  router: GaogeDesktopCodexRouterSettings
  sessionSync?: GaogeDesktopSessionSyncResponse
  launch?: GaogeDesktopCodexLaunchResult
  enhancements?: {
    plugin: GaogeDesktopCodexEnhancementResult
    sessionDelete: GaogeDesktopCodexEnhancementResult
    theme: GaogeDesktopCodexEnhancementResult
  }
  warnings?: string[]
  codexClosed: boolean
  codexLaunched?: boolean
  codexLaunchQueued?: boolean
  needsRestart: boolean
  aggregate?: GaogeDesktopAggregateLoginStatus
}

interface GaogeDesktopCodexRouterSettings {
  enabled: boolean
  mode: 'relay' | 'official'
  model: string
  modelOrigin?: 'automatic' | 'user' | ''
  displayModel?: string
  relayBaseUrl: string
  officialBaseUrl: string
  relayApiKeyConfigured: boolean
  provider: string
  configProvider?: string
  configuredProvider?: string
  configActive?: boolean
  relayConfigured?: boolean
  currentRelayConfigured?: boolean
  legacyRelayConfigured?: boolean
  officialConfigured?: boolean
  configPath?: string
  configUpdated?: boolean
}

interface GaogeDesktopClaudeRequest {
  apiKey: string
  baseUrl?: string
  model?: string
  sonnetModel?: string
  haikuModel?: string
  opusModel?: string
  fableModel?: string
  desktopModels?: string[]
}

interface GaogeDesktopClaudeResponse {
  settingsPath: string
  backupPath: string | null
  model: string
  baseUrl: string
  cliHadAccount?: boolean
  cliApiAuthCreated?: boolean
  desktop?: GaogeDesktopClaudeDesktopConfigResponse
  appPatch?: GaogeDesktopPluginAppPatch
  claudeClosed?: boolean
  needsRestart?: boolean
}

interface GaogeDesktopClaudeDisableResponse {
  settingsPath: string
  backupPath: string | null
  configUpdated: boolean
  removedKeys: string[]
  desktop?: GaogeDesktopClaudeDesktopConfigResponse
  claudeClosed?: boolean
  needsRestart?: boolean
}

interface GaogeDesktopClaudeDesktopConfigResponse {
  supported: boolean
  configured: boolean
  configUpdated: boolean
  removedProfile?: boolean
  mode?: string
  profileId?: string
  profileName?: string
  normalConfigPath?: string
  threepConfigPath?: string
  configLibraryPath?: string
  profilePath?: string
  metaPath?: string
  backupPaths?: string[]
  message?: string
}

interface GaogeDesktopSessionSyncResponse {
  status?: 'pending' | 'queued' | 'completed'
  background?: boolean
  deduplicated?: boolean
  provider: string
  providerSource?: string
  configuredProvider?: string
  configUpdated?: boolean
  configBackupPath?: string
  environment?: {
    changed: boolean
    skipped: boolean
    entries: string[]
  }
  backupPath: string | null
  rolloutFiles?: number
  rolloutSessions?: number
  rolloutCacheHits?: number
  rolloutCacheMisses?: number
  rolloutsChanged?: number
  threadsChanged?: number
  providerThreadsChanged?: number
  userEventThreadsChanged?: number
  indexedSessionsChanged?: number
  indexedSessionEntries?: number
  indexedSessionsAdded?: number
  indexedSessionsRemoved?: number
  indexedSessionsPreserved?: number
  sqliteThreads?: number
  sqliteBackfilledThreads?: number
  sqliteRolloutPathsChanged?: number
  sqliteMetadataThreadsChanged?: number
  sqliteMissingRolloutPaths?: number
  providerMismatches?: number
  rolloutProviderMismatches?: number
  indexMissingRollouts?: number
  indexStaleEntries?: number
  indexUnmatchedEntries?: number
  totalChanged?: number
  nativeProjectSync?: {
    nativeProjectsOwned: boolean
    migrationPending: number
    restored: number
    alreadyAssigned: number
    explicitlyProjectless: number
    deferred: boolean
    warning: string
    backupPath?: string | null
  }
  encryptedContentFiles?: number
  validation?: {
    sessionIndex?: {
      path: string
      entries: number
      sizeBytes: number
      malformedLines: number
      duplicateEntries: number
      missingRollouts?: number
      unmatchedEntries?: number
      staleEntries?: number
      preservedEntries?: number
    }
    sqlite?: {
      path: string
      threads: number
      providerMismatches: number
      backfilledThreads?: number
      rolloutPathsChanged?: number
      missingRolloutPaths?: number
    }
    rollouts?: {
      files: number
      sessions: number
      providerMismatches: number
      encryptedContentFiles: number
    }
  }
  warnings?: string[]
  codexClosed?: boolean
  needsRestart?: boolean
}

interface GaogeDesktopPluginRequest {
  enabled: boolean
  resourcesDir?: string
  appPath?: string
}

interface GaogeDesktopPluginAppPatch {
  applied: boolean
  method?: string
  restored?: boolean
  degraded?: boolean
  recoverable?: boolean
  resourcesDir?: string
  appPath?: string
  modelPickerEnhanced?: boolean
  nativeModelFallback?: boolean
  modelPickerDegraded?: boolean
  catalogPreserved?: boolean
  modelPickerAsset?: string
  apiKeyServiceTierPatched?: boolean
  ultraReasoningPatched?: boolean
  ultra?: GaogeDesktopCodexUltraResult | null
  nativeFast?: GaogeDesktopCodexNativeFastResult | null
  serviceTierAsset?: string
  serviceTierBackupPath?: string
  patchTarget?: string
  backupPath?: string
  alreadyPatched?: boolean
  changed?: boolean
  launched?: boolean
  launchQueued?: boolean
  background?: boolean
  standardShortcuts?: string[]
  backupAsarPath?: string
  extractedAppDir?: string
  needsRestart: boolean
  patchedFiles?: number
  patchActions?: number
  alreadyPatchedActions?: number
  actions?: string[]
  warnings: string[]
  errorCode?: string
  errorMessage?: string
  cdpFallback?: {
    applied: boolean
    method?: string
    debugPort?: number
    appPath?: string
    resourcesDir?: string
    targetTitle?: string
    targetUrl?: string
    needsRestart?: boolean
    injection?: unknown
    warnings?: string[]
    errorCode?: string
    errorMessage?: string
  }
}

/** Verified runtime evidence, separate from the saved plugin preference. */
interface GaogeDesktopPluginRuntimeEvidence {
  state?: string
  configEnabled?: boolean
  runtimeReady?: boolean
  runtimeInjected?: boolean
  configured?: boolean
  monitoring?: boolean
  nativeEntryReady?: boolean
  listVerified?: boolean
  searchReady?: boolean
  needsRestart?: boolean
  pending?: boolean
  runtimePending?: boolean
  reason?: string
  error?: string
  runtimeError?: string
  message?: string
  availablePluginCount?: number
  indexedPlugins?: number
}

interface GaogeDesktopPluginResponse extends GaogeDesktopPluginRuntimeEvidence {
  status?: GaogeDesktopPluginStatus
  enabled: boolean
  configEnabled?: boolean
  configPath: string
  backupPath: string | null
  plugins: string[]
  pluginMarketplace?: {
    name?: string
    marketplaceRoot?: string | null
    configured?: boolean
    marketplaceCount?: number
    pluginCount?: number
    marketplaces?: Array<{
      name?: string
      displayName?: string | null
      marketplaceRoot?: string | null
      path?: string | null
      pluginCount?: number
    }>
    warning?: string | null
  }
  pluginBootstrap?: {
    configured?: boolean
    marketplaceCount?: number
    pluginCount?: number
  }
  authStatus?: {
    mode?: 'chatgpt' | 'api_key' | 'partial' | 'none' | string
    hasChatgptAccount?: boolean
    apiOnly?: boolean
    requiresChatgptAccountForFullPlugins?: boolean
  }
  appPatch?: GaogeDesktopPluginAppPatch
  launch?: GaogeDesktopCodexLaunchResult
  enhancements?: {
    plugin: GaogeDesktopCodexEnhancementResult
    sessionDelete: GaogeDesktopCodexEnhancementResult
    theme: GaogeDesktopCodexEnhancementResult
  }
  warnings?: string[]
  codexClosed: boolean
  codexLaunched?: boolean
  needsRestart: boolean
}

interface GaogeDesktopPluginStatus extends GaogeDesktopPluginRuntimeEvidence {
  status?: GaogeDesktopPluginStatus
  imageToolsMigration?: import('./image-tools-status').ImageToolsMigrationStatus
  enabled: boolean
  runtimeReady: boolean
  pluginEnhancementsEnabled: boolean
  requestPatchReady?: boolean
  searchReady?: boolean
  indexedPlugins?: number
  renderedPlugins?: number
  autoExpandClicks?: number
  localMarketplaceCount?: number
  availablePluginCount?: number
  marketplaceRoot?: string | null
  platform: string
  debugPort?: number
  targetTitle?: string
  targetUrl?: string
  message?: string
  runtimeError?: string
}

interface GaogeDesktopSessionDeleteRequest {
  enabled: boolean
}

interface GaogeDesktopSessionDeleteStatus {
  enabled: boolean
  runtimeReady: boolean
  active: boolean
  runtimeRemoved?: boolean
  platform: string
  debugPort?: number
  appPath?: string
  targetTitle?: string
  targetUrl?: string
  sessionRows?: number
  buttonsAttached?: number
  codexClosed?: boolean
  codexLaunched?: boolean
  launch?: GaogeDesktopCodexLaunchResult
  enhancements?: {
    plugin: GaogeDesktopCodexEnhancementResult
    sessionDelete: GaogeDesktopCodexEnhancementResult
    theme: GaogeDesktopCodexEnhancementResult
  }
  warnings?: string[]
  message?: string
  error?: string
  runtimeError?: string
}

interface GaogeDesktopCodexManagedSession {
  id: string
  title: string
  projectId: string
  projectName: string
  projectPath: string
  projectKind: 'native' | 'workspace' | 'unassigned' | string
  cwd: string
  provider: string
  model?: string | null
  reasoningEffort?: string | null
  source: string
  updatedAt: string
  updatedAtMs: number
  sizeBytes: number
  storageCopies: number
  lineCount: number
  archived: boolean
  hasUserEvent: boolean
  rawAvailable: boolean
}

interface GaogeDesktopCodexSessionProject {
  id: string
  name: string
  path: string
  kind: 'native' | 'workspace' | 'unassigned' | string
  selected: boolean
  sortOrder: number
  sessionCount: number
  sizeBytes: number
}

interface GaogeDesktopCodexSessionsResponse {
  scannedAt: string
  sessions: GaogeDesktopCodexManagedSession[]
  projects: GaogeDesktopCodexSessionProject[]
  totalSessions: number
  totalProjects: number
  totalSizeBytes: number
  scannedFiles: number
  cacheHits: number
  cacheMisses: number
  codexRunning: boolean
  warnings: string[]
}

interface GaogeDesktopCodexSessionsDeleteRequest {
  sessionIds: string[]
}

interface GaogeDesktopCodexSessionsDeleteResponse {
  ok: boolean
  requestedCount: number
  deletedCount: number
  failedCount: number
  deletedSessionIds: string[]
  descendantSessions: number
  failures: Array<{ sessionId: string; message: string }>
  warnings: string[]
  message: string
}

interface GaogeDesktopCodexSessionsExportResponse {
  cancelled: boolean
  filePath: string
  requestedCount?: number
  exportedCount: number
  metadataOnlyCount?: number
  missingSessionIds?: string[]
}

interface GaogeDesktopCodexSessionImportItem {
  id: string
  title: string
  status: 'ready' | 'duplicate' | 'metadataOnly' | 'invalid' | 'deleted'
  message: string
  cwd: string
  suggestedProjectPath: string
  archived: boolean
}

interface GaogeDesktopCodexSessionsImportPreview {
  cancelled: boolean
  filePath?: string
  archiveHash?: string
  codexHome?: string
  codexRunning?: boolean
  sessions?: GaogeDesktopCodexSessionImportItem[]
}

interface GaogeDesktopCodexSessionsImportRequest {
  filePath: string
  archiveHash: string
  sessionIds: string[]
  projectMappings: Record<string, string>
}

interface GaogeDesktopCodexSessionsImportResponse {
  importedCount: number
  skippedCount: number
  failedCount: number
  importedSessionIds: string[]
  skipped: Array<{ sessionId: string; message: string; reason: string }>
  failures: Array<{ sessionId: string; message: string }>
  restartRequired: boolean
  codexHome: string
}

type GaogeDesktopCodexPluginMarketSource = 'public' | 'full'

interface GaogeDesktopCodexPluginMarketRequest {
  source: GaogeDesktopCodexPluginMarketSource
  refresh?: boolean
}

interface GaogeDesktopCodexMarketPlugin {
  id: string
  name: string
  displayName: string
  description: string
  version: string
  author: string
  tags: string[]
  license: string
  bytes: number
  skills: number
  requiresAuth: boolean
  installed: boolean
  installedVersion?: string | null
  updateAvailable: boolean
  installable: boolean
  enabled: boolean
  managed: boolean
}

interface GaogeDesktopCodexPluginMarketListResponse {
  source: GaogeDesktopCodexPluginMarketSource
  repository: string
  revision: string
  updatedAt: string
  cached: boolean
  codexHome: string
  warnings?: string[]
  plugins: GaogeDesktopCodexMarketPlugin[]
}

interface GaogeDesktopCodexPluginMutationRequest {
  source: GaogeDesktopCodexPluginMarketSource
  id: string
}

interface GaogeDesktopCodexPluginEnabledRequest extends GaogeDesktopCodexPluginMutationRequest {
  enabled: boolean
}

interface GaogeDesktopCodexPluginMutationResponse {
  status?: string
  message?: string
  restartRequired?: boolean
  plugin?: GaogeDesktopCodexMarketPlugin
  busy?: boolean
  stage?: string
  installedVersion?: string
}

interface GaogeDesktopCodexThemeSource {
  kind?: 'builtin' | 'community' | 'custom' | string
  repository?: string
  commit?: string
  originalPath?: string
}

interface GaogeDesktopCodexThemeRuntimeStatus {
  selectedThemeId: string
  appliedThemeId: string
  runtimeReady: boolean
  needsRestart: boolean
  runtimeError?: string
  status?: 'applied' | 'pending' | 'unavailable' | 'error'
}

interface GaogeDesktopCodexThemeItem {
  id: string
  name: string
  version: string
  remoteVersion?: string
  author: string
  description: string
  style: string
  platforms: string[]
  appearance: 'light' | 'dark' | 'system' | string
  sizeBytes: number
  sourceLabel: string
  source?: GaogeDesktopCodexThemeSource
  enabled: boolean
  installed: boolean
  custom: boolean
  active: boolean
  applied?: boolean
  pending?: boolean
  updateAvailable: boolean
  previewRevision?: string
  previewPath?: string
  previewUrl?: string
}

interface GaogeDesktopCodexThemeListResponse {
  schemaVersion: number
  catalogSource: 'remote' | 'cache' | 'none' | string
  catalogError?: string
  activeThemeId: string
  runtime?: GaogeDesktopCodexThemeRuntimeStatus
  themes: GaogeDesktopCodexThemeItem[]
  warnings: string[]
  storagePath: string
  platform: string
}

interface GaogeDesktopCodexThemeInstallResponse {
  installed: boolean
  themeId: string
  manifest?: Record<string, unknown>
  status: GaogeDesktopCodexThemeListResponse
  applied?: boolean
  needsRestart?: boolean
  runtime?: GaogeDesktopCodexThemeRuntimeStatus
}

interface GaogeDesktopCodexThemeImportRequest {
  filePath?: string
  replace?: boolean
}

interface GaogeDesktopCodexThemeImportResponse {
  applied?: boolean
  needsRestart?: boolean
  runtime?: GaogeDesktopCodexThemeRuntimeStatus
  cancelled?: boolean
  imported: boolean
  replaceRequired: boolean
  themeId: string
  themeName?: string
  filePath?: string
  manifest?: Record<string, unknown>
}

interface GaogeDesktopCodexThemeActionResponse {
  applied?: boolean
  runtime?: GaogeDesktopCodexThemeRuntimeStatus
  status?: Record<string, unknown>
  launch?: GaogeDesktopCodexLaunchResult
  theme?: GaogeDesktopCodexEnhancementResult
  warnings?: string[]
  codexClosed?: boolean
  codexLaunched?: boolean
  needsRestart?: boolean
  message?: string
  removed?: boolean
  themeId?: string
}

interface GaogeDesktopCodexThemeDownloadStatus {
  themeId: string
  state: 'downloading' | 'completed' | 'error'
  downloadedBytes?: number
  totalBytes?: number
  progress: number
  error?: string
}

interface GaogeDesktopLanguageRequest {
  enabled: boolean
  codexLocalePackUrl?: string
}

interface GaogeDesktopLanguageResponse {
  enabled: boolean
  language: string
  applied: boolean
  needsRestart: boolean
  message: string
  codexClosed: boolean
  warnings: string[]
  runtime?: {
    version?: number
    enabled?: boolean
    ready?: boolean
    localeApplied?: boolean
    gateReady?: boolean
    needsRestart?: boolean
    reason?: string
    error?: string
  } | null
}

type GaogeDesktopCodexInstallState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'copying'
  | 'shortcut'
  | 'done'
  | 'cancelled'
  | 'error'
  | 'unsupported'

interface GaogeDesktopCodexInstallStatus {
  state: GaogeDesktopCodexInstallState
  message: string
  os: string
  osLabel: string
  arch: string
  progress: number
  strategy: string
  installedVersion: string
  installPath: string
  downloadPath?: string
  shortcutPath: string
  manualInstall?: boolean
  packageUrl?: string
  extractedFiles?: number
  totalFiles?: number
  extractedBytes?: number
  totalBytes?: number
  installedBytes?: number
  shortcutRepair?: {
    inspected: boolean
    repaired: boolean
    shortcutPath: string
    previousTargetPath: string
    targetPath: string
    arguments: string
    warnings: string[]
  }
  canInstall: boolean
  error: string
}

interface GaogeDesktopPaymentWindowRequest {
  payUrl: string
}

interface GaogeDesktopPaymentWindowResponse {
  opened: boolean
}

type GaogeDesktopUpdateState =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'restarting'
  | 'error'

interface GaogeDesktopUpdateStatus {
  state: GaogeDesktopUpdateState
  message: string
  version: string
  latestVersion: string
  platform?: 'win' | 'mac' | 'linux' | string
  platformLabel?: string
  packageKind?: string
  feedUrl: string
  minimumVersion?: string
  forceUpdate?: boolean
  progress: number
  canCheck: boolean
  downloaded: boolean
  error: string
}

interface GaogeDesktopInstallUpdateResponse {
  installing: boolean
  restarting?: boolean
}

interface GaogeDesktopInvoiceDownloadRequest {
  url: string
  fileName: string
}

interface GaogeDesktopInvoiceDownloadStatus {
  state: 'downloading' | 'completed' | 'error'
  filePath: string
  fileName: string
  downloadedBytes: number
  totalBytes: number
  progress: number
  error?: string
}

interface GaogeDesktopInvoiceDownloadResponse {
  cancelled: boolean
  filePath: string
  downloadedBytes: number
  totalBytes: number
}

interface GaogeDesktopWindowLayoutRequest {
  mode: 'login' | 'server' | 'app'
}

interface GaogeDesktopWindowLayoutResponse {
  applied: boolean
  mode: 'login' | 'server' | 'app'
  width?: number
  height?: number
}

interface GaogeDesktopImageOutputDirResponse {
  cancelled: boolean
  path: string
}

interface GaogeDesktopImageReference {
  path: string
  previewUrl: string
  name: string
}

interface GaogeDesktopImageReferencesResponse {
  cancelled: boolean
  images: GaogeDesktopImageReference[]
}

interface GaogeDesktopGenerateLocalImageRequest {
  apiKey: string
  baseUrl?: string
  mode: 'text' | 'image'
  prompt: string
  model: string
  size: string
  quality: string
  outputFormat?: 'png' | 'gif'
  complexity?: 'low' | 'medium' | 'high'
  frameCount?: number
  frameDurationMs?: number
  imageCount: number
  outputDir: string
  referenceImagePaths: string[]
}

interface GaogeDesktopGeneratedLocalImage {
  path: string
  fileName: string
  mimeType: string
  bytes: number
  previewDataUrl: string
}

interface GaogeDesktopGeneratedLocalImageFailure {
  index: number
  message: string
}

interface GaogeDesktopGenerateLocalImageResponse {
  outputDir: string
  count: number
  images: GaogeDesktopGeneratedLocalImage[]
  failedCount?: number
  failedImages?: GaogeDesktopGeneratedLocalImageFailure[]
}

interface Window {
  gaogeDesktop?: {
    setWindowLayout?(request: GaogeDesktopWindowLayoutRequest): Promise<GaogeDesktopWindowLayoutResponse>
    apiRequest(request: GaogeDesktopApiRequest): Promise<GaogeDesktopApiResponse>
    reportError?(request: GaogeDesktopErrorReportRequest): Promise<GaogeDesktopErrorReportResponse>
    saveLocalLogin(request: GaogeDesktopLocalLoginRequest): Promise<GaogeDesktopSavedLoginResponse>
    getSavedLogin(): Promise<GaogeDesktopSavedLoginResponse>
    clearSavedLogin(): Promise<GaogeDesktopClearLoginResponse>
    saveAuthSession?(request: GaogeDesktopAuthSessionRequest): Promise<GaogeDesktopAuthSessionResponse>
    getAuthSession?(): Promise<GaogeDesktopAuthSessionResponse>
    clearAuthSession?(): Promise<GaogeDesktopClearLoginResponse>
    getCodexAccounts(): Promise<GaogeDesktopCodexAccountsState>
    checkCodexFuelAccount(): Promise<GaogeDesktopCodexFuelAccountCheck>
    refreshCodexAccountSnapshots?(): Promise<GaogeDesktopCodexAccountSnapshotsRefreshResponse>
    getCodexSessionStats(): Promise<GaogeDesktopCodexSessionStats>
    listCodexSessions?(): Promise<GaogeDesktopCodexSessionsResponse>
    deleteCodexSessions?(request: GaogeDesktopCodexSessionsDeleteRequest): Promise<GaogeDesktopCodexSessionsDeleteResponse>
    exportCodexSessions?(sessionIds: string[]): Promise<GaogeDesktopCodexSessionsExportResponse>
    previewCodexSessionsImport?(): Promise<GaogeDesktopCodexSessionsImportPreview>
    importCodexSessions?(request: GaogeDesktopCodexSessionsImportRequest): Promise<GaogeDesktopCodexSessionsImportResponse>
    selectCodexSessionProjectDir?(): Promise<{ cancelled: boolean; path: string }>
    addCurrentCodexAccount(): Promise<GaogeDesktopCodexAccountAddCurrentResponse>
    startCodexOauthLogin?(): Promise<GaogeDesktopCodexOauthLoginStartResponse>
    completeCodexOauthLogin?(request: GaogeDesktopCodexOauthLoginCompleteRequest): Promise<GaogeDesktopCodexOauthLoginCompleteResponse>
    addCodexAccountFromSession?(request: GaogeDesktopCodexAccountAddFromSessionRequest): Promise<GaogeDesktopCodexAccountAddCurrentResponse>
    importCodexAccounts(): Promise<GaogeDesktopCodexAccountsImportResponse>
    exportCodexAccounts(accountKeys?: string[]): Promise<GaogeDesktopCodexAccountsExportResponse>
    identifyOfficialChatgptSession?(): Promise<GaogeDesktopOfficialChatgptSessionIdentifyResponse>
    identifyOfficialChatgptSessionText?(request: GaogeDesktopOfficialChatgptSessionTextRequest): Promise<GaogeDesktopOfficialChatgptSessionTextResponse>
    identifyCodexAccountSession?(request: GaogeDesktopCodexAccountSessionIdentifyRequest): Promise<GaogeDesktopCodexAccountSessionIdentifyResponse>
    activateCodexAccount(request: GaogeDesktopCodexAccountActivateRequest): Promise<GaogeDesktopCodexAccountActivateResponse>
    deleteCodexAccount(request: GaogeDesktopCodexAccountDeleteRequest): Promise<GaogeDesktopCodexAccountDeleteResponse>
    fetchCodexModels(request: GaogeDesktopCodexModelsRequest): Promise<GaogeDesktopCodexModelsResponse>
    fetchClaudeModels?(request: GaogeDesktopCodexModelsRequest): Promise<GaogeDesktopCodexModelsResponse>
    testProviderLatency?(request: GaogeDesktopProviderLatencyRequest): Promise<GaogeDesktopProviderLatencyResponse>
    getCodexRouterStatus?(): Promise<GaogeDesktopCodexRouterSettings>
    getCodexUltraStatus?(): Promise<GaogeDesktopCodexUltraResult>
    getCodexApiModeStatus?(): Promise<GaogeDesktopCodexUltraResult>
    getCodexNativeFastStatus?(): Promise<GaogeDesktopCodexNativeFastResult>
    getAggregateLoginStatus?(): Promise<GaogeDesktopAggregateLoginStatus>
    getAggregateModelSettings?(): Promise<GaogeAggregateSettings>
    saveAggregateModelSettings?(request: Pick<GaogeAggregateSettings, 'groups' | 'providers'>): Promise<GaogeAggregateSettings>
    selectImageOutputDir?(): Promise<GaogeDesktopImageOutputDirResponse>
    selectImageReferences?(): Promise<GaogeDesktopImageReferencesResponse>
    generateLocalImage?(request: GaogeDesktopGenerateLocalImageRequest): Promise<GaogeDesktopGenerateLocalImageResponse>
    configureCodex(request: GaogeDesktopCodexRequest): Promise<GaogeDesktopCodexResponse>
    configureAggregateLogin?(request: GaogeDesktopAggregateLoginRequest): Promise<GaogeDesktopCodexResponse>
    disableAggregateLogin?(): Promise<GaogeDesktopCodexDisableResponse>
    getCodexLaunchTarget?(): Promise<GaogeDesktopCodexLaunchTarget>
    selectCodexLaunchTarget?(): Promise<GaogeDesktopCodexLaunchTarget>
    resetCodexLaunchTarget?(): Promise<GaogeDesktopCodexLaunchTarget>
    restartCodex?(request?: { modelPolicyApiBaseUrl: string; relayBaseUrl: string }): Promise<GaogeDesktopCodexRestartResponse>
    listCodexPlugins?(request: GaogeDesktopCodexPluginMarketRequest): Promise<GaogeDesktopCodexPluginMarketListResponse>
    installCodexPlugin?(request: GaogeDesktopCodexPluginMutationRequest): Promise<GaogeDesktopCodexPluginMutationResponse>
    uninstallCodexPlugin?(request: GaogeDesktopCodexPluginMutationRequest): Promise<GaogeDesktopCodexPluginMutationResponse>
    setCodexPluginEnabled?(request: GaogeDesktopCodexPluginEnabledRequest): Promise<GaogeDesktopCodexPluginMutationResponse>
    getCodexPluginInstallStatus?(request: GaogeDesktopCodexPluginMutationRequest): Promise<GaogeDesktopCodexPluginMutationResponse>
    listCodexThemes?(): Promise<GaogeDesktopCodexThemeListResponse>
    installCodexTheme?(themeId: string): Promise<GaogeDesktopCodexThemeInstallResponse>
    importCodexTheme?(request?: GaogeDesktopCodexThemeImportRequest): Promise<GaogeDesktopCodexThemeImportResponse>
    activateCodexTheme?(themeId: string): Promise<GaogeDesktopCodexThemeActionResponse>
    deactivateCodexTheme?(): Promise<GaogeDesktopCodexThemeActionResponse>
    removeCodexTheme?(themeId: string): Promise<GaogeDesktopCodexThemeActionResponse>
    onCodexThemeDownloadStatus?(
      callback: (status: GaogeDesktopCodexThemeDownloadStatus) => void,
    ): () => void
    onCodexLoginProgress?(
      callback: (status: { stage: string; message: string; elapsedMs: number }) => void,
    ): () => void
    disableCodexFuelPack(request?: GaogeDesktopCodexDisableRequest): Promise<GaogeDesktopCodexDisableResponse>
    configureClaude(request: GaogeDesktopClaudeRequest): Promise<GaogeDesktopClaudeResponse>
    disableClaudeRelay(): Promise<GaogeDesktopClaudeDisableResponse>
    syncCodexSessions(): Promise<GaogeDesktopSessionSyncResponse>
    setCodexPlugins(request: GaogeDesktopPluginRequest): Promise<GaogeDesktopPluginResponse>
    getCodexPluginsStatus?(): Promise<GaogeDesktopPluginStatus>
    getCodexSessionDeleteStatus?(): Promise<GaogeDesktopSessionDeleteStatus>
    setCodexSessionDelete?(request: GaogeDesktopSessionDeleteRequest): Promise<GaogeDesktopSessionDeleteStatus>
    getCodexLanguageSettings?(request?: { legacyEnabled?: boolean }): Promise<GaogeDesktopLanguageResponse>
    setCodexLanguage(request: GaogeDesktopLanguageRequest): Promise<GaogeDesktopLanguageResponse>
    getCodexInstallStatus(): Promise<GaogeDesktopCodexInstallStatus>
    installCodexApp(): Promise<GaogeDesktopCodexInstallStatus>
    cancelCodexInstall(): Promise<GaogeDesktopCodexInstallStatus>
    onCodexInstallStatus(callback: (status: GaogeDesktopCodexInstallStatus) => void): () => void
    openPaymentWindow(request: GaogeDesktopPaymentWindowRequest): Promise<GaogeDesktopPaymentWindowResponse>
    getUpdateStatus(): Promise<GaogeDesktopUpdateStatus>
    checkForUpdates(): Promise<GaogeDesktopUpdateStatus>
    installUpdate(): Promise<GaogeDesktopInstallUpdateResponse>
    onUpdateStatus(callback: (status: GaogeDesktopUpdateStatus) => void): () => void
    onMainWindowRestored(callback: (event: GaogeDesktopMainWindowRestoredEvent) => void): () => void
    downloadInvoiceFile?(
      request: GaogeDesktopInvoiceDownloadRequest,
      onProgress?: (status: GaogeDesktopInvoiceDownloadStatus) => void,
    ): Promise<GaogeDesktopInvoiceDownloadResponse>
  }
}
