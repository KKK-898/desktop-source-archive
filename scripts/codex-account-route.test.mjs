import assert from 'node:assert/strict'
import test from 'node:test'
import { harness, tick, deferred, account, router, aggregate, activation } from './codex-account-route-harness.mjs'

const fuelHarness = (options = {}) => harness({ fuel: true, page: '已有账号加油', ...options })
const missingFuelMessage = '未检测到已登录的gpt账号，请使用无账号登录'
const writes = (h) => h.calls.filter(([kind]) => ['prepare-key', 'configure', 'activate', 'restart', 'disable-relay', 'disable-aggregate'].includes(kind))

for (const [label, accountsState, fuelCheck] of [
  ['cached current account after real logout', { currentAccount: account('A'), accounts: [account('A')] }, { canStart: false, currentAccount: null, reason: 'missing' }],
  ['saved account without live auth', { currentAccount: null, accounts: [account('A')] }, { canStart: false, currentAccount: null, reason: 'missing' }],
  ['invalid live account', { currentAccount: account('A'), accounts: [account('A')] }, { canStart: false, currentAccount: { ...account('A'), requiresReauth: true }, reason: 'invalid' }],
]) {
  test(`existing-account fuel shows the real missing-login modal for ${label} before any writes`, async () => {
    const h = fuelHarness({ realConfirm: true, accountsState, fuelCheck })
    assert.equal(h.loginActionButtonText.value, '开始加油')
    assert.equal(h.isLoginStartDisabled.value, false)
    const pending = h.connectToolForActivePage()
    await tick()
    assert.equal(h.confirmDialog.value.open, true)
    assert.equal(h.confirmDialog.value.message, missingFuelMessage)
    assert.equal(h.confirmDialog.value.confirmText, '知道了')
    assert.equal(h.confirmDialog.value.cancelText, '')
    assert.equal(h.calls.filter(([kind]) => kind === 'check-fuel-account').length, 1)
    assert.deepEqual(writes(h), [])
    h.closeConfirmDialog(true)
    await pending
    assert.equal(h.isLoginStartDisabled.value, false)
    assert.equal(h.loginActionButtonText.value, '开始加油')
    assert.deepEqual(writes(h), [])
  })
}

test('existing-account fuel uses the fresh identity instead of the cached selection', async () => {
  const h = fuelHarness({ fuelCheck: { canStart: true, currentAccount: account('B'), reason: 'ready' } })
  h.api.getCodexAccounts = async () => ({ currentAccount: account('B'), accounts: [account('A'), account('B')] })
  await h.connectToolForActivePage()
  const request = h.calls.find(([kind]) => kind === 'configure')?.[1]
  assert.equal(request?.accountKey, 'B')
  assert.equal(request?.forceApiMode, false)
  assert.equal(request?.requireCurrentChatgptAccount, true)
  assert.equal(h.calls[0][0], 'check-fuel-account')
  assert.equal(h.state.fuelPackAccountKey.value, 'B')
  assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
  assert.equal(h.loginActionButtonText.value, '关闭加油')
  assert.match(h.state.toolNotices.value.codex, /加油成功/)
})

test('a fresh valid account is not rejected by a same-key cached requiresReauth snapshot', async () => {
  const stale = { ...account('A'), requiresReauth: true, loginState: 'invalid', canSwitch: false }
  const h = fuelHarness({ accountsState: { currentAccount: account('A'), accounts: [stale] } })
  assert.equal(h.invalidActiveCodexAccount().requiresReauth, true)
  h.api.getCodexAccounts = async () => ({ currentAccount: account('A'), accounts: [account('A')] })
  await h.connectToolForActivePage()
  assert.equal(h.calls.filter(([kind]) => kind === 'configure').length, 1)
  assert.equal(h.state.toolErrors.value.codex, '')
  assert.equal(h.loginActionButtonText.value, '关闭加油')
})

test('failed or unavailable live fuel checks cannot fall back to a cached ready account', async () => {
  for (const unavailable of [false, true]) {
    const h = fuelHarness()
    h.api.checkCodexFuelAccount = unavailable ? undefined : async () => { throw Error('auth read denied') }
    await h.connectToolForActivePage()
    assert.match(h.state.toolErrors.value.codex, /检测 ChatGPT 账号失败/)
    assert.equal(h.state.toolNotices.value.codex, '')
    assert.equal(h.isLoginStartDisabled.value, false)
    assert.equal(h.loginActionButtonText.value, '开始加油')
    assert.deepEqual(writes(h), [])
  }
})

test('fuel checking disables the button and ignores repeated clicks until the check completes', async () => {
  const checked = deferred()
  const h = fuelHarness()
  let checks = 0
  h.api.checkCodexFuelAccount = () => { checks += 1; return checked.promise }
  const pending = h.connectToolForActivePage()
  assert.equal(h.isLoginStartDisabled.value, true)
  assert.equal(h.loginActionButtonText.value, '正在检测账号')
  await h.connectToolForActivePage()
  assert.equal(checks, 1)
  assert.deepEqual(writes(h), [])
  checked.resolve({ canStart: true, currentAccount: account('A'), reason: 'ready' })
  await pending
  assert.equal(h.isLoginStartDisabled.value, false)
  assert.equal(h.calls.filter(([kind]) => kind === 'configure').length, 1)
})

test('switching pages and returning invalidates a pending check even when the page name matches again', async () => {
  const checked = deferred()
  const h = fuelHarness()
  h.api.checkCodexFuelAccount = () => checked.promise
  const pending = h.connectToolForActivePage()
  h.setPage('无账号登录')
  h.setPage('已有账号加油')
  checked.resolve({ canStart: true, currentAccount: account('A'), reason: 'ready' })
  await pending
  assert.deepEqual(writes(h), [])
  assert.equal(h.isLoginStartDisabled.value, false)
  assert.equal(h.state.toolNotices.value.codex, '')
})

test('a status mutation while checking requires a new fuel check', async () => {
  const checked = deferred()
  const h = fuelHarness()
  h.api.checkCodexFuelAccount = () => checked.promise
  const pending = h.connectToolForActivePage()
  h.invalidateCodexStatusRequests()
  checked.resolve({ canStart: true, currentAccount: account('A'), reason: 'ready' })
  await pending
  assert.deepEqual(writes(h), [])
  assert.match(h.state.toolErrors.value.codex, /状态已变化/)
})

for (const stage of ['restart-confirmation', 'model-selection']) {
  test(`leaving the fuel page during ${stage} prevents configuration`, async () => {
    const paused = deferred()
    const h = fuelHarness()
    if (stage === 'restart-confirmation') h.state.confirmCodexRestart = () => paused.promise
    else h.state.resolveCodexModelSelection = () => paused.promise
    const pending = h.connectToolForActivePage()
    await tick()
    h.setPage('无账号登录')
    paused.resolve(stage === 'restart-confirmation' ? true : { model: 'gpt-6-astra', mode: 'upstream', supportedModels: ['gpt-6-astra'] })
    await pending
    assert.equal(h.calls.some(([kind]) => kind === 'configure'), false)
    if (stage === 'restart-confirmation') assert.deepEqual(writes(h), [])
    assert.equal(h.isLoginStartDisabled.value, false)
  })
}

test('configuration failure restores Start Fuel without persisting success', async () => {
  const h = fuelHarness()
  h.api.configureCodex = async () => { throw Error('configuration write failed') }
  await h.connectToolForActivePage()
  assert.equal(h.loginActionButtonText.value, '开始加油')
  assert.equal(h.isLoginStartDisabled.value, false)
  assert.equal(h.isCodexFuelRecoveryAvailable.value, false)
  assert.equal(h.normalizedCodexRelaySource.value, '')
  assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.match(h.state.toolErrors.value.codex, /configuration write failed/)
})

