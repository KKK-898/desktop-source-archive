const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT,
  inspectCodexUltraQueryGateContent,
  isApiKeyServiceTierGateCandidate,
  isModelPickerFilterCandidate,
  patchCodexApiKeyServiceTierGateContent,
  patchCodexModelPickerFilterContent,
  patchCodexUltraQueryGateContent,
} = require('./codex-plugin-patch.cjs')

test('persistent runtime exposes the full marketplace and native thread deletion', () => {
  assert.doesNotThrow(() => new Function(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT))
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /app-server-manager-signals-/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /__gaogeCodexAppServerClient/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /"thread\/delete"/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /data-app-action-sidebar-thread-id/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /gaoge-codex-session-delete/)
  assert.ok(
    PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT.lastIndexOf('hideSessionRows(threadId);')
      < PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT.indexOf('await deleteThread(threadId);'),
    'the sidebar row must hide before the background delete request completes',
  )
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /toast\("已删除会话"\)/)
  assert.doesNotMatch(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /正在后台删除/)
  assert.ok(
    PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT.indexOf('openReplacementSession(replacementRow, threadId);')
      < PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT.indexOf('await deleteThread(threadId);'),
    'the active deleted thread must switch before the background delete request completes',
  )
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /plugin\/list/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /plugin\/install/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /nextKinds\.includes\("vertical"\)/)
  assert.doesNotMatch(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /delete next\.marketplaceKinds/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /openai-curated-remote/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /OpenAI API Curated Plugins/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /OpenAI Remote Plugins/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /OpenAI Role Plugins/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /gaoge-plugin-directory-toolbar/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /搜索插件名称、描述或关键词/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /state\.autoExpandClicks >= 80/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /setTimeout\(clickNext, 90\)/)
  assert.match(PLUGIN_MARKETPLACE_RUNTIME_UNLOCK_SCRIPT, /updatePluginDirectorySearchIndex\(result\)/)
})

