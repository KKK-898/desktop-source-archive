import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { harness, tick } from './codex-account-route-harness.mjs'

// Only production code is evaluated; all identity, settings and UI surfaces are
// in-memory fixtures. Never launch Codex, read real credentials, or alter its DB.
const runtimeSource = fs.readFileSync(new URL('../src-tauri/src/codex_api_mode_runtime.js', import.meta.url), 'utf8')
const modeSource = fs.readFileSync(new URL('../src-tauri/src/codex_api_mode.rs', import.meta.url), 'utf8')
const libSource = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8')
const createGuard = vm.runInNewContext(`${runtimeSource}\ncreateCodexApiModeGuard;`, {})

function lifecycleFixture() {
  const identity = { authMethod: 'apikey', accountId: null, userId: null, stableId: 'fixture-device' }
  const current = { authMethod: 'apikey', authLoading: false, identity, detailLevel: 'STEPS_PROSE' }
  const records = new Map([[JSON.stringify(identity), { ...identity, policy: 'everyday' }]])
  const effects = []
  const scope = Object.freeze({ fixtureScope: true })
  const saved = Object.freeze({
    auth: Object.freeze({ auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-key', native_metadata: Object.freeze({ schema: 2 }) }),
    onboarding: Object.freeze({ 'electron:onboarding-projectless-completed': true, 'electron:onboarding-welcome-pending': true }),
    navigation: '/welcome',
  })
  const key = value => JSON.stringify(Object.fromEntries(['authMethod', 'accountId', 'userId', 'stableId'].map(name => [name, value?.[name]])))
  let configured = 'STEPS_PROSE'
  let enabled = true
  const settings = {
    async read(name) {
      assert.equal(name, 'conversationDetailMode')
      return { configured, effective: configured }
    },
    async write(name, value) {
      assert.equal(name, 'conversationDetailMode', 'Only the supported preference may be changed')
      effects.push(['preference', value])
      configured = value
    },
  }
  const access = { async publish(payload) {
    assert.ok(['coding', 'everyday', 'preference'].includes(payload.policy))
    effects.push(['policy', { ...payload }])
    records.set(key(payload), { ...payload })
  } }
  const bindings = {
    appServices: {
      settings, workModeAccess: access,
      login: () => assert.fail('Mode normalization must not initiate login'),
      logout: () => assert.fail('Mode normalization must not initiate logout'),
      navigate: () => assert.fail('Mode normalization must not bypass the welcome route'),
    },
    scopes: () => [scope],
    read: value => {
      assert.equal(value, scope)
      return { ...current, policy: records.get(key(current.identity))?.policy }
    },
    setCoding: async value => {
      assert.equal(value, scope)
      effects.push(['native-set-coding'])
      current.detailLevel = 'STEPS_COMMANDS'
      await settings.write('conversationDetailMode', 'STEPS_COMMANDS')
    },
  }
  const guard = createGuard(bindings, { getState: () => ({ apiCodingModeEnabled: enabled }) })
  return { guard, current, records, effects, settings, saved, key, setEnabled: value => { enabled = value } }
}

test('repeated API normalization preserves native auth, welcome state and navigation', async t => {
  const f = lifecycleFixture()
  t.after(() => f.guard.dispose())
  const before = JSON.stringify(f.saved)
  await f.guard.refresh()
  assert.equal(f.guard.status().ready, true)
  assert.equal(f.guard.status().reason, 'coding')
  assert.equal(f.effects.filter(([kind]) => kind === 'native-set-coding').length, 1)
  const effectCount = f.effects.length
  await f.guard.refresh()
  await f.guard.refresh()
  assert.equal(f.effects.length, effectCount, 'A verified repeated refresh must not reinitialize the session')
  assert.equal(JSON.stringify(f.saved), before)
  assert.equal(f.saved.onboarding['electron:onboarding-welcome-pending'], true, 'Native welcome remains untouched')
})

test('loading or signed-out native identity never gains Coding verification', async t => {
  for (const state of [{ authLoading: true }, { authMethod: null, identity: null }]) {
    const f = lifecycleFixture()
    t.after(() => f.guard.dispose())
    Object.assign(f.current, state)
    await f.guard.refresh()
    assert.equal(f.guard.status().ready, false)
    assert.equal(f.guard.status().reason, 'awaiting-native-auth')
    assert.equal(f.effects.length, 0)
  }
})

test('a real ChatGPT identity switch restores API policy without reauthentication or navigation', async t => {
  const f = lifecycleFixture()
  t.after(() => f.guard.dispose())
  const oldIdentity = { ...f.current.identity }
  await f.guard.refresh()
  const before = JSON.stringify(f.saved)
  f.current.identity = { authMethod: 'chatgpt', accountId: 'fixture-account', userId: 'fixture-user', stableId: 'fixture-device' }
  f.current.authMethod = 'chatgpt'
  f.current.detailLevel = 'STEPS_PROSE'
  await f.guard.refresh()
  assert.equal(f.guard.status().ready, false)
  assert.equal(f.records.get(f.key(oldIdentity)).policy, 'everyday')
  await f.settings.write('conversationDetailMode', 'STEPS_PROSE')
  assert.equal((await f.settings.read('conversationDetailMode')).configured, 'STEPS_PROSE')
  assert.equal(JSON.stringify(f.saved), before)
})

test('same-key auth reuse is gated by pure API identity and occurs before credential backup/write', () => {
  const predicate = modeSource.slice(modeSource.indexOf('pub fn matches_api_key('), modeSource.indexOf('#[cfg(test)]'))
  assert.match(predicate, /enabled\(auth\)/)
  assert.match(predicate, /value\.get\("OPENAI_API_KEY"\)/)
  assert.match(predicate, /== Some\(api_key\)/)
  const start = libSource.indexOf('fn write_codex_api_auth(')
  const body = libSource.slice(start, libSource.indexOf('\nfn ', start + 1))
  const reuse = body.indexOf('codex_api_mode::matches_api_key(current_auth.as_ref(), api_key)')
  const unchanged = body.indexOf('return Ok(false);', reuse)
  const backup = body.indexOf('backup_codex_auth(backup_label)')
  const write = body.indexOf('write_json_pretty(&codex_auth_path(), &auth)')
  assert.ok(reuse >= 0 && unchanged > reuse && backup > unchanged && write > backup)
  assert.doesNotMatch(runtimeSource, /loginWithApiKey\s*\(|\.navigate\s*\(|\/welcome|onboarding-welcome-pending|workspaceRecovery/,
    'The compatibility layer must not replay login or alter native onboarding to hide errors')
})

const disabled = { requested: false, enabled: false, ready: false, verified: false, reason: 'disabled' }
const pending = { requested: true, enabled: true, ready: false, verified: false, reason: 'awaiting-bindings' }
const unsupported = { ...pending, reason: 'unsupported-runtime', warnings: ['当前 Codex 版本尚未适配，尚未确认成功。'] }
const success = /纯 API 登录已使用 Codex 编码模式/

test('unsupported API feedback is actionable and terminal, never reported as success', t => {
  const f = harness()
  t.after(() => f.stopCodexUltraStatusCheck())
  const result = f.codexApiModeFeedback({ apiMode: unsupported })
  assert.equal(result.pending, false)
  assert.equal(result.notice, '')
  assert.match(result.warning, /尚未适配/)
})

test('runtime feedback stops when pending contract discovery becomes unsupported', async t => {
  const f = harness({ api: { getCodexApiModeStatus: async () => unsupported } })
  const timers = new Map()
  let sequence = 0
  f.state.window.setTimeout = callback => { timers.set(++sequence, callback); return sequence }
  f.state.window.clearTimeout = id => timers.delete(id)
  t.after(() => f.stopCodexUltraStatusCheck())
  f.showCodexLaunchFeedback({ apiMode: pending, ultra: disabled }, 'API 登录配置已写入。')
  assert.equal(f.state.toolNotices.value.codex, '')
  const [id, callback] = timers.entries().next().value
  timers.delete(id)
  callback()
  await tick()
  assert.equal(timers.size, 0, 'Unsupported contracts must stop the UI retry loop')
  assert.equal(f.state.toolNotices.value.codex, '')
  assert.match(f.state.toolWarnings.value.codex, /尚未适配/)
  assert.doesNotMatch(f.state.toolWarnings.value.codex, success)
})

for (const status of [
  { ...unsupported, ready: true, verified: true },
  { ...pending, ready: true, verified: true },
  { ...pending, ready: true, verified: true, reason: 'coding', enabled: false },
  { ...pending, ready: true, verified: true, reason: 'coding', error: 'verification failed' },
]) {
  test(`contradictory API status cannot claim success (${status.reason}, enabled=${status.enabled}, error=${!!status.error})`, t => {
    const f = harness()
    t.after(() => f.stopCodexUltraStatusCheck())
    const result = f.codexApiModeFeedback({ apiMode: status })
    assert.doesNotMatch(result.notice, success)
    assert.notEqual(result.warning, '')
  })
}
