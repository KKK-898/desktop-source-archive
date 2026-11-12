import assert from 'node:assert/strict'
import test from 'node:test'
import { harness, tick, deferred, account, router, aggregate } from './codex-account-route-harness.mjs'

const actions = ['closeCodexRelayFromLoginPage', 'forceOfficialCodexForActivePage', 'disableAggregateLogin']
const saved = { ...account('A'), isActive: false, isLiveCurrent: false, canSwitch: true }
const closed = (authVerification) => ({ router: router(false), aggregate: aggregate(false), codexLaunched: true,
  authCleanup: { restored: true, restoredAccountKey: 'A' }, ...(authVerification ? { authVerification } : {}) })
const output = h => [h.state.toolNotices.value.codex, h.state.toolWarnings.value.codex,
  h.state.toolErrors.value.codex, h.state.aggregateLoginNotice.value, h.state.aggregateLoginError.value].filter(Boolean).join(' ')
const setup = (action, state, response = closed()) => harness({ fuel: true, page: '无账号登录',
  source: action === 'disableAggregateLogin' ? 'aggregate' : 'one-click',
  cachedRouter: router(true), liveRouter: router(false), cachedAggregate: aggregate(action === 'disableAggregateLogin'),
  accountsState: { currentAccount: null, accounts: [saved] }, api: {
    disableCodexFuelPack: async () => response, disableAggregateLogin: async () => response,
    getCodexAccounts: typeof state === 'function' ? state : async () => state,
  } })
for (const action of actions) {
  for (const [name, state] of [
    ['no current identity despite saved snapshot', { currentAccount: null, accounts: [saved] }],
    ['a different live account', { currentAccount: account('B'), accounts: [saved, account('B')] }],
    ['the account reread fails', async () => { throw Error('synthetic read failure') }],
    ['only a stale isActive account exists', { currentAccount: null, accounts: [{ ...saved, isActive: true }] }],
  ]) test(action + ' never claims restored login when ' + name, async () => {
    const h=setup(action,state); await h[action](); await tick();
    assert.match(output(h), /官方.*路由/)
    assert.match(output(h), /未能确认|核验失败|无法确认/)
    assert.doesNotMatch(output(h), /官方账号登录状态已恢复|原账号(?:本机)?登录凭据已恢复并核验/)
    assert.equal(h.normalizedCodexRelaySource.value, '')
    assert.equal(h.calls.some(([kind]) => ['activate','configure','restart'].includes(kind)), false)
  })
  test(action + ' waits for actual account verification before releasing the mutation', async () => {
    const read=deferred(); const h=setup(action,()=>read.promise);
    let finished=false; const pending=h[action]().then(()=>{finished=true}); await tick();
    assert.equal(finished,false); assert.equal(h.state.isToolConnecting.value.codex || h.state.isAggregateLoginLoading.value,true)
    assert.doesNotMatch(output(h), /官方账号登录状态已恢复|原账号(?:本机)?登录凭据已恢复并核验/)
    read.resolve({currentAccount:account('A'),accounts:[account('A')]}); await pending;
    assert.match(output(h), /登录.*已恢复/)
  })
  for(const response of [
    {...closed(),codexLaunched:false,codexLaunchQueued:true},
    {...closed(),codexLaunched:false},
    closed({status:'pending',expectedAccountKey:'A',reason:'native_launch_pending',checkedAfterLaunch:false}),
  ]) test(action + ' keeps unlaunched or backend-pending authentication unverified ' + JSON.stringify(response.authVerification || {launched:response.codexLaunched,queued:response.codexLaunchQueued}), async()=>{
    const h=setup(action,{currentAccount:account('A'),accounts:[account('A')]},response); await h[action]();
    assert.match(output(h), /待.*核验|尚未确认/)
    assert.doesNotMatch(output(h), /官方账号登录状态已恢复|原账号(?:本机)?登录凭据已恢复并核验/)
  })
  test(action + ' cannot override backend failed verification with a saved or current account',async()=>{
    const h=setup(action,{currentAccount:account('A'),accounts:[account('A')]},closed({status:'failed',expectedAccountKey:'A',reason:'identity_changed',checkedAfterLaunch:true}));
    await h[action](); assert.match(output(h), /未能确认|核验失败/); assert.doesNotMatch(output(h), /官方账号登录状态已恢复|原账号(?:本机)?登录凭据已恢复并核验/)
  })
}