for (const verification of ['read-failed', 'different-account']) {
  test(`a written fuel route keeps Close Fuel recovery when postverification ${verification}`, async () => {
    const h = fuelHarness()
    h.api.getCodexAccounts = async () => {
      if (verification === 'read-failed') throw Error('postverification read failed')
      return { currentAccount: account('B'), accounts: [account('B')] }
    }
    await h.connectToolForActivePage()
    assert.equal(h.loginActionButtonText.value, '关闭加油')
    assert.equal(h.isLoginStartDisabled.value, false)
    assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
    assert.equal(h.state.codexRelaySource.value, '')
    assert.equal(h.isExistingAccountFuelActive.value, false)
    assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
    assert.equal(h.state.toolNotices.value.codex, '')
    assert.match(h.state.toolErrors.value.codex, /未能确认加油成功.*关闭加油/)
    h.api.getCodexAccounts = async () => ({ currentAccount: account('A'), accounts: [account('A')] })
    await h.connectToolForActivePage()
    await tick()
    assert.equal(h.calls.filter(([kind]) => kind === 'disable-relay').length, 1)
    assert.equal(h.isCodexFuelRecoveryAvailable.value, false)
    assert.equal(h.loginActionButtonText.value, '开始加油')
    assert.equal(h.state.codexRouterStatus.value.mode, 'official')
    assert.equal(h.currentCodexAccount.value.accountKey, 'A')
  })
}

test('backend lost-account guard opens the same modal and does not claim success', async () => {
  const h = fuelHarness({ realConfirm: true })
  h.api.configureCodex = async () => { throw Error('CODEX_FUEL_ACCOUNT_REQUIRED') }
  const pending = h.connectToolForActivePage()
  await tick()
  assert.equal(h.confirmDialog.value.message, missingFuelMessage)
  assert.equal(h.confirmDialog.value.cancelText, '')
  h.closeConfirmDialog(true)
  await pending
  assert.equal(h.loginActionButtonText.value, '开始加油')
  assert.equal(h.state.toolNotices.value.codex, '')
  assert.equal(h.normalizedCodexRelaySource.value, '')
  assert.equal(h.calls.some(([kind]) => kind === 'activate' || kind === 'restart'), false)
})

test('pending fuel recovery survives a fresh status response for a previously configured relay domain', async () => {
  const h = fuelHarness()
  h.api.getCodexAccounts = async () => { throw Error('postverification failed') }
  await h.connectToolForActivePage()
  assert.equal(h.store.get(h.CODEX_FUEL_RECOVERY_STORAGE_KEY), 'true')
  h.api.getCodexRouterStatus = async () => router(true, { relayBaseUrl: 'https://old-relay.test/v1' })
  await h.loadCodexRouterStatus({ silent: true })
  assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
  assert.equal(h.loginActionButtonText.value, '关闭加油')
  assert.equal(h.store.get(h.CODEX_FUEL_RECOVERY_STORAGE_KEY), 'true')
  assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /加油成功/)
})

test('pending fuel recovery survives an app reload and is cleared by a successful official restore', async () => {
  const h = fuelHarness()
  h.api.getCodexAccounts = async () => { throw Error('postverification failed') }
  await h.connectToolForActivePage()
  const reloaded = fuelHarness({ storageEntries: [...h.store], liveRouter: router(true) })
  assert.equal(reloaded.loginActionButtonText.value, '关闭加油')
  assert.equal(reloaded.isExistingAccountFuelActive.value, false)
  assert.equal(reloaded.state.toolNotices.value.codex, '')
  assert.equal(reloaded.store.has('gaoge_desktop_fuel_pack_account_key'), false)
  await reloaded.connectToolForActivePage()
  await tick()
  assert.equal(reloaded.calls.some(([kind]) => kind === 'check-fuel-account' || kind === 'configure'), false)
  assert.equal(reloaded.calls.filter(([kind]) => kind === 'disable-relay').length, 1)
  assert.equal(reloaded.currentCodexAccount.value.accountKey, 'A')
  assert.equal(reloaded.isCodexFuelRecoveryAvailable.value, false)
  assert.equal(reloaded.store.has(h.CODEX_FUEL_RECOVERY_STORAGE_KEY), false)
  assert.equal(fuelHarness({ storageEntries: [...reloaded.store] }).loginActionButtonText.value, '开始加油')
})

test('failed restoration retains the pending recovery marker across reloads', async () => {
  const h = fuelHarness({ storageEntries: [['gaoge_desktop_codex_fuel_recovery_pending', 'true']], liveRouter: router(true) })
  h.api.disableCodexFuelPack = async () => { throw Error('restore failed') }
  await h.connectToolForActivePage()
  await tick()
  assert.equal(h.loginActionButtonText.value, '关闭加油')
  assert.equal(h.store.get(h.CODEX_FUEL_RECOVERY_STORAGE_KEY), 'true')
  const reloaded = fuelHarness({ storageEntries: [...h.store] })
  assert.equal(reloaded.loginActionButtonText.value, '关闭加油')
})

test('only a confirmed official route with no configured relay clears pending recovery during status reads', () => {
  const h = fuelHarness({ storageEntries: [['gaoge_desktop_codex_fuel_recovery_pending', 'true']] })
  h.applyCodexRouterSettings(router(true, { mode: 'official' }))
  assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
  h.applyCodexRouterSettings(router(false))
  assert.equal(h.isCodexFuelRecoveryAvailable.value, false)
  assert.equal(h.store.has(h.CODEX_FUEL_RECOVERY_STORAGE_KEY), false)
})

test('unavailable pending-marker storage preserves in-window recovery without inventing success', async () => {
  const h = fuelHarness()
  h.state.localStorage.setItem = () => { throw Error('storage denied') }
  h.api.getCodexAccounts = async () => { throw Error('postverification failed') }
  await h.connectToolForActivePage()
  assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
  assert.equal(h.loginActionButtonText.value, '关闭加油')
  assert.equal(h.state.toolNotices.value.codex, '')
  h.state.localStorage.getItem = () => { throw Error('storage denied') }
  assert.equal(h.readStoredCodexFuelRecovery(), false)
})

test('the fueling button stays busy through the backend write and ignores another click', async () => {
  const configured = deferred()
  const h = fuelHarness()
  let writesStarted = 0
  h.api.configureCodex = () => { writesStarted += 1; return configured.promise }
  const pending = h.connectToolForActivePage()
  await tick()
  assert.equal(h.loginActionButtonText.value, '正在加油')
  assert.equal(h.isLoginStartDisabled.value, true)
  await h.connectToolForActivePage()
  assert.equal(writesStarted, 1)
  configured.resolve({ router: router(true), codexLaunched: true })
  await pending
  assert.equal(h.loginActionButtonText.value, '关闭加油')
  assert.equal(h.store.has(h.CODEX_FUEL_RECOVERY_STORAGE_KEY), false)
})

test('backend changed-account guard asks for a fresh check without starting recovery', async () => {
  const h = fuelHarness()
  h.api.configureCodex = async () => { throw Error('CODEX_FUEL_ACCOUNT_CHANGED') }
  await h.connectToolForActivePage()
  assert.match(h.state.toolErrors.value.codex, /账号已发生变化.*重新点击/)
  assert.equal(h.loginActionButtonText.value, '开始加油')
  assert.equal(h.isCodexFuelRecoveryAvailable.value, false)
  assert.equal(h.state.toolNotices.value.codex, '')
})

