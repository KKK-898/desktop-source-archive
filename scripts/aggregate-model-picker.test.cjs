const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, after } = require('node:test')
const { chromium } = require('playwright')

const rust = fs.readFileSync(path.join(__dirname, '../src-tauri/src/lib.rs'), 'utf8')
const start = rust.indexOf('  function installAggregateModelPickerRuntime(catalog) {')
const end = rust.indexOf('  function installAccountBalanceRuntime()', start)
assert.ok(start > 0 && end > start)
const selectionRuntime = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_aggregate_selection.js'), 'utf8')
const transitionGuardRuntime = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_model_transition_guard.js'), 'utf8')
const transitionGuardVersion = Number(transitionGuardRuntime.match(/var CODEX_MODEL_TRANSITION_GUARD_VERSION = (\d+)/)[1])
const selectionSources = Object.fromEntries(['26.924', '26.1007', '26.1103'].map(version => [
  version,
  fs.readFileSync(path.join(__dirname, `fixtures/codex-aggregate-selection-${version}.js`), 'utf8'),
]))
const runtime = `${selectionRuntime}\n${rust.slice(start, end)}`
const balanceStart = rust.indexOf('  function installAccountBalanceRuntime() {', end)
const balanceEnd = rust.indexOf('  const pluginEnhancementsEnabled = ', balanceStart)
assert.ok(balanceStart === end && balanceEnd > balanceStart)
const balanceRuntime = rust.slice(balanceStart, balanceEnd)
const runtimeVersion = Number(rust.match(/const CODEX_AGGREGATE_MODEL_PICKER_RUNTIME_VERSION:\s*u64\s*=\s*(\d+)/)?.[1])
assert.ok(Number.isInteger(runtimeVersion) && runtimeVersion > 0)
assert.doesNotThrow(() => new Function(runtime))
assert.doesNotThrow(() => new Function(balanceRuntime))
assert.doesNotThrow(() => new Function(`${selectionRuntime}\n${transitionGuardRuntime}`))
let browser
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : process.platform === 'win32' ? { channel: 'msedge' } : {}) })
})
after(async () => { await browser?.close() })

async function fixture(t, {
  controller = true,
  nativeSpeed = false,
  transitionGuard = false,
  selectionVersion = '26.1007',
  selectionSource = selectionSources[selectionVersion],
  width = 1100,
  height = 750,
} = {}) {
  assert.equal(typeof selectionSource, 'string', `Missing native selection source for ${selectionVersion}`)
  const page = await browser.newPage({ viewport: { width, height } })
  t.after(() => page.close())
  if (selectionVersion === '26.1103') {
    await page.route('https://synthetic.invalid/**', route => route.fulfill({ status: 200,
      contentType: route.request().url().endsWith('.js') ? 'application/javascript' : 'text/html', body: '' }))
    await page.goto('https://synthetic.invalid/index.html')
  }
  await page.setContent('<style>body{font:14px system-ui;background:#101827;color:white}form{position:absolute;bottom:30px;left:20px;display:flex;align-items:center;gap:8px}button{color:inherit;background:#223046;padding:8px;border:0}#native-menu{position:absolute;bottom:100px;left:20px}</style><form><button type="button" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning">Native model / High</button></form>')
  await page.evaluate(async ({
    runtime,
    runtimeVersion,
    selectionRuntime,
    transitionGuardRuntime,
    selectionSource,
    selectionVersion,
    controller,
    nativeSpeed,
    transitionGuard,
  }) => {
    window.aggregateModelPickerRuntimeVersion = runtimeVersion
    window.reactFiberFrom = (node) => node?.__reactFiber$test || null
    const model = (group, slug = 'gpt-5.5') => ({ publicModel: `gaoge/openai/${group}/${slug}`, upstreamModel: slug,
      nativeLabel: `${slug} · ${group === 'one' ? '日常满血plus-简单使用' : '专业高倍率分组'} · GPT`, reasoningLevels: [],
      speedOptions: slug === 'gpt-6-astra' ? ['fast'] : [], speedLabel: '快速（2 倍速度，用量更高）',
      contextWindow: 272000, maxContextWindow: slug === 'gpt-6-astra' ? 872000 : 272000,
      contextLabel: '272K', maxContextLabel: slug === 'gpt-6-astra' ? '872K' : '272K',
      contextSource: 'codex', inputModalities: ['text', 'image'], imageCapabilityKnown: true })
    window.catalog = { enabled: true, defaultModel: 'gaoge/openai/one/gpt-5.5', providers: [
      { id: 'openai', label: 'GPT', name: 'OpenAI', groups: [
        { id: 'one', name: '日常满血plus-简单使用', models: [model('one')] },
        { id: 'two', name: '专业高倍率分组', models: [model('two'), model('two', 'gpt-5.6-sol'), model('two', 'gpt-6-astra')] },
      ] },
      { id: 'anthropic', label: 'Claude', name: 'Anthropic', groups: [
        { id: 'three', name: 'Claude 分组', models: [{ publicModel: 'gaoge/anthropic/three/claude-opus-4-8', upstreamModel: 'claude-opus-4-8', nativeLabel: 'claude-opus-4-8 · Claude 分组 · Claude', reasoningLevels: ['high'], speedOptions: [] }] },
      ] },
    ] }
    window.nativeButton = document.querySelector('[data-codex-intelligence-trigger]')
    window.bridgeCalls = []
    window.nativeCalls = []
    window.nativeOptionCalls = []
    window.nativeModelMode = 'default'
    window.currentAuth = { authMethod: nativeSpeed ? 'chatgpt' : 'apikey',
      isLoading: false, requiresAuth: true, hasChatGptToken: nativeSpeed }
    const rspack = selectionVersion === '26.1103'
    const pendingToken = { id: Symbol('aggregate-selection-root'), __scopeBrand: 'AppScope' }
    window.composerToken = { id: Symbol('aggregate-test-composer'), __scopeBrand: 'ComposerScope',
      parent: { __scopeBrand: 'RouteScope' }, getKey: value => value.clientThreadId }
    if (rspack) {
      window.nativeButton.removeAttribute('data-codex-intelligence-trigger')
      window.nativeButton.setAttribute('data-selected-reasoning-effort', 'high')
    }
    window.nativeQueuedAtom = { value: null }
    window.nativeInFlightAtom = { value: null }
    window.nativeSelectionSourceReads = 0
    window.nativeSelectionSourceVersion = selectionVersion
    window.nativeSelectionModule = { queueExport: { scope: pendingToken }, savingExport: { scope: pendingToken } }
    const pendingStore = {
      get: atom => atom.value,
      set: (atom, value) => { atom.value = typeof value === 'function' ? value(atom.value) : value },
      sub: () => () => {},
    }
    // The native writable-family cache holds resolved handles in both versions. Each
    // handle belongs to this exact root store rather than exposing resolve().
    const boundPending = atom => ({ atom, store: pendingStore,
      get: () => pendingStore.get(atom),
      set: value => pendingStore.set(atom, value),
      subscribe: callback => pendingStore.sub(atom, callback),
    })
    window.nativeSelectionRoot = { token: pendingToken, value: {},
      store: pendingStore,
      familyBindings: new Map([
        [window.nativeSelectionModule.queueExport, new Map([
          ['["thread","thread-a"]', { value: boundPending(window.nativeQueuedAtom) }],
        ])],
        [window.nativeSelectionModule.savingExport, new Map([
          ['["thread","thread-a"]', { value: boundPending(window.nativeInFlightAtom) }],
        ])],
      ]),
    }
    window.codexAppAssetUrl = prefix => prefix === 'app-initial-' ? 'https://synthetic.invalid/app-initial-test.js' : ''
    window.loadCodexAppModule = async prefix => {
      if (prefix !== 'app-initial-') throw new Error('Unexpected fixture module')
      return window.nativeSelectionModule
    }
    window.fetch = async url => {
      if (url !== window.codexAppAssetUrl('app-initial-')) throw new Error('External fetch blocked by aggregate test fixture')
      window.nativeSelectionSourceReads += 1
      return { ok: true, text: async () => selectionSource }
    }
    if (rspack) {
      const script = document.createElement('script'); script.type = 'module'
      script.src = 'https://synthetic.invalid/assets/index.fixture.js'; document.head.append(script)
      const registry = () => { throw new Error('Fixture native require must never be called') }
      registry.m = {
        selection: Object.values(new Function('return (' + selectionSource + '\n)')())[0],
        composer: ({ composer(e,t,n) {var r=n("scopes");let l=(0,r.z8)("ComposerScope",{key:e=>e.clientThreadId,parent:r.route,retain:{max:100}});n.d(t,{},{PR:l})} }).composer,
      }
      registry.c = { selection: { exports: { EX: window.nativeSelectionModule.queueExport,
        si: window.nativeSelectionModule.savingExport } }, composer: { exports: { PR: window.composerToken } },
        OWtl: { exports: { u: pendingToken } } }
      window.nativeRegistry = registry
      window.codexAppAssetUrl = name => name === 'index.fixture.js' ? script.src : ''
      window.loadCodexAppModule = async name => {
        if (name !== 'index.fixture.js') throw new Error('Unexpected fixture module')
        window.nativeSelectionSourceReads += 1
        return { __webpack_require__: registry }
      }
      window.fetch = () => { throw new Error('Rspack discovery must use cached exports') }
    }
    window.__gaogeSessionDeleteBridge = async (url, data) => {
      window.bridgeCalls.push({ url, data })
      if (window.failBridge) throw new Error('测试：本地路由保存失败')
      return { ok: true }
    }
    window.nativeProps = {
      model: window.catalog.defaultModel, reasoningEffort: 'high', selectionMode: 'default',
      models: window.catalog.providers.flatMap(p => p.groups.flatMap(g => g.models.map(m => ({
        model: m.publicModel, displayName: m.nativeLabel,
        defaultReasoningEffort: 'high',
        supportedReasoningEfforts: (
          m.upstreamModel === 'gpt-5.5'
            ? ['low', 'medium', 'high', 'xhigh']
            : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
        ).map(reasoningEffort => ({ reasoningEffort })),
      })))),
      onSelectModel(id, effort) {
        window.nativeCalls.push({ id, effort })
        if (window.rejectNative) return Promise.resolve(false)
        window.nativeProps.model = id
        window.nativeProps.reasoningEffort = effort
      },
      onSelectModelOption() {
        window.nativeOptionCalls.push(window.composerScope.value.conversationId)
        window.nativeProps.selectionMode = 'model'
        window.nativeModelMode = 'model'
      },
      onOpenChange(open) { if (!open) document.querySelector('#native-menu')?.remove() },
    }
    if (nativeSpeed) Object.assign(window.nativeProps, {
      selectedServiceTier: null, serviceTierOptionsLoading: false,
      serviceTierOptions: [{ value: null, label: 'Standard' }, { value: 'priority', label: 'Fast', description: '2x speed, increased usage' }],
      onSelectServiceTier(tier) {
        window.nativeProps.selectedServiceTier = tier
        document.querySelector('#native-fast')?.setAttribute('data-fast-mode-enabled', String(tier === 'priority'))
      },
    })
    window.setComposerTask = (id, props = window.nativeProps) => {
      const token = rspack ? window.composerToken : { id: Symbol('aggregate-test-composer') }
      window.composerScope = { token, parent: window.nativeSelectionRoot,
        value: { kind: 'local', conversationId: id, ...(rspack ? { clientThreadId: id, placement: 'main' } : {}) },
        familyBindings: new Map() }
      window.composerContext = { chain: new Map([
        [pendingToken.id, window.nativeSelectionRoot], [token.id, window.composerScope],
      ]) }
      window.nativeProps = props
      window.nativeButton.__reactFiber$test = { memoizedProps: controller ? props : {},
        dependencies: { firstContext: { memoizedValue: window.currentAuth,
          next: { memoizedValue: window.composerContext, next: null } } } }
    }
    window.setComposerTask('thread-a')
    if (rspack) {
      // Current native controller is over forty React parents above the trigger.
      const controllerFiber = window.nativeButton.__reactFiber$test
      let child = controllerFiber
      for (let i = 0; i < 42; i++) child = { memoizedProps: {}, return: child }
      window.nativeButton.__reactFiber$test = child
    }
    if (controller) {
      window.nativeButton.addEventListener('click', () => {
        document.querySelector('#native-menu')?.remove()
        const menu = document.createElement('div'); menu.id = 'native-menu'; menu.setAttribute('role', 'menu')
        menu.innerHTML = '<button role="menuitem" data-model-picker-view-toggle="true" aria-label="Select model">GPT</button>'
        document.body.append(menu)
        if (nativeSpeed) {
          const speed = document.createElement('button'); speed.id = 'native-fast'; speed.type = 'button'
          speed.textContent = 'Fast · 2x speed, increased usage'
          speed.onclick = () => window.nativeProps.onSelectServiceTier(window.nativeProps.selectedServiceTier ? null : 'priority')
          menu.append(speed)
        }
      })
    }
    if (transitionGuard) {
      window.installTransitionGuard = new Function(
        `${selectionRuntime}\n${transitionGuardRuntime};return installCodexModelTransitionGuard;`,
      )()
      window.transitionGuardResult = await window.installTransitionGuard({
        state: { enabled: true, mode: 'relay' },
      })
    }
  }, {
    runtime,
    runtimeVersion,
    selectionRuntime,
    transitionGuardRuntime,
    selectionSource,
    selectionVersion,
    controller,
    nativeSpeed,
    transitionGuard,
  })
  return page
}

