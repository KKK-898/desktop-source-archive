const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const vm = require('node:vm')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const asar = require('@electron/asar')
const ts = require('typescript')
const { nativeWebpackApiFixture } = require('./codex-api-mode-webpack-native-fixture.cjs')

// First entry in each pair is the desktop copy in 26.1111.21308. index.html
// loads 348410; its loader explicitly requests 982888, not 760507.
const desktopCopies1111 = {
  E7Ps: [
    ['webview/assets/348410.374a9b8f98.js', 'e1b00ae1070241f273aa6b630f097076c8ffb0015748353a6c717d4324bec603'],
    ['webview/assets/async/9921.9e1b993ce9.js', '43c7144d3099b6bf384eba2cc99b8588faabd82b39f06b7d0386ef16f42c7655'],
  ],
  HI9o: [
    ['webview/assets/348410.374a9b8f98.js', 'a468b1d8f514089815453c863ad10deb538d55420cfbe28eb4ee19ec9af21e9a'],
    ['webview/assets/async/9921.9e1b993ce9.js', '66a3a3dc2f037c1bf4a6be0c8947995b02975f4e86f81a4ef679ac9afe366223'],
  ],
  tQ31: [
    ['webview/assets/async/982888.5f362a59ae.js', 'be62937a258ccbeb6e32e20d9e86cd8c3872c7f74fd0c645392fd7f4a25522a6'],
    ['webview/assets/async/760507.0d634a5b8f.js', '94b491e10184ddf19e62a5bdf4490e1aba571a8a4789b7326c175f30bb89bfe3'],
  ],
}

function selectProjectFactoryCopy(id, copies, reviewed) {
  if (!reviewed) {
    assert.equal(copies.length, 1, 'Expected exactly one native project factory: ' + id)
    return copies[0]
  }
  const byFile = new Map(copies.map(copy => [copy.file.replaceAll('\\', '/'), copy]))
  assert.equal(byFile.size, copies.length, 'Duplicate native project factory in one chunk: ' + id)
  assert.deepEqual([...byFile.keys()].sort(), reviewed.map(([file]) => file).sort(), 'Unreviewed set of native project copies: ' + id)
  for (const [file, sha256] of reviewed) {
    assert.equal(createHash('sha256').update(byFile.get(file).source).digest('hex'), sha256, 'Unreviewed native project copy: ' + id + ' in ' + file)
  }
  return byFile.get(reviewed[0][0])
}

