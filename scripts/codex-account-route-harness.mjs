import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, ref, watch } from 'vue'

const text = readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
const script = text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const source = ts.createSourceFile('account-route.vue.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const noop = () => {}
export const tick = () => new Promise((resolve) => setImmediate(resolve))
export const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
export const account = (key) => ({ accountKey: key, email: `${key}@example.test`, isActive: true })
export const router = (relay, overrides = {}) => ({
  mode: relay ? 'relay' : 'official', configActive: relay, relayConfigured: relay,
  relayBaseUrl: 'https://relay.test/v1', model: 'gpt-6-astra', ...overrides,
})
export const aggregate = (enabled) => ({ enabled, running: enabled, routerBaseUrl: 'https://relay.test/v1' })
export const activation = (relay, overrides = {}) => ({
  accounts: [account('B')], currentAccount: account('B'), activeAccountKey: 'B',
  router: router(relay), relayPreserved: relay, codexLaunched: true, ...overrides,
})

export const accountRouteNames = [
    'codexStatusGeneration', 'codexAccountsLoadGeneration', 'codexAccountMutationDepth',
    'codexAccountsRetryTimer', 'invalidateCodexAccountsRequests', 'beginCodexAccountMutation',
    'readCodexAccountSwitchRoute', 'applyCodexAccountSwitchRoute', 'loadCodexAccounts',
    'completeCodexOauthLogin', 'connectTool', 'codexRouterHasActiveRelay', 'codexRouterHasConfiguredRelay',
    'isAggregateLoginActive', 'isCodexRouterRelayBaseUrlCurrent', 'isCodexRelayConfigured',
    'normalizedCodexRelaySource', 'setCodexRelaySource', 'invalidateCodexStatusRequests',
    'clearCodexRelayState', 'applyAggregateLoginStatus', 'markAggregateLoginInactive',
    'loadAggregateLoginStatus', 'applyCodexRouterSettings', 'loadCodexRouterStatus',
    'normalLoginCodexAccount', 'closeCodexRelayFromLoginPage', 'forceOfficialCodexForActivePage', 'disableAggregateLogin',
    'codexOfficialAccountRestoreNotice', 'verifyCodexOfficialAccountRestore', 'codexLaunchWarnings',
    'codexLaunchWarningMessages', 'codexUltraFeedback', 'showCodexLaunchFeedback',
    'codexApiModeFeedback', 'codexNativeFastFeedback', 'codexRuntimeFeedback',
    'codexUltraStatusGeneration', 'codexUltraStatusTimer', 'codexUltraStatusCancelWait',
    'cancelCodexUltraStatusWait', 'stopCodexUltraStatusCheck', 'waitForCodexUltraStatusCheck',
    'codexLoginNotificationDepth', 'codexLoginDiagnostics', 'beginCodexLoginFeedback',
    'watchFeedback', 'watchFeedbackGetter',
    'recordCodexLoginDiagnostics', 'codexLoginFailureDetails', 'showCodexLoginFailure',
    'rawErrorText', 'isCodexConfigurationBusyError', 'restartCodexForActivePage',
    'handleCodexConfigUpgradeBusy', 'finishCodexConfigUpgradeMutation',
    'isCodexFuelAccountChecking', 'isCodexFuelRecoveryAvailable', 'codexFuelAccountCheckGeneration',
    'CODEX_FUEL_RECOVERY_STORAGE_KEY', 'readStoredCodexFuelRecovery', 'setCodexFuelRecoveryAvailable',
  ]

export function accountRouteProduction(options = {}) {
  const names = [...accountRouteNames,
    ...(options.realSanitize ? ['stripSensitiveErrorText'] : []),
    ...(options.fuel ? [
      'activeCodexLoginMode', 'isCodexLoginRelayActive', 'isExistingAccountFuelActive',
      'isCodexLoginActionClose', 'loginActionButtonText', 'isLoginActionBusy', 'isLoginStartDisabled',
      'connectToolForActivePage', 'showMissingCodexFuelAccountDialog', 'setPage',
      'codexAccounts', 'currentCodexAccount', 'activeCodexAccountKey', 'invalidActiveCodexAccount',
    ] : []),
    ...(options.realConfirm ? ['confirmDialog', 'confirmResolve', 'confirmAction', 'closeConfirmDialog'] : []),
  ]
  const declarations = source.statements.filter((node) => (
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text) ||
    ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => names.includes(item.name.getText(source)))
  ))
  assert.equal(declarations.length, names.length, 'Every test subject must come from the production component')
  const compiled = ts.transpileModule(`${declarations.map((node) => node.getText(source)).join('\n')}
globalThis.subject = { ${names.join(',')} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  return compiled
}

export function accountRouteFixture({ computed, ref, watch }, options = {}) {
  const calls = []
  const store = new Map(options.storageEntries || [])
  const initialSource = options.source || ''
  const initialKey = options.key || ''
  if (initialSource) store.set('relay-source', initialSource)
  if (initialKey) store.set('gaoge_desktop_fuel_pack_account_key', initialKey)
  let liveRouter = options.liveRouter || router(false)
  const api = {
    getCodexRouterStatus: async () => { calls.push(['read-router']); return liveRouter },
    getAggregateLoginStatus: async () => { calls.push(['read-aggregate']); return options.liveAggregate || aggregate(false) },
    activateCodexAccount: async (request) => {
      calls.push(['activate', request])
      return options.result || activation(request.preserveRelay ?? Boolean(liveRouter.configActive))
    },
    getCodexAccounts: async () => { calls.push(['read-accounts']); return context.codexAccountsState.value },
    checkCodexFuelAccount: async () => {
      calls.push(['check-fuel-account'])
      return options.fuelCheck || { canStart: true, currentAccount: account('A'), reason: 'ready' }
    },
    completeCodexOauthLogin: async (request) => {
      calls.push(['complete-oauth', request])
      const result = options.result || activation(Boolean(liveRouter.configActive))
      return {
        ...result, state: request.setActive ? result : context.codexAccountsState.value,
        account: account('B'), activated: request.setActive,
      }
    },
    configureCodex: async (request) => { calls.push(['configure', request]); return { router: router(true), codexLaunched: true } },
    disableCodexFuelPack: async (request) => { calls.push(['disable-relay', request]); liveRouter = router(false); return { router: liveRouter, codexLaunched: true } },
    disableAggregateLogin: async () => { calls.push(['disable-aggregate']); liveRouter = router(false); return { router: liveRouter, aggregate: aggregate(false), codexLaunched: true } },
    restartCodex: async () => { calls.push(['restart']); return { codexLaunched: true } },
    ...options.api,
  }
  const context = {
    computed, ref, watch, window: { gaogeDesktop: api, clearTimeout, setTimeout },
    localStorage: { getItem: (key) => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
    CODEX_RELAY_SOURCE_STORAGE_KEY: 'relay-source', CODEX_OFFICIAL_BASE_URL: 'https://official.test/v1',
    codexRelaySource: ref(initialSource), fuelPackAccountKey: ref(initialKey),
    codexRouterStatus: ref(options.cachedRouter || null), aggregateLoginStatus: ref(options.cachedAggregate || aggregate(false)),
    connectedTools: ref({ codex: Boolean(initialSource) }), codexRouterForm: ref({}), codexModelOptions: ref([]), codexModelCatalogSource: ref('upstream'),
    codexAccountsState: ref(options.accountsState || { currentAccount: account('A'), accounts: [account('A')] }),
    codexAccountsError: ref(''), codexAccountsNotice: ref(''), selectedCodexAccountKey: ref('A'),
    isCodexAccountsLoading: ref(false), activePage: ref(options.page || '账号管理'),
    selectedCodexAccount: ref(account('B')), managedAccounts: ref([]), isCodexAccountSwitching: ref(false),
    activeTool: ref('codex'), toolErrors: ref({ codex: '' }), toolNotices: ref({ codex: '' }), toolWarnings: ref({ codex: '' }),
    isCodexFuelPackClosing: ref(false), isToolConnecting: ref({ codex: false }), aggregateLoginError: ref(''), aggregateLoginNotice: ref(''), isAggregateLoginLoading: ref(false),
    isCodexFuelPackOpening: ref(false), isToolGroupSyncing: ref({ codex: false }),
    activeCodexLoginMode: ref(null),
    loginModelsNotice: ref(''), loginModelsError: ref(''), loginPanels: ref({}),
    toolLatencyErrors: ref({}), toolLatencyNotices: ref({}),
    startDashboardAutoRefresh: noop, stopDashboardAutoRefresh: noop,
    stopSmsReceiverPolling: noop, stopSmsReceiverCleanupTimer: noop,
    isOfficialSubscriptionPage: () => false, stopOfficialSubscriptionPriceRefresh: noop,
    isOnlinePaymentPage: () => false, stopOnlinePaymentConfigRefresh: noop,
    openUserMenu: ref(false), activeUtilityPanel: ref(''),
    isCodexRestarting: ref(false), loadCodexLaunchTarget: async () => {},
    isCodexOauthCompleting: ref(false), codexOauthCallbackInput: ref('https://callback.test/?code=test'),
    codexOauthLoginId: ref('login-test'), codexOauthAuthUrl: ref('https://auth.test/'),
    codexOauthRedirectUri: ref('https://callback.test/'), activateOauthAccount: ref(true),
    overwriteSessionAccount: ref(false), showAddAccountDialog: ref(true),
    authToken: ref('test-token'), lockedCodexModel: ref(''), CODEX_MODEL: 'gpt-6-astra',
    getCurrentApiBaseUrl: () => 'https://control.test/custom/api/v1',
    currentCodexBaseUrl: () => 'https://relay.test/v1', isGaogeCodexRelayBaseUrl: (url) => url === 'https://relay.test/v1',
    resolveCodexBackendModelAfterDefaultMigration: (_storage, _options, model) => model,
    codexModelMigrationOptions: () => ({}), filterCodexConversationModels: (models) => models,
    persistCodexRouterForm: noop, isCodexImageGenerationModel: () => false, syncSelectedLoginModelForTool: noop,
    normalizeCodexAccountsState: (value) => value, normalizeCodexAccount: (value) => value,
    normalizeCodexAccountList: (value) => value || [], stripSensitiveErrorText: (value) => String(value || ''),
    codexAccountTitle: (value) => value.accountKey, confirmCodexRestart: async () => true,
    confirmAction: async (message, settings) => { calls.push(['confirm', message, settings]); return true },
    openCodexOperationDialog: (...args) => { calls.push(['open-operation', args]); return { update: noop, close: noop } },
    applyCodexEnhancementResults: noop, showManualOpenNotice: (action, message) => calls.push(['manual-open', action, message]),
    reportPageError: (...args) => calls.push(['report-error', ...args]), notify: (message, tone) => calls.push(['notify', message, tone]), getCodexAccountErrorMessage: (error) => error.message,
    getToolActionErrorMessage: (error) => error.message, isCodexAccountInvalidError: () => false,
    ensureSelectedCodexAccount: noop, syncOfficialSubscriptionRecordsFromAccounts: noop,
    selectedToolGroupId: () => 1, invalidActiveCodexAccount: () => null,
    ensureToolDefaultApiKeyForGroup: async () => { calls.push(['prepare-key']); return { key: 'test-key', id: 1 } },
    tryEnsureCodexImageTools: async () => ({}),
    resolveCodexModelSelection: async () => ({
      model: 'gpt-6-astra', mode: 'upstream', supportedModels: ['gpt-6-astra'],
    }),
  }
  return { state: context, api, calls, store }
}

export function harness(options = {}) {
  const fixture = accountRouteFixture({ computed, ref, watch }, options)
  const context = vm.createContext(fixture.state)
  vm.runInContext(accountRouteProduction(options), context)
  Object.assign(context, context.subject)
  return { ...context.subject, ...fixture }
}