async function balanceFixture(t, {
  permission = true,
  permissionLabel = '完全访问',
  wrappedPermission = false,
  width = 1100,
  height = 750,
} = {}) {
  const page = await browser.newPage({ viewport: { width, height } })
  t.after(async () => {
    if (page.isClosed()) return
    await page.evaluate(() => window.__gaogeAccountBalanceRuntime?.dispose?.())
    await page.close()
  })
  const permissionButton = permission
    ? `<button id="balance-permission" type="button" data-composer-navigation-target="permissions" aria-label="更改权限">${permissionLabel}</button>`
    : ''
  await page.setContent(`
    <style>
      html,body{margin:0;width:100%;height:100%;font:14px system-ui;background:#101827;color:#e5e7eb}
      aside{position:fixed;inset:0 auto 0 0;width:240px;background:#111827}
      main{margin-left:240px;padding:0 24px}
      header{height:54px;display:flex;align-items:center}
      .composer-surface-chrome{position:fixed;bottom:24px;left:260px;width:calc(100vw - 280px);max-width:736px;box-sizing:border-box;background:#303030;border-radius:20px;padding:8px 0}
      [data-composer-footer-responsive]{display:grid;grid-template-columns:auto 1fr auto;column-gap:5px;padding:0 8px}
      .composer-input{grid-column:1/-1;grid-row:1;height:48px;min-width:0}
      .composer-input [contenteditable]{min-height:28px;padding:6px}
      .composer-tools-slot{grid-column:1;grid-row:2;min-width:0}
      #balance-tools{display:flex;min-width:0;align-items:center;gap:5px}
      .composer-actions{grid-column:3;grid-row:2;display:flex;justify-content:flex-end;align-items:center;gap:6px;min-width:0}
      button{box-sizing:border-box;color:inherit;background:transparent;border:0;height:28px;flex:0 0 auto;padding:0 6px;white-space:nowrap}
      #balance-permission{width:86px}
      .icon-action{width:28px;padding:0}
      .model-action{width:152px;flex:0 1 152px;min-width:0;overflow:hidden;text-overflow:ellipsis}
    </style>
    <aside><span data-thread-title="true">侧栏会话</span></aside>
    <main><header class="app-header-tint"><span data-thread-title="true">会话标题</span></header><section>对话正文</section></main>
    <form style="display:none"><div data-composer-footer-responsive><div style="display:flex"><button data-composer-navigation-target="permissions">隐藏的输入框</button></div></div></form>
    <form id="balance-composer" class="composer-surface-chrome">
      <div data-composer-footer-responsive data-composer-layout="multiline" data-composer-rows="stacked">
        <div class="composer-input"><div contenteditable="true" role="textbox">待发送内容</div></div>
        <div class="composer-tools-slot"><div id="balance-tools">
          <span style="display:contents"><button class="icon-action" type="button" data-composer-navigation-target="add-context">+</button></span>
          ${wrappedPermission ? `<span id="permission-wrapper" style="display:contents">${permissionButton}</span>` : permissionButton}
        </div></div>
        <div class="composer-actions">
          <button class="model-action" type="button" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning">GPT-6 Astra Max</button>
          <button class="icon-action" type="button" aria-label="语音">🎙</button>
          <button class="icon-action" type="button" aria-label="发送">↑</button>
        </div>
      </div>
    </form>
  `)
  await page.evaluate(({ balanceRuntime }) => {
    window.__GAOGE_SESSION_HELPER_BASE__ = ''
    window.__GAOGE_SESSION_HELPER_TOKEN__ = ''
    window.balanceControlClicks = 0
    window.balanceRequestCount = 0
    document.querySelector('#balance-composer').addEventListener('click', () => window.balanceControlClicks++)
    window.__gaogeSessionDeleteBridge = async (url) => {
      if (url !== '/account/balance') throw new Error(`unexpected bridge path: ${url}`)
      window.balanceRequestCount++
      if (window.failBalanceRefresh) throw new Error('测试：余额接口暂时不可用')
      return { ok: true, balance: 89436.45, updatedAt: Date.now() }
    }
    window.installAccountBalance = new Function(`${balanceRuntime};return installAccountBalanceRuntime;`)()
    window.balanceRuntimeResult = window.installAccountBalance()
  }, { balanceRuntime })
  await page.locator('.gaoge-account-balance').waitFor({ state: 'attached' })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent.includes('89,436.45'))
  return page
}

// Aggregate menu and model persistence are now native-owned. Their regressions
// live in codex-aggregate-native-picker.test.cjs. Keep the independent ordinary
// relay transition guard and composer account balance coverage here.

const recoveryAlias = 'gaoge/openai/3/gpt-6-astra'
const ordinaryRecoveryModels = [
  { model: 'gpt-6-astra', defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { model: 'gpt-5.5', defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
]

async function recoveryFixture(t, {
  selectionVersion = '26.1103', mode = 'relay', currentModel = recoveryAlias,
  effort = 'high', models = ordinaryRecoveryModels,
  mappings = [{ publicModel: recoveryAlias, upstreamModel: 'gpt-6-astra' }],
  defaultModel = 'gpt-5.5', newConversation = false, deferWrite = false, pendingUserModel = '',
  foreignPendingTarget = null, unknownPending = false,
  rejectWrite = false, voidSelector = false,
  permissionAware = voidSelector, permissionDenied = false,
  permissionBinding = 'valid',
  localDraft = false,
  beforeDenied = false,
  effectiveOptions = false,
} = {}) {
  const page = await fixture(t, { transitionGuard: true, selectionVersion, nativeSpeed: mode === 'official' })
  await page.evaluate(async setup => {
    window.__gaogeCodexModelTransitionGuard?.dispose()
    const root = window.nativeSelectionRoot
    const token = root.token
    root.familyBindings.clear()
    const queues = new Map()
    const atomFamily = (scope, initialize) => ({ scope, initialize, kind: 'atom' })
    const queueFamily = (scope, initialize) => ({ scope, initialize, kind: 'queue' })
    const member = (family, target) => {
      const key = typeof target === 'string' ? target : JSON.stringify(target)
      let members = root.familyBindings.get(family)
      if (!members) root.familyBindings.set(family, members = new Map())
      let entry = members.get(key)
      if (!entry) {
        const atom = { value: family.initialize(target) }
        entry = { value: { atom, store: root.store,
          get: () => root.store.get(atom), set: value => root.store.set(atom, value),
          subscribe: callback => root.store.sub(atom, callback) } }
        members.set(key, entry)
      }
      return entry.value.atom
    }
    const nativeScope = {
      get(family, target) {
        if (family.kind === 'queue') {
          let members = queues.get(family)
          if (!members) queues.set(family, members = new Map())
          const key = typeof target === 'string' ? target : JSON.stringify(target)
          if (!members.has(key)) members.set(key, family.initialize(key, { scope: nativeScope }))
          return members.get(key)
        }
        return member(family, target).value
      },
      set(family, target, value) { member(family, target).value = value },
    }
    let native
    if (setup.selectionVersion === '26.1103') {
      // Execute the captured native debounce/commit factory only inside this
      // isolated test. Recovery must persist the target, not just paint a label.
      const factory = Object.values(new Function('return (' + setup.selectionSource + '\n)')())[0]
      native = {}
      const requireNative = id => {
        if (id === 'zTeN') return { bD: atomFamily, T1: queueFamily }
        if (id === 'OWtl') return { u: token }
        throw new Error('Unexpected native fixture import: ' + id)
      }
      requireNative.d = (exports, getters, values) => Object.assign(exports, values)
      factory({}, native, requireNative)
      window.nativeSelectionModule = { queueExport: native.EX, savingExport: native.si }
      window.nativeRegistry.c.selection.exports = native
    } else {
      const source = setup.selectionSource.replace(/export\{[^}]+\}/g, '')
      const exports = new Function('family', 'Root', 'controller', source
        + ';return {queued,inFlight,selectionQueue};')(atomFamily, token, queueFamily)
      native = { EX: exports.queued, si: exports.inFlight,
        BG: ({ conversationId, hasConversation, hostId, cwd }) => hasConversation && conversationId != null
          ? ['conversation', conversationId] : ['default', hostId, cwd],
        HM: (scope, target, selection, write) => new Promise(resolve => {
          scope.get(exports.selectionQueue, JSON.stringify(target))({ resolve, target, selection, write })
        }) }
      window.nativeSelectionModule = { queueExport: native.EX, savingExport: native.si }
    }
    const target = () => native.BG({
      conversationId: window.composerScope.value.conversationId,
      hasConversation: window.composerScope.value.kind === 'local',
      hostId: window.composerScope.value.hostId || 'local',
      cwd: window.composerScope.value.cwd || 'D:/recovery/current',
    })
    if (setup.newConversation || setup.localDraft) {
      window.composerScope.value = { kind: setup.localDraft ? 'local' : 'new',
        ...(setup.localDraft ? { conversationId: null } : {}), hostId: 'local', cwd: 'D:/recovery/draft',
        clientThreadId: 'draft-one', focusComposerNonce: 'draft-one' }
    }
    nativeScope.get(native.EX, target())
    nativeScope.get(native.si, target())
    window.setForeignRecoveryPending = selection => nativeScope.set(native.EX,
      setup.foreignPendingTarget || ['conversation', 'thread-ab'], selection)
    if (setup.foreignPendingTarget) window.setForeignRecoveryPending({ model: 'gpt-5.5', reasoningEffort: 'high' })
    if (setup.unknownPending) window.setForeignRecoveryPending(undefined)
    window.nativeCalls = []
    window.nativeEffortCalls = []
    window.nativeCommits = []
    window.nativeWriteResults = []
    window.nativePermissionCalls = []
    window.nativeBeforeCalls = []
    window.nativePersistedSelections = {}
    window.nativeSendRequests = []
    const form = window.nativeButton.closest('form')
    const input = document.createElement('div')
    input.setAttribute('role', 'textbox'); input.contentEditable = 'true'; input.id = 'recovery-input'
    input.textContent = 'continue the conversation'
    const send = document.createElement('button')
    send.type = 'submit'; send.id = 'recovery-send'; send.setAttribute('aria-label', '发送'); send.textContent = 'Send'
    form.append(input, send)
    form.addEventListener('submit', event => {
      event.preventDefault()
      const selectedTarget = target()
      const saved = window.nativePersistedSelections[JSON.stringify(selectedTarget)]
        || { model: setup.currentModel, reasoningEffort: setup.effort }
      window.nativeSendRequests.push({ target: selectedTarget, ...saved })
    })
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.defaultPrevented) return
      event.preventDefault(); form.requestSubmit()
    })
    window.deferRecoveryWrite = setup.deferWrite
    window.rejectRecoveryWrite = setup.rejectWrite
    window.denyRecoveryPermission = setup.permissionDenied
    window.nativeProps.model = setup.currentModel
    window.nativeProps.reasoningEffort = setup.effort
    window.nativeProps.models = setup.models
    window.queueRecoverySelection = (kind, selection, applyAtCommit = false) => {
      const selectedTarget = target()
      return native.HM(nativeScope, selectedTarget, selection, async () => {
        if (window.deferRecoveryWrite) await new Promise(resolve => { window.releaseRecoveryWrite = resolve })
        else await new Promise(resolve => setTimeout(resolve, 35))
        if (window.rejectRecoveryWrite) {
          // Native draft settings are optimistic. A rejected config write does
          // not restore the old controller label; idle queues are not proof.
          window.nativeWriteResults.push({ kind, target: selectedTarget, ...selection, success: false })
          return false
        }
        if (applyAtCommit) {
          window.nativeProps.model = selection.model
          window.nativeProps.reasoningEffort = selection.reasoningEffort
        }
        window.nativePersistedSelections[JSON.stringify(selectedTarget)] = structuredClone(selection)
        window.nativeCommits.push({ kind, target: selectedTarget, ...selection })
        window.nativeWriteResults.push({ kind, target: selectedTarget, ...selection, success: true })
        return true
      })
    }
    window.applyRecoveryModel = (id, effort, kind = 'model') => {
      if (kind === 'effort') window.nativeEffortCalls.push({ effort })
      else window.nativeCalls.push({ id, effort })
      window.nativeProps.model = id
      window.nativeProps.reasoningEffort = effort
      return window.queueRecoverySelection(kind, { model: id, reasoningEffort: effort })
    }
    window.nativePermissionSelection = {
      get modelSettings() { return { model: window.nativeProps.model,
        reasoningEffort: window.nativeProps.reasoningEffort } },
      setModelAndReasoningEffort() { throw new Error('Recovery must never invoke the private thread writer') },
      setDefaultModelAndReasoningEffort() { throw new Error('Recovery must never invoke the private config writer') },
      selectComposerModelAndReasoningEffort(id, effort, additional) {
        if (typeof additional !== 'function') throw new Error('Native permission selection requires its commit callback')
        window.nativePermissionCalls.push({ id, effort, callbackType: typeof additional })
        if (window.denyRecoveryPermission) return Promise.resolve(false)
        additional()
        const kind = id === window.nativeProps.model && effort !== window.nativeProps.reasoningEffort
          ? 'effort' : 'model'
        return window.applyRecoveryModel(id, effort, kind)
      },
    }
    window.nativeProps.onBeforeSelectModel = id => {
      window.nativeBeforeCalls.push(id)
      return setup.beforeDenied ? false : undefined
    }
    window.nativeProps.onSelectModel = (id, effort) => {
      const result = setup.permissionAware
        ? window.nativePermissionSelection.selectComposerModelAndReasoningEffort(id, effort, () => {})
        : window.applyRecoveryModel(id, effort)
      return setup.voidSelector ? undefined : result
    }
    window.nativeProps.onSelectReasoningEffort = effort => {
      const result = setup.permissionAware
        ? window.nativePermissionSelection.selectComposerModelAndReasoningEffort(window.nativeProps.model, effort, () => {})
        : window.applyRecoveryModel(window.nativeProps.model, effort, 'effort')
      return setup.voidSelector ? undefined : result
    }
    if (setup.permissionAware) {
      // Codex 26.1103 memoizes the permission-aware selection object, options,
      // and its composer wrapper in the ancestor compiler cache. The public
      // menu callback intentionally discards this helper's persistence Promise.
      const options = {
        get conversationId() { return window.composerScope.value.conversationId ?? null },
        get cwdOverride() { return window.composerScope.value.cwd || 'D:/recovery/current' },
        get hostId() { return window.composerScope.value.hostId || 'local' },
      }
      if (setup.effectiveOptions) Object.defineProperty(options, 'cwd', {
        enumerable: true, get: () => window.composerScope.value.cwd || 'D:/recovery/current',
      })
      const wrapper = {
        get conversationId() { return setup.permissionBinding === 'foreign-conversation'
          ? 'thread-elsewhere' : window.composerScope.value.conversationId ?? null },
        executionHostId: setup.permissionBinding === 'foreign-host' ? 'remote-host' : 'local',
        modelSelection: window.nativePermissionSelection,
      }
      let ancestor = window.nativeButton.__reactFiber$test
      while (ancestor.return) ancestor = ancestor.return
      ancestor.updateQueue = { memoCache: { data: [[options, window.nativePermissionSelection, wrapper]] } }
      window.nativePermissionAncestor = ancestor
      window.nativePermissionWrapper = wrapper
    }
    window.recoveryState = {
      enabled: setup.mode === 'relay', mode: setup.mode,
      aggregateModelRecovery: { version: 1, enabled: true, defaultModel: setup.defaultModel, models: setup.mappings },
    }
    if (setup.pendingUserModel) {
      window.userSelectionPromise = window.queueRecoverySelection('user', {
        model: setup.pendingUserModel, reasoningEffort: 'xhigh',
      }, true)
    }
    window.transitionGuardResult = await window.installTransitionGuard({ state: window.recoveryState })
  }, { selectionVersion, selectionSource: selectionSources[selectionVersion], mode, currentModel,
    effort, models, mappings, defaultModel, newConversation, deferWrite, pendingUserModel,
    foreignPendingTarget, unknownPending, rejectWrite, voidSelector, permissionAware, permissionDenied,
    permissionBinding, localDraft, beforeDenied, effectiveOptions })
  return page
}

