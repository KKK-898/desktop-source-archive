import assert from 'node:assert/strict'
import test from 'node:test'
import { harness, deferred, tick, router } from './codex-account-route-harness.mjs'

function loginHarness(options = {}) {
  const h = harness({ fuel: true, page: '无账号登录', realSanitize: true, ...options })
  h.watchFeedback(h.state.loginModelsNotice, 'info', true)
  h.watchFeedback(h.state.loginModelsError, 'error', true)
  h.watchFeedback(h.state.aggregateLoginNotice, 'success', true)
  h.watchFeedback(h.state.aggregateLoginError, 'error', true)
  h.watchFeedbackGetter(() => h.state.toolNotices.value.codex, 'success', true)
  h.watchFeedbackGetter(() => h.state.toolWarnings.value.codex, 'warning', true)
  h.watchFeedbackGetter(() => h.state.toolErrors.value.codex, 'error', true)
  return h
}
const notices = h => h.calls.filter(([kind]) => kind === 'notify')
const dialogs = h => h.calls.filter(([kind]) => kind === 'confirm')

test('API login is silent while loading and reports one short success despite runtime and history diagnostics', async () => {
  const configured = deferred()
  let runtimeReads = 0
  const h = loginHarness({ api: {
    configureCodex: () => configured.promise,
    getCodexUltraStatus: async () => { runtimeReads += 1; throw Error('late UI failure') },
    getCodexNativeFastStatus: async () => { runtimeReads += 1; throw Error('late Fast failure') },
    getCodexApiModeStatus: async () => { runtimeReads += 1; throw Error('late API mode failure') },
  } })
  const pending = h.connectToolForActivePage()
  await tick()
  assert.equal(h.state.isToolConnecting.value.codex, true)
  h.state.loginModelsNotice.value = '模型目录准备中'
  assert.deepEqual(notices(h), [])
  assert.deepEqual(dialogs(h), [])
  assert.equal(h.calls.some(([kind]) => kind === 'open-operation'), false)
  configured.resolve({
    routeConfigured: true, router: router(true), codexLaunched: true,
    modelCatalogModels: ['gpt-6-astra'],
    imageToolsWarning: '图片工具后台加载中',
    sessionSync: { status: 'completed', warnings: ['历史索引已保留，部分文件待原生恢复'] },
    launch: { runtimePending: true,
      ultra: { requested: true, enabled: true, reason: 'connection-unavailable', warnings: ['Ultra 未连接'] },
      nativeFast: { enabled: true, reason: 'preparing-modules', phase: 'pending' },
      apiMode: { requested: true, reason: 'awaiting-page', warnings: ['API 模式验证中'] },
    },
  })
  await pending
  await tick()
  assert.deepEqual(notices(h), [['notify', '登录成功', 'success']])
  assert.deepEqual(dialogs(h), [])
  assert.equal(h.state.toolWarnings.value.codex, '')
  assert.equal(h.state.toolErrors.value.codex, '')
  assert.equal(runtimeReads, 0, 'Login must not start a second notification-producing verification loop')
  assert.equal(h.calls.some(([kind]) => kind === 'manual-open'), false)
  assert.match(h.codexLoginDiagnostics.value.messages.join(' '), /历史索引已保留/)
  assert.match(h.codexLoginDiagnostics.value.messages.join(' '), /Ultra/)
  assert.doesNotMatch(h.codexLoginDiagnostics.value.messages.join(' '), /Ultra 已通过/)
  h.state.loginModelsNotice.value = '用户随后手动刷新模型'
  assert.deepEqual(notices(h).at(-1), ['notify', '用户随后手动刷新模型', 'info'])
})

test('successful fuel uses the same quiet flow and exactly one 加油成功 notification', async () => {
  const h = loginHarness({ page: '已有账号加油' })
  await h.connectToolForActivePage()
  assert.deepEqual(notices(h), [['notify', '加油成功', 'success']])
  assert.deepEqual(dialogs(h), [])
  assert.equal(h.isExistingAccountFuelActive.value, true)
  assert.equal(h.calls.some(([kind]) => kind === 'open-operation'), false)
})

for (const [error, code, reason] of [
  [{ code: 'invalid_api_key', reason: 'The supplied API key was rejected.', message: 'Request failed' }, 'invalid_api_key', 'The supplied API key was rejected.'],
  [JSON.stringify({ error: { code: 'account_disabled', message: 'This account is disabled.' } }), 'account_disabled', 'This account is disabled.'],
  ['CODEX_FUEL_ACCOUNT_MODE_CONFLICT: 已有账号加油不允许同时使用 API 登录模式。', 'CODEX_FUEL_ACCOUNT_MODE_CONFLICT', 'CODEX_FUEL_ACCOUNT_MODE_CONFLICT: 已有账号加油不允许同时使用 API 登录模式。'],
  [Object.assign(new Error('Service unavailable'), { status: 503 }), '503', 'Service unavailable'],
  ['Native configuration write failed', '', 'Native configuration write failed'],
]) {
  test(`real login failure preserves returned code ${code || '(absent)'} and reason in one dialog`, async () => {
    const h = loginHarness({ api: { configureCodex: async () => { throw error } } })
    await h.connectToolForActivePage()
    assert.deepEqual(notices(h), [])
    assert.equal(dialogs(h).length, 1)
    const [, message, options] = dialogs(h)[0]
    assert.equal(message, reason)
    assert.equal(options.title, '登录失败')
    assert.deepEqual(Array.from(options.details), code ? [`错误码：${code}`] : [])
    assert.equal(h.state.toolNotices.value.codex, '')
    assert.equal(h.state.isToolConnecting.value.codex, false)
  })
}

