import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { writeFile } from '@tauri-apps/plugin-fs'
import {
  getCodexInstallerUrl,
  getCodexLocalePackUrl,
  getCodexMacInstallerUrl,
  getDownloadBaseUrl,
  getUpdateBaseUrl,
} from './domain-config'

type DesktopEventCallback<T> = (payload: T) => void

const INVOICE_DOWNLOAD_LIMIT_BYTES = 50 * 1024 * 1024

const hasTauriRuntime = () => (
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
)

function callDesktop<T>(command: string, request?: unknown): Promise<T> {
  if (typeof request === 'undefined') {
    return invoke<T>(command)
  }
  return invoke<T>(command, { request })
}

function subscribeDesktopEvent<T>(
  eventName: string,
  callback: DesktopEventCallback<T>,
  initialStatus?: () => Promise<T>,
) {
  let unlisten: UnlistenFn | null = null
  let disposed = false

  if (initialStatus) {
    initialStatus()
      .then((status) => {
        if (!disposed) callback(status)
      })
      .catch(() => undefined)
  }

  listen<T>(eventName, (event) => {
    callback(event.payload)
  })
    .then((nextUnlisten) => {
      if (disposed) {
        nextUnlisten()
        return
      }
      unlisten = nextUnlisten
    })
    .catch(() => undefined)

  return () => {
    disposed = true
    if (unlisten) unlisten()
  }
}

function updateRuntimeRequest() {
  return { updateBaseUrl: getUpdateBaseUrl() }
}

function codexRuntimeRequest(extra: object = {}) {
  return {
    ...extra,
    codexInstallerUrl: getCodexInstallerUrl(),
    codexMacInstallerUrl: getCodexMacInstallerUrl(),
    codexLocalePackUrl: getCodexLocalePackUrl(),
  }
}

function versionedCodexThemePreviewUrl(previewUrl: string, version: string) {
  if (!previewUrl || !version) return previewUrl
  const hashOffset = previewUrl.indexOf('#')
  const fragment = hashOffset >= 0 ? previewUrl.slice(hashOffset) : ''
  const base = hashOffset >= 0 ? previewUrl.slice(0, hashOffset) : previewUrl
  const queryOffset = base.indexOf('?')
  const path = queryOffset >= 0 ? base.slice(0, queryOffset) : base
  const params = new URLSearchParams(queryOffset >= 0 ? base.slice(queryOffset + 1) : '')
  params.set('theme-version', version)
  return `${path}?${params.toString()}${fragment}`
}

function normalizeCodexThemeList(status: GaogeDesktopCodexThemeListResponse) {
  return {
    ...status,
    themes: (status.themes || []).map((theme) => {
      const developmentPreviewUrl = (
        import.meta.env.DEV
        && status.catalogSource === 'development'
        && !theme.installed
      )
        ? `/__gaoge-theme-previews/${encodeURIComponent(theme.id)}.webp`
        : ''
      return {
        ...theme,
        previewUrl: versionedCodexThemePreviewUrl(
          developmentPreviewUrl || (theme.previewPath ? convertFileSrc(theme.previewPath) : theme.previewUrl || ''),
          theme.previewRevision || (theme.previewPath ? theme.version : theme.remoteVersion || theme.version),
        ),
      }
    }),
  }
}