for (const source of ['one-click', 'aggregate']) {
  test(`existing-account fuel does not close an unrelated ${source} route`, async () => {
    const h = fuelHarness({ source, cachedRouter: router(true), cachedAggregate: aggregate(source === 'aggregate'), fuelCheck: { canStart: false, currentAccount: null, reason: 'missing' } })
    assert.equal(h.loginActionButtonText.value, '开始加油')
    await h.connectToolForActivePage()
    assert.equal(h.calls.filter(([kind]) => kind === 'check-fuel-account').length, 1)
    assert.deepEqual(writes(h), [])
    assert.equal(h.normalizedCodexRelaySource.value, source)
  })
}

test('successful fuel closes to the official route while retaining the same ChatGPT identity', async () => {
  const h = fuelHarness()
  await h.connectToolForActivePage()
  assert.equal(h.loginActionButtonText.value, '关闭加油')
  await h.connectToolForActivePage()
  await tick()
  assert.equal(h.calls.filter(([kind]) => kind === 'check-fuel-account').length, 1)
  assert.equal(h.calls.filter(([kind]) => kind === 'disable-relay').length, 1)
  assert.equal(h.currentCodexAccount.value.accountKey, 'A')
  assert.equal(h.state.codexRouterStatus.value.mode, 'official')
  assert.equal(h.normalizedCodexRelaySource.value, '')
  assert.equal(h.loginActionButtonText.value, '开始加油')
  assert.match(h.state.toolNotices.value.codex, /已关闭加油.*官方原生路由/)
})

test('failed or cancelled Close Fuel retains its close action and account', async () => {
  for (const cancel of [false, true]) {
    const h = fuelHarness({ source: 'fuel-pack', key: 'A', cachedRouter: router(true), liveRouter: router(true) })
    if (cancel) h.state.confirmAction = async () => false
    else h.api.disableCodexFuelPack = async () => { throw Error('restore failed') }
    await h.connectToolForActivePage()
    await tick()
    assert.equal(h.loginActionButtonText.value, '关闭加油')
    assert.equal(h.isLoginStartDisabled.value, false)
    assert.equal(h.currentCodexAccount.value.accountKey, 'A')
    assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
    if (cancel) assert.deepEqual(writes(h), [])
    else assert.match(h.state.toolErrors.value.codex, /restore failed/)
  }
})

test('no-account login still bypasses ChatGPT checks and uses API mode', async () => {
  const h = fuelHarness({ page: '无账号登录', accountsState: { currentAccount: null, accounts: [] } })
  await h.connectToolForActivePage()
  const request = h.calls.find(([kind]) => kind === 'configure')?.[1]
  assert.equal(request?.forceApiMode, true)
  assert.equal(Object.hasOwn(request, 'requireCurrentChatgptAccount'), false)
  assert.equal(Object.hasOwn(request, 'accountKey'), false)
  assert.equal(h.calls.some(([kind]) => kind === 'check-fuel-account'), false)
  assert.equal(h.normalizedCodexRelaySource.value, 'one-click')
  assert.equal(h.loginActionButtonText.value, '关闭登录')
})

test('switching from account management reads the live relay even without cached route state', async () => {
  const h = harness({ source: 'fuel-pack', key: 'A', liveRouter: router(true) })
  await h.normalLoginCodexAccount(account('B'))
  const request = h.calls.find(([kind]) => kind === 'activate')[1]
  assert.equal(Object.hasOwn(request, 'preserveRelay'), false)
  assert.equal(request.accountKey, 'B')
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
  assert.equal(h.state.fuelPackAccountKey.value, 'B')
  assert.equal(h.store.get('gaoge_desktop_fuel_pack_account_key'), 'B')
})

test('an API relay stays enabled while switching to a real account', async () => {
  const h = harness({ source: 'one-click', liveRouter: router(true) })
  await h.normalLoginCodexAccount(account('B'))
  assert.equal(h.normalizedCodexRelaySource.value, 'one-click')
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  assert.equal(h.state.connectedTools.value.codex, true)
  assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
})

test('fresh aggregate status keeps the aggregate route despite an empty page cache', async () => {
  const h = harness({ liveRouter: router(true), liveAggregate: aggregate(true), result: activation(true, { aggregate: aggregate(true) }) })
  await h.normalLoginCodexAccount(account('B'))
  assert.equal(h.normalizedCodexRelaySource.value, 'aggregate')
  assert.equal(h.state.aggregateLoginStatus.value.enabled, true)
  assert.equal(h.state.fuelPackAccountKey.value, '')
})

test('a live official route overrides stale relay and aggregate page state', async () => {
  const h = harness({ source: 'fuel-pack', key: 'A', cachedRouter: router(true), cachedAggregate: aggregate(true) })
  await h.normalLoginCodexAccount(account('B'))
  assert.equal(Object.hasOwn(h.calls.find(([kind]) => kind === 'activate')[1], 'preserveRelay'), false)
  assert.equal(h.normalizedCodexRelaySource.value, '')
  assert.equal(h.state.aggregateLoginStatus.value.enabled, false)
  assert.equal(h.state.connectedTools.value.codex, false)
  assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
})

test('explicit relayPreserved false wins over a stale relay mode label', async () => {
  const h = harness({ source: 'fuel-pack', key: 'A', liveRouter: router(true), result: activation(false, { router: router(false, { mode: 'relay' }) }) })
  await h.normalLoginCodexAccount(account('B'))
  assert.equal(h.state.codexRelaySource.value, '')
  assert.equal(h.normalizedCodexRelaySource.value, '')
  assert.equal(h.state.connectedTools.value.codex, false)
})

test('account activation delegates route selection to the backend when a preflight read becomes stale', async () => {
  for (const actualRelay of [false, true]) {
    const h = harness({
      source: 'fuel-pack', key: 'A', liveRouter: router(actualRelay),
      api: { getCodexRouterStatus: async () => router(!actualRelay) },
    })
    await h.normalLoginCodexAccount(account('B'))
    const request = h.calls.find(([kind]) => kind === 'activate')[1]
    assert.equal(Object.hasOwn(request, 'preserveRelay'), false)
    assert.equal(h.state.connectedTools.value.codex, actualRelay)
    assert.equal(Boolean(h.normalizedCodexRelaySource.value), actualRelay)
    assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  }
})

test('a failed switch preserves the current account and relay markers', async () => {
  const h = harness({ source: 'fuel-pack', key: 'A', cachedRouter: router(true), liveRouter: router(true), api: {
    activateCodexAccount: async () => { throw Error('switch failed') },
  } })
  await h.normalLoginCodexAccount(account('B'))
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'A')
  assert.equal(h.state.fuelPackAccountKey.value, 'A')
  assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
  assert.equal(h.state.codexAccountsError.value, 'switch failed')
  assert.equal(h.state.isCodexAccountSwitching.value, false)
})

test('a failed live route read never guesses from cached state or starts activation', async () => {
  let activated = false
  const h = harness({ cachedRouter: router(true), api: {
    getCodexRouterStatus: async () => { throw Error('route unavailable') },
    activateCodexAccount: async () => { activated = true },
  } })
  await h.normalLoginCodexAccount(account('B'))
  assert.equal(activated, false)
  assert.equal(h.state.codexAccountsError.value, 'route unavailable')
})