async function waitForRecoveryCommit(page, model, effort = 'high', target = ['conversation', 'thread-a']) {
  await page.waitForFunction(({ model, effort, target }) => {
    const saved = window.nativePersistedSelections[JSON.stringify(target)]
    return saved?.model === model && saved?.reasoningEffort === effort
      && !document.documentElement.dataset.gaogeModelTransitionPending
  }, { model, effort, target }, { timeout: 5000 })
}

for (const selectionVersion of ['26.1007', '26.1103']) {
  test(`${selectionVersion} exiting aggregation restores and natively persists the current conversation model`, async t => {
    const page = await recoveryFixture(t, { selectionVersion })
    await waitForRecoveryCommit(page, 'gpt-6-astra')
    const result = await page.evaluate(() => ({ result: window.transitionGuardResult,
      calls: window.nativeCalls, commits: window.nativeCommits, bridgeCalls: window.bridgeCalls }))
    assert.equal(result.result.ready, true)
    assert.deepEqual(result.calls, [{ id: 'gpt-6-astra', effort: 'high' }])
    assert.deepEqual(result.commits, [{ kind: 'model', target: ['conversation', 'thread-a'],
      model: 'gpt-6-astra', reasoningEffort: 'high' }])
    assert.deepEqual(result.bridgeCalls, [], 'native recovery must not save an obsolete aggregate route')
  })
}

test('official login with fuel disabled still recovers the old aggregation selection', async t => {
  const page = await recoveryFixture(t, { mode: 'official' })
  await waitForRecoveryCommit(page, 'gpt-6-astra')
  assert.equal(await page.evaluate(() => window.recoveryState.enabled), false)
  assert.equal(await page.evaluate(() => window.nativeOptionCalls.length), 1)
})

test('exiting aggregation preserves official authentication while native permission-aware recovery selects an official model', async t => {
  for (const localDraft of [false, true]) for (const availableUpstream of [true, false]) {
    await t.test(`${localDraft ? 'draft' : 'conversation'} / ${availableUpstream ? 'same model' : 'official default'}`, async t => {
      const page = await recoveryFixture(t, { mode: 'official', voidSelector: true, localDraft,
        models: availableUpstream ? ordinaryRecoveryModels : [ordinaryRecoveryModels[1]],
        defaultModel: 'gpt-5.5' })
      const expectedModel = availableUpstream ? 'gpt-6-astra' : 'gpt-5.5'
      const expectedTarget = localDraft ? ['default', 'local', 'D:/recovery/draft'] : ['conversation', 'thread-a']
      await waitForRecoveryCommit(page, expectedModel, 'high', expectedTarget)
      const result = await page.evaluate(() => ({ state: window.recoveryState, calls: window.bridgeCalls,
        auth: window.currentAuth, permissions: window.nativePermissionCalls,
        savedKeys: Object.keys(window.nativePersistedSelections) }))
      assert.equal(result.state.mode, 'official')
      assert.equal(result.state.enabled, false)
      assert.deepEqual(result.calls, [])
      assert.deepEqual(result.auth, { authMethod: 'chatgpt', isLoading: false,
        requiresAuth: true, hasChatGptToken: true })
      assert.deepEqual(result.savedKeys, [JSON.stringify(expectedTarget)])
      assert.equal(result.permissions.length, 1)
      await page.locator('#recovery-send').click()
      assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
        target: expectedTarget, model: expectedModel, reasoningEffort: 'high',
      }])
    })
  }
})

test('new conversation recovery persists only the native default host/directory target', async t => {
  const page = await recoveryFixture(t, { newConversation: true })
  await waitForRecoveryCommit(page, 'gpt-6-astra', 'high', ['default', 'local', 'D:/recovery/draft'])
  const persisted = await page.evaluate(() => Object.keys(window.nativePersistedSelections))
  assert.deepEqual(persisted, ['["default","local","D:/recovery/draft"]'])
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
    target: ['default', 'local', 'D:/recovery/draft'], model: 'gpt-6-astra', reasoningEffort: 'high',
  }])
})

test('opening another stale conversation recovers its own native target before the first send', async t => {
  const page = await recoveryFixture(t)
  await waitForRecoveryCommit(page, 'gpt-6-astra')
  await page.evaluate(() => {
    window.setComposerTask('thread-b')
    window.nativeProps.model = 'gaoge/openai/3/gpt-6-astra'
    window.nativeProps.reasoningEffort = 'high'
    document.querySelector('#recovery-send').click()
  })
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  await waitForRecoveryCommit(page, 'gpt-6-astra', 'high', ['conversation', 'thread-b'])
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
    target: ['conversation', 'thread-b'], model: 'gpt-6-astra', reasoningEffort: 'high',
  }])
  assert.deepEqual(await page.evaluate(() => Object.keys(window.nativePersistedSelections)),
    ['["conversation","thread-a"]', '["conversation","thread-b"]'])
})

test('unsupported mapped upstream falls back to the verified ordinary default model', async t => {
  const page = await recoveryFixture(t, { models: [ordinaryRecoveryModels[1]], effort: 'ultra' })
  await waitForRecoveryCommit(page, 'gpt-5.5', 'high')
  const calls = await page.evaluate(() => [...window.nativeCalls, ...window.nativeEffortCalls])
  assert.ok(calls.length > 0)
  assert.equal(calls.some(call => ['max', 'ultra'].includes(call.effort)), false)
})

test('recovery retains Ultra only after the ordinary target model has a confirmed native save', async t => {
  const page = await recoveryFixture(t, { effort: 'ultra' })
  await waitForRecoveryCommit(page, 'gpt-6-astra', 'ultra')
  const result = await page.evaluate(() => ({ calls: window.nativeCalls,
    effortCalls: window.nativeEffortCalls, commits: window.nativeCommits }))
  assert.equal(result.commits.length, 2)
  assert.equal(result.commits[0].model, 'gpt-6-astra')
  assert.equal(['max', 'ultra'].includes(result.commits[0].reasoningEffort), false)
  assert.deepEqual(result.commits[1], { kind: 'effort', target: ['conversation', 'thread-a'],
    model: 'gpt-6-astra', reasoningEffort: 'ultra' })
})

test('recovery waits for the native write instead of accepting an optimistic controller label', async t => {
  const page = await recoveryFixture(t, { deferWrite: true })
  await page.waitForFunction(() => typeof window.releaseRecoveryWrite === 'function')
  const waiting = await page.evaluate(() => ({ model: window.nativeProps.model,
    persisted: window.nativePersistedSelections,
    pending: document.documentElement.dataset.gaogeModelTransitionPending }))
  assert.equal(waiting.model, 'gpt-6-astra')
  assert.deepEqual(waiting.persisted, {})
  assert.equal(waiting.pending, 'true')
  await page.evaluate(() => { window.deferRecoveryWrite = false; window.releaseRecoveryWrite() })
  await waitForRecoveryCommit(page, 'gpt-6-astra')
})