for (const action of actions) {
  for (const [name, flags] of [
    ['expired credential', { requiresReauth: true }],
    ['unusable credential', { canSwitch: false }],
  ]) test(action + ' rejects an exact account key with ' + name, async () => {
    const current = { ...account('A'), ...flags }
    const h = setup(action, { currentAccount: current, accounts: [current] })
    await h[action]()
    assert.match(output(h), /未能确认原账号恢复/)
    assert.doesNotMatch(output(h), /登录(?:凭据|状态)已恢复/)
  })
  test(action + ' accepts refreshable credentials without pretending to verify a native session', async () => {
    const current = { ...account('A'), loginState: 'refreshable', requiresReauth: false, canSwitch: true }
    const h = setup(action, { currentAccount: current, accounts: [current] }, closed({
      status: 'verified', expectedAccountKey: 'A', reason: 'exact_local_auth', checkedAfterLaunch: true,
      scope: 'local-auth-file', nativeSessionVerified: false,
    }))
    await h[action]()
    assert.match(output(h), /本机登录凭据已恢复并核验/)
    assert.match(output(h), /尚未核验 Codex 原生会话/)
    assert.doesNotMatch(output(h), /官方账号登录状态已恢复/)
  })
  test(action + ' honors the backend expected identity instead of cleanup fallback', async () => {
    const response = closed({ status: 'verified', expectedAccountKey: 'B', reason: 'expected_original', checkedAfterLaunch: true })
    const wrong = setup(action, { currentAccount: account('A'), accounts: [account('A'), account('B')] }, response)
    await wrong[action]()
    assert.match(output(wrong), /未能确认原账号恢复/)
    assert.doesNotMatch(output(wrong), /登录(?:凭据|状态)已恢复/)
    const right = setup(action, { currentAccount: account('B'), accounts: [account('A'), account('B')] }, response)
    await right[action]()
    assert.match(output(right), /本机登录凭据已恢复并核验/)
  })
  test(action + ' treats checkedAfterLaunch false as pending even when status says verified', async () => {
    const h = setup(action, { currentAccount: account('A'), accounts: [account('A')] }, closed({
      status: 'verified', expectedAccountKey: 'A', reason: 'local_only', checkedAfterLaunch: false,
    }))
    await h[action]()
    assert.match(output(h), /尚未确认原生登录/)
    assert.doesNotMatch(output(h), /登录(?:凭据|状态)已恢复/)
  })
  test(action + ' keeps an originally signed-out session signed out without activating a saved account', async () => {
    const h = setup(action, { currentAccount: null, accounts: [saved] }, { ...closed(),
      authCleanup: { restored: true, reason: 'restored_pre_login_signed_out' },
      authVerification: { status: 'not-required', reason: 'no_original_account', checkedAfterLaunch: true,
        scope: 'local-auth-file', nativeSessionVerified: false },
    })
    await h[action]()
    assert.match(output(h), /当前处于官方未登录状态/)
    assert.doesNotMatch(output(h), /登录(?:凭据|状态)已恢复|未能确认/)
    assert.equal(h.state.codexAccountsState.value.currentAccount, null)
    assert.equal(h.calls.some(([kind]) => ['activate', 'configure', 'restart'].includes(kind)), false)
  })
  test(action + ' cannot claim the original account restored when backend preserved unrelated current auth', async () => {
    const h = setup(action, { currentAccount: account('B'), accounts: [saved, account('B')] }, { ...closed(),
      authCleanup: { restored: false, reason: 'preserved_current_auth_after_missing_official_auth', restoredAccountKey: 'B' },
      authVerification: { status: 'failed', expectedAccountKey: 'A', reason: 'missing_official_auth', checkedAfterLaunch: true },
    })
    await h[action]()
    assert.match(output(h), /原账号登录核验失败/)
    assert.doesNotMatch(output(h), /登录(?:凭据|状态)已恢复/)
  })
}

test('close verification rejects late reads without replacing newer account state', async () => {
  const read = deferred()
  const h = setup('closeCodexRelayFromLoginPage', () => read.promise)
  const pending = h.verifyCodexOfficialAccountRestore(closed())
  await tick()
  h.invalidateCodexAccountsRequests()
  const newer = { currentAccount: account('B'), accounts: [account('B')] }
  h.state.codexAccountsState.value = newer
  read.resolve({ currentAccount: account('A'), accounts: [account('A')] })
  const result = await pending
  assert.match(result.warning, /账号状态已变化/)
  assert.equal(h.state.codexAccountsState.value.currentAccount.accountKey, 'B')
})

test('close verification times out, clears its timer, and ignores the eventual stale reply', async () => {
  const read = deferred()
  const h = setup('closeCodexRelayFromLoginPage', () => read.promise)
  const cleared = []
  let timeout
  h.state.window.setTimeout = (callback, delay) => { assert.equal(delay, 8000); timeout = callback; return 4321 }
  h.state.window.clearTimeout = id => cleared.push(id)
  const before = h.state.codexAccountsState.value
  const pending = h.verifyCodexOfficialAccountRestore(closed())
  await tick()
  assert.equal(typeof timeout, 'function')
  timeout()
  const result = await pending
  assert.match(result.warning, /登录状态核验超时/)
  assert.deepEqual(cleared, [4321])
  read.resolve({ currentAccount: account('A'), accounts: [account('A')] })
  await tick()
  assert.equal(h.state.codexAccountsState.value, before)
})

for (const action of actions) test(action + ' never calls preserved credentials restored for an unknown cleanup reason', async () => {
  const h = setup(action, { currentAccount: account('A'), accounts: [account('A')] }, { ...closed(),
    authCleanup: { restored: false, reason: 'future_preserved_state', restoredAccountKey: 'A' },
  })
  await h[action]()
  assert.match(output(h), /没有确认恢复原账号/)
  assert.doesNotMatch(output(h), /登录(?:凭据|状态)已恢复/)
})