test('backend fuel failure retains the real native error code rather than an invented status', async () => {
  const h = loginHarness({ page: '已有账号加油', api: {
    configureCodex: async () => { throw 'CODEX_FUEL_ACCOUNT_CHANGED: 当前登录账号已经变化。' },
  } })
  await h.connectToolForActivePage()
  assert.deepEqual(notices(h), [])
  assert.equal(dialogs(h).length, 1)
  assert.equal(dialogs(h)[0][2].title, '加油失败')
  assert.deepEqual(Array.from(dialogs(h)[0][2].details), ['错误码：CODEX_FUEL_ACCOUNT_CHANGED'])
  assert.match(dialogs(h)[0][1], /当前登录账号已经变化/)
})

test('post-write account observation failure stays recoverable without claiming success or definite fuel failure', async () => {
  const h = loginHarness({ page: '已有账号加油', api: {
    getCodexAccounts: async () => { throw Error('Account observation temporarily unavailable') },
  } })
  await h.connectToolForActivePage()
  assert.deepEqual(notices(h), [])
  assert.deepEqual(dialogs(h), [])
  assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
  assert.equal(h.isExistingAccountFuelActive.value, false)
  assert.match(h.codexLoginDiagnostics.value.messages.join(' '), /Account observation temporarily unavailable/)
})

test('canceling the explicit restart confirmation does not emit login status notifications', async () => {
  const h = loginHarness()
  h.state.confirmCodexRestart = async () => false
  await h.connectToolForActivePage()
  assert.deepEqual(notices(h), [])
  assert.deepEqual(dialogs(h), [])
  assert.equal(h.calls.some(([kind]) => kind === 'configure'), false)
})


test('real failure redaction preserves the returned code while removing headers, named tokens, and JWT credentials', async () => {
  const secrets = ['opaqueHeaderCredential', 'opaqueBearerCredential', 'arbitraryKeyValue',
    'arbitraryAccessToken', 'arbitraryRefreshToken', 'privateCookieValue',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJpc29sYXRlZCJ9.c3ludGhldGljU2lnbmF0dXJl']
  const reason = `Upstream rejected credentials; Authorization: Bearer ${secrets[0]}; `
    + `Bearer ${secrets[1]}; api_key=${secrets[2]}; "access_token":"${secrets[3]}"; `
    + `'refresh_token'='${secrets[4]}'; Cookie: ${secrets[5]}; jwt=${secrets[6]}`
  const h = loginHarness({ api: { configureCodex: async () => { throw { code: 'invalid_api_key', reason } } } })
  await h.connectToolForActivePage()
  assert.deepEqual(notices(h), [])
  assert.equal(dialogs(h).length, 1)
  const [, message, options] = dialogs(h)[0]
  assert.match(message, /Upstream rejected credentials/)
  assert.deepEqual(Array.from(options.details), ['错误码：invalid_api_key'])
  const displayed = [message, ...options.details, h.state.toolErrors.value.codex,
    JSON.stringify(h.calls.filter(([kind]) => kind === 'report-error'))].join(' ')
  for (const secret of secrets) assert.equal(displayed.includes(secret), false)
  assert.match(displayed, /已隐藏/)
})


for (const invalidStatus of [
  { requiresReauth: true }, { loginState: 'invalid' }, { canSwitch: false },
]) {
  test(`fresh same-account ${Object.keys(invalidStatus)[0]} rejects fuel success and retains actual failure details`, async () => {
    const h = loginHarness({ page: '已有账号加油', api: {
      getCodexAccounts: async () => ({ currentAccount: {
        accountKey: 'A', ...invalidStatus, reauthReason: 'Session was revoked by the account owner.', code: 'session_revoked',
      }, accounts: [] }),
    } })
    await h.connectToolForActivePage()
    assert.deepEqual(notices(h), [])
    assert.equal(dialogs(h).length, 1)
    assert.equal(dialogs(h)[0][1], 'Session was revoked by the account owner.')
    assert.equal(dialogs(h)[0][2].title, '加油失败')
    assert.deepEqual(Array.from(dialogs(h)[0][2].details), ['错误码：session_revoked'])
    assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
    assert.equal(h.isExistingAccountFuelActive.value, false)
    assert.equal(h.store.has('gaoge_desktop_fuel_pack_account_key'), false)
  })
}

test('fresh invalid account without a returned error code never invents one', async () => {
  const h = loginHarness({ page: '已有账号加油', api: {
    getCodexAccounts: async () => ({ currentAccount: { accountKey: 'A', requiresReauth: true, reauthReason: '重新登录后再试。' }, accounts: [] }),
  } })
  await h.connectToolForActivePage()
  assert.deepEqual(notices(h), [])
  assert.equal(dialogs(h)[0][1], '重新登录后再试。')
  assert.deepEqual(Array.from(dialogs(h)[0][2].details), [])
  assert.equal(h.isCodexFuelRecoveryAvailable.value, true)
})