test('first click and Enter send wait for recovery, then submit the ordinary model without a manual switch', async t => {
  const page = await recoveryFixture(t, { deferWrite: true })
  await page.waitForFunction(() => typeof window.releaseRecoveryWrite === 'function')
  await page.locator('#recovery-send').click()
  await page.locator('#recovery-input').press('Enter')
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  assert.equal(await page.locator('#recovery-input').textContent(), 'continue the conversation')
  await page.evaluate(() => { window.deferRecoveryWrite = false; window.releaseRecoveryWrite() })
  await waitForRecoveryCommit(page, 'gpt-6-astra')
  await page.locator('#recovery-send').click()
  await page.locator('#recovery-input').press('Enter')
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [
    { target: ['conversation', 'thread-a'], model: 'gpt-6-astra', reasoningEffort: 'high' },
    { target: ['conversation', 'thread-a'], model: 'gpt-6-astra', reasoningEffort: 'high' },
  ])
})

test('a failed native recovery cannot enable sending until a successful explicit model save', async t => {
  const page = await recoveryFixture(t, { rejectWrite: true })
  await page.waitForFunction(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'aggregate-recovery-failed')
  assert.deepEqual(await page.evaluate(() => window.nativePersistedSelections), {})
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  await page.evaluate(async () => {
    window.rejectRecoveryWrite = false
    await window.nativeProps.onSelectModel('gpt-6-astra', 'high')
  })
  await waitForRecoveryCommit(page, 'gpt-6-astra')
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
    target: ['conversation', 'thread-a'], model: 'gpt-6-astra', reasoningEffort: 'high',
  }])
})

test('void menu callbacks recover through the permission-aware native persistence Promise', async t => {
  const page = await recoveryFixture(t, { voidSelector: true })
  await waitForRecoveryCommit(page, 'gpt-6-astra')
  assert.equal(await page.evaluate(() => window.nativeCommits.length), 1)
  assert.deepEqual(await page.evaluate(() => window.nativePermissionCalls), [
    { id: 'gpt-6-astra', effort: 'high', callbackType: 'function' },
  ])
  assert.deepEqual(await page.evaluate(() => window.nativeBeforeCalls), ['gpt-6-astra'])
})

test('native local draft with null conversation id recovers only its permission-owned default target', async t => {
  for (const effectiveOptions of [true, false]) await t.test(effectiveOptions ? 'effective cwd' : 'cwd override', async t => {
    const page = await recoveryFixture(t, { voidSelector: true, localDraft: true, effectiveOptions })
    await waitForRecoveryCommit(page, 'gpt-6-astra', 'high', ['default', 'local', 'D:/recovery/draft'])
    await page.locator('#recovery-send').click()
    assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
      target: ['default', 'local', 'D:/recovery/draft'], model: 'gpt-6-astra', reasoningEffort: 'high',
    }])
  })
})

test('failed void-menu persistence keeps the optimistic label but never confirms recovery or releases send', async t => {
  for (const state of ['conversation', 'new', 'local-draft']) await t.test(state, async t => {
    const page = await recoveryFixture(t, { voidSelector: true, rejectWrite: true,
      newConversation: state === 'new', localDraft: state === 'local-draft' })
    await page.waitForFunction(() => window.nativeWriteResults.length === 1
      && window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'aggregate-recovery-failed')
    assert.equal(await page.evaluate(() => window.nativeProps.model), 'gpt-6-astra')
    assert.equal(await page.evaluate(() => window.nativeOptionCalls.length), 0)
    await page.locator('#recovery-send').click()
    await page.locator('#recovery-input').press('Enter')
    assert.deepEqual(await page.evaluate(() => window.nativePersistedSelections), {})
    assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  })
})

test('a void-only callback without a permission-aware Promise is not a successful recovery', async t => {
  const page = await recoveryFixture(t, { voidSelector: true, permissionAware: false })
  await page.waitForTimeout(800)
  assert.notEqual(await page.evaluate(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event), 'aggregate-recovery-complete')
  await page.locator('#recovery-send').click()
  await page.locator('#recovery-input').press('Enter')
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
})

test('native permission refusal does not write a model or enable sending', async t => {
  const page = await recoveryFixture(t, { voidSelector: true, permissionDenied: true })
  await page.waitForFunction(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'aggregate-recovery-failed')
  assert.equal(await page.evaluate(() => window.nativeProps.model), recoveryAlias)
  assert.equal(await page.evaluate(() => window.nativePermissionCalls.length), 1)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
  assert.deepEqual(await page.evaluate(() => window.nativeWriteResults), [])
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
})

test('native before-select veto runs before the permission helper and leaves the selection untouched', async t => {
  const page = await recoveryFixture(t, { voidSelector: true, beforeDenied: true })
  await page.waitForFunction(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'aggregate-recovery-failed')
  assert.deepEqual(await page.evaluate(() => window.nativeBeforeCalls), ['gpt-6-astra'])
  assert.deepEqual(await page.evaluate(() => window.nativePermissionCalls), [])
  assert.deepEqual(await page.evaluate(() => window.nativeWriteResults), [])
  assert.equal(await page.evaluate(() => window.nativeProps.model), recoveryAlias)
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
})

test('permission-aware persistence must belong to this exact conversation and local host', async t => {
  for (const permissionBinding of ['foreign-conversation', 'foreign-host']) await t.test(permissionBinding, async t => {
    const page = await recoveryFixture(t, { voidSelector: true, permissionBinding })
    await page.waitForTimeout(800)
    assert.notEqual(await page.evaluate(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event), 'aggregate-recovery-complete')
    await page.locator('#recovery-send').click()
    assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  })
})

test('failed recovery protection survives a pending and rejected manual save, clearing only after native success', async t => {
  const page = await recoveryFixture(t, { voidSelector: true, rejectWrite: true })
  await page.waitForFunction(() => window.nativeWriteResults.length === 1
    && window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'aggregate-recovery-failed')
  await page.evaluate(() => {
    window.deferRecoveryWrite = true
    window.nativeProps.onSelectModel('gpt-5.5', 'high')
  })
  await page.waitForFunction(() => typeof window.releaseRecoveryWrite === 'function')
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  await page.evaluate(() => { window.deferRecoveryWrite = false; window.releaseRecoveryWrite() })
  await page.waitForFunction(() => window.nativeWriteResults.length === 2
    && window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'aggregate-recovery-failed')
  assert.equal(await page.evaluate(() => window.nativeProps.model), 'gpt-5.5')
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  await page.evaluate(() => {
    window.rejectRecoveryWrite = false
    window.nativeProps.onSelectModel('gpt-5.5', 'high')
  })
  await waitForRecoveryCommit(page, 'gpt-5.5')
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
    target: ['conversation', 'thread-a'], model: 'gpt-5.5', reasoningEffort: 'high',
  }])
})

test('an unrelated optimistic model change during recovery does not silently remove send protection', async t => {
  const page = await recoveryFixture(t, { voidSelector: true, deferWrite: true, localDraft: true })
  await page.waitForFunction(() => typeof window.releaseRecoveryWrite === 'function')
  await page.evaluate(() => {
    // A stale native event can update the draft UI while its earlier write is
    // outstanding. This is not evidence that the newly displayed model saved.
    window.nativeProps.model = 'gpt-5.5'
    window.nativeProps.reasoningEffort = 'high'
  })
  await page.waitForFunction(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'aggregate-recovery-failed')
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  await page.evaluate(() => { window.deferRecoveryWrite = false; window.releaseRecoveryWrite() })
  await page.waitForFunction(() => window.nativeWriteResults.length === 1)
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  await page.evaluate(() => window.nativeProps.onSelectModel('gpt-5.5', 'high'))
  await waitForRecoveryCommit(page, 'gpt-5.5', 'high', ['default', 'local', 'D:/recovery/draft'])
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
    target: ['default', 'local', 'D:/recovery/draft'], model: 'gpt-5.5', reasoningEffort: 'high',
  }])
})

test('navigating away during an unconfirmed recovery protects only the original conversation on return', async t => {
  const page = await recoveryFixture(t, { deferWrite: true, rejectWrite: true })
  await page.waitForFunction(() => typeof window.releaseRecoveryWrite === 'function')
  await page.evaluate(() => {
    window.setComposerTask('thread-b')
    window.nativeProps.model = 'gpt-5.5'
    window.nativeProps.reasoningEffort = 'high'
    window.nativePersistedSelections['["conversation","thread-b"]'] = { model: 'gpt-5.5', reasoningEffort: 'high' }
  })
  await page.waitForTimeout(150)
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
    target: ['conversation', 'thread-b'], model: 'gpt-5.5', reasoningEffort: 'high',
  }])
  await page.evaluate(() => { window.deferRecoveryWrite = false; window.releaseRecoveryWrite() })
  await page.waitForFunction(() => window.nativeWriteResults.length === 1)
  await page.evaluate(() => {
    window.setComposerTask('thread-a')
    window.nativeProps.model = 'gpt-6-astra'
    window.nativeProps.reasoningEffort = 'high'
    window.nativeSendRequests = []
  })
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [])
  await page.evaluate(async () => {
    window.rejectRecoveryWrite = false
    await window.nativeProps.onSelectModel('gpt-6-astra', 'high')
  })
  await waitForRecoveryCommit(page, 'gpt-6-astra')
  await page.locator('#recovery-send').click()
  assert.deepEqual(await page.evaluate(() => window.nativeSendRequests), [{
    target: ['conversation', 'thread-a'], model: 'gpt-6-astra', reasoningEffort: 'high',
  }])
})

test('non-reasoning targets never inherit the stale aggregate Ultra effort', async t => {
  for (const efforts of [['none'], []]) await t.test(JSON.stringify(efforts), async t => {
    const model = { model: 'plain-chat', supportedReasoningEfforts: efforts,
      ...(efforts.length ? { defaultReasoningEffort: 'none' } : {}) }
    const page = await recoveryFixture(t, { effort: 'ultra', models: [model],
      mappings: [{ publicModel: recoveryAlias, upstreamModel: 'plain-chat' }], voidSelector: true })
    await page.waitForFunction(() => window.nativeCommits.length === 1
      && !document.documentElement.dataset.gaogeModelTransitionPending)
    const result = await page.evaluate(() => ({ calls: window.nativeCalls, saved: window.nativeCommits[0] }))
    assert.equal(result.saved.model, 'plain-chat')
    assert.equal(result.calls[0].effort, efforts.length ? 'none' : undefined)
    assert.equal(result.saved.reasoningEffort, efforts.length ? 'none' : undefined)
  })
})

test('an existing user model save wins over automatic aggregation recovery', async t => {
  const page = await recoveryFixture(t, { pendingUserModel: 'gpt-5.5', deferWrite: true })
  await page.waitForFunction(() => typeof window.releaseRecoveryWrite === 'function')
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
  await page.evaluate(() => { window.deferRecoveryWrite = false; window.releaseRecoveryWrite() })
  await page.evaluate(() => window.userSelectionPromise)
  await page.waitForTimeout(160)
  const result = await page.evaluate(() => ({ calls: window.nativeCalls,
    commits: window.nativeCommits, model: window.nativeProps.model }))
  assert.deepEqual(result.calls, [])
  assert.equal(result.model, 'gpt-5.5')
  assert.deepEqual(result.commits, [{ kind: 'user', target: ['conversation', 'thread-a'],
    model: 'gpt-5.5', reasoningEffort: 'xhigh' }])
})

test('valid native selection and unmapped aggregate-looking models are never overwritten', async t => {
  for (const currentModel of ['gpt-5.5', 'gaoge/custom/openai/3/gpt-6-astra', 'gaoge/openai/unknown/vendor/model']) {
    await t.test(currentModel, async t => {
      const page = await recoveryFixture(t, { currentModel })
      await page.waitForTimeout(200)
      assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
      assert.equal(await page.evaluate(() => window.nativeProps.model), currentModel)
    })
  }
})