test('plugin settings use backend truth and restore persisted marketplace configuration', () => {
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', '新版主题.vue'), 'utf8')
  const desktopApi = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-api.ts'), 'utf8')

  assert.match(rust, /fn gaoge_get_codex_plugins_status_inner\(\)/)
  assert.match(rust, /async fn gaoge_get_codex_plugins_status\(\)/)
  assert.match(rust, /repair_enabled_codex_plugin_configs\(\)/)
  assert.match(rust, /set_codex_marketplace_config\(&config_snapshot, &marketplace_root\)/)
  assert.match(rust, /gaoge_get_codex_plugins_status,/)
  assert.match(rust, /gaoge-plugin-directory-toolbar/)
  assert.match(rust, /state\.autoExpandClicks >= 80/)
  assert.match(desktopApi, /getCodexPluginsStatus: \(\) => callDesktop\('gaoge_get_codex_plugins_status'\)/)
  assert.match(vue, /plugins: false,/)
  assert.match(vue, /async function loadCodexPluginsStatus/)
  assert.match(vue, /persistSettingToggle\('plugins',/)
  assert.doesNotMatch(vue, /plugins: localStorage\.getItem\(settingStorageKeys\.plugins\) === 'true'/)
})

test('Codex session manager keeps scan, batch delete, and export wired end to end', () => {
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', '新版主题.vue'), 'utf8')
  const desktopApi = fs.readFileSync(path.join(__dirname, '..', 'src', 'desktop-api.ts'), 'utf8')
  const envTypes = fs.readFileSync(path.join(__dirname, '..', 'src', 'env.d.ts'), 'utf8')

  assert.match(rust, /fn gaoge_list_codex_sessions_inner\(\)/)
  assert.match(rust, /fn gaoge_delete_codex_sessions_inner\(request: Value\)/)
  assert.match(rust, /fn gaoge_export_codex_sessions_inner\(request: Value\)/)
  assert.match(rust, /fn read_managed_codex_native_metadata/)
  assert.match(rust, /"thread-project-assignments"/)
  assert.match(rust, /target\.dir\.join\("session_index\.jsonl"\)/)
  assert.match(rust, /gaoge_list_codex_sessions,/)
  assert.match(rust, /gaoge_delete_codex_sessions,/)
  assert.match(rust, /gaoge_export_codex_sessions,/)
  assert.match(desktopApi, /listCodexSessions: \(\) => callDesktop\('gaoge_list_codex_sessions'\)/)
  assert.match(desktopApi, /deleteCodexSessions: \(request\) => callDesktop\('gaoge_delete_codex_sessions', request\)/)
  assert.match(desktopApi, /exportCodexSessions: async \(sessionIds\)/)
  assert.match(envTypes, /interface GaogeDesktopCodexManagedSession/)
  assert.match(envTypes, /listCodexSessions\?\(\): Promise<GaogeDesktopCodexSessionsResponse>/)
  assert.match(vue, /secondaryActionText: '管理会话'/)
  assert.match(vue, /async function openCodexSessionManager\(\)/)
  assert.match(vue, /async function deleteManagedCodexSessions/)
  assert.match(vue, /async function exportManagedCodexSessions/)
  assert.match(vue, /project\.kind === 'native'/)
  assert.match(vue, /session\.rawAvailable/)
})

test('Codex login commits the core route before optional enhancements and relaunches only after a confirmed exit', () => {
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const start = rust.indexOf('fn gaoge_configure_codex_inner(')
  const end = rust.indexOf('#[tauri::command]', start)
  assert.ok(start >= 0 && end > start)
  const login = rust.slice(start, end)

  assert.doesNotMatch(login, /run_plugin_patch\s*\(/)
  assert.doesNotMatch(login, /run_plugin_cdp_fallback\s*\(/)
  assert.match(login, /prepare_codex_enhancements\(&app,\s*false\)/)
  assert.doesNotMatch(login, /enhance_codex_model_picker_bounded\s*\(/)
  assert.match(login, /sync_codex_route_targets_resilient\(CODEX_DIRECT_PROVIDER_ID,\s*true\)/)
  assert.doesNotMatch(login, /queue_codex_session_sync/)
  assert.doesNotMatch(login, /queue_codex_model_picker_enhancement/)
  assert.match(login, /match enhance_codex_model_picker\(running_app_dirs\.clone\(\), None\)/)
  assert.match(login, /launch_prepared_codex_with_target\(running_app_dirs, enhancement_preparation, patched_app_dir\)/)
  assert.match(login, /"routeConfigured": true/)
  assert.match(login, /Some\(&model_catalog_plan\)/)
  assert.match(login, /Some\(&model_catalog\)/)
  assert.doesNotMatch(login, /catalog_plan_for_write/)
  assert.ok(
    login.indexOf('configure_codex_route_targets_with_resolved_catalog(') < login.indexOf('prepare_codex_enhancements(&app, false)'),
    'the required route must be committed before optional enhancements are prepared',
  )
  assert.ok(
    login.indexOf('configure_codex_route_targets_with_resolved_catalog(') < login.indexOf('sync_codex_route_targets_resilient('),
    'session migration must run after the selected route is written',
  )
  assert.ok(
    login.indexOf('sync_codex_route_targets_resilient(') < login.indexOf('launch_prepared_codex_with_target('),
    'Codex must launch only after route and session migration complete',
  )
  assert.match(login, /core_failure_with_normal_launch/)
  assert.match(login, /requested_account_key/)
  assert.match(login, /commit_codex_account_activation/)
  assert.match(rust, /disable_codex_plugin_after_failure/)
  assert.match(rust, /disable_codex_session_delete_after_failure/)
  assert.match(rust, /fallback_to_normal_codex_launch/)
  assert.match(rust, /async fn gaoge_restart_codex/)
  assert.match(rust, /async fn gaoge_get_codex_launch_target/)
  assert.match(rust, /async fn gaoge_set_codex_launch_target/)
  assert.match(rust, /fn launch_codex_normally_and_wait\(/)
  assert.match(rust, /wait_for_codex_app_ready\(/)
  assert.match(rust, /fn cdp_page_target_priority\(/)
  assert.match(rust, /initialroute=%2favatar-overlay/)
  assert.match(rust, /\.min_by_key\(cdp_page_target_priority\)/)
  const prepareStart = rust.indexOf('fn prepare_codex_enhancements(')
  const prepareEnd = rust.indexOf('fn launch_codex_cdp_target(', prepareStart)
  const prepare = rust.slice(prepareStart, prepareEnd)
  assert.ok(
    prepare.indexOf('bootstrap_codex_plugin_marketplace(app, allow_plugin_download)') < prepare.indexOf('stop_codex_session_delete_bridge()'),
    'plugin configuration must be prepared before session deletion runtime state',
  )
  const toggle = rust.slice(rust.indexOf('fn gaoge_set_codex_plugins_inner_v2('), rust.indexOf('fn codex_plugin_active_debug_port('))
  assert.doesNotMatch(toggle, /stop_prepare_and_launch|stop_codex_app|launch_codex/)
  assert.match(toggle, /runtime\.configure/)
  assert.match(toggle, /\"codexClosed\": false/)
  assert.match(rust, /stop_prepare_and_launch_codex_with_options\(app,\s*false,\s*&\[\]\)/)
  assert.match(rust, /stop_prepare_and_launch_codex_with_options\(&app,\s*false,\s*&retired_app_dirs\)/)
  const windowsStopStart = rust.indexOf('fn stop_codex_app_with_additional_target(additional_app_dir: Option<&Path>) -> bool')
  const windowsStopEnd = rust.indexOf('fn terminate_windows_codex_process(process: &RunningCodexProcess) -> bool', windowsStopStart)
  assert.ok(windowsStopStart >= 0 && windowsStopEnd > windowsStopStart)
  const windowsStop = rust.slice(windowsStopStart, windowsStopEnd)
  assert.match(windowsStop, /terminate_windows_codex_process\(&process\)/)
  assert.doesNotMatch(windowsStop, /taskkill[\s\S]*"\/T"/)
  assert.match(rust, /fn should_run_startup_codex_session_sync\(running_app_dirs: &\[PathBuf\]\) -> bool/)
  assert.match(rust, /running_app_dirs\.is_empty\(\)/)
  assert.match(rust, /match gaoge_sync_codex_sessions_on_startup_inner\(\)/)
  assert.match(rust, /"reason": "codex_running"/)
  assert.match(rust, /json_string_field_range\(line_bytes,\s*"model_provider"/)
  assert.match(rust, /rolloutCacheHits/)
  assert.match(rust, /write_rollout_scan_cache\(&mut cache\)/)

  const prewriteStart = rust.indexOf('fn prewrite_codex_native_fallback_current_dir(')
  const prewriteEnd = rust.indexOf('fn prewrite_codex_native_fallback_route_targets(', prewriteStart)
  const prewrite = rust.slice(prewriteStart, prewriteEnd)
  assert.match(prewrite, /codex_marketplace_config_without_download/)
  assert.doesNotMatch(prewrite, /ensure_codex_marketplace_config\s*\(/)

  const configureStart = rust.indexOf('fn configure_codex_current_dir(')
  const configureEnd = rust.indexOf('#[cfg_attr(not(test)', configureStart)
  const configure = rust.slice(configureStart, configureEnd)
  assert.match(configure, /codex_marketplace_config_without_download/)
  assert.doesNotMatch(configure, /ensure_codex_marketplace_config\s*\(/)
  assert.doesNotMatch(configure, /sync_sessions\s*\(/)
  assert.match(configure, /"status": "pending"/)
  assert.match(configure, /"backupPath": Value::Null/)
  assert.match(rust, /"effort": "low"/)
  assert.match(rust, /"effort": "xhigh"/)

  assert.match(rust, /MODEL_FETCH_TIMEOUT_SECS: u64 = 6/)
  assert.match(rust, /PROVIDER_LATENCY_TIMEOUT_SECS: u64 = 8/)

  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', '新版主题.vue'), 'utf8')
  assert.match(vue, /resolveCodexModelSelection\(/)
  assert.match(vue, /restartCodexForActivePage/)
  assert.doesNotMatch(vue, /activeTool\.value !== 'codex' \|\| !isCodexRelayActive\.value/)
  assert.match(vue, /accountKey: target\.accountKey/)
  assert.match(vue, /applyCodexEnhancementResults\(disabled\.enhancements \|\| disabled\.launch\)/)
  assert.match(vue, /selectCodexLaunchTarget/)
  assert.doesNotMatch(vue, /await verifyCodexSelectedModel/)
  assert.doesNotMatch(vue, /Promise\.race\(\[operation, timeout\]\)/)
  assert.doesNotMatch(vue, /Codex (?:配置操作|增强等待)超过 90 秒/)
})

test('image-only models stay out of Codex conversations without disabling image generation', () => {
  const capabilities = fs.readFileSync(
    path.join(__dirname, '..', 'src-tauri', 'src', 'model_capabilities.rs'),
    'utf8',
  )
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', '新版主题.vue'), 'utf8')

  assert.match(capabilities, /"image-2\.5-flare"/)
  assert.match(capabilities, /"image-2\.5-sunburst"/)
  assert.match(rust, /\.filter\(\|model\| is_codex_conversation_model\(model\)\)/)
  assert.match(rust, /normalize_aggregate_conversation_state/)
  assert.match(vue, /function extractCodexConversationModelNames/)
  assert.match(vue, /selectCodexConversationModel\(availableModels, previousModel\)/)
  assert.match(vue, /model: image2Model\.value/)
  assert.match(vue, /gpt-image-2\.5-flare/)
  assert.match(vue, /gpt-image-2\.5-sunburst/)
  assert.match(vue, /gpt-image-2/)
})

test('frontend image filtering recognizes full model IDs, routed IDs and dated snapshots', () => {
  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', '新版主题.vue'), 'utf8')
  const constants = vue.match(/const CODEX_IMAGE_GENERATION_MODEL_RELEASES = \[[\s\S]*?\]/)?.[0]
  const start = vue.indexOf('function canonicalCodexUpstreamModelName(')
  const end = vue.indexOf('function selectCodexConversationModel(', start)
  assert.ok(constants && start >= 0 && end > start)
  const ts = require('typescript')
  const source = ts.transpileModule(`${constants}\n${vue.slice(start, end)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const filter = new Function(`${source}\nreturn filterCodexConversationModels;`)()
  assert.deepEqual(filter([
    'gpt-6-astra', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
    'gaoge/openai/3/gpt-image-2.5-flare', 'GPT_IMAGE_2.5_SUNBURST',
    'gpt-image-2.5-sunburst-2026-09-21', 'image-2.5-flare', 'image-2.5-sunburst',
    'gpt-image-2.5-flare-chat', 'gpt-5.6-sol',
  ]), ['gpt-6-astra', 'gpt-image-2.5-flare-chat', 'gpt-5.6-sol'])
})

test('selecting or restoring a Codex theme verifies hot application without restarting the app', () => {
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const activateStart = rust.indexOf('fn gaoge_activate_codex_theme_inner(')
  const deactivateEnd = rust.indexOf(
    'async fn gaoge_remove_codex_theme',
    activateStart,
  )
  assert.ok(activateStart >= 0 && deactivateEnd > activateStart)
  const themeActions = rust.slice(activateStart, deactivateEnd)

  assert.match(themeActions, /codex_themes::activate_theme/)
  assert.match(themeActions, /codex_themes::deactivate_theme/)
  assert.match(themeActions, /codex_theme_mutation_response/)
  assert.match(themeActions, /start_codex_runtime_watcher/)
  const stateStart = rust.indexOf("fn codex_theme_runtime_state(")
  const stateEnd = rust.indexOf("fn codex_theme_mutation_response(", stateStart)
  const themeState = rust.slice(stateStart, stateEnd)
  assert.match(themeState, /await controller\.apply/)
  assert.match(themeState, /codex_theme_status::response/)
  assert.doesNotMatch(themeState, /stop_codex_app|launch_codex|location\.reload/)
  assert.doesNotMatch(themeActions, /stop_prepare_and_launch_codex/)
  assert.doesNotMatch(themeActions, /stop_codex_app/)

  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', '新版主题.vue'), 'utf8')
  const applyStart = vue.indexOf('async function previewCodexThemeDownload(')
  const applyEnd = vue.indexOf('function handleCodexThemeDownloadStatus(', applyStart)
  const themeUi = vue.slice(applyStart, applyEnd)
  assert.match(themeUi, /applyCodexThemeActionFeedback/)
  assert.doesNotMatch(themeUi, /选择成功，请在软件内点击“重启 Codex”后生效/)
  assert.doesNotMatch(themeUi, /confirmCodexRestart/)
  assert.doesNotMatch(themeUi, /Codex 已重新打开/)
})

test('Codex themes preserve native appearance and adapt the upstream QQ 2007 structure', () => {
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const start = rust.indexOf('async function installThemeRuntime(theme)')
  const end = rust.indexOf('const pluginEnhancementsEnabled', start)
  assert.ok(start >= 0 && end > start)
  const runtime = rust.slice(start, end)

  assert.match(runtime, /const root = await waitForDocumentRoot\(\)/)
  assert.match(runtime, /ready: false, reason: "document-root-unavailable", error: ""/)
  assert.match(runtime, /captureNativeAppearance/)
  assert.match(runtime, /restoreNativeAppearance/)
  assert.match(runtime, /clearInlineColorVariables/)
  assert.match(runtime, /root\.classList\.remove\("electron-dark", "electron-light"\)/)
  assert.match(runtime, /attributeFilter: \["class", "style"\]/)
  assert.match(runtime, /main\[data-app-shell-main-surface\]/)
  assert.doesNotMatch(runtime, /_MainContentSurface_[A-Za-z0-9_]+/)
  assert.match(runtime, /const body = await waitForDocumentBody\(\)/)
  assert.match(runtime, /ready: false, reason: "document-body-unavailable", error: ""/)
  assert.match(runtime, /window\.__GAOGE_QQ2007_CSS__/)
  assert.match(runtime, /window\.__GAOGE_QQ2007_UPSTREAM_COMMIT__/)
  assert.match(runtime, /window\.__GAOGE_QQ2007_ASSETS__/)
  assert.match(runtime, /qq2007-upstream-assets-unavailable/)
  assert.doesNotMatch(runtime, /encodeSvg/)
  assert.match(runtime, /codex-dream-skin-chrome/)
  assert.match(runtime, /data-dream-skin-mode", "qq2007"/)
  assert.match(runtime, /class="ds2007-toolbar"/)
  assert.match(runtime, /data-nav="新建任务"/)
  assert.match(runtime, /data-nav="已安排"/)
  assert.match(runtime, /data-nav="插件"/)
  assert.match(runtime, /data-nav="站点"/)
  assert.match(runtime, /data-nav="拉取请求"/)
  assert.match(runtime, /data-nav="聊天"/)
  assert.doesNotMatch(runtime, /data-nav="换肤"/)
  assert.match(runtime, /class="ds2007-open-location-proxy"/)
  assert.match(runtime, /new PointerEvent\("pointerdown"/)
  assert.match(runtime, /new PointerEvent\("pointerup"/)
  assert.match(runtime, /class="ds2007-friends"/)
  assert.match(runtime, /class="ds2007-assistant-card"/)
  assert.match(runtime, /class="ds2007-quick-actions"/)
  assert.match(runtime, /class="ds2007-friend-list"/)
  assert.match(runtime, /class="ds2007-qqshow-card"/)
  assert.match(runtime, /data-ds2007-friend-search/)
  assert.doesNotMatch(runtime, /流畅模式/)
  assert.doesNotMatch(runtime, /ds2007-profile-signature/)
  assert.match(runtime, /markSidebar/)
  assert.match(runtime, /markComposer/)
  assert.match(runtime, /let nativeRightRequested = null/)
  assert.match(runtime, /const activateNativeControl = \(target\) =>/)
  assert.match(runtime, /const nativeFloatingDock = \(\) =>/)
  assert.match(runtime, /const nativeInlineDock = \(\) =>/)
  assert.match(runtime, /data-app-shell-focus-area="right-panel"/)
  assert.match(runtime, /thread-summary-panel-item-button/)
  assert.match(runtime, /thread-floating-content-top-inset/)
  assert.match(runtime, /const nativeDockLayout = \(dock\) =>/)
  assert.match(runtime, /const nativeRightCloseSelector = \[/)
  assert.match(runtime, /Close review tab/)
  assert.match(
    runtime,
    /activateNativeControl\(passiveDock\?\.querySelector\(nativeRightCloseSelector\)\)/,
  )
  assert.match(runtime, /const explicitEnvironment = nativeRightRequested === true/)
  assert.match(runtime, /const explicitFriends = nativeRightRequested === false/)
  assert.match(runtime, /data-ds2007-native-dock-suppressed/)
  assert.match(runtime, /currentLayout !== "floating" && currentLayout !== "pending"/)
  assert.match(runtime, /event\.isTrusted/)
  assert.match(runtime, /nativeRightRequested !== false/)
  assert.match(runtime, /nativeReviewTrigger/)
  assert.match(runtime, /return "inline"/)
  assert.match(runtime, /data-ds2007-native-right-layout/)
  assert.match(runtime, /data-ds2007-native-dock-layout/)
  assert.match(runtime, /qqObserver\.observe\(body, \{ childList: true, subtree: true \}\)/)
  assert.match(runtime, /qqDispose/)

  assert.match(
    rust,
    /include_bytes!\("\.\.\/\.\.\/theme-resources\/vendor\/codex-qq-2007-assets\/qq2007-icons\.png"\)/,
  )
  assert.match(
    rust,
    /include_bytes!\("\.\.\/\.\.\/theme-resources\/vendor\/codex-qq-2007-assets\/assistant\.png"\)/,
  )
  assert.match(
    rust,
    /include_bytes!\("\.\.\/\.\.\/theme-resources\/vendor\/codex-qq-2007-assets\/qq-show\.png"\)/,
  )

  const qqCss = fs.readFileSync(
    path.join(__dirname, '..', 'theme-resources', 'vendor', 'codex-qq-2007-deep.css'),
    'utf8',
  )
  assert.match(qqCss, /zhangjanice66\/Codex-QQ-2007/)
  assert.match(qqCss, /grid-template-rows:/)
  assert.match(qqCss, /\.ds2007-toolbar/)
  assert.match(qqCss, /\.ds2007-toolbar > \.ds2007-open-location-proxy/)
  assert.match(qqCss, /z-index: 31/)
  assert.match(qqCss, /button:not\(\.ds2007-open-location-proxy\)/)
  assert.match(qqCss, /aside\.app-shell-left-panel/)
  assert.match(qqCss, /main\.main-surface/)
  assert.match(qqCss, /\.ds2007-app-root > div:has\(main\.main-surface\)/)
  assert.match(qqCss, /\.composer-surface-chrome/)
  assert.match(qqCss, /\.ds2007-friends/)
  assert.match(qqCss, /\.ds2007-qqshow-media/)
  assert.match(qqCss, /\.ds2007-statusbar/)
  assert.match(qqCss, /data-ds2007-native-dock-layout="inline"/)
  assert.match(qqCss, /data-ds2007-native-dock-layout="floating"/)
  assert.match(qqCss, /data-ds2007-native-dock-suppressed="true"/)
  assert.match(
    qqCss,
    /data-ds2007-native-dock-layout="inline"\]\s*>\s*\.absolute\.inset-0\s*>\s*\.absolute\.left-0\s*\{[^}]*width:\s*100%\s*!important;[^}]*min-width:\s*0\s*!important;[^}]*max-width:\s*100%\s*!important;/s,
  )
  assert.match(
    qqCss,
    /data-ds2007-native-right-layout="inline"\] body\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*28px;/s,
  )
  assert.match(
    qqCss,
    /data-ds2007-native-right-layout="floating"\] body,[\s\S]*data-ds2007-native-right-layout="pending"\] body\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--ds2007-friend-width\);/,
  )
  assert.match(
    qqCss,
    /data-ds2007-native-dock="true"\]\[data-ds2007-native-dock-layout="floating"\]\s*\{[^}]*position:\s*fixed\s*!important;[^}]*width:\s*calc\(var\(--ds2007-friend-width\)\s*-\s*10px\)\s*!important;/s,
  )
  assert.match(qqCss, /opacity:\s*1\s*!important;[\s\S]*transform:\s*none\s*!important;/)
  assert.match(qqCss, /@media \(max-width: 959px\)/)
  assert.match(qqCss, /@media \(max-width: 720px\)/)
  assert.match(
    qqCss,
    /@media \(max-width: 720px\)[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*!important;/,
  )
  assert.match(qqCss, /@media \(max-height: 720px\)/)
  assert.match(qqCss, /prefers-reduced-motion/)

  const definitions = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'theme-resources', 'themes.json'), 'utf8'),
  )
  const qq = definitions.themes.find((theme) => theme.id === 'qq-retro')
  assert.equal(qq.runtime, 'qq-retro')
  assert.equal(qq.version, '1.3.0')
  assert.equal(qq.sourceFile, 'qq-2007-deep.svg')
  assert.equal(qq.source.kind, 'community')
  assert.equal(qq.source.commit, 'ef88c712c5e919e12bff5c714fe1517e9d3a03a4')
  assert.match(qq.source.sha256, /^[a-f0-9]{64}$/)
  assert.ok(fs.existsSync(path.join(
    __dirname,
    '..',
    'theme-resources',
    'licenses',
    'codex-qq-2007-LICENSE.txt',
  )))
  assert.ok(fs.existsSync(path.join(
    __dirname,
    '..',
    'theme-resources',
    'licenses',
    'codex-qq-2007-NOTICE.md',
  )))
  const assetProvenancePath = path.join(
    __dirname,
    '..',
    'theme-resources',
    'licenses',
    'codex-qq-2007-ASSET-PROVENANCE.md',
  )
  assert.ok(fs.existsSync(assetProvenancePath))

  const expectedAssets = new Map([
    ['qq2007-icons.png', '1ec9533230a8ac61a2a4b0dd13d869b590a1c2b590e33bd3821f7daf21c9c19b'],
    ['assistant.png', '080718881233301fb93e3b52cbcda7a62ab21159beacd4ac46fc59a048443f13'],
    ['qq-show.png', 'c6a7530cf8410c85c664ea94a7809a1bab885da47d74429afc70ece235da9681'],
  ])
  const assetDir = path.join(
    __dirname,
    '..',
    'theme-resources',
    'vendor',
    'codex-qq-2007-assets',
  )
  const provenance = fs.readFileSync(assetProvenancePath, 'utf8')
  for (const [name, expectedHash] of expectedAssets) {
    const assetPath = path.join(assetDir, name)
    assert.ok(fs.existsSync(assetPath), `${name} must be present`)
    const actualHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(assetPath))
      .digest('hex')
    assert.equal(actualHash, expectedHash)
    assert.match(provenance, new RegExp(name.replace('.', '\\.')))
    assert.match(provenance, new RegExp(expectedHash))
  }

  const themeBuilder = fs.readFileSync(
    path.join(__dirname, 'build-codex-themes.mjs'),
    'utf8',
  )
  assert.match(themeBuilder, /codex-qq-2007-ASSET-PROVENANCE\.md/)
  assert.ok(
    definitions.themes
      .filter((theme) => theme.id !== 'qq-retro')
      .every((theme) => theme.runtime === 'wallpaper' && /^[a-f0-9]{64}$/.test(theme.source.sha256)),
  )
})

test('official restoration and optional CDP features degrade while required guards prevent normal fallback', () => {
  // Source anchors must behave identically in LF and Windows CRLF checkouts.
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8').replace(/\r\n/g, '\n')
  const start = rust.indexOf('fn gaoge_disable_codex_fuel_pack_inner_with_restore(')
  const end = rust.indexOf('\n#[tauri::command]\nasync fn gaoge_disable_codex_fuel_pack(', start)
  assert.ok(start >= 0 && end > start)
  const restore = rust.slice(start, end)

  assert.match(restore, /let _operation = lock_codex_foreground_operation\(\)\?;/)
  const lockStart = rust.indexOf('fn lock_codex_foreground_operation()')
  const lockEnd = rust.indexOf('\nfn random_session_helper_token()', lockStart)
  assert.ok(lockStart >= 0 && lockEnd > lockStart)
  const foregroundLock = rust.slice(lockStart, lockEnd)
  assert.match(foregroundLock, /lock_codex_foreground_operation_with_timeout\(&CODEX_CONFIGURE_LOCK,/)
  assert.match(foregroundLock, /CodexConfigureActivityGuard::start\(\)/)
  assert.match(foregroundLock, /mutex\.try_lock\(\)/)
  assert.match(foregroundLock, /try_acquire_codex_lock\("configure"\)\?/)
  assert.match(restore, /sync_codex_route_targets_resilient\("openai", true\)/)
  assert.match(restore, /prepare_codex_enhancements\(&app, false\)/)
  assert.match(restore, /launch_prepared_codex/)
  assert.match(restore, /"codexLaunched"/)
  assert.match(restore, /core_failure_with_normal_launch/)
  assert.match(
    rust,
    /fn gaoge_disable_codex_fuel_pack_inner_with_restore\([\s\S]*?gaoge_disable_codex_fuel_pack_inner_with_recovery\(app, restore_account_key, false\)/,
  )
  assert.match(rust, /async fn gaoge_disable_codex_fuel_pack\([\s\S]*?request: Option<Value>/)
  assert.match(rust, /gaoge_disable_codex_fuel_pack_inner_with_recovery\(app, None, force_official\)/)

  assert.match(rust, /let themeResult;\s*try \{\s*themeResult = await installThemeRuntime/s)
  assert.match(rust, /let pluginRuntime = null;[\s\S]*?try \{\s*pluginRuntime = installCodexPluginRuntime\(/)
  assert.match(rust, /const pluginResult = pluginRuntime\?\.status\?\.\(\) \|\| \{/)
  assert.match(rust, /let sessionDeleteError = "";\s*try \{\s*sessionDeleteRuntime = await installSessionDeleteRuntime/s)
  assert.match(rust, /pluginError: pluginResult\.error \|\| ""/)
  assert.match(rust, /sessionDeleteError,/)
  assert.match(rust, /gaoge_activate_codex_account_and_restart_inner\(\s*app,/)
  assert.match(rust, /preferred_running_codex_app_dir/)
  assert.match(rust, /codex_refresh_failure_requires_reauth/)
  assert.match(rust, /已保留现有登录状态，请稍后重试/)
  assert.match(rust, /已保留通过系统应用标识启动的普通实例/)
  assert.doesNotMatch(
    rust.slice(
      rust.indexOf('fn launch_codex_cdp_target('),
      rust.indexOf('fn codex_effective_launch_path(', rust.indexOf('fn launch_codex_cdp_target(')),
    ),
    /launch_codex_executable_with_cdp/,
  )

  const launchStart = rust.indexOf('fn launch_prepared_codex_with_target(')
  const launchEnd = rust.indexOf('\nfn stop_prepare_and_launch_codex_with_options(', launchStart)
  assert.ok(launchStart >= 0 && launchEnd > launchStart)
  const launch = rust.slice(launchStart, launchEnd)
  assert.match(launch, /let api_coding_mode_requested = codex_api_coding_mode_enabled\(\);/)
  assert.match(launch, /let runtime_requested = [\s\S]*?\|\| api_coding_mode_requested\s*\|\| codex_account_balance_enabled\(\);/)
  const failureBranches = [...launch.matchAll(
    /Err\(error\) => \{\s*disable_shared_codex_enhancements\(&mut preparation, &error\);([\s\S]*?)\n        \}/g,
  )]
  assert.equal(failureBranches.length, 2, 'port allocation and CDP launch failures both need guarded fallback')
  for (const [, branch] of failureBranches) {
    const guard = branch.match(
      /^\s*if model_transition_guard_requested \|\| api_coding_mode_requested \{([\s\S]*?)\n            \}\s*let fallback = launch_codex_normally_and_wait\(&app_dir\);([\s\S]*)$/,
    )
    assert.ok(guard, 'required guards must be checked before any normal fallback')
    assert.match(guard[1], /return codex_launch_result\(\s*&preparation,\s*false,\s*"cdp-required",[\s\S]*?warnings,\s*None,\s*\);\s*$/)
    assert.doesNotMatch(guard[1], /launch_codex_normally_and_wait|fallback_to_normal_codex_launch/)
    assert.match(guard[2], /codex_launch_result\(\s*&preparation,\s*fallback\.is_ok\(\),\s*"fallback-normal",/)
    assert.match(guard[2], /if let Err\(fallback_error\) = &fallback \{\s*warnings\.push\(fallback_error\.clone\(\)\);\s*\}/)
  }

  const vue = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', '新版主题.vue'), 'utf8')
  assert.match(vue, /confirmCodexRestart\('授权成功后立即切换 Codex 账号'\)/)
  assert.match(vue, /const returnedState = await desktopApi!\.getCodexAccounts\(\)\s*const verifiedState = normalizeCodexAccountsState\(returnedState\)\s*codexAccountsState\.value = verifiedState/)
  assert.match(vue, /const verifiedAccount = normalizeCodexAccount\(verifiedState\.currentAccount\)/)
  assert.match(vue, /if \(!verifiedAccount \|\| verifiedAccount\.accountKey !== options\.accountKey\) \{\s*codexFuelIdentityRejected = true\s*throw new Error/)
  assert.match(vue, /const returnedAccount = returnedState\.currentAccount as unknown as Record<string, unknown>[\s\S]*?code: returnedAccount\?\.code \?\? returnedAccount\?\.errorCode \?\? returnedAccount\?\.reauthCode/)
  assert.match(vue, /账号登录状态校验失败/)
  assert.match(vue, /Codex 未能自动重新打开/)
  assert.match(vue, /isCodexLoginRelayActive/)
  assert.match(vue, /closeCodexRelayFromLoginPage/)
  assert.match(vue, /isGaogeCodexRelayBaseUrl/)
  assert.match(vue, /关闭登录/)
  assert.match(vue, /confirmCodexRestart\('强制官方'\)/)
  assert.doesNotMatch(vue, /回到官方账号/)
})

test('existing-account fuel waits for and normalizes the fresh native account result before success', async () => {
  const { harness, account, deferred, tick } = await import('./codex-account-route-harness.mjs')
  const pendingRead = deferred()
  const rawState = { currentAccount: account('B'), accounts: [account('B')] }
  const normalizedState = { ...rawState, normalized: true }
  const h = harness({ api: { getCodexAccounts: () => pendingRead.promise } })
  const normalizedInputs = []
  h.state.normalizeCodexAccountsState = (value) => { normalizedInputs.push(value); return normalizedState }
  const connecting = h.connectTool('codex', { accountKey: 'B' })
  await tick()
  assert.equal(h.calls.filter(([kind]) => kind === 'configure').length, 1)
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.equal(h.state.fuelPackAccountKey.value, '')
  assert.equal(h.calls.some(([kind, , tone]) => kind === 'notify' && tone === 'success'), false)
  pendingRead.resolve(rawState)
  await connecting
  assert.deepEqual(normalizedInputs, [rawState])
  assert.equal(h.state.codexAccountsState.value.normalized, true)
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  assert.equal(h.store.get('gaoge_desktop_fuel_pack_account_key'), 'B')
  assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
  assert.equal(h.state.toolNotices.value.codex, '加油成功')
  assert.equal(h.calls.filter(([kind, message, tone]) => kind === 'notify' && message === '加油成功' && tone === 'success').length, 1)
})

test('existing-account fuel never claims success when the fresh account read fails or changes identity', async (t) => {
  const { harness, account } = await import('./codex-account-route-harness.mjs')
  const cases = [
    ['read failure', async () => { throw Error('native account read failed') }],
    ['missing current account', async () => ({ currentAccount: null, accounts: [account('B')] })],
    ['different current account', async () => ({ currentAccount: account('A'), accounts: [account('B')] })],
  ]
  for (const [name, getCodexAccounts] of cases) {
    await t.test(name, async () => {
      const h = harness({ api: { getCodexAccounts } })
      await h.connectTool('codex', { accountKey: 'B' })
      assert.equal(h.state.toolNotices.value.codex, '')
      assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
      assert.equal(h.isCodexFuelRecoveryAvailable.value, true, 'a written route must remain recoverable')
      assert.match(h.state.toolErrors.value.codex, /未能确认加油成功/)
      assert.equal(h.calls.some(([kind, , tone]) => kind === 'notify' && tone === 'success'), false)
      assert.equal(h.state.isToolConnecting.value.codex, false)
    })
  }
})

test('existing-account fuel retains raw native reauthentication codes after account normalization', async (t) => {
  const { harness, account } = await import('./codex-account-route-harness.mjs')
  for (const [invalid, codeField] of [[{ requiresReauth: true }, 'code'], [{ loginState: 'invalid' }, 'errorCode'], [{ canSwitch: false }, 'reauthCode']]) {
    await t.test(codeField, async () => {
      const code = 'native_account_expired'
      const rawAccount = { ...account('B'), ...invalid, [codeField]: code }
      const rawState = { currentAccount: rawAccount, accounts: [rawAccount] }
      const h = harness({ api: { getCodexAccounts: async () => rawState } })
      h.state.normalizeCodexAccountsState = (value) => {
        assert.equal(value, rawState)
        const normalizedAccount = { ...account('B'), ...invalid }
        return { currentAccount: normalizedAccount, accounts: [normalizedAccount] }
      }
      await h.connectTool('codex', { accountKey: 'B' })
      const dialogs = h.calls.filter(([kind]) => kind === 'confirm')
      assert.equal(dialogs.length, 1)
      assert.deepEqual(Array.from(dialogs[0][2].details), [`错误码：${code}`])
      assert.equal(h.state.toolNotices.value.codex, '')
      assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
      assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
      assert.equal(h.calls.some(([kind, , tone]) => kind === 'notify' && tone === 'success'), false)
    })
  }
})

test('Codex runtime watcher never terminates or relaunches the user app', () => {
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const start = rust.indexOf('fn start_codex_runtime_watcher()')
  const end = rust.indexOf('fn load_router_state()', start)
  assert.ok(start >= 0 && end > start)
  const watcher = rust.slice(start, end)

  assert.match(watcher, /query_cdp_targets/)
  assert.match(watcher, /Err\(_\) => \{\}/)
  assert.doesNotMatch(watcher, /stop_codex_app\s*\(/)
  assert.doesNotMatch(watcher, /launch_codex_with_cdp\s*\(/)
  assert.doesNotMatch(watcher, /last_relaunch_attempt/)
})

test('provider latency check probes the selected model instead of trusting the model list', () => {
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const start = rust.indexOf('async fn gaoge_test_provider_latency(')
  const end = rust.indexOf('#[derive(Clone)]', start)
  assert.ok(start >= 0 && end > start)
  const latency = rust.slice(start, end)

  assert.match(latency, /"responses"/)
  assert.match(latency, /"model": model/)
  assert.match(latency, /"store": false/)
  assert.match(latency, /payload\.get\("error"\)/)
  assert.doesNotMatch(latency, /fetch_provider_models\s*\(/)
})

const STOCK_FILTER = [
  'import{x as y}from"./fixture.js";',
  'function r({authMethod:e,availableModels:n,defaultModel:r,enabledReasoningEfforts:i,',
  'includeUltraReasoningEffort:a,models:o,useHiddenModels:s})',
  '{let c=[],u=s&&e!==`amazonBedrock`;return o.forEach(r=>{if(u?n.has(r.model):!r.hidden)c.push(r)}),',
  '{models:c,defaultModel:c.find(e=>e.model===r)??null}}',
].join('')

test('patches exactly the model-picker destructuring key without changing bundle length', () => {
  assert.equal(isModelPickerFilterCandidate(STOCK_FILTER), true)
  const result = patchCodexModelPickerFilterContent(STOCK_FILTER)

  assert.equal(result.changed, true)
  assert.equal(result.already, false)
  assert.equal(result.content.length, STOCK_FILTER.length)
  assert.match(result.content, /models:o,useHiddenModelZ:s/)
  assert.doesNotMatch(result.content, /models:o,useHiddenModels:s/)
})

test('is idempotent when the model-picker visibility patch is already installed', () => {
  const first = patchCodexModelPickerFilterContent(STOCK_FILTER)
  assert.equal(isModelPickerFilterCandidate(first.content), true)
  const second = patchCodexModelPickerFilterContent(first.content)

  assert.equal(second.changed, false)
  assert.equal(second.already, true)
  assert.equal(second.content, first.content)
})

test('does not rewrite unrelated useHiddenModels strings', () => {
  const content = `const diagnostic="useHiddenModels";${STOCK_FILTER}`
  const result = patchCodexModelPickerFilterContent(content)

  assert.match(result.content, /diagnostic="useHiddenModels"/)
  assert.match(result.content, /models:o,useHiddenModelZ:s/)
})

test('rejects bundles that only mention the model-picker field names', () => {
  const referencesOnly = [
    'authMethod',
    'availableModels',
    'defaultModel',
    'enabledReasoningEfforts',
    'includeUltraReasoningEffort',
    'models',
    'useHiddenModels',
  ].join(';')

  assert.equal(isModelPickerFilterCandidate(referencesOnly), false)
})

test('fails closed when the model-picker signature is absent', () => {
  assert.throws(
    () => patchCodexModelPickerFilterContent('function unrelated({availableModels:e,defaultModel:t}){}'),
    /found 0/,
  )
})

test('fails closed when more than one model-picker signature is present', () => {
  assert.throws(
    () => patchCodexModelPickerFilterContent(`${STOCK_FILTER}\n${STOCK_FILTER}`),
    /found 2/,
  )
})

const installedFixture = process.env.CODEX_MODEL_PICKER_FIXTURE
const nativeFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-model-filter-26.901.js'), 'utf8')

test('26.901 uses native catalog support without modifying the model filter', () => {
  assert.equal(isModelPickerFilterCandidate(nativeFixture), true)
  const result = patchCodexModelPickerFilterContent(nativeFixture)
  assert.equal(result.nativeModelCatalog, true)
  assert.equal(result.changed, false)
  assert.equal(result.content, nativeFixture)
  const { runInNewContext } = require('node:vm')
  const filter = runInNewContext(`${nativeFixture}; bZi`)
  const options = { authMethod: 'apikey', availableModels: new Set(), hasConfiguredModelCatalog: true,
    isCustomModelProvider: true, useHiddenModels: true }
  assert.equal(filter({ ...options, model: { model: 'gaoge/openai/3/gpt-5.5', hidden: false } }), true)
  assert.equal(filter({ ...options, model: { model: 'gaoge/openai/3/private', hidden: true } }), false)
})

test('native capability detection requires the known predicate, not just new field names', () => {
  assert.throws(() => patchCodexModelPickerFilterContent(nativeFixture.replace('r&&!a.hidden', 'r&&a.hidden')), /found 0/)
  assert.throws(() => patchCodexModelPickerFilterContent(nativeFixture + nativeFixture), /found 2/)
})

const nativeDaybreakFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-model-filter-26.1007.js'), 'utf8')

test('26.1007 recognizes native catalog support without changing API Key access checks', () => {
  assert.equal(isModelPickerFilterCandidate(nativeDaybreakFixture), true)
  const result = patchCodexModelPickerFilterContent(nativeDaybreakFixture)
  assert.equal(result.nativeModelCatalog, true)
  assert.equal(result.changed, false)
  assert.equal(result.content, nativeDaybreakFixture)

  const renamed = nativeDaybreakFixture.replace(/\b([etnriaosc])\b/g, 'renamed_$1')
  const renamedResult = patchCodexModelPickerFilterContent(renamed)
  assert.equal(renamedResult.nativeModelCatalog, true)
  assert.equal(renamedResult.content, renamed)
})

test('26.1007 preserves native API Key restricted and standard model behavior', () => {
  const { runInNewContext } = require('node:vm')
  const predicate = runInNewContext(`${nativeDaybreakFixture}; jRi`)
  const options = { authMethod: 'apikey', apiKeyDaybreakSupported: false,
    availableModels: new Set(), hasConfiguredModelCatalog: true,
    isCustomModelProvider: true, useHiddenModels: true }
  const model = (programs, hidden = false) => ({ model: 'gaoge/openai/3/gpt-6-sol', hidden,
    ...(programs === undefined ? {} : { availableAccessPrograms: { cyber: programs } }) })
  for (const programs of [undefined, [], ['standard'], ['standard', 'restricted']]) {
    assert.equal(predicate({ ...options, model: model(programs) }), true)
  }
  const restricted = model(['restricted'])
  assert.equal(predicate({ ...options, model: restricted }), false)
  assert.equal(predicate({ ...options, model: restricted,
    additionalAvailableModels: new Set([restricted.model]) }), false)
  assert.equal(predicate({ ...options, apiKeyDaybreakSupported: true, model: restricted }), true)
  assert.equal(predicate({ ...options, authMethod: 'chatgpt', model: restricted }), true)
  assert.equal(predicate({ ...options, apiKeyDaybreakSupported: true,
    model: model(['restricted'], true) }), false)
  assert.equal(predicate({ ...options, model: { ...model(['standard']), model: 'codex-auto-review' } }), false)

  // The new native branch permits visible restricted API models without a
  // configured catalog, only when API Key Daybreak support is enabled.
  const nativeOptions = { ...options, hasConfiguredModelCatalog: false, isCustomModelProvider: false }
  assert.equal(predicate({ ...nativeOptions, apiKeyDaybreakSupported: true, model: restricted }), true)
  assert.equal(predicate({ ...nativeOptions, model: restricted }), false)
  assert.equal(predicate({ ...nativeOptions, apiKeyDaybreakSupported: true, model: model(['standard']) }), false)
  assert.equal(predicate({ ...nativeOptions, authMethod: 'chatgpt', apiKeyDaybreakSupported: true,
    model: restricted }), false)
})

test('26.1007 rejects changed access checks, unknown signatures and ambiguous native predicates', () => {
  const mutations = [
    ['n===`apikey`&&!t&&', 'n===`apikey`&&t&&'],
    ['c.includes(`standard`)', 'c.includes(`restricted`)'],
    ['availableAccessPrograms?.cyber', 'availableAccessPrograms?.other'],
    ['i&&!o.hidden', 'i&&o.hidden'],
    ['c?.some(e=>e!==`standard`)', 'c?.some(e=>e===`standard`)'],
    ['apiKeyDaybreakSupported:t,authMethod:n', 'apiKeyDaybreakSupported:t,unknownField:z,authMethod:n'],
    ['apiKeyDaybreakSupported:t,authMethod:n', 'apiKeyDaybreakSupported:t,apiKeyDaybreakSupported:z,authMethod:n'],
    ['let c=o.availableAccessPrograms?.cyber;', 'let c=o.availableAccessPrograms?.cyber;unsafeSideEffect();'],
  ]
  for (const [before, after] of mutations) {
    assert.ok(nativeDaybreakFixture.includes(before), before)
    const changed = nativeDaybreakFixture.replaceAll(before, after)
    assert.equal(isModelPickerFilterCandidate(changed), false, before)
    assert.throws(() => patchCodexModelPickerFilterContent(changed), /found 0/, before)
  }
  assert.throws(() => patchCodexModelPickerFilterContent(nativeDaybreakFixture + nativeDaybreakFixture), /found 2/)
  assert.throws(() => patchCodexModelPickerFilterContent(nativeFixture + nativeDaybreakFixture), /found 2/)
})

const nativeUltraQueryFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-ultra-query-26.1007.js'), 'utf8')

function evaluateNativeUltraQuery(source, options = {}) {
  const { runInNewContext } = require('node:vm')
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  const allowedEfforts = options.allowedEfforts ?? efforts
  const query = runInNewContext(`${nativeDaybreakFixture}\n${source}\nnativeUltraQuery26_1007`, {
    Pd: null, GRi: 'efforts', BRi: 'availability', kc: 'gate', Ie: 'hosts',
    Qg: { FIVE_MINUTES: 300000 }, yee: () => ['model/list'],
    yte: (effort) => efforts.includes(effort),
  })
  const config = query({ additionalAvailableModels: [], authMethod: 'apikey',
    enabledReasoningEfforts: allowedEfforts, hasConfiguredModelCatalog: true,
    hostId: 'local', includeUltraReasoningEffort: true, isCustomModelProvider: true,
    limit: 100, modelCatalogPath: 'custom-catalog.json', modelProvider: 'custom',
    ...options.args,
  }, {
    get: (signal, gate) => {
      if (signal === 'gate') {
        assert.equal(gate, '1186680773')
        return options.remoteGate ?? false
      }
      if (signal === 'availability') return { availableModels: new Set(), defaultModel: 'gpt-6-sol', useHiddenModels: false }
      if (signal === 'hosts') return ['local']
      if (signal === 'efforts') return new Set(allowedEfforts)
      throw new Error(`Unexpected native query signal: ${signal}`)
    }, queryClient: {}, scope: {},
  })
  return config.select({ data: [{ model: 'gpt-6-sol', hidden: false,
    supportedReasoningEfforts: (options.modelEfforts ?? efforts).map(reasoningEffort => ({ reasoningEffort })),
    ...options.model,
  }] })
}

test('26.1007 Ultra query adapter restores only configured custom API Key catalogs', () => {
  const patched = patchCodexUltraQueryGateContent(nativeUltraQueryFixture)
  assert.equal(patched.changed, true)
  assert.equal(patched.ultraReasoningPatched, true)
  const efforts = (source, options) => Array.from(evaluateNativeUltraQuery(source, options).models[0].supportedReasoningEfforts,
    ({ reasoningEffort }) => reasoningEffort)
  const throughMax = ['low', 'medium', 'high', 'xhigh', 'max']
  assert.deepEqual(efforts(nativeUltraQueryFixture), throughMax)
  assert.deepEqual(efforts(patched.content), [...throughMax, 'ultra'])
  for (const args of [{ authMethod: 'chatgpt' }, { authMethod: 'amazonBedrock' },
    { isCustomModelProvider: false }, { hasConfiguredModelCatalog: false }, { includeUltraReasoningEffort: false }]) {
    assert.deepEqual(efforts(patched.content, { args }), throughMax, JSON.stringify(args))
  }
  assert.deepEqual(efforts(patched.content, { args: { authMethod: 'copilot' } }), ['medium'])
  assert.deepEqual(efforts(patched.content, { allowedEfforts: throughMax }), throughMax)
  assert.deepEqual(efforts(patched.content, { modelEfforts: throughMax }), throughMax)
  assert.deepEqual(efforts(patched.content, { remoteGate: true, args: { authMethod: 'chatgpt', isCustomModelProvider: false } }), [...throughMax, 'ultra'])
  assert.deepEqual(efforts(patched.content, { remoteGate: true, args: { includeUltraReasoningEffort: false } }), throughMax)
  assert.equal(evaluateNativeUltraQuery(patched.content, { model: { availableAccessPrograms: { cyber: ['restricted'] } } }).models.length, 0)
})

test('26.1007 Ultra query adapter is idempotent and leaves other gate uses unchanged', () => {
  const unrelatedGate = 'const otherFeature=otherGet(kc,`1186680773`);'
  const source = `${unrelatedGate}${nativeUltraQueryFixture}`
  assert.equal(inspectCodexUltraQueryGateContent(source).already, false)
  const first = patchCodexUltraQueryGateContent(source)
  assert.equal(first.content, source.replace('y=a&&u(kc,`1186680773`)', 'y=a&&(u(kc,`1186680773`)||t===`apikey`&&o&&r)'))
  assert.ok(first.content.startsWith(unrelatedGate))
  const second = patchCodexUltraQueryGateContent(first.content)
  assert.equal(second.content, first.content)
  assert.equal(second.changed, false)
  assert.equal(second.already, true)
  assert.equal(second.ultraReasoningPatched, true)
  assert.equal(inspectCodexUltraQueryGateContent(second.content).already, true)
  assert.equal(inspectCodexUltraQueryGateContent(nativeFixture), null)
  assert.equal(patchCodexUltraQueryGateContent(nativeFixture).changed, false)
})

test('26.1007 model picker patch includes the Ultra query adapter and reports it', () => {
  const source = nativeDaybreakFixture + nativeUltraQueryFixture
  const first = patchCodexModelPickerFilterContent(source)
  assert.equal(first.nativeModelCatalog, true)
  assert.equal(first.ultraReasoningPatched, true)
  assert.equal(first.changed, true)
  assert.ok(first.content.startsWith(nativeDaybreakFixture))
  const second = patchCodexModelPickerFilterContent(first.content)
  assert.equal(second.content, first.content)
  assert.equal(second.changed, false)
  assert.equal(second.already, true)
})

test('older model queries without the Ultra gate remain unchanged even beside unrelated gate uses', () => {
  const legacyQuery = nativeUltraQueryFixture.replace('y=a&&u(kc,`1186680773`)', 'y=a')
  const unrelatedGate = 'const unrelated=u(kc,`1186680773`);'
  const olderHeader = '({hasConfiguredModelCatalog:r,isCustomModelProvider:o,modelCatalogPath:c},{queryClient:d})=>'
  const olderBody = '{const object={text:"}",nested:()=>({value:`text ${"}"}`})};/* } */return object}'
  for (const source of [legacyQuery, `${unrelatedGate}${legacyQuery}${unrelatedGate}`,
    `${olderHeader}${olderBody};${unrelatedGate}`, legacyQuery + legacyQuery]) {
    assert.equal(inspectCodexUltraQueryGateContent(source), null)
    const result = patchCodexUltraQueryGateContent(source)
    assert.equal(result.content, source)
    assert.equal(result.changed, false)
    assert.equal(result.ultraReasoningPatched, false)
    const combined = nativeFixture + source
    assert.equal(patchCodexModelPickerFilterContent(combined).content, combined)
  }
  // Only the callback that actually contains the Ultra gate counts for patching.
  const combined = legacyQuery + nativeUltraQueryFixture
  assert.equal(patchCodexUltraQueryGateContent(combined).changed, true)
})

test('26.1007 Ultra query adapter rejects unsupported query changes and duplicate callbacks', () => {
  for (const [before, after] of [
    ['y=a&&u(', 'y=a||u('],
    ['authMethod:t,enabledReasoningEfforts:n', 'enabledReasoningEfforts:n'],
    ['includeUltraReasoningEffort:a,isCustomModelProvider:o', 'isCustomModelProvider:o'],
    ['queryClient:d', 'queryClient:renamed'],
    ['scope:f})=>{', 'scope:f})=> {'],
    ['includeUltraReasoningEffort:y', 'includeUltraReasoningEffort:a'],
    ['enabledReasoningEfforts:_', 'enabledReasoningEfforts:n'],
    ['isCustomModelProvider:o,limit:s', 'isCustomModelProvider:o,unknownField:z,limit:s'],
  ]) {
    assert.ok(nativeUltraQueryFixture.includes(before), before)
    const changed = nativeUltraQueryFixture.replaceAll(before, after)
    assert.throws(() => patchCodexUltraQueryGateContent(changed), /unsupported shape/, before)
    assert.throws(() => patchCodexModelPickerFilterContent(nativeDaybreakFixture + changed), /unsupported shape/, before)
  }
  const patched = patchCodexUltraQueryGateContent(nativeUltraQueryFixture).content
  assert.throws(() => patchCodexUltraQueryGateContent(patched.replace('&&o&&r)', '&&o)')), /unsupported shape/)
  assert.throws(() => patchCodexUltraQueryGateContent(nativeUltraQueryFixture + nativeUltraQueryFixture), /found 2/)
  assert.throws(() => patchCodexUltraQueryGateContent(nativeUltraQueryFixture + patched), /found 2/)
})

const serviceTierFixture = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'codex-service-tier-gate-26.915.js'),
  'utf8',
)

test('26.915 exposes native speed tiers to API Key sessions without spoofing ChatGPT auth', () => {
  assert.equal(isApiKeyServiceTierGateCandidate(serviceTierFixture), true)
  const result = patchCodexApiKeyServiceTierGateContent(serviceTierFixture)

  assert.equal(result.changed, true)
  assert.equal(result.already, false)
  assert.equal(result.content.length, serviceTierFixture.length)
  assert.match(
    result.content,
    /u=i\?\.isLoading\|\|a&&l,d=u\?0:a\?c&&c\.requirements\?\.featureRequirements\?\.fast_mode!=0:o==`apikey`/,
  )
  assert.doesNotMatch(result.content, /d=a&&!u&&c!=null/)
  assert.match(result.content, /a=i\?\.authMethod===`chatgpt`/)

  const expression = result.content.match(/,d=([^,]+),f;return/)?.[1]
  assert.ok(expression)
  const isAllowed = new Function('a', 'c', 'o', 'u', `return (${expression})`)
  const plan = (fastMode) => ({ requirements: { featureRequirements: { fast_mode: fastMode } } })
  assert.equal(isAllowed(false, null, 'apikey', false), true)
  assert.equal(isAllowed(false, null, 'copilot', false), false)
  assert.equal(isAllowed(false, null, 'amazonBedrock', false), false)
  assert.equal(isAllowed(true, plan(true), 'chatgpt', false), true)
  assert.equal(isAllowed(true, plan(false), 'chatgpt', false), false)
  assert.equal(Boolean(isAllowed(true, null, 'chatgpt', false)), false)
  assert.equal(Boolean(isAllowed(false, null, 'apikey', true)), false)
})

test('API Key service-tier gate patch is idempotent', () => {
  const first = patchCodexApiKeyServiceTierGateContent(serviceTierFixture)
  const second = patchCodexApiKeyServiceTierGateContent(first.content)

  assert.equal(second.changed, false)
  assert.equal(second.already, true)
  assert.equal(second.content, first.content)
})

test('API Key service-tier patch fails closed when the known return contract changes', () => {
  const changed = serviceTierFixture.replace('isServiceTierAllowed:d', 'isServiceTierAllowed:a')
  assert.equal(isApiKeyServiceTierGateCandidate(changed), true)
  assert.throws(
    () => patchCodexApiKeyServiceTierGateContent(changed),
    /found 0 original and 0 patched/,
  )
})

test('API Key service-tier candidate detection ignores unrelated fast-mode strings', () => {
  assert.equal(
    isApiKeyServiceTierGateCandidate('authMethod===`chatgpt`;featureRequirements?.fast_mode'),
    false,
  )
})

if (installedFixture) {
  test('matches the explicitly supplied installed Codex model-picker bundle', () => {
    const content = fs.readFileSync(installedFixture, 'utf8')
    assert.equal(isModelPickerFilterCandidate(content), true)

    const result = patchCodexModelPickerFilterContent(content)
    assert.ok(result.changed || result.already || result.nativeModelCatalog)
    if (!result.ultraReasoningPatched) assert.equal(result.content.length, content.length)
    assert.equal(patchCodexModelPickerFilterContent(result.content).changed, false)
  })
}

const installedAssets = process.env.CODEX_MODEL_PICKER_ASSETS
if (installedAssets) {
  test('selects exactly one bundle from explicitly supplied installed Codex assets', () => {
    const candidates = fs.readdirSync(installedAssets, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => ({
        name: entry.name,
        content: fs.readFileSync(path.join(installedAssets, entry.name), 'utf8'),
      }))
      .filter(({ content }) => isModelPickerFilterCandidate(content))

    assert.equal(candidates.length, 1)
    const result = patchCodexModelPickerFilterContent(candidates[0].content)
    assert.ok(result.changed || result.already || result.nativeModelCatalog)
  })
}

test('backend plugin status rejects persistent legacy patches even beside a ready controller', () => {
  const vm = require('node:vm')
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const block = rust.slice(rust.indexOf('fn codex_plugin_runtime_status('), rust.indexOf('fn gaoge_get_codex_plugins_status_inner()'))
  const version = Number(rust.match(/const CODEX_PLUGIN_RUNTIME_VERSION: u64 = (\d+);/)[1])
  const script = block.match(/let script = r#"([\s\S]*?)"#/)?.[1].replaceAll("__GAOGE_PLUGIN_RUNTIME_VERSION__", String(version))
  assert.ok(script, 'production backend status probe is extracted')
  const markers = [
    'window.__gaogeCodexPluginMarketplaceRuntimeV5 = true',
    'window.__gaogePluginMarketplaceFetchPatch = true',
    'Array.prototype.__gaogePluginOriginalFilter = Array.prototype.filter',
    'window.__gaogePluginMarketplaceRuntimeTimer = 123',
    'window.fetch.__gaogePluginMarketplacePatch = true',
    'window.fetch.__gaogeCodexPluginFetchPatch = true',
  ]
  for (const withController of [false, true]) {
    for (const marker of markers) {
      const context = vm.createContext({ window: { fetch() {}, __GAOGE_PLUGIN_ENHANCEMENTS_ENABLED__: true }, document: { querySelector() { return null } } })
      if (withController) context.window.__gaogeCodexPluginRuntime = { version, disposed: false, status: () => ({ version, disposed: false, enabled: true, runtimeInjected: true, nativeEntryReady: true, listVerified: true, runtimeReady: true, pending: false }) }
      vm.runInContext(marker, context)
      const status = vm.runInContext(script, context)
      assert.equal(status.runtimeReady, false, marker)
      assert.equal(status.needsRestart, true, marker)
      assert.equal(status.pending, false, marker)
      assert.equal(status.reason, 'legacy-runtime-restart-required', marker)
    }
  }
  const clean = vm.runInNewContext(script, { window: { __GAOGE_PLUGIN_ENHANCEMENTS_ENABLED__: false }, document: { querySelector() { return null } } })
  assert.equal(clean.needsRestart, false)
  assert.equal(clean.pending, false)
  assert.equal(clean.reason, 'disabled')
})

test('backend status never accepts old, disposed, or incomplete controller evidence', () => {
  const vm = require('node:vm')
  const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const block = rust.slice(rust.indexOf('fn codex_plugin_runtime_status('), rust.indexOf('fn gaoge_get_codex_plugins_status_inner()'))
  const version = Number(rust.match(/const CODEX_PLUGIN_RUNTIME_VERSION: u64 = (\d+);/)[1])
  const script = block.match(/let script = r#"([\s\S]*?)"#/)[1].replaceAll('__GAOGE_PLUGIN_RUNTIME_VERSION__', String(version))
  const ready = { version, disposed: false, enabled: true, applied: true, runtimeInjected: true, nativeEntryReady: true, listVerified: true, runtimeReady: true, searchReady: true, pluginCount: 78 }
  for (const [controllerVersion, controllerDisposed, patch] of [[version-1,false,{}],[version,true,{}],[version,undefined,{}],[version,false,{version:version-1}],[version,false,{disposed:true}]]) {
    const runtime={version:controllerVersion,disposed:controllerDisposed,status:()=>({...ready,...patch})}
    const result=vm.runInNewContext(script,{window:{__gaogeCodexPluginRuntime:runtime,__GAOGE_PLUGIN_ENHANCEMENTS_ENABLED__:true},document:{querySelector(){return null}}})
    for(const key of ['ready','applied','runtimeReady','runtimeInjected','nativeEntryReady','entryReady','listVerified','nativeListVerified','searchReady']) assert.equal(result[key],false,key)
    assert.equal(result.pluginCount,0);assert.equal(result.indexedPlugins,0);assert.equal(result.pending,true)
  }
})