test('route responses begun before or during switching cannot overwrite the final relay state', async () => {
  for (const duringSwitch of [false, true]) {
    const stale = deferred(), switching = deferred()
    let reads = 0
    const h = harness({ source: 'fuel-pack', key: 'A', api: {
      getCodexRouterStatus: async () => {
        reads += 1
        return reads === (duringSwitch ? 2 : 1) ? stale.promise : router(true)
      },
      activateCodexAccount: async () => switching.promise,
    } })
    let background
    if (!duringSwitch) background = h.loadCodexRouterStatus({ silent: true })
    const pending = h.normalLoginCodexAccount(account('B'))
    await tick()
    if (duringSwitch) background = h.loadCodexRouterStatus({ silent: true })
    switching.resolve(activation(true))
    await pending
    stale.resolve(router(false))
    await background
    assert.equal(h.state.codexRouterStatus.value.configActive, true)
    assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
    assert.equal(h.state.fuelPackAccountKey.value, 'B')
  }
})

for (const action of ['normalLoginCodexAccount', 'completeCodexOauthLogin']) {
  test(`${action} rejects old account responses and suppresses background reads during the write`, async () => {
    const stale = deferred(), switching = deferred()
    let reads = 0
    const h = harness({ source: 'fuel-pack', key: 'A', liveRouter: router(true), api: {
      getCodexAccounts: async () => { reads += 1; return stale.promise },
      activateCodexAccount: async () => switching.promise,
      completeCodexOauthLogin: async () => switching.promise,
    } })
    const background = h.loadCodexAccounts({ silent: true })
    const pending = h[action](account('B'))
    await tick()
    await h.loadCodexAccounts({ silent: true, force: true })
    assert.equal(reads, 1, 'a mutation must not start a read of intermediate auth')
    switching.resolve(action === 'completeCodexOauthLogin'
      ? { ...activation(true), state: activation(true), account: account('B'), activated: true }
      : activation(true))
    await pending
    stale.resolve({ currentAccount: account('A'), accounts: [account('A')] })
    await background
    assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
    assert.equal(h.state.fuelPackAccountKey.value, 'B')
    assert.equal(h.state.codexAccountsError.value, '')
    assert.equal(h.state.isCodexAccountsLoading.value, false)
  })

  test(`${action} suppresses duplicate mutations`, async () => {
    const switching = deferred()
    let writes = 0
    const h = harness({ source: 'fuel-pack', key: 'A', liveRouter: router(true), api: {
      activateCodexAccount: async () => { writes += 1; return switching.promise },
      completeCodexOauthLogin: async () => { writes += 1; return switching.promise },
    } })
    const pending = h[action](account('B'))
    await tick()
    await h[action](account('C'))
    await h.forceOfficialCodexForActivePage()
    assert.equal(writes, 1)
    assert.equal(h.calls.some(([kind]) => kind === 'disable-relay'), false)
    switching.resolve(action === 'completeCodexOauthLogin'
      ? { ...activation(true), state: activation(true), account: account('B'), activated: true }
      : activation(true))
    await pending
  })
}

test('only the newest overlapping account load can update the current identity', async () => {
  const first = deferred(), second = deferred()
  let reads = 0
  const h = harness({ api: { getCodexAccounts: async () => ++reads === 1 ? first.promise : second.promise } })
  const older = h.loadCodexAccounts({ silent: true })
  const newer = h.loadCodexAccounts({ silent: true })
  second.resolve(activation(false))
  await newer
  first.resolve({ currentAccount: account('A'), accounts: [account('A')] })
  await older
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
})

test('a stale account-load failure cannot replace a successful switch notice with an error', async () => {
  const stale = deferred()
  const h = harness({ liveRouter: router(true), api: { getCodexAccounts: async () => stale.promise } })
  const background = h.loadCodexAccounts({ silent: true })
  await h.normalLoginCodexAccount(account('B'))
  stale.reject(Error('old read failed'))
  await background
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  assert.equal(h.state.codexAccountsError.value, '')
})

test('a stale snapshot refresh cannot start a follow-up account read after switching', async () => {
  const refreshing = deferred()
  let reads = 0
  const h = harness({ api: {
    refreshCodexAccountSnapshots: async () => refreshing.promise,
    getCodexAccounts: async () => { reads += 1; return activation(false) },
  } })
  const background = h.loadCodexAccounts({ silent: true, refreshSnapshots: true })
  await h.normalLoginCodexAccount(account('B'))
  refreshing.resolve()
  await background
  assert.equal(reads, 0)
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
})

test('a failed switch releases the account-read guard for the next refresh', async () => {
  const h = harness({ api: {
    activateCodexAccount: async () => { throw Error('switch failed') },
    getCodexAccounts: async () => activation(false),
  } })
  await h.normalLoginCodexAccount(account('B'))
  assert.equal(h.state.codexAccountsError.value, 'switch failed')
  await h.loadCodexAccounts({ silent: true })
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  assert.equal(h.state.codexAccountsError.value, '')
})

test('existing-account relay login rejects stale account reads around its account verification', async () => {
  const stale = deferred(), configuring = deferred()
  let reads = 0
  const h = harness({ api: {
    getCodexAccounts: async () => ++reads === 1 ? stale.promise : activation(true),
    configureCodex: async () => configuring.promise,
  } })
  const background = h.loadCodexAccounts({ silent: true })
  const pending = h.connectTool('codex', { accountKey: 'B' })
  await tick()
  await h.loadCodexAccounts({ silent: true })
  assert.equal(reads, 1)
  configuring.resolve({ router: router(true), codexLaunched: true })
  await pending
  stale.resolve({ currentAccount: account('A'), accounts: [account('A')] })
  await background
  assert.equal(reads, 2, 'only the operation may verify the account while it is active')
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  assert.equal(h.state.fuelPackAccountKey.value, 'B')
  assert.equal(h.state.toolErrors.value.codex, '')
})

for (const source of ['fuel-pack', 'one-click', 'aggregate', '']) {
  test(`OAuth immediate switch preserves the ${source || 'official'} route`, async () => {
    const relay = Boolean(source)
    const h = harness({
      source, key: source === 'fuel-pack' ? 'A' : '',
      liveRouter: router(relay), liveAggregate: aggregate(source === 'aggregate'),
      result: activation(relay, source === 'aggregate' ? { aggregate: aggregate(true) } : {}),
    })
    await h.completeCodexOauthLogin()
    assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
    assert.equal(h.normalizedCodexRelaySource.value, source)
    assert.equal(h.state.fuelPackAccountKey.value, source === 'fuel-pack' ? 'B' : '')
    assert.equal(h.state.aggregateLoginStatus.value.enabled, source === 'aggregate')
    assert.equal(h.state.codexAccountsError.value, '')
  })
}

test('OAuth snapshot-only import does not read or change the active route', async () => {
  const h = harness({ source: 'fuel-pack', key: 'A', liveRouter: router(true), cachedRouter: router(true) })
  h.state.activateOauthAccount.value = false
  await h.completeCodexOauthLogin()
  assert.equal(h.calls.some(([kind]) => kind === 'read-router'), false)
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'A')
  assert.equal(h.state.fuelPackAccountKey.value, 'A')
  assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
})