// Executes reviewed selector factories from the installed ASAR, never an app
// entry point. IPC, query scheduling, persistence, thread pages, remote hosts and
// schema primitives are in-memory adapters. This is a native source integration
// test, NOT an Electron/app-server/UI end-to-end test.
function nativeProjectsFixture(packagePath) {
  const apiFixture = nativeWebpackApiFixture(packagePath)
  const files = asar.listPackage(packagePath).map(file => file.replace(/^[\\/]/, ''))
  const candidates = new Map()
  const splitHelpers = apiFixture.packageVersion === '26.1111.21308'
  const needed = new Set([
    'Wbxh', 'qj4H', 'ndjw', 'XsHM', 'XyS0', 's6B0', 'DZgh', 'pSzu', 'cpC0',
    'V0vl', 'DVsG', 'Xqyo', 'UxLy', 'CnPR', 'h54q', 'FHI1', 'sHm2', 'gLQa',
    'WVuR', 'pQ7w', 'RFDv', 'HI9o', 'CiYY', 'I3ol', 'ZRtB', 'N2rm', 'EIJx',
    'yJ6f', 'bnxy', 'ZIaK', 'r8w8', 'E7Ps', 'Rrp3', 'Pfrd', 'dPHU', 'y5af', 'YTFQ', 'wHcA',
    ...(splitHelpers ? ['tQ31', 'XNy1', 'hu8h'] : []),
  ])
  // Shared project helpers can move to another chunk without changing their
  // factory IDs (26.1111). The AST below still admits only the reviewed IDs.
  const mayContainFactory = new RegExp(`(?:^|[,{])\\s*["']?(?:${[...needed].join('|')})["']?\\s*\\(`)
  const legacyMarkers = ['groups:Y,individualProjects:Y', 'thread-project-membership-host-ids', 'function(e){return a(e).replace(/', 'bnxy(e,t,n)']
  for (const file of files) {
    if (!/^webview[\\/]assets[\\/].*\.js$/.test(file)) continue
    const source = asar.extractFile(packagePath, file).toString()
    if (splitHelpers ? !mayContainFactory.test(source) : !legacyMarkers.some(marker => source.includes(marker))) continue
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    function visit(node) {
      if (ts.isMethodDeclaration(node) && node.body && node.parameters.length === 3 && ts.isObjectLiteralExpression(node.parent)) {
        const id = node.name.text
        if (needed.has(id)) {
          if (!candidates.has(id)) candidates.set(id, [])
          candidates.get(id).push({ id, source: node.getText(tree), file })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  assert.deepEqual([...needed].filter(id => !candidates.has(id)), [], 'Reviewed native project closure changed')
  const records = new Map([...candidates].map(([id, copies]) => [id, splitHelpers
    ? selectProjectFactoryCopy(id, copies, desktopCopies1111[id])
    : copies.reduce((best, copy) => copy.source.length > best.source.length ? copy : best)]))
  assert.match(records.get('Wbxh').source, /projectCatalog/)
  assert.match(records.get('Wbxh').source, /readMemberships\(\)/)
  assert.match(records.get('DZgh').source, /hasLoadedProjectSources/)
  assert.match(records.get('sHm2').source, /codexProjectGroups/)

  function createHarness({ catalog, memberships, threads, state = {}, identity } = {}) {
    const base = apiFixture.createHarness(identity ? { identity, authMethod: identity.authMethod } : undefined)
    const registry = base.module.__webpack_require__
    const scope = base.scope
    const baseGet = scope.get.bind(scope)
    const values = new Map(), queryRows = new Map(), pending = new Set(), families = new Map()
    const observed = { reads: [], writes: [], remoteRequests: [] }
    const appScope = registry.c.OWtl.exports.u
    let currentCatalog = structuredClone(catalog)
    let currentMemberships = structuredClone(memberships)
    let currentThreads = structuredClone(threads)
    let currentState = structuredClone(state)
    const descriptor = (kind, run) => ({ projectFixtureKind: kind, run })
    const constant = value => descriptor('constant', value)
    const primitive = {
      un: (owner, run) => descriptor('computed', run),
      i1: (owner, run) => descriptor('parameterized', run),
      vU: (owner, run) => descriptor('query', run),
      RD: (owner, run) => descriptor('queryNoParameter', run),
      T1: (owner, run) => descriptor('family', run),
      vP: (owner, run) => descriptor('state', run),
      SZ: (owner, run) => descriptor('state', run),
      Y: (owner, run) => run(),
      Ul() { throw Error('React hooks must not run in the source fixture') },
      gh() { throw Error('React hooks must not run in the source fixture') },
    }
    const deny = label => () => { throw Error('Unexpected native fixture boundary: ' + label) }
    const context = () => ({ get: scope.get, set: scope.set.bind(scope), scope })
    scope.get = function get(item, argument) {
      if (!item?.projectFixtureKind) return baseGet(item, argument)
      if (values.has(item)) return values.get(item)
      switch (item.projectFixtureKind) {
        case 'constant': return item.run
        case 'computed': return item.run(context())
        case 'parameterized': return item.run(argument, context())
        case 'state': {
          const value = typeof item.run === 'function' ? item.run(context()) : item.run
          values.set(item, value)
          return value
        }
        case 'family': {
          let map = families.get(item)
          if (!map) families.set(item, map = new Map())
          const key = JSON.stringify(argument)
          if (!map.has(key)) map.set(key, item.run(argument))
          return map.get(key)
        }
        case 'query':
        case 'queryNoParameter': {
          const options = item.projectFixtureKind === 'query' ? item.run(argument, context()) : item.run(context())
          const key = JSON.stringify(options.queryKey)
          if (!queryRows.has(key)) {
            const row = { data: undefined, isLoading: options.enabled !== false, isPending: options.enabled !== false, isFetched: false, isError: false }
            queryRows.set(key, row)
            if (options.enabled !== false) {
              const promise = Promise.resolve().then(() => options.queryFn({ signal: new AbortController().signal })).then(data => {
                Object.assign(row, { data, isLoading: false, isPending: false, isFetched: true })
              })
              pending.add(promise)
              promise.finally(() => pending.delete(promise)).catch(() => {})
            }
          }
          return queryRows.get(key)
        }
        default: throw Error('Unknown fixture descriptor')
      }
    }
    const baseSet = scope.set.bind(scope)
    scope.set = (item, next) => item?.projectFixtureKind
      ? values.set(item, typeof next === 'function' ? next(scope.get(item)) : next)
      : baseSet(item, next)
    scope.query = new Proxy({}, { get: (_, key) => deny('query mutation ' + String(key)) })
    const cache = (id, exports) => { registry.c[id] = { exports } }
    const persist = new Map()
    const stored = (key, fallback) => {
      if (!persist.has(key)) persist.set(key, constant(Object.hasOwn(currentState, key) ? currentState[key] : fallback))
      return persist.get(key)
    }
    // Every schema input here is the sanitized, Rust-validated fixture. The
    // schemas are not under test; native normalization still executes.
    const schema = new Proxy({}, { get: (_, key) => {
      if (key === 'safeParse') return value => ({ success: value != null, data: value })
      if (key === 'parse') return value => value
      return () => schema
    } })
    cache('ASxG', new Proxy({}, { get: () => () => schema }))
    cache('zTeN', primitive)
    cache('q77y', { P: value => Promise.resolve(value) })
    cache('rbzn', { jG: { batch: callback => callback() } })
    cache('vLsY', { G: deny('query invalidation') })
    cache('M8aW', { IF: (name, args) => [name, args] })
    cache('Nwp9', { m3: stored, Kn: () => constant(undefined), Ay: constant([]) })
    cache('kpIY', { TB: (key, fallback) => currentState[key] ?? fallback, jx: deny('persisted atom write') })
    cache('zKw6', path)
    cache('NntY', { nv: () => null })
    cache('fqor', { N: value => value })
    cache('qFmb', {})
    // 26.1111 delegates final project keys to this real shared factory.
    if (!splitHelpers) cache('hu8h', {})
    cache('nZMd', Object.fromEntries)
    cache('HFi9', (items, key) => items.reduce((groups, item) => { (groups[key(item)] ??= []).push(item); return groups }, {}))
    cache('nuXe', items => [...new Set(items)])
    cache('i5ac', (items, key) => [...new Map(items.map(item => [key(item), item])).values()])
    cache('kfGJ', { fI: 'local' })
    cache('rP0s', { f: descriptor('parameterized', () => ({ kind: 'local' })) })
    cache('D7Ms', { rX: undefined })
    cache('xS4d', { EP: constant([]), K: constant([]), Zr: constant([]) })
    cache('ywWc', { N8: args => ['execution-paths', args], Kd: async () => ({ codexHome: '/synthetic-home/.codex' }) })
    cache('kX0Q', { tQ: ['projectless-root'], k$: async () => ({ workspaceRoot: '/synthetic-projectless' }) })
    cache('tl5a', { Dc: constant('local'), Dj: constant(['local']), y2: descriptor('parameterized', () => 'connected') })
    cache('rljs', { EX: descriptor('parameterized', () => true) })
    cache('B81s', { I2: descriptor('parameterized', () => ({ data: { config: {} }, isLoading: false })) })
    cache('kx7U', { oX: constant(new Set()), kj: constant(false) })
    cache('nPCK', { j: descriptor('parameterized', () => ({ data: { available: false } })) })
    cache('koMX', { gitOriginsQuery$: descriptor('parameterized', () => ({ data: { origins: [] }, isLoading: false })) })
    cache('mNN5', { Gs: ({ paths }) => ({ queryKey: ['paths-exist', paths], queryFn: async () => ({ existingPaths: paths }) }) })
    cache('ay73', { yQ: constant({ data: { threadIds: [] } }) })
    cache('aDVs', { U: deny('project order write') })
    cache('j9xU', { Hn: constant(false) })
    cache('HFSu', { CodexRequest: { safeGet: url => { observed.remoteRequests.push(url); throw Error('Cloud request in local fixture') } } })
    cache('GDNt', { fk: Error })
    cache('AzNg', { Rn: () => new Map(), xX: () => false, UT: () => null })
    cache('p6wS', { z: () => null })
    cache('WFY2', { v: { warning: deny('unexpected native warning') } })
    cache('f3xH', { k: deny('pending-worktree assignment') })
    cache('Pv8s', { GT: deny('thread page materialization'), nG: deny('thread page materialization'), R3: deny('thread page materialization') })
    cache('bs6a', { u: id => 'pending-assignment:' + id })
    cache('V7mA', {})
    cache('wTVm', {})
    cache('ReGc', { a: constant({ isPending: false }) })
    cache('XRI6', { ec: constant(null) })
    cache('p6VP', { g: constant({ threadIds: [] }) })
    cache('bLNn', { NK: () => [], kf: (previous, current) => current, xo: () => [], JL: () => [], mY: () => [] })
    cache('EDyN', { we: constant('updated_at'), ic: ({ pinnedThreadKeys }) => pinnedThreadKeys })
    cache('d6Ff', { OC: key => key.replace(/^local:/, ''), PK: key => key.replace(/^local:/, ''), Pc: key => ({ kind: 'local', threadId: key.replace(/^local:/, '') }) })
    cache('jcQS', { s: access => access.status === 'allowed' })
    cache('mq1u', { s: 'updated_at' })
    cache('E8Sp', {})
    cache('TjTj', {})
    cache('nlNF', { x2: constant({ pathname: '/' }) })
    cache('B3N0', { P: descriptor('parameterized', () => ({ routeKind: 'home' })) })
    cache('Oj9r', { VJ: ({ pathname }) => pathname })
    cache('V3rO', { nu: () => {} })
    cache('jFzS', { pp: constant([]), sO: constant(false), fM: constant({ sections: [] }) })
    const entries = () => currentThreads.map((thread, index) => ({
      kind: 'local', key: 'local:' + thread.id, threadId: thread.id, conversationId: thread.id,
      hostId: 'local', cwd: '/unrelated-synthetic-cwd', workspaceKind: 'project', isPinned: false,
      summary: { hostId: 'local', conversationId: thread.id, cwd: '/unrelated-synthetic-cwd', workspaceKind: 'project' },
      recency: index,
    }))
    const entryMap = () => new Map(entries().map(entry => [entry.key, entry]))
    const keys = () => entries().map(entry => entry.key)
    cache('r6TF', {
      Kj: constant([]), Tv: descriptor('computed', keys), Ei: constant(undefined),
      r4: (get, selected) => selected.map(key => entryMap().get(key)),
      Kr: (get, key) => entryMap().get(key)?.recency ?? 0,
      q$: (get, id) => id, oB: (get, key) => entryMap().get(key),
      ZI: (get, selected) => selected.map(key => entryMap().get(key)), dt: () => false,
      kt: (get, key, attention) => attention,
    })
    cache('N42N', {
      bd: descriptor('computed', () => ({ pinnedThreadKeys: [], allSidebarThreadKeys: keys(), unpinnedThreadKeys: keys() })),
      R: (get, selected) => selected.map(key => entryMap().get(key)),
      xn: (get, selected) => selected.map(key => ({ task: entryMap().get(key), isPinned: false })),
    })
    cache('nOQb', {
      uH: (selected, items) => selected.flatMap(key => items.has(key) ? [items.get(key)] : []),
      Oy: (selected, items) => selected.flatMap(key => items.has(key) ? [items.get(key).task] : []),
    })
    cache('SPnB', { chatGptAuthenticatedAccountId$: descriptor('computed', () => scope.get(base.descriptors.realAuth).authenticatedAccountId), chatGptAuthenticatedUserId$: descriptor('computed', () => scope.get(base.descriptors.realAuth).authenticatedAccountId ? 'synthetic-user' : null) })
    cache('a8ri', { l: constant(true) })
    // Final sidebar adapters: no ChatGPT projects, pending drag/drop, unread
    // filtering, pinned tabs or remote sources are present in this local fixture.
    cache('ChYf', { G: descriptor('parameterized', () => ({ isCapable: false, isLoading: false })) })
    cache('UlKW', { Hy: 'synthetic-excluded-source' })
    cache('Dd72', { $: () => false })
    cache('Lzlp', { cH: constant([]), Ft: ({ threadKeys }) => threadKeys })
    cache('B1od', { Bf: () => constant(null) })
    cache('e1xH', { pagesEnabled$: constant(false) })
    cache('eJrd', { z: constant(false) })
    cache('Og9d', { t6: constant([]), YT: constant([]), lI: constant([]) })
    cache('VNGl', { Hx: () => 'idle' })
    cache('H5Jz', { Rk: constant([]) })
    for (const id of ['owEK', 'Vr32', 'AXK1', 'nZBp', 'VrzK', 'OOaz']) cache(id, {})
    cache('cuMn', { Z_: constant([]) })
    cache('Yf5O', { Cg: constant([]) })
    cache('pyoT', { visiblePinnedSpaceItemKeys$: constant([]) })
    if (splitHelpers) {
      // Native memoization and pending-membership transforms run as shipped.
      // Their cache and equality boundaries only receive the synthetic data.
      cache('jWwv', Map)
      cache('SZCv', isDeepStrictEqual)
      cache('Noom', { visiblePinnedSpaceItemKeys$: constant([]) })
      // s6B0 imports the new-task computer preference only for initialization;
      // selectors under test must not read or change this separate preference.
      cache('OM3m', new Proxy({}, { get: (_, key) => deny('computer preference ' + String(key))() }))
    }

    registry.n = value => () => value
    registry.j = 348410
    for (const [id, record] of records) registry.m[id] = vm.runInThisContext('({' + record.source + '})')[id]
    const globalKeys = registry('HI9o')
    const membershipTools = registry('CiYY')
    const orderTools = registry('I3ol')
    const projectTools = registry('ZRtB')
    const hosts = registry('N2rm')
    const paths = registry('EIJx')
    const worktrees = registry('yJ6f')
    cache('DBCl', {
      ...registry.c.DBCl.exports, Q2Y: globalKeys.Q2, yDt: globalKeys.yD,
      DZs: membershipTools.DZ, Ko0: orderTools.Ko, ycq: projectTools.yc, PuL: projectTools.Pu,
      ZJQ: hosts.ZJ, iwv: hosts.iw, qPI: paths.qP, n9x: worktrees.n9, YHz: worktrees.YH,
      yIh: { safeParse: () => ({ success: false }) }, m20: '~', JXB: value => value,
      aiU: { THREAD_SORT_KEY: 'thread-sort-key' },
    })
    const services = registry.c.GaA7.exports.appServices
    Object.assign(services, {
      executionPaths: { read: async () => ({ codexHome: '/synthetic-home/.codex' }) },
      workspaceRoots: { read: async () => {
        observed.reads.push('workspaceRoots.read')
        return { roots: Object.values(currentCatalog).flatMap(project => project.rootPaths), labels: {}, canonicalPathByRoot: {} }
      }, cancel: async () => {} },
      projectCatalog: {
        readLocalProjects: async () => { observed.reads.push('projectCatalog.readLocalProjects'); return structuredClone(currentCatalog) },
        readRemoteProjects: async () => [],
        readSelection: async () => null,
      },
      threadProjectAssignments: { readMemberships: async () => { observed.reads.push('threadProjectAssignments.readMemberships'); return structuredClone(currentMemberships) } },
      applicationState: {
        read: async key => { observed.reads.push('applicationState.read:' + key); return { value: currentState[key] } },
        write: (...args) => { observed.writes.push(args); throw Error('Unexpected native state write') },
      },
    })
    const groupsDescriptor = registry('DZgh').sS
    const sidebarMode = registry('pasN').l
    const sidebarDescriptor = registry('sHm2').v
    const emptyChatGptSource = { pinnedTargets: [], projects: [], pinnedProjects: [], chatTargets: [] }
    const access = registry('eFn4')
    async function settle(read) {
      for (let round = 0; round < 30; round++) {
        const result = read()
        if (pending.size === 0) return result
        await Promise.all([...pending])
      }
      throw Error('Native selector queries failed to settle')
    }
    return {
      base, scope, observed, registry, records, access,
      setIdentity(next) { base.setIdentity(next) },
      setData({ catalog: nextCatalog, memberships: nextMemberships, threads: nextThreads }) {
        if (nextCatalog) currentCatalog = structuredClone(nextCatalog)
        if (nextMemberships) currentMemberships = structuredClone(nextMemberships)
        if (nextThreads) currentThreads = structuredClone(nextThreads)
        queryRows.clear()
      },
      readGroups: () => settle(() => scope.get(groupsDescriptor, 'codex')),
      readSidebar: () => settle(() => scope.get(sidebarDescriptor, { sidebarMode: scope.get(sidebarMode) === 'codex' ? 'codex' : 'chatgpt', chatGptSource: emptyChatGptSource })),
      readMode: () => scope.get(sidebarMode),
      readLocalAccess: () => scope.get(access.VJ),
      readCloudAccess: () => scope.get(access.xI),
      readIdentity: () => scope.get(base.descriptors.realAuth),
    }
  }
  return { createHarness, records, packageVersion: apiFixture.packageVersion }
}
module.exports = { nativeProjectsFixture, selectProjectFactoryCopy }