test('a similarly named conversation save is neither replaced nor mistaken for the recovery target', async t => {
  const page = await recoveryFixture(t, { foreignPendingTarget: ['conversation', 'thread-ab'] })
  await page.waitForTimeout(200)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
  await page.evaluate(() => window.setForeignRecoveryPending(null))
  await waitForRecoveryCommit(page, 'gpt-6-astra')
  assert.deepEqual(await page.evaluate(() => Object.keys(window.nativePersistedSelections)),
    ['["conversation","thread-a"]'])
})

test('unknown pending state cannot start or confirm an automatic recovery write', async t => {
  const page = await recoveryFixture(t, { unknownPending: true })
  await page.waitForTimeout(200)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
  await page.evaluate(() => window.setForeignRecoveryPending(null))
  await waitForRecoveryCommit(page, 'gpt-6-astra')
})

test('a mapped aggregate identity still present in the active native catalog is preserved', async t => {
  const page = await recoveryFixture(t, { models: [
    ...ordinaryRecoveryModels, { ...ordinaryRecoveryModels[0], model: recoveryAlias },
  ] })
  await page.waitForTimeout(200)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
  assert.equal(await page.evaluate(() => window.nativeProps.model), recoveryAlias)
})

test('conflicting saved aggregate mappings never guess which upstream model to select', async t => {
  const page = await recoveryFixture(t, { mappings: [
    { publicModel: recoveryAlias, upstreamModel: 'gpt-6-astra' },
    { publicModel: recoveryAlias, upstreamModel: 'gpt-5.5' },
  ] })
  await page.waitForTimeout(200)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
})

test('custom collision aliases and upstream models with slashes use their exact saved mapping', async t => {
  const currentModel = 'gaoge/custom/openai/3/vendor/gpt-6-astra'
  const upstreamModel = 'vendor/gpt-6-astra'
  const page = await recoveryFixture(t, { currentModel,
    models: [{ ...ordinaryRecoveryModels[0], model: upstreamModel }],
    mappings: [{ publicModel: currentModel, upstreamModel }] })
  await waitForRecoveryCommit(page, upstreamModel)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [{ id: upstreamModel, effort: 'high' }])
})

test('active aggregation never applies a stored ordinary recovery mapping', async t => {
  const page = await recoveryFixture(t, { mode: 'aggregate' })
  await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => window.transitionGuardResult.enabled), false)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
})

test('ordinary relay guards dangerous 5.5 to 5.6 max and ultra writes before native commit', async t => {
  for (const requestedEffort of ['max', 'ultra']) await t.test(requestedEffort, async t => {
    const page = await fixture(t, { transitionGuard: true })
    const guardResult = await page.evaluate(() => ({
      enabled: window.transitionGuardResult.enabled,
      ready: window.transitionGuardResult.ready,
      version: window.transitionGuardResult.version,
      wrappedControllerCount: window.transitionGuardResult.wrappedControllerCount,
      error: window.transitionGuardResult.error,
    }))
    assert.deepEqual(guardResult, {
      enabled: true,
      ready: true,
      version: transitionGuardVersion,
      wrappedControllerCount: 1,
      error: '',
    })
    await page.evaluate(() => {
      const owner = window.nativeProps
      owner.model = 'gaoge/openai/one/gpt-5.5'
      owner.reasoningEffort = 'medium'
      window.nativeCalls = []
      window.nativeEffortCalls = []
      window.nativeCommits = []
      window.nativeCommitTimers = []
      const scheduleCommit = (kind, fromModel, id, effort) => {
        const selection = { model: id, reasoningEffort: effort }
        window.nativeQueuedAtom.value = selection
        window.nativeInFlightAtom.value = null
        for (const timer of window.nativeCommitTimers) clearTimeout(timer)
        window.nativeCommitTimers = [
          setTimeout(() => {
            window.nativeQueuedAtom.value = null
            window.nativeInFlightAtom.value = selection
            window.nativeCommitTimers = [
              setTimeout(() => {
                window.nativeCommits.push({ kind, fromModel, id, effort })
                window.nativeInFlightAtom.value = null
              }, 70),
            ]
          }, 160),
        ]
      }
      owner.onSelectModel = (id, effort) => {
        const fromModel = owner.model
        window.nativeCalls.push({ fromModel, id, effort })
        owner.model = id
        owner.reasoningEffort = effort
        scheduleCommit('model', fromModel, id, effort)
      }
      owner.onSelectReasoningEffort = effort => {
        const fromModel = owner.model
        window.nativeEffortCalls.push({ fromModel, effort })
        owner.reasoningEffort = effort
        scheduleCommit('effort', fromModel, owner.model, effort)
      }
    })
    await page.waitForFunction(() => (
      window.nativeProps.onSelectModel.__gaogeCodexModelTransitionGuard === true
    ))
    await page.evaluate(requestedEffort => {
      window.nativeProps.onSelectModel('gaoge/openai/two/gpt-5.6-sol', requestedEffort)
    }, requestedEffort)
    await page.waitForFunction(() => (
      window.nativeCommits.length === 2
        && window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'transition-complete'
    ))
    const result = await page.evaluate(() => ({
      calls: window.nativeCalls,
      effortCalls: window.nativeEffortCalls,
      commits: window.nativeCommits,
      model: window.nativeProps.model,
      effort: window.nativeProps.reasoningEffort,
    }))
    assert.deepEqual(result.calls, [{
      fromModel: 'gaoge/openai/one/gpt-5.5',
      id: 'gaoge/openai/two/gpt-5.6-sol',
      effort: 'medium',
    }])
    assert.deepEqual(result.effortCalls, [{
      fromModel: 'gaoge/openai/two/gpt-5.6-sol',
      effort: requestedEffort,
    }])
    assert.equal(result.commits.some(commit => (
      commit.kind === 'model'
        && commit.fromModel === 'gaoge/openai/one/gpt-5.5'
        && commit.effort === requestedEffort
    )), false, 'the unsafe old-model/new-effort pair must never reach the native commit queue')
    assert.deepEqual(result.commits, [
      {
        kind: 'model',
        fromModel: 'gaoge/openai/one/gpt-5.5',
        id: 'gaoge/openai/two/gpt-5.6-sol',
        effort: 'medium',
      },
      {
        kind: 'effort',
        fromModel: 'gaoge/openai/two/gpt-5.6-sol',
        id: 'gaoge/openai/two/gpt-5.6-sol',
        effort: requestedEffort,
      },
    ])
    assert.equal(result.model, 'gaoge/openai/two/gpt-5.6-sol')
    assert.equal(result.effort, requestedEffort)
  })
})

test('stale native menu callbacks are repaired by the pending-selection observer before commit', async t => {
  for (const requestedEffort of ['max', 'ultra']) await t.test(requestedEffort, async t => {
    const page = await fixture(t, { transitionGuard: true })
    await page.evaluate(async () => {
      window.__gaogeCodexModelTransitionGuard.dispose()
      const owner = window.nativeProps
      owner.model = 'gaoge/openai/one/gpt-5.5'
      owner.reasoningEffort = 'medium'
      window.nativeCalls = []
      window.nativeEffortCalls = []
      window.nativeCommits = []
      window.nativeCommitTimers = []
      const scheduleCommit = (kind, fromModel, id, effort) => {
        const selection = { model: id, reasoningEffort: effort }
        window.nativeQueuedAtom.value = selection
        window.nativeInFlightAtom.value = null
        for (const timer of window.nativeCommitTimers) clearTimeout(timer)
        window.nativeCommitTimers = [
          setTimeout(() => {
            window.nativeQueuedAtom.value = null
            window.nativeInFlightAtom.value = selection
            window.nativeCommitTimers = [
              setTimeout(() => {
                window.nativeCommits.push({ kind, fromModel, id, effort })
                window.nativeInFlightAtom.value = null
              }, 160),
            ]
          }, 160),
        ]
      }
      owner.onSelectModel = (id, effort) => {
        const fromModel = owner.model
        window.nativeCalls.push({ fromModel, id, effort })
        owner.model = id
        owner.reasoningEffort = effort
        scheduleCommit('model', fromModel, id, effort)
      }
      owner.onSelectReasoningEffort = effort => {
        const fromModel = owner.model
        window.nativeEffortCalls.push({ fromModel, effort })
        owner.reasoningEffort = effort
        scheduleCommit('effort', fromModel, owner.model, effort)
      }
      // Native menus can close over this callback before the guard replaces
      // the controller prop. Calling it later must still be repaired by the
      // queued-selection observer before the synthetic 160/320 ms commit.
      window.staleOriginal = owner.onSelectModel
      window.transitionGuardResult = await window.installTransitionGuard({
        state: { enabled: true, mode: 'relay' },
      })
    })
    await page.waitForFunction(() => (
      window.nativeProps.onSelectModel.__gaogeCodexModelTransitionGuard === true
    ))
    await page.evaluate(requestedEffort => {
      window.staleOriginal('gaoge/openai/two/gpt-5.6-sol', requestedEffort)
    }, requestedEffort)
    await page.waitForFunction(() => (
      window.nativeCommits.length === 2
        && window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'transition-complete'
    ))
    const result = await page.evaluate(() => ({
      calls: window.nativeCalls,
      effortCalls: window.nativeEffortCalls,
      commits: window.nativeCommits,
      model: window.nativeProps.model,
      effort: window.nativeProps.reasoningEffort,
    }))
    assert.deepEqual(result.calls, [
      {
        fromModel: 'gaoge/openai/one/gpt-5.5',
        id: 'gaoge/openai/two/gpt-5.6-sol',
        effort: requestedEffort,
      },
      {
        fromModel: 'gaoge/openai/two/gpt-5.6-sol',
        id: 'gaoge/openai/two/gpt-5.6-sol',
        effort: 'medium',
      },
    ])
    assert.deepEqual(result.effortCalls, [{
      fromModel: 'gaoge/openai/two/gpt-5.6-sol',
      effort: requestedEffort,
    }])
    assert.equal(result.commits.some(commit => (
      commit.kind === 'model'
        && commit.fromModel === 'gaoge/openai/one/gpt-5.5'
        && commit.effort === requestedEffort
    )), false, 'the stale old-model/new-effort commit must be replaced before it starts')
    assert.deepEqual(result.commits, [
      {
        kind: 'model',
        fromModel: 'gaoge/openai/two/gpt-5.6-sol',
        id: 'gaoge/openai/two/gpt-5.6-sol',
        effort: 'medium',
      },
      {
        kind: 'effort',
        fromModel: 'gaoge/openai/two/gpt-5.6-sol',
        id: 'gaoge/openai/two/gpt-5.6-sol',
        effort: requestedEffort,
      },
    ])
    assert.equal(result.model, 'gaoge/openai/two/gpt-5.6-sol')
    assert.equal(result.effort, requestedEffort)
  })
})

test('an already in-flight dangerous selection is rewritten before its native write observes it', async t => {
  for (const requestedEffort of ['max', 'ultra']) await t.test(requestedEffort, async t => {
    const page = await fixture(t, { transitionGuard: true })
    await page.evaluate(() => {
      const owner = window.nativeProps
      owner.model = 'gaoge/openai/one/gpt-5.5'
      owner.reasoningEffort = 'medium'
      window.nativeCalls = []
      window.nativeEffortCalls = []
      window.nativeCommits = []
      owner.onSelectModel = (id, effort) => {
        window.nativeCalls.push({ id, effort })
        owner.model = id
        owner.reasoningEffort = effort
      }
      owner.onSelectReasoningEffort = effort => {
        window.nativeEffortCalls.push({ effort })
        owner.reasoningEffort = effort
      }
    })
    await page.waitForTimeout(140)
    await page.waitForFunction(() => (
      window.nativeProps.onSelectModel.__gaogeCodexModelTransitionGuard === true
    ))
    await page.evaluate(requestedEffort => {
      const selection = {
        model: 'gaoge/openai/two/gpt-5.6-sol',
        reasoningEffort: requestedEffort,
      }
      window.nativeProps.model = selection.model
      window.nativeProps.reasoningEffort = requestedEffort
      window.nativeInFlightAtom.value = selection
      window.nativeInFlightTimer = setTimeout(() => {
        window.nativeCommits.push({
          model: selection.model,
          effort: selection.reasoningEffort,
        })
        window.nativeInFlightAtom.value = null
      }, 180)
    }, requestedEffort)
    await page.waitForFunction(() => (
      window.nativeCommits.length === 1
        && window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'transition-complete'
    ))
    const result = await page.evaluate(() => ({
      calls: window.nativeCalls,
      effortCalls: window.nativeEffortCalls,
      commits: window.nativeCommits,
      model: window.nativeProps.model,
      effort: window.nativeProps.reasoningEffort,
    }))
    assert.deepEqual(result.calls, [{
      id: 'gaoge/openai/two/gpt-5.6-sol',
      effort: 'medium',
    }])
    assert.deepEqual(result.effortCalls, [{ effort: requestedEffort }])
    assert.deepEqual(result.commits, [{
      model: 'gaoge/openai/two/gpt-5.6-sol',
      effort: 'medium',
    }], 'the in-flight write must observe the safe bridge effort')
    assert.equal(result.model, 'gaoge/openai/two/gpt-5.6-sol')
    assert.equal(result.effort, requestedEffort)
  })
})