for (const action of ['closeCodexRelayFromLoginPage', 'forceOfficialCodexForActivePage']) {
  test(`${action} clears every relay marker and retains the selected account`, async () => {
    for (const source of ['fuel-pack', 'one-click', 'aggregate']) {
      const h = harness({ source, key: 'B', liveRouter: router(true), cachedRouter: router(true), cachedAggregate: aggregate(source === 'aggregate') })
      h.state.codexAccountsState.value = { currentAccount: account('B'), accounts: [account('B')] }
      await h[action]()
      await tick()
      assert.equal(h.normalizedCodexRelaySource.value, '')
      assert.equal(h.state.codexRelaySource.value, '')
      assert.equal(h.state.fuelPackAccountKey.value, '')
      assert.equal(h.state.aggregateLoginStatus.value.enabled, false)
      assert.equal(h.state.connectedTools.value.codex, false)
      assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
      assert.equal(h.store.has('relay-source'), false)
      assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
      assert.match(h.state.toolNotices.value.codex, /官方原生路由/)
      const disableRequest = h.calls.find(([kind]) => kind === 'disable-relay')?.[1]
      assert.equal(disableRequest?.forceOfficial, action === 'forceOfficialCodexForActivePage' ? true : undefined)
      assert.equal(h.calls.some(([kind]) => kind === 'read-router'), true)
    }
  })

  test(`${action} keeps relay state when the backend fails`, async () => {
    const fail = async () => { throw Error('close failed') }
    const h = harness({ source: 'fuel-pack', key: 'A', liveRouter: router(true), cachedRouter: router(true), api: {
      disableCodexFuelPack: fail, disableAggregateLogin: fail,
    } })
    await h[action]()
    await tick()
    assert.equal(h.normalizedCodexRelaySource.value, 'fuel-pack')
    assert.equal(h.state.fuelPackAccountKey.value, 'A')
    assert.equal(h.state.toolErrors.value.codex, 'close failed')
    assert.equal(h.state.isCodexFuelPackClosing.value, false)
  })

  test(`${action} refreshes the restored account and rejects an older account response`, async () => {
    const stale = deferred(), closing = deferred()
    let reads = 0
    const h = harness({ source: 'fuel-pack', key: 'B', liveRouter: router(true), cachedRouter: router(true), api: {
      getCodexAccounts: async () => ++reads === 1 ? stale.promise : activation(false),
      disableCodexFuelPack: async () => closing.promise,
    } })
    const background = h.loadCodexAccounts({ silent: true })
    const pending = h[action]()
    await tick()
    await h.loadCodexAccounts({ silent: true, force: true })
    assert.equal(reads, 1)
    closing.resolve({ router: router(false), codexLaunched: true })
    await pending
    await tick()
    stale.resolve({ currentAccount: account('A'), accounts: [account('A')] })
    await background
    assert.equal(reads, 2)
    assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  })
}

for (const [reason, expected] of [
  ['native_signed_out_after_missing_official_auth', /原账号登录凭据缺失.*官方未登录状态.*重新登录/],
  ['native_signed_out_after_invalid_official_auth', /原账号登录已失效.*官方未登录状态.*重新登录/],
]) {
  for (const codexLaunched of [true, false]) {
    test(`no-account close finishes signed out after ${reason}, automatic launch: ${codexLaunched}`, async () => {
      const signedOut = { currentAccount: null, activeAccountKey: null, accounts: [] }
      const h = fuelHarness({
        page: '无账号登录', source: 'one-click', key: 'A',
        cachedRouter: router(true), liveRouter: router(false),
        api: {
          disableCodexFuelPack: async () => ({
            router: router(false), codexLaunched,
            authCleanup: { reason, removed: true, restored: false },
          }),
          getCodexAccounts: async () => signedOut,
        },
      })
      assert.equal(h.loginActionButtonText.value, '关闭登录')
      await h.connectToolForActivePage()
      await tick()
      assert.equal(h.state.codexRouterStatus.value.mode, 'official')
      assert.equal(h.normalizedCodexRelaySource.value, '')
      assert.equal(h.state.codexRelaySource.value, '')
      assert.equal(h.state.fuelPackAccountKey.value, '')
      assert.equal(h.state.aggregateLoginStatus.value.enabled, false)
      assert.equal(h.state.connectedTools.value.codex, false)
      assert.equal(h.store.has('relay-source'), false)
      assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
      assert.equal(h.currentCodexAccount.value, null)
      assert.equal(h.activeCodexAccountKey.value, '')
      assert.equal(h.loginActionButtonText.value, '开始登录')
      assert.equal(h.isLoginStartDisabled.value, false)
      assert.equal(h.state.toolErrors.value.codex, '')
      assert.match(h.state.toolNotices.value.codex, /已关闭中转并恢复官方原生路由/)
      assert.match(h.state.toolNotices.value.codex, expected)
      assert.doesNotMatch(h.state.toolNotices.value.codex, /官方账号登录状态已恢复|已恢复开启中转前的登录状态/)
      const manual = h.calls.find(([kind]) => kind === 'manual-open')
      if (codexLaunched) {
        assert.match(h.state.toolNotices.value.codex, /Codex 已自动重新打开/)
        assert.equal(manual, undefined)
      } else {
        assert.equal(manual?.[1], 'codex-login-close')
        assert.match(manual[2], expected)
        assert.match(manual[2], /请手动打开 Codex/)
        assert.doesNotMatch(h.state.toolNotices.value.codex, /已自动重新打开/)
      }
    })
  }
}

for (const [reason, expected] of [
  ['preserved_current_auth_after_missing_official_auth', /原账号登录凭据缺失.*无法恢复原账号.*已保留当前登录状态/],
  ['preserved_current_auth_after_invalid_official_auth', /原账号登录已失效.*无法恢复原账号.*已保留当前登录状态/],
]) {
  test(`no-account close reports the retained login after ${reason}`, async () => {
    const h = fuelHarness({
      page: '无账号登录', source: 'one-click', cachedRouter: router(true), liveRouter: router(false),
      api: {
        disableCodexFuelPack: async () => ({
          router: router(false), codexLaunched: true,
          authCleanup: { reason, restoredAccountKey: 'B' },
        }),
        getCodexAccounts: async () => activation(false),
      },
    })
    await h.connectToolForActivePage()
    await tick()
    assert.equal(h.loginActionButtonText.value, '开始登录')
    assert.equal(h.currentCodexAccount.value.accountKey, 'B')
    assert.equal(h.state.toolErrors.value.codex, '')
    assert.match(h.state.toolNotices.value.codex, expected)
    assert.doesNotMatch(h.state.toolNotices.value.codex, /未登录状态|官方账号登录状态已恢复/)
    assert.match(h.codexOfficialAccountRestoreNotice({ authCleanup: { reason } }), expected)
  })
}

for (const [reason, expected, retained] of [
  ['native_signed_out_after_missing_official_auth', /原账号登录凭据缺失.*官方未登录状态.*重新登录/, false],
  ['native_signed_out_after_invalid_official_auth', /原账号登录已失效.*官方未登录状态.*重新登录/, false],
  ['preserved_current_auth_after_missing_official_auth', /原账号登录凭据缺失.*无法恢复原账号.*已保留当前登录状态/, true],
  ['preserved_current_auth_after_invalid_official_auth', /原账号登录已失效.*无法恢复原账号.*已保留当前登录状态/, true],
]) {
  test(`standalone aggregate close reports ${reason} and refreshes the resulting identity`, async () => {
    const h = harness({
      source: 'aggregate', cachedRouter: router(true), cachedAggregate: aggregate(true),
      api: {
        disableAggregateLogin: async () => ({
          aggregate: aggregate(false), router: router(false), codexLaunched: true,
          authCleanup: { reason, ...(retained ? { restoredAccountKey: 'B' } : {}) },
        }),
        getCodexAccounts: async () => retained ? activation(false) : { currentAccount: null, accounts: [] },
      },
    })
    await h.disableAggregateLogin()
    await tick()
    assert.equal(h.normalizedCodexRelaySource.value, '')
    assert.equal(h.state.aggregateLoginStatus.value.enabled, false)
    assert.equal(h.state.connectedTools.value.codex, false)
    assert.equal(h.state.codexAccountsState.value.currentAccount?.accountKey || null, retained ? 'B' : null)
    assert.equal(h.state.aggregateLoginError.value, '')
    assert.equal(h.state.isAggregateLoginLoading.value, false)
    assert.match(h.state.aggregateLoginNotice.value, /已退出聚合登录并恢复 Codex 官方路由/)
    assert.match(h.state.aggregateLoginNotice.value, expected)
    assert.match(h.state.aggregateLoginNotice.value, /Codex 已自动重新打开/)
    assert.doesNotMatch(h.state.aggregateLoginNotice.value, /官方账号登录状态已恢复/)
  })
}

