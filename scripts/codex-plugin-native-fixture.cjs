const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const ts = require('typescript');

// Extract only reviewed, side-effect-free module factories. Never import an
// application entrypoint or contact Electron, a user profile, or an RPC server.
function nativePluginFixture(packagePath) {
  const wanted = new Set(['OWtl', 'l00C', 'E8Sp', 'Dgwo', 'Buqh', 'zTeN', 'HkKI', 'ouEa', 'GNwQ', 'VgPM', 'okCa', 'w0gB', 'SlNh', 'D4ZO', 'ueue']);
  const candidates = new Map(), found = new Map();
  const names = asar.listPackage(packagePath).map(name => name.replace(/^[\\/]/, ''));
  for (const name of names) {
    if (!/webview[\\/]assets[\\/].*\.js$/.test(name)) continue;
    const source = asar.extractFile(packagePath, name).toString('utf8');
    for (const id of wanted) if (source.includes(id + '(')
        && (!candidates.has(id) || source.length < candidates.get(id).source.length)) candidates.set(id, { name, source });
  }
  for (const { name, source } of new Map([...candidates.values()].map(value => [value.name, value])).values()) {
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      if (ts.isMethodDeclaration(node) && wanted.has(node.name.getText(tree))) {
        found.set(node.name.getText(tree), { source: node.getText(tree), node, tree, name });
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  for (const id of wanted) assert.ok(found.has(id), 'Reviewed native module is missing: ' + id);
  const core = found.get('zTeN');
  let scopeFunction, nodeFunction;
  function findScope(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'eu') scopeFunction = node.getText(core.tree);
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'et') nodeFunction = node.getText(core.tree);
    ts.forEachChild(node, findScope);
  }
  findScope(core.node);
  assert.match(scopeFunction, /scope:e,value:i/);
  assert.match(scopeFunction, /r\.current=o/);
  assert.match(nodeFunction, /store:e\?\.store\?\?\(0,s\.y\$\)\(\)/);
  const signalCore = found.get('GNwQ'), signalFunctions = {};
  for (const statement of signalCore.node.body.statements) {
    if (ts.isFunctionDeclaration(statement) && ['p', 'F', 'd', 'c'].includes(statement.name?.text)) signalFunctions[statement.name.text] = statement.getText(signalCore.tree);
  }
  assert.match(signalFunctions.p, /e\.store\.sub\(t,\(\)=>\{\}\)/);
  assert.match(signalFunctions.F, /l\.onMount=/);
  assert.match(found.get('w0gB').source, /bV:_/);
  assert.match(found.get('w0gB').source, /_\=\(0,a\.A4\)/);
  assert.match(found.get('w0gB').source, /read:\(\)=>I,subscribe:e=>\(y\.add\(e\),e\(I\),N\(\)/);
  assert.match(found.get('HkKI').source, /h7:function\(e\)\{let t=D\.get\(e\),n=t\[24\];return n\?n\(t,e\):t\}/);
  assert.match(found.get('ouEa').source, /function c\(\)\{return i\?i\(\):\(0,o\._b\)\(\)\}/);
  assert.match(found.get('VgPM').source, /id:"plugins-store-page-search"/);
  assert.match(found.get('okCa').source, /jsx\)\("input",.*id:E/);
  assert.match(found.get('D4ZO').source, /marketplaceName:l\.name,marketplacePath:l\.path/);
  assert.match(found.get('SlNh').source, /"\/\.agents\/plugins\/marketplace\.json"/);
  assert.match(found.get('SlNh').source, /"\/marketplace\.json"/);
  assert.match(found.get('SlNh').source, /subLabelSource:null==[a-z]\.marketplacePath/);
  const catalogSource = found.get('ueue').source;
  assert.ok(catalogSource.includes('let e=`${n.name}\\0${n.path??""}`'));
  assert.match(catalogSource, /name:n\.name,path:n\.path,pluginCount:n\.plugins\.length/);

  const query = found.get('Buqh');
  let queryFunction;
  function findQuery(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(query.tree) === 'queryFn') queryFunction = node.initializer.getText(query.tree);
    ts.forEachChild(node, findQuery);
  }
  findQuery(query.node);
  assert.match(queryFunction, /sendRequest\("plugin\/list"/);
  assert.match(queryFunction, /marketplaceKinds:\["local"\]/);
  assert.doesNotMatch(queryFunction, /list-plugins/);
  const html = asar.extractFile(packagePath, 'webview\\index.html').toString();
  const entryPaths = [...html.matchAll(/<script type="module" src="([^\"]+)"/g)].map(match => match[1]);
  const appEntry = entryPaths.find(path => asar.extractFile(packagePath, 'webview\\' + path.replace(/^\//, '').replaceAll('/', '\\')).toString().includes('as __webpack_require__'));
  assert.ok(appEntry, 'An already-loaded entry must export the webpack require cache');
  const anchors = { appEntry, queryMethod: 'plugin/list', queryKind: 'local', moduleFactories: [...found.keys()] };
  let nextId = 1;
  function signal(scope, initial, family = false) {
    const descriptor = { scope, key: nextId++, initial, family,
      resolve(node, chain, arg) {
        const key = family ? descriptor.key + ':' + arg : descriptor.key;
        if (!node.values.has(key)) node.values.set(key, typeof initial === 'function' ? initial(arg, { get: () => null }) : initial);
        return node.values.get(key);
      } };
    return descriptor;
  }
  const nativeSignals = {
    vP: (scope, initial) => signal(scope, initial),
    bD: (scope, initial) => signal(scope, initial, true),
    i1: (scope, initial) => signal(scope, initial, true),
  };
  const factories = {};
  for (const id of ['OWtl', 'l00C', 'E8Sp', 'Dgwo', 'HkKI', 'ouEa']) factories[id] = new Function('return ({' + found.get(id).source + '})')()[id];
  const cache = {};
  const stubs = {
    Hl6a: { z8: name => ({ __scopeBrand: name, id: Symbol(name) }) },
    zTeN: nativeSignals,
    rljs: { y2: {} }, CfsC: { D: {} }, SRbQ: { hk: () => {} },
    Fkn8: { AX: () => { throw Error('Deferred RPC creation is forbidden'); } },
    DBCl: { udX: () => { throw Error('Deferred RPC creation is forbidden'); } },
  };
  function requireNative(id) {
    if (stubs[id]) return stubs[id];
    if (cache[id]) return cache[id].exports;
    if (!factories[id]) throw Error('Unreviewed module execution: ' + id);
    const target = { exports: {} }; cache[id] = target;
    factories[id](target, target.exports, requireNative);
    return target.exports;
  }
  requireNative.d = (target, getters, constants) => {
    for (const [key, getter] of Object.entries(getters || {})) Object.defineProperty(target, key, { get: getter, enumerable: true });
    for (const [key, value] of Object.entries(constants || {})) Object.defineProperty(target, key, { value, enumerable: true });
  };
  requireNative.c = cache; requireNative.m = factories;
  for (const id of Object.keys(factories)) requireNative(id);
  const appScope = cache.OWtl.exports.u;
  const nativeAtoms = cache.ouEa.exports, nativeStores = cache.HkKI.exports;
  const constructNode = new Function('s', 'q', 'return (' + nodeFunction + ')')(nativeAtoms, { ue: class {} });
  const node = constructNode({ scope: appScope }); node.values = new Map();
  const chain = node, accessCounters = { get: 0, sub: 0, authSubscribe: 0 };
  const nativeGet = node.store.get, nativeSub = node.store.sub;
  node.store.get = (...args) => { accessCounters.get++; return nativeGet(...args); };
  node.store.sub = (...args) => { accessCounters.sub++; return nativeSub(...args); };
  const rawTuple = nativeStores.h7(node.store);
  assert.equal(rawTuple[24], undefined, 'Native AppScope creates a store with no inspection hook');
  let accountValue = Object.freeze({});
  const nativeAtom = nativeAtoms.eU(accountValue);
  nativeAtom.onMount = () => { accessCounters.authSubscribe++; };
  let unmount = nativeSub(nativeAtom, () => {});
  const accountSignal = {};
  cache.w0gB = { exports: { bV: accountSignal } };
  node.familyBindings.set(accountSignal, new Map([['local', { value: { atom: nativeAtom, store: node.store } }]]));
  node.imperativeReadAtoms.add(nativeAtom);
  // Execute the installed GNwQ imperative reader, not a rewritten approximation.
  // Its temporary subscription is intentionally observable only in this fixture.
  const imperativeRead = new Function('o', 'l', 'return (' + signalFunctions.p + ')')({ n: { withCurrentRead: fn => fn(), getCurrentAtomValue: (_atom, value) => value } }, new WeakMap());
  function setAccount(value) { accountValue = value; node.store.set(nativeAtom, value); }
  function unmountAccount() { unmount?.(); unmount = null; }
  function restoreAccount() { if (!unmount) unmount = nativeSub(nativeAtom, () => {}); }
  function unsafeImperativeRead() { return imperativeRead(node, nativeAtom); }
  function resetAccessCounters() { for (const key of Object.keys(accessCounters)) accessCounters[key] = 0; }
  resetAccessCounters();
  let ref = { current: null };
  const X = { useContext: () => chain, useRef: () => ref };
  const S = { iP: value => value, Q0: () => undefined, mX: () => false, nL: () => false,
    NX: (_node, value) => value, JB: () => false, xm: () => ({}), EK: () => undefined };
  const makeScope = new Function('X', 'S', 'W', 'j', 'return (' + scopeFunction + ')')(X, S, () => ({}), () => { throw Error('watch is forbidden in read-only fixture'); });
  const scope = makeScope(appScope);
  function setSignal(descriptor, value, argument) {
    node.values.set(descriptor.family ? descriptor.key + ':' + argument : descriptor.key, value);
  }
  function setConnection(value) { setSignal(cache.l00C.exports.M4, value, 'local'); }
  function setNavigation(value) { setSignal(cache.E8Sp.exports.gM, value); }
  async function queryLocal(roots = []) {
    const transforms = { VB: value => value, z0: markets => markets.flatMap(market => market.plugins), RR: async value => value.plugins };
    const run = new Function('i', 't', 'e', 'w', 'n', 's', 'g', 'return (' + queryFunction + ')')(
      cache.Dgwo.exports, scope, 'local', roots, {}, transforms, { w: signal => signal });
    return run({ signal: new AbortController().signal });
  }
  return { module: { __webpack_require__: requireNative }, scope, appScope, node, setConnection, setNavigation, queryLocal, anchors, setAccount, unmountAccount, restoreAccount, unsafeImperativeRead, resetAccessCounters, accessCounters, nativeAtom, accountSignal, rawTuple };
}
module.exports = { nativePluginFixture };