test('dangerous transitions fail closed when target model metadata is unavailable', async t => {
  const page = await fixture(t, { transitionGuard: true })
  await page.evaluate(() => {
    const owner = window.nativeProps
    owner.model = 'gaoge/openai/one/gpt-5.5'
    owner.reasoningEffort = 'medium'
    owner.models = owner.models.filter(model => model.model !== 'gaoge/openai/two/gpt-5.6-sol')
    window.nativeCalls = []
  })
  await page.waitForTimeout(120)
  const result = await page.evaluate(() => (
    window.nativeProps.onSelectModel('gaoge/openai/two/gpt-5.6-sol', 'max')
  ))
  assert.equal(result, false)
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 0)
  const diagnostic = await page.evaluate(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__)
  assert.equal(diagnostic.event, 'transition-blocked')
  assert.equal(diagnostic.reason, 'model-metadata-unavailable')
})

test('ordinary efforts remain usable when a future client moves model metadata', async t => {
  const page = await fixture(t, { transitionGuard: true })
  await page.evaluate(() => {
    const owner = window.nativeProps
    owner.model = 'gaoge/openai/one/gpt-5.5'
    owner.reasoningEffort = 'medium'
    owner.models = []
    window.nativeCalls = []
  })
  await page.waitForTimeout(120)
  const result = await page.evaluate(() => (
    window.nativeProps.onSelectModel('gaoge/openai/two/gpt-5.6-sol', 'medium')
  ))
  assert.notEqual(result, false)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [{
    id: 'gaoge/openai/two/gpt-5.6-sol',
    effort: 'medium',
  }])
})

test('re-rendered controllers release obsolete wrappers instead of accumulating them', async t => {
  const page = await fixture(t, { transitionGuard: true })
  await page.waitForFunction(() => (
    window.__gaogeCodexModelTransitionGuard?.wrappedControllerCount === 1
  ))
  const result = await page.evaluate(async () => {
    const previous = window.nativeProps
    const previousOriginal = previous.onSelectModel
      .__gaogeCodexModelTransitionOriginal || null
    const next = {
      ...previous,
      onSelectModel(id, effort) {
        window.nativeCalls.push({ id, effort })
        next.model = id
        next.reasoningEffort = effort
      },
    }
    window.setComposerTask('thread-a', next)
    await new Promise(resolve => setTimeout(resolve, 160))
    return {
      count: window.__gaogeCodexModelTransitionGuard?.wrappedControllerCount,
      previousRestored: previousOriginal
        ? previous.onSelectModel === previousOriginal
        : previous.onSelectModel.__gaogeCodexModelTransitionGuard !== true,
      nextWrapped: next.onSelectModel.__gaogeCodexModelTransitionGuard === true,
    }
  })
  assert.deepEqual(result, {
    count: 1,
    previousRestored: true,
    nextWrapped: true,
  })
})

test('dangerous transitions fail closed when models have no shared bridge effort', async t => {
  const page = await fixture(t, { transitionGuard: true })
  await page.evaluate(() => {
    const owner = window.nativeProps
    owner.model = 'gaoge/openai/one/gpt-5.5'
    owner.reasoningEffort = 'medium'
    owner.models = owner.models.map(model => {
      if (model.model === 'gaoge/openai/one/gpt-5.5') {
        return { ...model, supportedReasoningEfforts: [{ reasoningEffort: 'none' }] }
      }
      if (model.model === 'gaoge/openai/two/gpt-5.6-sol') {
        return { ...model, supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }
      }
      return model
    })
    window.nativeCalls = []
  })
  await page.waitForTimeout(120)
  const result = await page.evaluate(() => (
    window.nativeProps.onSelectModel('gaoge/openai/two/gpt-5.6-sol', 'max')
  ))
  assert.equal(result, false)
  assert.equal(await page.evaluate(() => window.nativeCalls.length), 0)
  const diagnostic = await page.evaluate(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__)
  assert.equal(diagnostic.event, 'transition-blocked')
  assert.equal(diagnostic.reason, 'no-common-bridge-effort')
})

test('stale native reasoning callbacks are repaired before an unsupported commit', async t => {
  for (const requestedEffort of ['max', 'ultra']) await t.test(requestedEffort, async t => {
    const page = await fixture(t, { transitionGuard: true })
    await page.evaluate(async () => {
      window.__gaogeCodexModelTransitionGuard.dispose()
      const owner = window.nativeProps
      owner.model = 'gaoge/openai/one/gpt-5.5'
      owner.reasoningEffort = 'medium'
      window.nativeEffortCalls = []
      window.nativeCommits = []
      window.nativeCommitTimers = []
      const scheduleCommit = effort => {
        const selection = { model: owner.model, reasoningEffort: effort }
        window.nativeQueuedAtom.value = selection
        window.nativeInFlightAtom.value = null
        for (const timer of window.nativeCommitTimers) clearTimeout(timer)
        window.nativeCommitTimers = [
          setTimeout(() => {
            window.nativeQueuedAtom.value = null
            window.nativeInFlightAtom.value = selection
            window.nativeCommitTimers = [
              setTimeout(() => {
                window.nativeCommits.push({
                  model: selection.model,
                  effort: selection.reasoningEffort,
                })
                window.nativeInFlightAtom.value = null
              }, 160),
            ]
          }, 160),
        ]
      }
      owner.onSelectReasoningEffort = effort => {
        window.nativeEffortCalls.push(effort)
        owner.reasoningEffort = effort
        scheduleCommit(effort)
      }
      // A native menu can retain this callback before the guard is installed.
      window.staleReasoning = owner.onSelectReasoningEffort
      window.transitionGuardResult = await window.installTransitionGuard({
        state: { enabled: true, mode: 'relay' },
      })
    })
    await page.waitForFunction(() => (
      window.nativeProps.onSelectReasoningEffort?.__gaogeCodexModelTransitionGuard === true
    ))
    await page.evaluate(effort => window.staleReasoning(effort), requestedEffort)
    await page.waitForFunction(() => (
      window.nativeCommits.length === 1
        && window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__?.event === 'transition-blocked'
    ))
    const result = await page.evaluate(() => ({
      nativeEffortCalls: window.nativeEffortCalls,
      commits: window.nativeCommits,
      effort: window.nativeProps.reasoningEffort,
    }))
    assert.deepEqual(result.nativeEffortCalls, [requestedEffort])
    assert.deepEqual(result.commits, [{
      model: 'gaoge/openai/one/gpt-5.5',
      effort: 'medium',
    }])
    assert.equal(result.effort, 'medium')
  })
})

test('direct reasoning-effort callbacks reject max and ultra on gpt-5.5', async t => {
  for (const requestedEffort of ['max', 'ultra']) await t.test(requestedEffort, async t => {
    const page = await fixture(t, { transitionGuard: true })
    await page.evaluate(() => {
      const owner = window.nativeProps
      owner.model = 'gaoge/openai/one/gpt-5.5'
      owner.reasoningEffort = 'medium'
      window.nativeEffortCalls = []
      owner.onSelectReasoningEffort = effort => {
        window.nativeEffortCalls.push(effort)
        owner.reasoningEffort = effort
      }
    })
    await page.waitForFunction(() => (
      window.nativeProps.onSelectReasoningEffort?.__gaogeCodexModelTransitionGuard === true
    ))
    const result = await page.evaluate(requestedEffort => (
      window.nativeProps.onSelectReasoningEffort(requestedEffort)
    ), requestedEffort)
    assert.equal(result, false)
    assert.deepEqual(await page.evaluate(() => window.nativeEffortCalls), [])
    const diagnostic = await page.evaluate(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__)
    assert.equal(diagnostic.event, 'transition-blocked')
    assert.equal(diagnostic.reason, 'target-effort-unsupported')
  })
})

test('same canonical model on another billing route still validates max capability', async t => {
  const page = await fixture(t, { transitionGuard: true })
  await page.evaluate(() => {
    const owner = window.nativeProps
    const target = 'gaoge/openai/three/gpt-5.6-sol'
    owner.model = 'gaoge/openai/two/gpt-5.6-sol'
    owner.reasoningEffort = 'max'
    owner.models = [
      ...owner.models,
      {
        modelSlug: target,
        supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
        default_reasoning_effort: 'medium',
      },
    ]
    window.nativeCalls = []
  })
  await page.waitForTimeout(120)
  const result = await page.evaluate(() => (
    window.nativeProps.onSelectModel('gaoge/openai/three/gpt-5.6-sol', 'max')
  ))
  assert.equal(result, false)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
  const diagnostic = await page.evaluate(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__)
  assert.equal(diagnostic.event, 'transition-blocked')
  assert.equal(diagnostic.reason, 'target-effort-unsupported')
})

test('gpt-5.6 max to gpt-5.5 max never passes the unsupported effort through', async t => {
  const page = await fixture(t, { transitionGuard: true })
  await page.evaluate(() => {
    const owner = window.nativeProps
    owner.model = 'gaoge/openai/two/gpt-5.6-sol'
    owner.reasoningEffort = 'max'
    window.nativeCalls = []
  })
  await page.waitForTimeout(120)
  const result = await page.evaluate(() => (
    window.nativeProps.onSelectModel('gaoge/openai/one/gpt-5.5', 'max')
  ))
  assert.equal(result, false)
  assert.deepEqual(await page.evaluate(() => window.nativeCalls), [])
  const diagnostic = await page.evaluate(() => window.__GAOGE_CODEX_MODEL_TRANSITION_DIAGNOSTIC__)
  assert.equal(diagnostic.event, 'transition-blocked')
  assert.equal(diagnostic.reason, 'target-effort-unsupported')
})

test('account balance mounts immediately after permissions without changing composer controls', async t => {
  const page = await balanceFixture(t)
  const initial = await page.evaluate(() => {
    const badge = document.querySelector('.gaoge-account-balance')
    const permission = document.querySelector('#balance-permission')
    const model = document.querySelector('.model-action')
    const badgeRect = badge.getBoundingClientRect()
    const permissionRect = permission.getBoundingClientRect()
    return {
      count: document.querySelectorAll('.gaoge-account-balance').length,
      parent: badge.parentElement?.id,
      afterPermission: badge.previousElementSibling === permission,
      placement: badge.dataset.gaogeAccountBalancePlacement,
      displayMode: badge.dataset.gaogeAccountBalanceDisplay,
      color: getComputedStyle(badge).color,
      position: getComputedStyle(badge).position,
      overlapsPermission: badgeRect.left < permissionRect.right,
      overlapsModel: badgeRect.right > model.getBoundingClientRect().left,
      sameRow: badgeRect.top >= permissionRect.top && badgeRect.bottom <= permissionRect.bottom,
      inHeader: !!badge.closest('header'),
      clicks: window.balanceControlClicks,
      input: document.querySelector('[contenteditable]').textContent,
    }
  })
  assert.deepEqual(initial, {
    count: 1,
    parent: 'balance-tools',
    afterPermission: true,
    placement: 'composer',
    displayMode: 'full',
    color: 'rgba(255, 255, 255, 0.5)',
    position: 'static',
    overlapsPermission: false,
    overlapsModel: false,
    sameRow: true,
    inHeader: false,
    clicks: 0,
    input: '待发送内容',
  })

  await page.evaluate(() => {
    const host = document.querySelector('#balance-tools')
    host.innerHTML = '<button type="button" class="icon-action">+</button><button id="balance-permission" type="button" data-composer-navigation-target="permissions">默认权限</button>'
  })
  await page.waitForFunction(() => {
    const badge = document.querySelector('.gaoge-account-balance')
    return badge?.previousElementSibling?.id === 'balance-permission'
      && getComputedStyle(badge).display !== 'none'
      && document.querySelectorAll('.gaoge-account-balance').length === 1
  })

  await page.evaluate(() => {
    const composer = document.querySelector('#balance-composer')
    const next = composer.cloneNode(true)
    next.querySelector('.gaoge-account-balance')?.remove()
    composer.replaceWith(next)
  })
  await page.waitForFunction(() => {
    const badge = document.querySelector('.gaoge-account-balance')
    return badge?.closest('#balance-composer')
      && badge.previousElementSibling?.id === 'balance-permission'
      && badge.textContent === '余额 $89,436.45'
      && document.querySelectorAll('.gaoge-account-balance').length === 1
  })
  const idleMutations = await page.evaluate(async () => {
    let count = 0
    const observer = new MutationObserver(records => { count += records.length })
    observer.observe(document.querySelector('.gaoge-account-balance'), { childList: true, subtree: true, characterData: true })
    await new Promise(resolve => setTimeout(resolve, 400))
    observer.disconnect()
    return count
  })
  assert.equal(idleMutations, 0, 'a settled badge must not create a text mutation loop')
})