test('standalone aggregate close includes secondary account recovery warnings without claiming failure', async () => {
  const warning = '其他配置目录的原账号登录已失效，已恢复官方未登录状态，请在对应 Codex 中重新登录。'
  const h = harness({
    source: 'aggregate', cachedRouter: router(true), cachedAggregate: aggregate(true),
    api: {
      disableAggregateLogin: async () => ({
        aggregate: aggregate(false), router: router(false), codexLaunched: true,
        authCleanup: { restored: true, restoredAccountKey: 'B' }, warnings: [warning],
      }),
      getCodexAccounts: async () => activation(false),
    },
  })
  await h.disableAggregateLogin()
  await tick()
  assert.equal(h.normalizedCodexRelaySource.value, '')
  assert.equal(h.state.aggregateLoginStatus.value.enabled, false)
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
  assert.equal(h.state.aggregateLoginError.value, '')
  assert.match(h.state.aggregateLoginNotice.value, /已退出聚合登录并恢复 Codex 官方路由/)
  assert.match(h.state.aggregateLoginNotice.value, /原账号本机登录凭据已恢复并核验/)
  assert.ok(h.state.aggregateLoginNotice.value.includes(warning))
})

for (const [reason, expected] of [
  ['native_signed_out_after_corrupt_restore', /恢复记录损坏.*重新登录自己的订阅账号/],
  ['preserved_live_official_auth_after_corrupt_restore', /恢复记录损坏.*已保留当前可确认的官方账号/],
]) {
  test(`force official reports ${reason} truthfully in both status and manual-open dialog`, async () => {
    const warning = '原恢复记录已备份。'
    const h = harness({
      source: 'fuel-pack', key: 'A', liveRouter: router(false),
      api: { disableCodexFuelPack: async () => ({
        router: router(false), codexLaunched: false,
        authCleanup: { reason }, warnings: [warning],
      }), getCodexAccounts: async () => reason === 'native_signed_out_after_corrupt_restore'
        ? { currentAccount: null, accounts: [] } : activation(false) },
    })
    await h.forceOfficialCodexForActivePage()
    await tick()
    assert.match(h.state.toolWarnings.value.codex, expected)
    assert.match(h.state.toolWarnings.value.codex, /原恢复记录已备份/)
    assert.doesNotMatch(h.state.toolWarnings.value.codex, /最后主动切换的账号/)
    const manual = h.calls.find(([kind]) => kind === 'manual-open')
    assert.equal(manual?.[1], 'codex-force-official')
    assert.match(manual[2], expected)
    assert.match(manual[2], /原恢复记录已备份/)
    assert.equal(h.calls.some(([kind]) => kind === 'read-router'), true)
  })
}

test('official recovery only certifies an account after explicit identity verification', () => {
  const h = harness()
  assert.equal(h.codexOfficialAccountRestoreNotice({}), '')
  const restored = { authCleanup: { restored: true, restoredAccountKey: 'B' } }
  assert.match(h.codexOfficialAccountRestoreNotice(restored), /待核验/)
  assert.doesNotMatch(h.codexOfficialAccountRestoreNotice(restored), /已恢复/)
  assert.match(h.codexOfficialAccountRestoreNotice(restored, true), /原账号本机登录凭据已恢复并核验/)
  for (const authCleanup of [
    { reason: 'restored_pre_login_signed_out' },
    { reason: 'missing_auth' },
    { removed: true, restored: false },
  ]) {
    assert.match(h.codexOfficialAccountRestoreNotice({ authCleanup }), /官方未登录状态/)
  }
})

test('silent refresh ignores only known transient contention and preserves account identity', async () => {
  for (const error of [
    'Codex 正在切换账号，请稍后刷新账号列表。',
    new Error('Codex configure 正在进行中，请稍后再试。'),
    { message: 'Codex 正在处理其他配置，请稍后重试。' },
  ]) {
    const h = harness({ api: { getCodexAccounts: async () => { throw error } } })
    const identity = h.state.codexAccountsState.value
    await h.loadCodexAccounts({ silent: true })
    assert.equal(h.state.codexAccountsError.value, '')
    assert.equal(h.state.codexAccountsState.value, identity)
  }
  const h = harness({ api: { getCodexAccounts: async () => { throw Error('account storage unreadable') } } })
  await h.loadCodexAccounts({ silent: true })
  assert.equal(h.state.codexAccountsError.value, 'account storage unreadable')
})

test('explicit refresh still reports a real contention failure', async () => {
  const message = 'Codex 正在切换账号，请稍后刷新账号列表。'
  const h = harness({ api: { getCodexAccounts: async () => { throw Error(message) } } })
  await h.loadCodexAccounts()
  assert.equal(h.state.codexAccountsError.value, message)
  assert.equal(h.state.isCodexAccountsLoading.value, false)
})

test('manual restart executes once and pauses background reads until completion', async () => {
  const restarting = deferred()
  let restarts = 0
  const h = harness({ api: {
    restartCodex: async () => { restarts += 1; return restarting.promise },
  } })
  const pending = h.restartCodexForActivePage()
  await tick()
  assert.equal(h.state.isCodexRestarting.value, true)
  await h.loadCodexAccounts({ silent: true })
  await h.loadCodexRouterStatus({ silent: true })
  await h.loadAggregateLoginStatus({ silent: true })
  assert.equal(h.calls.some(([kind]) => kind.startsWith('read-')), false)
  restarting.resolve({ codexLaunched: true })
  await pending
  assert.equal(restarts, 1)
  assert.equal(h.state.isCodexRestarting.value, false)
  assert.match(h.state.toolNotices.value.codex, /已重新打开/)
  await h.loadCodexAccounts({ silent: true })
  assert.equal(h.calls.filter(([kind]) => kind === 'read-accounts').length, 1)
})

test('failed restart releases background reads and shows the actual failure', async () => {
  const h = harness({ api: { restartCodex: async () => { throw Error('launch failed') } } })
  await h.restartCodexForActivePage()
  assert.equal(h.state.toolErrors.value.codex, 'launch failed')
  assert.equal(h.state.isCodexRestarting.value, false)
  await h.loadCodexAccounts({ silent: true })
  assert.equal(h.calls.filter(([kind]) => kind === 'read-accounts').length, 1)
})

test('queued restart is shown as launching rather than a failed click', async () => {
  const h = harness({ api: { restartCodex: async () => ({ codexLaunched: false, codexLaunchQueued: true }) } })
  await h.restartCodexForActivePage()
  assert.equal(h.state.toolErrors.value.codex, '')
  assert.match(h.state.toolNotices.value.codex, /已提交 Codex 启动请求/)
})

function ultraTestClock(h) {
  const timers = new Map()
  let nextId = 0
  h.state.window.setTimeout = (callback) => { timers.set(++nextId, callback); return nextId }
  h.state.window.clearTimeout = (id) => timers.delete(id)
  return {
    timers,
    async advance() {
      const [id, callback] = timers.entries().next().value || []
      assert.ok(callback, 'Expected a scheduled Ultra check')
      timers.delete(id)
      callback()
      await tick()
    },
  }
}