async function downloadInvoiceFile(
  request: GaogeDesktopInvoiceDownloadRequest,
  onProgress?: (status: GaogeDesktopInvoiceDownloadStatus) => void,
): Promise<GaogeDesktopInvoiceDownloadResponse> {
  const filePath = await save({
    title: '保存发票',
    defaultPath: request.fileName,
    filters: [
      { name: '发票文件', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'] },
    ],
  })
  if (!filePath) {
    return { cancelled: true, filePath: '', downloadedBytes: 0, totalBytes: 0 }
  }

  let downloadedBytes = 0
  let totalBytes = 0
  const emitProgress = (status: GaogeDesktopInvoiceDownloadStatus) => {
    try {
      onProgress?.(status)
    } catch {
      // UI callbacks must never interrupt the background download.
    }
  }

  emitProgress({
    state: 'downloading',
    filePath,
    fileName: request.fileName,
    downloadedBytes,
    totalBytes,
    progress: 0,
  })

  try {
    const response = await fetch(request.url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/pdf,image/*,application/octet-stream' },
    })
    if (!response.ok) {
      throw new Error(`发票下载失败（HTTP ${response.status}）`)
    }

    totalBytes = Math.max(0, Number(response.headers.get('content-length') || 0))
    if (totalBytes > INVOICE_DOWNLOAD_LIMIT_BYTES) {
      throw new Error('发票文件超过 50MB，已停止下载。')
    }

    const chunks: Uint8Array[] = []
    if (response.body) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value?.byteLength) continue
        downloadedBytes += value.byteLength
        if (downloadedBytes > INVOICE_DOWNLOAD_LIMIT_BYTES) {
          await reader.cancel()
          throw new Error('发票文件超过 50MB，已停止下载。')
        }
        chunks.push(value)
        emitProgress({
          state: 'downloading',
          filePath,
          fileName: request.fileName,
          downloadedBytes,
          totalBytes,
          progress: totalBytes > 0 ? Math.min(99, Math.round(downloadedBytes / totalBytes * 100)) : 0,
        })
      }
    } else {
      const content = new Uint8Array(await response.arrayBuffer())
      downloadedBytes = content.byteLength
      if (downloadedBytes > INVOICE_DOWNLOAD_LIMIT_BYTES) {
        throw new Error('发票文件超过 50MB，已停止下载。')
      }
      chunks.push(content)
    }

    if (!downloadedBytes) {
      throw new Error('服务器返回了空的发票文件。')
    }

    const content = new Uint8Array(downloadedBytes)
    let offset = 0
    chunks.forEach((chunk) => {
      content.set(chunk, offset)
      offset += chunk.byteLength
    })
    await writeFile(filePath, content)

    const completedStatus: GaogeDesktopInvoiceDownloadStatus = {
      state: 'completed',
      filePath,
      fileName: request.fileName,
      downloadedBytes,
      totalBytes: totalBytes || downloadedBytes,
      progress: 100,
    }
    emitProgress(completedStatus)
    return {
      cancelled: false,
      filePath,
      downloadedBytes,
      totalBytes: completedStatus.totalBytes,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '发票下载失败。')
    emitProgress({
      state: 'error',
      filePath,
      fileName: request.fileName,
      downloadedBytes,
      totalBytes,
      progress: totalBytes > 0 ? Math.min(99, Math.round(downloadedBytes / totalBytes * 100)) : 0,
      error: message,
    })
    throw error
  }
}

export function installTauriDesktopApi() {
  if (!hasTauriRuntime()) return

  const desktopApi: NonNullable<Window['gaogeDesktop']> = {
    setWindowLayout: (request) => callDesktop('gaoge_set_window_layout', request),
    apiRequest: (request) => callDesktop('gaoge_api_request', request),
    reportError: (request) => callDesktop('gaoge_report_error', request),
    saveLocalLogin: (request) => callDesktop('gaoge_save_local_login', request),
    getSavedLogin: () => callDesktop('gaoge_get_saved_login'),
    clearSavedLogin: () => callDesktop('gaoge_clear_saved_login'),
    saveAuthSession: (request) => callDesktop('gaoge_save_auth_session', request),
    getAuthSession: () => callDesktop('gaoge_get_auth_session'),
    clearAuthSession: () => callDesktop('gaoge_clear_auth_session'),
    getCodexAccounts: () => callDesktop('gaoge_get_codex_accounts'),
    checkCodexFuelAccount: () => callDesktop('gaoge_check_codex_fuel_account'),
    refreshCodexAccountSnapshots: () => callDesktop('gaoge_refresh_codex_account_snapshots'),
    getCodexSessionStats: () => callDesktop('gaoge_get_codex_session_stats'),
    listCodexSessions: () => callDesktop('gaoge_list_codex_sessions'),
    deleteCodexSessions: (request) => callDesktop('gaoge_delete_codex_sessions', request),
    exportCodexSessions: async (sessionIds) => {
      const filePath = await save({
        title: '导出 Codex 会话',
        defaultPath: `Gaoge-Codex-sessions-${Date.now()}.zip`,
        filters: [
          { name: 'Gaoge Codex Sessions', extensions: ['zip'] },
          { name: 'ZIP', extensions: ['zip'] },
        ],
      })
      if (!filePath) {
        return callDesktop('gaoge_export_codex_sessions', { cancelled: true })
      }
      return callDesktop('gaoge_export_codex_sessions', { filePath, sessionIds })
    },
    previewCodexSessionsImport: async () => {
      const filePath = await open({
        title: '导入 Codex 会话',
        multiple: false,
        filters: [{ name: 'Gaoge Codex Sessions', extensions: ['zip'] }],
      })
      if (!filePath || Array.isArray(filePath)) return { cancelled: true }
      return callDesktop<GaogeDesktopCodexSessionsImportPreview>('gaoge_preview_codex_sessions_import', { filePath })
    },
    importCodexSessions: (request) => callDesktop('gaoge_import_codex_sessions', request),
    selectCodexSessionProjectDir: async () => {
      const directory = await open({ title: '选择此会话在本机使用的项目文件夹', directory: true, multiple: false })
      return { cancelled: !directory || Array.isArray(directory), path: typeof directory === 'string' ? directory : '' }
    },
    addCurrentCodexAccount: () => callDesktop('gaoge_add_current_codex_account'),
    startCodexOauthLogin: () => callDesktop('gaoge_start_codex_oauth_login'),
    completeCodexOauthLogin: (request) => callDesktop('gaoge_complete_codex_oauth_login', request),
    addCodexAccountFromSession: (request) => callDesktop('gaoge_add_codex_account_from_session', request),
    importCodexAccounts: async () => {
      const filePath = await open({
        title: '导入 Codex 账号',
        multiple: false,
        filters: [
          { name: 'Gaoge Codex Accounts', extensions: ['json', 'gaoge-codex-accounts'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      })
      if (!filePath || Array.isArray(filePath)) {
        return callDesktop('gaoge_import_codex_accounts', { cancelled: true })
      }
      return callDesktop('gaoge_import_codex_accounts', { filePath })
    },
    exportCodexAccounts: async (accountKeys) => {
      const filePath = await save({
        title: '导出 Codex 账号',
        defaultPath: `Gaoge-accounts-${Date.now()}.Gaoge-accounts.json`,
        filters: [
          { name: 'Gaoge Accounts Backup', extensions: ['json'] },
          { name: 'JSON', extensions: ['json'] },
        ],
      })
      if (!filePath) {
        return callDesktop('gaoge_export_codex_accounts', { cancelled: true })
      }
      return callDesktop('gaoge_export_codex_accounts', { filePath, accountKeys })
    },
    identifyCodexAccountSession: (request) => callDesktop('gaoge_identify_codex_account_session', request),
    identifyOfficialChatgptSession: () => callDesktop('gaoge_identify_official_chatgpt_session'),
    identifyOfficialChatgptSessionText: (request) => callDesktop('gaoge_identify_official_chatgpt_session_text', request),
    activateCodexAccount: (request) => callDesktop('gaoge_activate_codex_account', request),
    deleteCodexAccount: (request) => callDesktop('gaoge_delete_codex_account', request),
    fetchCodexModels: (request) => callDesktop('gaoge_fetch_codex_models', request),
    fetchClaudeModels: (request) => callDesktop('gaoge_fetch_claude_models', request),
    testProviderLatency: (request) => callDesktop('gaoge_test_provider_latency', request),
    getCodexRouterStatus: () => callDesktop('gaoge_get_codex_router_status'),
    getCodexUltraStatus: () => callDesktop('gaoge_get_codex_ultra_status'),
    getCodexApiModeStatus: () => callDesktop('gaoge_get_codex_api_mode_status'),
    getCodexNativeFastStatus: () => callDesktop('gaoge_get_codex_native_fast_status'),
    getAggregateLoginStatus: () => callDesktop('gaoge_get_aggregate_login_status'),
    selectImageOutputDir: async () => {
      const directory = await open({
        title: '选择图片保存位置',
        directory: true,
        multiple: false,
      })
      return {
        cancelled: !directory || Array.isArray(directory),
        path: typeof directory === 'string' ? directory : '',
      }
    },
    selectImageReferences: async () => {
      const files = await open({
        title: '上传参考图',
        multiple: true,
        filters: [
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        ],
      })
      const paths = !files
        ? []
        : Array.isArray(files)
          ? files.filter((file): file is string => typeof file === 'string')
          : [files]
      return {
        cancelled: paths.length === 0,
        images: paths.map((path) => ({
          path,
          previewUrl: convertFileSrc(path),
          name: path.split(/[\\/]/).pop() || '参考图',
        })),
      }
    },
    generateLocalImage: (request) => callDesktop('gaoge_generate_local_image', request),
    configureCodex: (request) => callDesktop('gaoge_configure_codex', request),
    getAggregateModelSettings: () => callDesktop('gaoge_get_aggregate_model_settings'),
    saveAggregateModelSettings: (request) => callDesktop('gaoge_save_aggregate_model_settings', request),
    configureAggregateLogin: (request) => callDesktop('gaoge_configure_aggregate_login', request),
    disableAggregateLogin: () => callDesktop('gaoge_disable_aggregate_login'),
    getCodexLaunchTarget: () => callDesktop('gaoge_get_codex_launch_target'),
    selectCodexLaunchTarget: async () => {
      const current = await callDesktop<GaogeDesktopCodexLaunchTarget>('gaoge_get_codex_launch_target')
      const selected = await open({
        title: '选择 Codex / ChatGPT 启动程序',
        directory: false,
        multiple: false,
        filters: current.platform === 'windows'
          ? [{ name: 'Codex / ChatGPT', extensions: ['exe'] }]
          : current.platform === 'macos'
            ? [{ name: 'Codex', extensions: ['app'] }]
            : undefined,
      })
      if (!selected || Array.isArray(selected)) {
        return { ...current, cancelled: true }
      }
      return callDesktop('gaoge_set_codex_launch_target', { path: selected })
    },
    resetCodexLaunchTarget: () => callDesktop('gaoge_reset_codex_launch_target'),
    restartCodex: (request) => callDesktop('gaoge_restart_codex', request),
    listCodexPlugins: (request) => callDesktop('gaoge_list_codex_plugins', request),
    installCodexPlugin: (request) => callDesktop('gaoge_install_codex_plugin', request),
    uninstallCodexPlugin: (request) => callDesktop('gaoge_uninstall_codex_plugin', request),
    setCodexPluginEnabled: (request) => callDesktop('gaoge_set_codex_plugin_enabled', request),
    getCodexPluginInstallStatus: (request) => callDesktop('gaoge_get_codex_plugin_install_status', request),
    listCodexThemes: async () => {
      const status = await callDesktop<GaogeDesktopCodexThemeListResponse>(
        'gaoge_list_codex_themes',
        { downloadBaseUrl: getDownloadBaseUrl() },
      )
      return normalizeCodexThemeList(status)
    },
    installCodexTheme: async (themeId) => {
      const result = await callDesktop<GaogeDesktopCodexThemeInstallResponse>(
        'gaoge_install_codex_theme',
        { downloadBaseUrl: getDownloadBaseUrl(), themeId },
      )
      return {
        ...result,
        status: normalizeCodexThemeList(result.status),
      }
    },
    importCodexTheme: async (request = {}) => {
      let filePath = String(request.filePath || '').trim()
      if (!filePath) {
        const selected = await open({
          title: '导入 Codex 主题包',
          directory: false,
          multiple: false,
          filters: [{ name: 'Codex 主题包', extensions: ['zip'] }],
        })
        if (!selected || Array.isArray(selected)) {
          return {
            cancelled: true,
            imported: false,
            replaceRequired: false,
            themeId: '',
            filePath: '',
          }
        }
        filePath = selected
      }
      const result = await callDesktop<GaogeDesktopCodexThemeImportResponse>(
        'gaoge_import_codex_theme',
        { filePath, replace: request.replace === true },
      )
      return { ...result, filePath }
    },
    activateCodexTheme: (themeId) => callDesktop('gaoge_activate_codex_theme', { themeId }),
    deactivateCodexTheme: () => callDesktop('gaoge_deactivate_codex_theme'),
    removeCodexTheme: (themeId) => callDesktop('gaoge_remove_codex_theme', { themeId }),
    onCodexThemeDownloadStatus: (callback) => (
      subscribeDesktopEvent('gaoge-codex-theme-download-status', callback)
    ),
    onCodexLoginProgress: (callback) => (
      subscribeDesktopEvent('gaoge-codex-login-progress', callback)
    ),
    disableCodexFuelPack: (request) => callDesktop('gaoge_disable_codex_fuel_pack', request),
    configureClaude: (request) => callDesktop('gaoge_configure_claude', request),
    disableClaudeRelay: () => callDesktop('gaoge_disable_claude_relay'),
    syncCodexSessions: () => callDesktop('gaoge_sync_codex_sessions'),
    setCodexPlugins: (request) => callDesktop('gaoge_set_codex_plugins', request),
    getCodexPluginsStatus: () => callDesktop('gaoge_get_codex_plugins_status'),
    getCodexSessionDeleteStatus: () => callDesktop('gaoge_get_codex_session_delete_status'),
    setCodexSessionDelete: (request) => callDesktop('gaoge_set_codex_session_delete', request),
    getCodexLanguageSettings: (request) => callDesktop('gaoge_get_codex_language_settings', request || {}),
    setCodexLanguage: (request) => callDesktop('gaoge_set_codex_language', request),
    getCodexInstallStatus: () => callDesktop('gaoge_get_codex_install_status'),
    installCodexApp: async () => {
      const currentStatus = await callDesktop<GaogeDesktopCodexInstallStatus>('gaoge_get_codex_install_status')
      if (currentStatus.os === 'macos' || currentStatus.manualInstall || currentStatus.os === 'linux' || !currentStatus.canInstall) {
        return callDesktop('gaoge_install_codex_app', codexRuntimeRequest())
      }
      const installPath = await open({
        title: '选择 Codex 安装位置',
        directory: true,
        multiple: false,
      })
      if (!installPath || Array.isArray(installPath)) {
        const status = await callDesktop<GaogeDesktopCodexInstallStatus>('gaoge_get_codex_install_status')
        return {
          ...status,
          state: 'cancelled',
          message: '已取消选择 Codex 安装位置。',
          progress: 0,
          canInstall: true,
        }
      }
      return callDesktop('gaoge_install_codex_app', codexRuntimeRequest({ installPath }))
    },
    cancelCodexInstall: () => callDesktop('gaoge_cancel_codex_install'),
    onCodexInstallStatus: (callback) => (
      subscribeDesktopEvent(
        'gaoge-codex-install-status',
        callback,
        () => callDesktop('gaoge_get_codex_install_status'),
      )
    ),
    openPaymentWindow: (request) => callDesktop('gaoge_open_payment_window', request),
    getUpdateStatus: () => callDesktop('gaoge_get_update_status', updateRuntimeRequest()),
    checkForUpdates: () => callDesktop('gaoge_check_for_updates', updateRuntimeRequest()),
    installUpdate: () => callDesktop('gaoge_install_update'),
    onUpdateStatus: (callback) => (
      subscribeDesktopEvent(
        'gaoge-update-status',
        callback,
        () => callDesktop('gaoge_get_update_status', updateRuntimeRequest()),
      )
    ),
    onMainWindowRestored: (callback) => (
      subscribeDesktopEvent('gaoge-main-window-restored', callback)
    ),
    downloadInvoiceFile,
  }
  window.gaogeDesktop = { ...(window.gaogeDesktop || {}), ...desktopApi }
}

installTauriDesktopApi()