test('account balance follows the permission control marker through labels and tooltip wrappers', async t => {
  const page = await balanceFixture(t, { permissionLabel: 'Default permissions', wrappedPermission: true })
  assert.deepEqual(await page.evaluate(() => {
    const badge = document.querySelector('.gaoge-account-balance')
    return {
      parent: badge.parentElement?.id,
      afterWrapper: badge.previousElementSibling?.id === 'permission-wrapper',
      visible: getComputedStyle(badge).display !== 'none',
    }
  }), { parent: 'balance-tools', afterWrapper: true, visible: true })
})

test('account balance adapts to composer space without squeezing the model or send controls', async t => {
  const page = await balanceFixture(t)
  await page.setViewportSize({ width: 780, height: 750 })
  await page.waitForFunction(() => (
    document.querySelector('.gaoge-account-balance')?.dataset.gaogeAccountBalanceDisplay === 'compact'
  ))
  const compact = await page.evaluate(() => {
    const badge = document.querySelector('.gaoge-account-balance')
    const model = document.querySelector('.model-action')
    const permission = document.querySelector('#balance-permission')
    return {
      text: badge.textContent,
      overlapsPermission: badge.getBoundingClientRect().left < permission.getBoundingClientRect().right,
      overlapsModel: badge.getBoundingClientRect().right > model.getBoundingClientRect().left,
      modelWidth: model.getBoundingClientRect().width,
      sendWidth: document.querySelector('[aria-label="发送"]').getBoundingClientRect().width,
    }
  })
  assert.deepEqual(compact, {
    text: '$89,436.45',
    overlapsPermission: false,
    overlapsModel: false,
    modelWidth: 152,
    sendWidth: 28,
  })
  await page.setViewportSize({ width: 680, height: 750 })
  await page.waitForFunction(() => (
    document.querySelector('.gaoge-account-balance')?.dataset.gaogeAccountBalanceDisplay === 'hidden'
  ))
  await page.setViewportSize({ width: 1100, height: 750 })
  await page.waitForFunction(() => (
    document.querySelector('.gaoge-account-balance')?.dataset.gaogeAccountBalanceDisplay === 'full'
  ))
})

test('account balance waits for a composer permission control and never falls back to a conversation header', async t => {
  const page = await balanceFixture(t, { permission: false })
  assert.deepEqual(await page.evaluate(() => {
    const badge = document.querySelector('.gaoge-account-balance')
    return { parent: badge.parentElement?.tagName, display: getComputedStyle(badge).display }
  }), { parent: 'BODY', display: 'none' })
  await page.evaluate(() => {
    const button = document.createElement('button')
    button.id = 'balance-permission'
    button.dataset.composerNavigationTarget = 'permissions'
    button.textContent = '完全访问'
    document.querySelector('#balance-tools').appendChild(button)
  })
  await page.waitForFunction(() => (
    document.querySelector('.gaoge-account-balance')?.dataset.gaogeAccountBalancePlacement === 'composer'
  ))
  await page.evaluate(() => document.querySelector('#balance-composer').remove())
  await page.waitForFunction(() => (
    document.querySelector('.gaoge-account-balance')?.dataset.gaogeAccountBalancePlacement === 'hidden'
  ))
  assert.equal(await page.locator('header .gaoge-account-balance').count(), 0)
})

test('account balance keeps the last amount when refreshing fails and disposes its badge', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(async () => {
    window.failBalanceRefresh = true
    await window.__gaogeAccountBalanceRuntime.refresh()
  })
  assert.equal(await page.locator('.gaoge-account-balance').textContent(), '余额 $89,436.45')
  assert.match(await page.locator('.gaoge-account-balance').getAttribute('title'), /刷新失败/)
  await page.evaluate(() => window.__gaogeAccountBalanceRuntime.dispose())
  assert.equal(await page.locator('.gaoge-account-balance').count(), 0)
  assert.equal(await page.locator('#gaoge-account-balance-style').count(), 0)
})

test('account balance reuses a healthy runtime through repeated background injections and repairs removed nodes', async t => {
  const page = await balanceFixture(t)
  const expectedVersion = Number(rust.match(/const CODEX_ACCOUNT_BALANCE_RUNTIME_VERSION:\s*u64\s*=\s*(\d+)/)?.[1])
  const result = await page.evaluate(() => {
    const runtime = window.__gaogeAccountBalanceRuntime
    const badge = document.querySelector('.gaoge-account-balance')
    const requests = window.balanceRequestCount
    const outcomes = Array.from({ length: 20 }, () => window.installAccountBalance())
    const stable = {
      sameRuntime: window.__gaogeAccountBalanceRuntime === runtime,
      sameBadge: document.querySelector('.gaoge-account-balance') === badge,
      requests: window.balanceRequestCount - requests,
      amount: badge.textContent,
      ready: outcomes.every(result => result.ready && result.mounted),
      version: runtime.version,
    }
    badge.remove()
    document.querySelector('#gaoge-account-balance-style').remove()
    const repaired = window.installAccountBalance()
    return {
      ...stable,
      repaired: repaired.ready && repaired.mounted
        && !!document.querySelector('#gaoge-account-balance-style')
        && document.querySelector('.gaoge-account-balance')?.textContent === '余额 $89,436.45',
      count: document.querySelectorAll('.gaoge-account-balance').length,
    }
  })
  assert.deepEqual(result, {
    sameRuntime: true,
    sameBadge: true,
    requests: 0,
    amount: '余额 $89,436.45',
    ready: true,
    version: expectedVersion,
    repaired: true,
    count: 1,
  })
})

test('account balance survives repeated conversation visibility switches without rebuilding either composer', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    const second = document.querySelector('#balance-composer').cloneNode(true)
    second.id = 'balance-composer-b'
    second.style.display = 'none'
    second.querySelector('.gaoge-account-balance')?.remove()
    document.body.appendChild(second)
  })
  const result = await page.evaluate(async () => {
    const first = document.querySelector('#balance-composer')
    const second = document.querySelector('#balance-composer-b')
    const originalRuntime = window.__gaogeAccountBalanceRuntime
    for (let i = 0; i < 12; i++) {
      const active = i % 2 === 0 ? second : first
      const inactive = active === first ? second : first
      inactive.style.display = 'none'
      active.style.display = ''
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const badge = document.querySelector('.gaoge-account-balance')
      if (!active.contains(badge) || getComputedStyle(badge).display === 'none'
          || badge.previousElementSibling?.dataset.composerNavigationTarget !== 'permissions'
          || document.querySelectorAll('.gaoge-account-balance').length !== 1) {
        return { failedSwitch: i + 1 }
      }
      window.installAccountBalance()
      await originalRuntime.refresh()
    }
    return {
      switches: 12,
      sameRuntime: window.__gaogeAccountBalanceRuntime === originalRuntime,
      amount: document.querySelector('.gaoge-account-balance').textContent,
    }
  })
  assert.deepEqual(result, { switches: 12, sameRuntime: true, amount: '余额 $89,436.45' })
})

test('account balance ignores an old in-flight result after replacing its connection', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.oldBalanceRuntime = window.__gaogeAccountBalanceRuntime
    window.__gaogeSessionDeleteBridge = () => new Promise(resolve => { window.resolveOldBalance = resolve })
    window.oldBalanceRefresh = window.oldBalanceRuntime.refresh()
    window.__GAOGE_SESSION_HELPER_TOKEN__ = 'new-test-connection'
    window.__gaogeSessionDeleteBridge = async () => ({ ok: true, balance: 123.45, updatedAt: Date.now() })
    window.installAccountBalance()
  })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $123.45')
  const result = await page.evaluate(async () => {
    window.resolveOldBalance({ ok: true, balance: 99999, updatedAt: Date.now() })
    await window.oldBalanceRefresh
    const badge = document.querySelector('.gaoge-account-balance')
    return {
      oldDisposed: window.oldBalanceRuntime.status().ready === false,
      replaced: window.oldBalanceRuntime !== window.__gaogeAccountBalanceRuntime,
      amount: badge.textContent,
      count: document.querySelectorAll('.gaoge-account-balance').length,
      visible: getComputedStyle(badge).display !== 'none',
      afterPermission: badge.previousElementSibling?.dataset.composerNavigationTarget === 'permissions',
    }
  })
  assert.deepEqual(result, {
    oldDisposed: true, replaced: true, amount: '余额 $123.45',
    count: 1, visible: true, afterPermission: true,
  })
})



test('account balance refreshes immediately when the missing bridge announces readiness', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.__gaogeAccountBalanceRuntime.dispose()
    delete window.__gaogeSessionDeleteBridge
    window.installAccountBalance()
    window.recoveryRuntime = window.__gaogeAccountBalanceRuntime
  })
  assert.equal(await page.locator('.gaoge-account-balance').textContent(), '余额 --')
  assert.deepEqual(await page.evaluate(() => {
    const state = window.__gaogeAccountBalanceRuntime.status()
    return { readState: state.readState, hasValue: state.hasValue, bridgeReady: state.bridgeReady, errorCode: state.errorCode }
  }), { readState: 'waiting-bridge', hasValue: false, bridgeReady: false, errorCode: 'bridge-unavailable' })
  await page.evaluate(() => {
    window.recoveryCalls = 0
    window.__gaogeSessionDeleteBridge = async () => { window.recoveryCalls++; return { ok: true, balance: 71.25 } }
    window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
  })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $71.25')
  const result = await page.evaluate(() => ({ sameRuntime: window.recoveryRuntime === window.__gaogeAccountBalanceRuntime,
    requests: window.recoveryCalls, state: window.__gaogeAccountBalanceRuntime.status() }))
  assert.equal(result.sameRuntime, true)
  assert.equal(result.requests, 1)
  assert.equal(result.state.readState, 'ready')
  assert.equal(result.state.hasValue, true)
  assert.equal(result.state.errorCode, '')
  for (const forbidden of ['balance', 'token', 'helperToken', 'helperBase', 'amount']) assert.equal(forbidden in result.state, false)
})

test('account balance replaces a blocked fetch fallback with the restored native bridge', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.__gaogeAccountBalanceRuntime.dispose()
    delete window.__gaogeSessionDeleteBridge
    window.__GAOGE_SESSION_HELPER_BASE__ = 'http://127.0.0.1:1'
    window.__GAOGE_SESSION_HELPER_TOKEN__ = 'test-fixture-only'
    window.fetchAttempts = 0
    window.fetch = async () => { window.fetchAttempts++; throw new TypeError('Failed to fetch') }
    window.installAccountBalance()
  })
  await page.waitForFunction(() => window.__gaogeAccountBalanceRuntime.status().readState === 'error')
  assert.equal(await page.locator('.gaoge-account-balance').textContent(), '余额 --')
  await page.evaluate(() => {
    window.nativeBalanceCalls = 0
    window.__gaogeSessionDeleteBridge = async () => { window.nativeBalanceCalls++; return { ok: true, balance: '125.50' } }
    window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
  })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $125.50')
  assert.deepEqual(await page.evaluate(() => ({ fetch: window.fetchAttempts, native: window.nativeBalanceCalls,
    state: window.__gaogeAccountBalanceRuntime.status().readState })), { fetch: 1, native: 1, state: 'ready' })
})