const pendingUltra = { requested: true, enabled: true, ready: false, verified: false, reason: 'awaiting-page' }
const verifiedUltra = { requested: true, enabled: true, ready: true, verified: true, reason: 'ready' }

test('launch feedback preserves and deduplicates nested patch and launch warnings', () => {
  const h = harness()
  assert.equal(h.codexLaunchWarnings({
    warnings: [' 相同提示。 ', '', '顶层提示。'],
    appPatch: { warnings: ['相同提示。', '模型目录提示。'] },
    launch: { warnings: ['模型目录提示。', '启动提示。'] },
  }), '相同提示。 顶层提示。 模型目录提示。 启动提示。')
})

test('login reports only success while keeping unverified Ultra in diagnostics', async () => {
  const warning = 'macOS 未修改 Ultra 显示条件。'
  const h = fuelHarness({ page: '无账号登录', api: {
    configureCodex: async () => ({
      router: router(true), codexLaunched: true,
      appPatch: { applied: true, modelPickerEnhanced: true, ultraReasoningPatched: false, warnings: [warning] },
      launch: { warnings: [warning] },
    }),
  } })
  await h.connectToolForActivePage()
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.equal(h.state.toolNotices.value.codex, '登录成功')
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'notify'), [['notify', '登录成功', 'success']])
  const messages = h.codexLoginDiagnostics.value.messages
  assert.equal(messages.filter(message => message === warning).length, 1)
  assert.match(messages.join(' '), /Ultra 检查尚未完成/)
  assert.doesNotMatch(messages.join(' '), /Ultra 已通过/)
})

test('restart finishes immediately and updates Ultra only after verified background status', async () => {
  let reads = 0
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, launch: { ultra: pendingUltra } }),
    getCodexUltraStatus: async () => { reads += 1; return verifiedUltra },
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  assert.equal(h.state.isCodexRestarting.value, false)
  assert.equal(reads, 0)
  assert.match(h.state.toolNotices.value.codex, /Ultra 检查尚未完成/)
  await clock.advance()
  assert.equal(reads, 1)
  assert.match(h.state.toolNotices.value.codex, /已重新打开.*Ultra 已通过本次检查/)
  assert.equal(clock.timers.size, 0)
})

test('current launch pending status wins over a stale top-level verified result', () => {
  const h = harness()
  const feedback = h.codexUltraFeedback({ ultra: verifiedUltra, launch: { ultra: pendingUltra } })
  assert.equal(feedback.pending, true)
  assert.doesNotMatch(feedback.notice, /已通过/)
})

test('ready without verification stays pending and bounded polling never claims success', async () => {
  let reads = 0
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: pendingUltra }),
    getCodexUltraStatus: async () => { reads += 1; return { ...pendingUltra, ready: true, reason: 'future-state' } },
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  for (let attempt = 0; attempt < 15; attempt += 1) await clock.advance()
  assert.equal(reads, 15)
  assert.equal(clock.timers.size, 0)
  assert.match(h.state.toolNotices.value.codex, /检查尚未完成，可继续使用当前可见的思考档位/)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /已通过|future-state/)
})

for (const [reason, expected] of [
  ['unsupported-query', /当前 Codex 版本的 Ultra 界面尚未适配/],
  ['verification-failed', /Ultra 界面检查未通过/],
  ['connection-unavailable', /暂时无法连接 Codex 界面/],
  ['catalog-unavailable', /Ultra 模型目录不可用.*重新执行 API 登录/],
  ['route-inactive', /当前 API 路由未就绪.*检查登录配置/],
]) {
  test(`Ultra ${reason} is a readable degraded status while Codex remains open`, async () => {
    const h = harness({ api: {
      restartCodex: async () => ({ codexLaunched: true, ultra: pendingUltra }),
      getCodexUltraStatus: async () => ({ ...pendingUltra, reason, error: 'internal-sensitive-diagnostic' }),
    } })
    const clock = ultraTestClock(h)
    await h.restartCodexForActivePage()
    await clock.advance()
    assert.equal(h.state.toolErrors.value.codex, '')
    assert.match(h.state.toolWarnings.value.codex, /Codex 已重新打开/)
    assert.match(h.state.toolWarnings.value.codex, expected)
    assert.doesNotMatch(h.state.toolWarnings.value.codex, /internal-sensitive-diagnostic|unsupported-query|verification-failed|connection-unavailable/)
    assert.equal(clock.timers.size, 0)
  })
}

test('official sessions stay quiet while unavailable managed catalogs remain actionable', () => {
  const h = harness()
  const disabled = h.codexUltraFeedback({ ultra: {
    requested: false, enabled: false, reason: 'route-inactive',
  } })
  assert.equal(disabled.notice, '')
  assert.equal(disabled.warning, '')
  assert.equal(disabled.pending, false)
  const unavailable = h.codexUltraFeedback({ ultra: {
    requested: true, enabled: false, reason: 'catalog-unavailable',
  } })
  assert.match(unavailable.warning, /模型目录不可用/)
  assert.equal(unavailable.pending, false)
})

test('visible picker verification and unsupported current models have distinct feedback', () => {
  const h = harness()
  const awaiting = h.codexUltraFeedback({ ultra: { ...pendingUltra, reason: 'awaiting-visible-picker' } })
  assert.equal(awaiting.pending, true)
  assert.match(awaiting.notice, /当前输入框仍在等待 Ultra 验证/)
  assert.match(awaiting.notice, /打开本地聊天的模型或思考档位选择器/)
  assert.doesNotMatch(awaiting.notice, /已通过/)
  for (const [reason, expected] of [
    ['model-unsupported', /当前模型未声明支持 Ultra/],
    ['visible-model-unsupported', /当前模型或可见选项未提供 Ultra/],
  ]) {
    const feedback = h.codexUltraFeedback({ ultra: { ...pendingUltra, reason } })
    assert.equal(feedback.pending, true)
    assert.match(feedback.notice, expected)
    assert.equal(feedback.warning, '')
    if (reason === 'visible-model-unsupported') assert.doesNotMatch(feedback.notice, /未声明/)
  }
  const disabled = h.codexUltraFeedback({ ultra: { ...pendingUltra, reason: 'setting-disabled' } })
  assert.equal(disabled.pending, true)
  assert.match(disabled.notice, /当前选择器未允许显示 Ultra/)
  const catalogUnsupported = h.codexUltraFeedback({ ultra: {
    ...pendingUltra, enabled: false, reason: 'model-unsupported',
  } })
  assert.equal(catalogUnsupported.pending, false)
})

test('an initial Ultra asset timeout recovers without leaving a stale launch warning', async () => {
  const warning = 'Ultra 界面资源加载超时，正在自动重试。'
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: {
      ...pendingUltra, reason: 'asset-timeout', error: warning, warnings: [warning],
    } }),
    getCodexUltraStatus: async () => verifiedUltra,
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  assert.match(h.state.toolWarnings.value.codex, /资源加载超时/)
  await clock.advance()
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.match(h.state.toolNotices.value.codex, /Ultra 已通过本次检查/)
  assert.equal(clock.timers.size, 0)
})

test('bounded Ultra polling preserves the actionable visible-picker instruction', async () => {
  const status = { ...pendingUltra, reason: 'awaiting-visible-picker' }
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: status }),
    getCodexUltraStatus: async () => status,
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  for (let attempt = 0; attempt < 15; attempt += 1) await clock.advance()
  assert.match(h.state.toolNotices.value.codex, /打开本地聊天的模型或思考档位选择器/)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /已通过/)
  assert.equal(clock.timers.size, 0)
})