test('account balance reinjection recovers a new bridge without rebuilding and throttles repeated failures', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.__gaogeAccountBalanceRuntime.dispose()
    delete window.__gaogeSessionDeleteBridge
    window.installAccountBalance()
    window.recoveryRuntime = window.__gaogeAccountBalanceRuntime
    window.recoveryCalls = 0
    window.__gaogeSessionDeleteBridge = async () => { window.recoveryCalls++; throw new Error('unavailable') }
    for (let attempt = 0; attempt < 30; attempt++) window.installAccountBalance()
  })
  await page.waitForFunction(() => window.__gaogeAccountBalanceRuntime.status().readState === 'error')
  await page.evaluate(() => { for (let attempt = 0; attempt < 30; attempt++) window.installAccountBalance() })
  assert.equal(await page.evaluate(() => window.recoveryCalls), 1)
  await page.evaluate(() => {
    window.__gaogeSessionDeleteBridge = async () => { window.recoveryCalls++; return { ok: true, balance: 62 } }
    for (let attempt = 0; attempt < 30; attempt++) window.installAccountBalance()
  })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $62.00')
  assert.deepEqual(await page.evaluate(() => ({ requests: window.recoveryCalls, same: window.recoveryRuntime === window.__gaogeAccountBalanceRuntime })),
    { requests: 2, same: true })
})

test('account balance queues one bridge recovery behind an in-flight read and ignores healthy duplicate events', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.__gaogeSessionDeleteBridge = () => new Promise(resolve => { window.finishOldBalance = resolve })
    window.waitingBalance = window.__gaogeAccountBalanceRuntime.refresh()
    window.restoredCalls = 0
    window.__gaogeSessionDeleteBridge = async () => { window.restoredCalls++; return { ok: true, balance: 207.11 } }
    for (let i = 0; i < 30; i++) window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
  })
  assert.equal(await page.evaluate(() => window.__gaogeAccountBalanceRuntime.status().refreshPending), true)
  await page.evaluate(async () => { window.finishOldBalance({ ok: true, balance: 5 }); await window.waitingBalance })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $207.11')
  await page.evaluate(() => {
    for (let i = 0; i < 30; i++) { window.dispatchEvent(new Event('gaoge:runtime-bridge-ready')); window.installAccountBalance() }
  })
  assert.equal(await page.evaluate(() => window.restoredCalls), 1)
  assert.equal(await page.evaluate(() => window.__gaogeAccountBalanceRuntime.status().refreshPending), false)
})

test('account balance readiness during a failed read is not lost when the bridge function stays the same', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.sameBridgeCalls = 0
    window.__gaogeSessionDeleteBridge = () => {
      window.sameBridgeCalls++
      if (window.sameBridgeCalls === 1) return new Promise((_, reject) => { window.rejectOldBalance = reject })
      return Promise.resolve({ ok: true, balance: 81.03 })
    }
    window.waitingBalance = window.__gaogeAccountBalanceRuntime.refresh()
    for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
  })
  await page.evaluate(async () => { window.rejectOldBalance(new Error('old read failed')); await window.waitingBalance })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $81.03')
  assert.equal(await page.evaluate(() => window.sameBridgeCalls), 2)
})

test('account balance never coerces empty or nonnumeric values to zero and preserves the last valid read', async t => {
  const page = await balanceFixture(t)
  const invalid = await page.evaluate(async () => {
    window.__gaogeAccountBalanceRuntime.dispose()
    window.testBalancePayload = { ok: true, balance: null }
    window.__gaogeSessionDeleteBridge = async () => window.testBalancePayload
    window.installAccountBalance()
    const runtime = window.__gaogeAccountBalanceRuntime
    await runtime.refresh()
    const values = [undefined, null, '', '  ', false, true, [], {}, 'not-a-number', 'NaN', 'Infinity', '0x10', Infinity, NaN]
    const outcomes = []
    for (const balance of values) {
      window.testBalancePayload = { ok: true, balance }; await runtime.refresh()
      outcomes.push({ text: document.querySelector('.gaoge-account-balance').textContent,
        hasValue: runtime.status().hasValue, code: runtime.status().errorCode })
    }
    window.testBalancePayload = { ok: true, balance: '0' }; await runtime.refresh()
    const zero = document.querySelector('.gaoge-account-balance').textContent
    window.testBalancePayload = { ok: true, balance: 12.34 }; await runtime.refresh()
    window.testBalancePayload = { ok: true, balance: null }; await runtime.refresh()
    return { outcomes, zero, retained: document.querySelector('.gaoge-account-balance').textContent,
      state: runtime.status().readState }
  })
  assert.equal(invalid.outcomes.length, 14)
  for (const outcome of invalid.outcomes) assert.deepEqual(outcome, { text: '余额 --', hasValue: false, code: 'invalid-balance' })
  assert.equal(invalid.zero, '余额 $0.00')
  assert.equal(invalid.retained, '余额 $12.34')
  assert.equal(invalid.state, 'stale')
})

test('account balance disposal cancels bridge deadlines and queued recovery listeners', async t => {
  const page = await balanceFixture(t)
  const result = await page.evaluate(async () => {
    const nativeSetTimeout = window.setTimeout, nativeClearTimeout = window.clearTimeout
    const tracked = new Set()
    window.setTimeout = function(callback, delay, ...args) {
      const id = nativeSetTimeout.call(window, callback, delay, ...args)
      if (delay === 10000) tracked.add(id)
      return id
    }
    window.clearTimeout = function(id) { tracked.delete(id); return nativeClearTimeout.call(window, id) }
    const runtime = window.__gaogeAccountBalanceRuntime
    window.__gaogeSessionDeleteBridge = () => new Promise(() => {})
    const waiting = runtime.refresh()
    window.afterDisposeCalls = 0
    window.__gaogeSessionDeleteBridge = async () => { window.afterDisposeCalls++; return { ok: true, balance: 70 } }
    window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
    const trackedBefore = tracked.size
    runtime.dispose()
    await waiting
    window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
    await new Promise(resolve => nativeSetTimeout(resolve, 30))
    return { trackedBefore, remainingTimeouts: tracked.size, calls: window.afterDisposeCalls,
      state: runtime.status().readState, pending: runtime.status().refreshPending,
      badges: document.querySelectorAll('.gaoge-account-balance').length }
  })
  assert.deepEqual(result, { trackedBefore: 1, remainingTimeouts: 0, calls: 0, state: 'disposed', pending: false, badges: 0 })
})

test('account balance times out stalled bridge and fetch JSON reads without losing the previous value', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    const native = window.setTimeout
    window.setTimeout = (callback, delay, ...args) => native(callback, delay === 10000 ? 40 : delay, ...args)
    window.__gaogeSessionDeleteBridge = () => new Promise(() => {})
  })
  await page.evaluate(() => window.__gaogeAccountBalanceRuntime.refresh())
  assert.equal(await page.locator('.gaoge-account-balance').textContent(), '余额 $89,436.45')
  assert.equal(await page.evaluate(() => window.__gaogeAccountBalanceRuntime.status().errorCode), 'timeout')
  await page.evaluate(() => {
    window.__gaogeAccountBalanceRuntime.dispose()
    delete window.__gaogeSessionDeleteBridge
    window.__GAOGE_SESSION_HELPER_BASE__ = 'http://127.0.0.1:1'
    window.__GAOGE_SESSION_HELPER_TOKEN__ = 'test-only'
    window.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) })
    window.installAccountBalance()
  })
  await page.waitForFunction(() => window.__gaogeAccountBalanceRuntime.status().errorCode === 'timeout')
  assert.equal(await page.locator('.gaoge-account-balance').textContent(), '余额 --')
})


test('account balance identifies known login failures without exposing arbitrary response details', async t => {
  const page = await balanceFixture(t)
  const result = await page.evaluate(async () => {
    const runtime = window.__gaogeAccountBalanceRuntime
    const messages = ['尚未登录 Gaoge Free', '登录已失效，请重新登录', 'unrelated failure with private-fixture-value']
    const outcomes = []
    for (const message of messages) {
      window.__gaogeSessionDeleteBridge = async () => ({ ok: false, message })
      await runtime.refresh()
      const badge = document.querySelector('.gaoge-account-balance')
      outcomes.push({ text: badge.textContent, title: badge.title, state: runtime.status() })
    }
    return outcomes
  })
  for (const outcome of result.slice(0, 2)) {
    assert.equal(outcome.state.errorCode, 'login-required')
    assert.equal(outcome.state.readState, 'stale')
    assert.match(outcome.title, /请先登录 Gaoge Free 后刷新余额/)
    assert.equal(outcome.text, '余额 $89,436.45')
  }
  assert.equal(result[2].state.errorCode, 'request-failed')
  assert.equal(result[2].title.includes('private-fixture-value'), false)
  assert.equal(JSON.stringify(result[2].state).includes('private-fixture-value'), false)
})

test('account balance queues a later ready event during an ordinary read after the same bridge recovered earlier', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.bridgeReads = 0
    window.__gaogeSessionDeleteBridge = () => {
      window.bridgeReads++
      if (window.bridgeReads === 2) return new Promise((_, reject) => { window.rejectSecondRead = reject })
      return Promise.resolve({ ok: true, balance: window.bridgeReads === 1 ? 17 : 29 })
    }
    for (let index = 0; index < 20; index++) window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
  })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $17.00')
  assert.equal(await page.evaluate(() => window.bridgeReads), 1)
  await page.evaluate(() => {
    window.secondRead = window.__gaogeAccountBalanceRuntime.refresh()
    for (let index = 0; index < 20; index++) window.dispatchEvent(new Event('gaoge:runtime-bridge-ready'))
  })
  assert.equal(await page.evaluate(() => window.__gaogeAccountBalanceRuntime.status().refreshPending), true)
  await page.evaluate(async () => { window.rejectSecondRead(new Error('transient')); await window.secondRead })
  await page.waitForFunction(() => document.querySelector('.gaoge-account-balance')?.textContent === '余额 $29.00')
  assert.equal(await page.evaluate(() => window.bridgeReads), 3)
})


test('account balance classifies HTTP login failures through the same safe message whitelist', async t => {
  const page = await balanceFixture(t)
  await page.evaluate(() => {
    window.__gaogeAccountBalanceRuntime.dispose()
    delete window.__gaogeSessionDeleteBridge
    window.__GAOGE_SESSION_HELPER_BASE__ = 'http://127.0.0.1:1'
    window.__GAOGE_SESSION_HELPER_TOKEN__ = 'test-only'
    window.fetch = async () => ({ ok: false, status: 401, json: async () => ({ ok: false,
      message: '登录已失效 private-fixture-value' }) })
    window.installAccountBalance()
  })
  await page.waitForFunction(() => window.__gaogeAccountBalanceRuntime.status().errorCode === 'login-required')
  assert.equal(await page.locator('.gaoge-account-balance').textContent(), '余额 --')
  assert.match(await page.locator('.gaoge-account-balance').getAttribute('title'), /请先登录 Gaoge Free 后刷新余额/)
  assert.equal((await page.locator('.gaoge-account-balance').getAttribute('title')).includes('private-fixture-value'), false)
})

// A healthy native aggregate must not be reinjected just because an unrelated
// private relay-selection adapter cannot load on a newer Codex version.
test('aggregate uses native effort fallback without loading the private relay guard', async () => {
  let disposed = 0
  const sandbox = { window: { __gaogeCodexModelTransitionGuard: { dispose() { disposed++ } } } }
  const vm = require('node:vm')
  vm.createContext(sandbox)
  vm.runInContext(transitionGuardRuntime, sandbox)
  const result = await sandbox.installCodexModelTransitionGuard({ state: { enabled: true, mode: 'aggregate' } })
  assert.equal(disposed, 1)
  assert.equal(result.enabled, false)
  assert.equal(result.ready, true)
  assert.equal(result.error, '')
})