test('a hung Ultra status request times out and cannot replace its warning when it resolves later', async () => {
  const reading = deferred()
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: pendingUltra }),
    getCodexUltraStatus: async () => reading.promise,
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  await clock.advance()
  await clock.advance()
  const warning = h.state.toolWarnings.value.codex
  assert.match(warning, /暂时无法完成 Ultra 检查/)
  assert.equal(clock.timers.size, 0)
  reading.resolve(verifiedUltra)
  await tick()
  assert.equal(h.state.toolWarnings.value.codex, warning)
})

test('a later configuration cancels an in-flight Ultra check and ignores its stale success', async () => {
  const reading = deferred()
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: pendingUltra }),
    getCodexUltraStatus: async () => reading.promise,
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  await clock.advance()
  const finish = h.beginCodexAccountMutation()
  h.state.toolNotices.value.codex = '已切换到另一个账号。'
  assert.equal(clock.timers.size, 0)
  reading.resolve(verifiedUltra)
  await tick()
  assert.equal(h.state.toolNotices.value.codex, '已切换到另一个账号。')
  finish()
})

test('an old status response cannot clear the timer or update feedback for a newer check', async () => {
  const firstRead = deferred()
  let reads = 0
  const h = harness({ api: {
    getCodexUltraStatus: async () => ++reads === 1 ? firstRead.promise : verifiedUltra,
  } })
  const clock = ultraTestClock(h)
  h.showCodexLaunchFeedback({ ultra: pendingUltra }, '第一次启动。')
  await clock.advance()
  h.showCodexLaunchFeedback({ ultra: pendingUltra }, '第二次启动。')
  firstRead.resolve(verifiedUltra)
  await tick()
  assert.equal(clock.timers.size, 1)
  assert.match(h.state.toolNotices.value.codex, /第二次启动.*检查尚未完成/)
  await clock.advance()
  assert.equal(reads, 2)
  assert.match(h.state.toolNotices.value.codex, /第二次启动.*已通过本次检查/)
  assert.equal(clock.timers.size, 0)
})

test('a rejected status request stops polling with a readable warning', async () => {
  const h = harness({ api: {
    getCodexUltraStatus: async () => { throw Error('internal-status-error') },
  } })
  const clock = ultraTestClock(h)
  h.showCodexLaunchFeedback({ ultra: pendingUltra }, 'Codex 已重新打开。')
  await clock.advance()
  assert.match(h.state.toolWarnings.value.codex, /暂时无法完成 Ultra 检查/)
  assert.doesNotMatch(h.state.toolWarnings.value.codex, /internal-status-error/)
  assert.equal(clock.timers.size, 0)
})

test('stopping the view cancels the pending Ultra timer', async () => {
  let reads = 0
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: pendingUltra }),
    getCodexUltraStatus: async () => { reads += 1; return verifiedUltra },
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  h.stopCodexUltraStatusCheck()
  await tick()
  assert.equal(reads, 0)
  assert.equal(clock.timers.size, 0)
})

test('leaving a login page cancels Ultra verification before its next request', async () => {
  const h = fuelHarness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: pendingUltra }),
    getCodexUltraStatus: async () => verifiedUltra,
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  assert.equal(clock.timers.size, 1)
  h.setPage('无账号登录')
  await tick()
  assert.equal(clock.timers.size, 0)
})

test('official mode neither polls nor claims an Ultra result', async () => {
  let reads = 0
  const h = harness({ api: {
    restartCodex: async () => ({ codexLaunched: true, ultra: { requested: false, reason: 'disabled' } }),
    getCodexUltraStatus: async () => { reads += 1; return verifiedUltra },
  } })
  const clock = ultraTestClock(h)
  await h.restartCodexForActivePage()
  assert.equal(reads, 0)
  assert.equal(clock.timers.size, 0)
  assert.doesNotMatch(h.state.toolNotices.value.codex, /Ultra/)
})

for (const [reason, expected] of [
  ['setting-disabled', /当前选择器未允许显示 Ultra/],
  ['model-unsupported', /当前模型未声明支持 Ultra/],
  ['visible-model-unsupported', /当前模型或可见选项未提供 Ultra/],
]) {
  test(`Ultra ${reason} keeps checking until a later consumer verifies`, async () => {
    let reads = 0
    const h = harness({ api: {
      getCodexUltraStatus: async () => ++reads === 1 ? { ...pendingUltra, reason } : verifiedUltra,
    } })
    const clock = ultraTestClock(h)
    h.showCodexLaunchFeedback({ ultra: pendingUltra }, 'Codex 已重新打开。')
    await clock.advance()
    assert.match(h.state.toolNotices.value.codex, expected)
    assert.doesNotMatch(h.state.toolNotices.value.codex, /已关闭|已通过/)
    assert.equal(h.state.toolWarnings.value.codex, '')
    assert.equal(clock.timers.size, 1)
    await clock.advance()
    assert.equal(reads, 2)
    assert.match(h.state.toolNotices.value.codex, /Ultra 已通过本次检查/)
    assert.equal(clock.timers.size, 0)
  })

  test(`Ultra ${reason} remains bounded without claiming a global setting is disabled`, async () => {
    let reads = 0
    const status = { ...pendingUltra, reason }
    const h = harness({ api: {
      getCodexUltraStatus: async () => { reads += 1; return status },
    } })
    const clock = ultraTestClock(h)
    h.showCodexLaunchFeedback({ ultra: status }, 'Codex 已重新打开。')
    for (let attempt = 0; attempt < 15; attempt += 1) await clock.advance()
    assert.equal(reads, 15)
    assert.match(h.state.toolNotices.value.codex, expected)
    assert.doesNotMatch(h.state.toolNotices.value.codex, /已关闭|已通过|正在继续检查/)
    assert.equal(h.state.toolWarnings.value.codex, '')
    assert.equal(clock.timers.size, 0)
  })
}

test('aggregate login background verification updates its own feedback and retains catalog warnings', async () => {
  const h = harness({ api: { getCodexUltraStatus: async () => verifiedUltra } })
  const clock = ultraTestClock(h)
  h.showCodexLaunchFeedback({ ultra: pendingUltra, appPatch: { warnings: ['目录提示。'] } }, '聚合登录已启用。', [], false, 'aggregate')
  assert.match(h.state.aggregateLoginNotice.value, /Ultra 检查尚未完成/)
  await clock.advance()
  assert.match(h.state.aggregateLoginNotice.value, /Ultra 已通过本次检查/)
  assert.equal(h.state.aggregateLoginError.value, '目录提示。')
  assert.equal(h.state.toolNotices.value.codex, '')
})

test('aggregate login can verify its completed write while unrelated background reads remain paused', async () => {
  const h = harness({ liveAggregate: aggregate(true) })
  const finish = h.beginCodexAccountMutation()
  await h.loadAggregateLoginStatus({ silent: true })
  assert.equal(h.calls.length, 0)
  await h.loadAggregateLoginStatus({ silent: true, afterMutation: true })
  assert.equal(h.calls.filter(([kind]) => kind === 'read-aggregate').length, 1)
  assert.equal(h.state.aggregateLoginStatus.value.enabled, true)
  finish()
})

test('notice restart pauses account and route reads only for the actual restart', async () => {
  const h = harness()
  h.handleCodexConfigUpgradeBusy(true)
  await h.loadCodexAccounts({ silent: true })
  await h.loadCodexRouterStatus({ silent: true })
  await h.loadAggregateLoginStatus({ silent: true })
  assert.equal(h.calls.length, 0)
  h.handleCodexConfigUpgradeBusy(false)
  await h.loadCodexAccounts({ silent: true })
  assert.equal(h.calls.filter(([kind]) => kind === 'read-accounts').length, 1)
  assert.equal(h.state.isToolConnecting.value.codex, false)
})
