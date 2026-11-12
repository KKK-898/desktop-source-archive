// Codex's reserve quota gate belongs to the official provider. Keep the
// original account data and raw usage snapshots intact. Release the gate when the helper
// confirms the live configuration routes through the active Gaoge relay.
//
// The native quota family reads the signed-in ChatGPT plan, not the route the
// request actually takes. Codex dispatches by config.toml's model_provider, so
// a composer signed in with an exhausted account still sends through Gaoge.
//
// v10 adds the account-backed composer kind to the release path. That kind
// exists only while 已有账号登录 is active, and it was absent from both the
// resolver filter and the context classifier, so an exhausted account kept the
// native blocked value even with the relay configured. Every other rule is
// unchanged: cloud and unrecognized composers, non-local hosts, ambiguous or
// remote new-task targets, and a live configuration that does not match the
// active relay all keep the official gate.
// v11 protects edit/interrupt/send ordering and restores explicitly missing
// local threads once, without retrying uncertain or already accepted turns.
// v15 adds an explicit relay-global mode. When the bridge has confirmed that
// the local request path is the relay, the native submit gate is released from
// its account quota without depending on composer/context discovery.
// v17 reports live adapter integrity and repairs replaced usage publishers.
// v18 discovers root query providers and starts cache monitoring independently
// of optional native modules. Brief helper outages retain the confirmed route.
var CODEX_FUEL_RUNTIME_VERSION = 19;
var CODEX_FUEL_STATUS_GRACE_MS = 60000;
var CODEX_FUEL_NATIVE_LOAD_TIMEOUT_MS = 3000;
var CODEX_FUEL_NATIVE_RETRY_MS = 15000;

function codexFuelUnique(source, expression, label) {
  const matches = Array.from(source.matchAll(expression));
  if (matches.length !== 1) throw new Error(`Unsupported Codex ${label} signature`);
  return matches[0];
}

function codexFuelExportName(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = codexFuelUnique(source.slice(source.lastIndexOf("export{")),
    new RegExp(`(?:[,{])${escaped} as ([\\w$]+)(?=[,}])`, "g"), "export");
  return match[1];
}

function codexFuelExport(source, module, name) {
  const value = module[codexFuelExportName(source, name)];
  if (value == null) throw new Error("Codex quota dependencies are not initialized");
  return value;
}

function codexFuelImportedBinding(source, dependencies, localName) {
  const imports = [];
  for (const match of source.matchAll(/import\{([^}]+)\}from["']\.\/([^"']+\.js)["']/g)) {
    for (const entry of match[1].split(",")) {
      const [exported, alias] = entry.trim().split(/\s+as\s+/);
      if ((alias || exported) === localName) imports.push({ asset: match[2], exported });
    }
  }
  if (imports.length !== 1) throw new Error("Unsupported Codex imported dependency signature");
  const dependency = Object.entries(dependencies || {})
    .find(([prefix]) => imports[0].asset.startsWith(prefix))?.[1];
  const value = dependency?.[imports[0].exported];
  if (value == null) throw new Error("Codex imported dependencies are not initialized");
  return value;
}

function codexFuelExportOrImport(source, module, dependencies, name) {
  try { return codexFuelExport(source, module, name); }
  catch (exportError) {
    try { return codexFuelImportedBinding(source, dependencies, name); }
    catch (_) { throw exportError; }
  }
}

function codexFuelModernThreadHost(source) {
  const matches = Array.from(source.matchAll(
    /([\w$]+)=([\w$]+)\(([\w$]+),\(([\w$]+),\{get:([\w$]+)\}\)=>\{([^{}]{1,1400})\}\)/g,
  )).filter(match => match[6].includes(".has(`local`)")
    && match[6].includes(".getHostId()") && match[6].includes("??`local`"));
  if (matches.length !== 1) throw new Error("Unsupported Codex thread host signature");
  return matches[0];
}

function codexFuelWritableSignalName(source, rootName) {
  try {
    return codexFuelUnique(source,
      /function ([\w$]+)\(e,t,n\)\{let r=([\w$]+)\(`signal`,e,\(r,i\)=>/g,
      "writable signal")[1];
  } catch (_) {
    const root = rootName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const candidates = new Set(Array.from(source.matchAll(
      new RegExp(`[\\w$]+=([\\w$]+)\\(${root},(?:0|null|!0|!1|\\[\\]|\\{\\})\\)`, "g"),
    )).map(match => match[1]));
    if (candidates.size !== 1) throw new Error("Unsupported Codex writable signal signature");
    return candidates.values().next().value;
  }
}

function codexFuelSourceRecords(source, module, dependencies) {
  const records = [{ source, module }];
  for (const [prefix, text] of Object.entries(dependencies?.__sources || {})) {
    if (typeof text === "string" && dependencies[prefix]) records.push({ source: text, module: dependencies[prefix] });
  }
  return records;
}

function codexFuelRecordMatch(records, expression, label) {
  const matches = records.flatMap(record => Array.from(record.source.matchAll(expression), match => ({ ...record, match })));
  if (matches.length !== 1) throw new Error(`Unsupported Codex ${label} signature`);
  return matches[0];
}

function codexFuelDerivedFactory(records, dependencies) {
  // The shared framework's public derived factory delegates to the cached
  // descriptor builder. This survives moving composer selectors between files.
  const factories = [];
  for (const record of records) {
    for (const match of record.source.matchAll(/function ([\w$]+)\(e,t,n\)\{return ([\w$]+)\(e,t,void 0,n\)\}/g)) {
      const start = record.source.indexOf(`function ${match[2]}(`);
      if (start < 0) continue;
      const next = record.source.indexOf("function ", start + 9);
      const body = record.source.slice(start, next < 0 ? start + 4000 : next);
      if (body.includes("createSubscriberAtom:") && body.includes("`derived`")) {
        factories.push(codexFuelExportOrImport(record.source, record.module, dependencies, match[1]));
      }
    }
  }
  if (new Set(factories).size === 1) return factories[0];
  if (factories.length) throw new Error("Unsupported Codex derived factory signature");
  // Earlier builds expose only the factory import here. Resolve the factory
  // shared by cloud/project readers without depending on either reader's body.
  const candidates = new Set();
  for (const record of records) {
    const names = new Set(Array.from(record.source.matchAll(
      /[\w$]+=([\w$]+)\([\w$]+,\(\{get:[\w$]+,scope:[\w$]+\}\)=>/g,
    ), match => match[1]));
    for (const name of names) {
      try { candidates.add(codexFuelExportOrImport(record.source, record.module, dependencies, name)); } catch (_) {}
    }
  }
  if (candidates.size !== 1) throw new Error("Unsupported Codex derived factory signature");
  return candidates.values().next().value;
}

function discoverCodexFuelQuotaBindings(source, module, dependencies = {}) {
  // Capture names from semantic signatures, never assume minified export
  // names remain stable across Codex updates. Ambiguity leaves native gates on.
  const hard = codexFuelUnique(source,
    /([\w$]+)=([\w$]+)\(([\w$]+),\(([\w$]+),\{get:([\w$]+)\}\)=>\5\(([\w$]+),\4\)\.hardBlocked\)/g,
    "hard-block family");
  const active = codexFuelUnique(source,
    /([\w$]+)=([\w$]+)\(([\w$]+),\(([\w$]+),\{get:([\w$]+)\}\)=>\5\(([\w$]+),\4\)\.active\)/g,
    "reserve family");
  if (active[6] !== hard[6] || active[3] !== hard[3]
      || !source.includes("hardBlocked:") || !source.includes("luna_reserve")) {
    throw new Error("Unsupported Codex reserve quota gate");
  }
  const records = codexFuelSourceRecords(source, module, dependencies);
  const signalName = codexFuelWritableSignalName(source, hard[3]);
  const bindings = {
    hardBlockedExport: codexFuelExportName(source, hard[1]),
    hardBlocked: codexFuelExport(source, module, hard[1]),
    reserveActive: codexFuelExport(source, module, active[1]),
    createDerived: codexFuelDerivedFactory(records, dependencies),
    createSignal: codexFuelExportOrImport(source, module, dependencies, signalName),
  };
  if (typeof bindings.createDerived !== "function" || typeof bindings.createSignal !== "function") {
    throw new Error("Unsupported Codex signal factories");
  }
  return bindings;
}

function discoverCodexFuelConfigBinding(source, module, dependencies = {}) {
  const record = codexFuelRecordMatch(codexFuelSourceRecords(source, module, dependencies),
    /([\w$]+)=([\w$]+)\(([\w$]+),\(\{cwd:([\w$]+)=null,hostId:([\w$]+)\},\{get:([\w$]+),queryClient:([\w$]+),scope:([\w$]+)\}\)=>/g,
    "effective configuration");
  return codexFuelExport(record.source, record.module, record.match[1]);
}

function discoverCodexFuelBindings(source, module, dependencies = {}) {
  const bindings = discoverCodexFuelQuotaBindings(source, module, dependencies);
  const records = codexFuelSourceRecords(source, module, dependencies);
  const provider = codexFuelRecordMatch(records,
    /([\w$]+)=([\w$]+)\(\(\{modelProvider:([\w$]+)\}\)=>\3\?\?null\)/g, "thread provider");
  const cwd = codexFuelRecordMatch(records,
    /([\w$]+)=([\w$]+)\(\(\{cwd:([\w$]+)\}\)=>\3\?\?null\)/g, "thread directory");
  let host;
  try {
    host = codexFuelRecordMatch(records,
      /([\w$]+)=([\w$]+)\(\(\{hostId:([\w$]+)\}\)=>\3\?\?null\)/g, "thread host");
  } catch (_) {
    const matches = [];
    for (const record of records) {
      try { matches.push({ ...record, match: codexFuelModernThreadHost(record.source) }); } catch (_) {}
    }
    if (matches.length !== 1) throw new Error("Unsupported Codex thread host signature");
    host = matches[0];
  }
  bindings.config = discoverCodexFuelConfigBinding(source, module, dependencies);
  for (const [key, record] of Object.entries({ threadProvider: provider, threadCwd: cwd, threadHost: host })) {
    bindings[key] = codexFuelExport(record.source, record.module, record.match[1]);
  }
  // Existing local conversations do not use the new-task selectors. Their
  // unrelated layout/feature changes must not discard a working local route.
  try {
  // Newer clients add a local cloud-prototype branch before the existing
  // cloud-mode selector. Require that exact branch and the same get/scope.
  const cloud = codexFuelRecordMatch(records,
    /([\w$]+)=([\w$]+)\(([\w$]+),\(\{get:([\w$]+),scope:([\w$]+)\}\)=>\4\([\w$]+\)\?(?:\5\.value\.kind===`local`&&\5\.value\.cloudThreadPrototype\?\4\([\w$]+\):)?(?:\4\([\w$]+\)\?)*\4\([\w$]+\)&&\4\([\w$]+\)\?\.kind===`cloud`:/g,
    "cloud execution selection");
  const project = codexFuelRecordMatch(records,
    /([\w$]+)=([\w$]+)\(([\w$]+),\(\{get:([\w$]+),scope:([\w$]+)\}\)=>\{(?:(?!\}\),)[\s\S]){0,900}?if\(\4\([\w$]+\)&&\5\.value\.routeKind===`home`\)return null;if\(\(\5\.value\.routeKind===`home`\|\|\5\.value\.routeKind===`local-thread`\)/g,
    "selected project");
  for (const [key, record] of Object.entries({ cloudSelection: cloud, selectedProject: project })) {
    bindings[key] = codexFuelExport(record.source, record.module, record.match[1]);
  }
  } catch (error) {
    bindings.newTargetSelectorsUnavailable = true;
    bindings.selectionDiscoveryError = String(error?.message || "new-task selectors unavailable");
  }
  return bindings;
}

function verifyCodexFuelComposer(source, hardBlockedExport) {
  const imported = codexFuelUnique(source,
    /import\{([^}]+)\}from["']\.\/app-initial-[^"']+\.js["']/g, "composer import");
  const names = imported[1].split(",").map(value => value.trim().split(/\s+as\s+/))
    .filter(([name]) => name === hardBlockedExport);
  if (names.length !== 1 || !/^[\w$]+$/.test(names[0][1] || "")) {
    throw new Error("Unsupported Codex composer quota import");
  }
  const importedName = names[0][1].replace(/\$/g, "\\$");
  const read = codexFuelUnique(source,
    new RegExp(`([\\w$]+)=([\\w$]+)\\(${importedName},([\\w$]+)\\)`, "g"), "composer quota read");
  // Follow the positive OR dependency rather than requiring every other
  // blocker to be a bare variable. Newer clients also combine readiness
  // comparisons and optional loading properties in the same expression.
  const body = source.slice(read.index, Math.min(read.index + 120000, source.length));
  const gate = read[1];
  const combined = Array.from(body.matchAll(/([\w$]+)=([\w$?.!&|=()\s\[\]]{1,1200})(?=[,;])/g))
    .filter(match => match[2].split("||").some(term => term.trim().replace(/^\(+|\)+$/g, "") === gate)
      && match[2].includes("||"));
  if (combined.length !== 1) throw new Error("Unsupported Codex composer disabled condition signature");
  const disabled = combined[0][1].replace(/\$/g, "\\$");
  if (!new RegExp(`submitDisabled\\s*:\\s*${disabled}(?=[,}])`).test(body)) {
    throw new Error("Unsupported Codex submit consumer");
  }
  return true;
}

function codexFuelNormalizedUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
        || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch (_) { return null; }
}

function codexFuelStateEnabled(state) {
  return state?.enabled === true && state.provider === "custom"
    && ["relay", "aggregate"].includes(state.mode)
    && codexFuelNormalizedUrl(state.baseUrl) != null;
}

function codexFuelContextNode(chain) {
  if (!(chain instanceof Map)) return null;
  const candidates = Array.from(chain.values()).filter(node =>
    node?.token && node?.value && ["local", "new", "cloud", "chatgpt"].includes(node.value.kind));
  // The deepest composer scope owns this read. Never infer execution from a
  // document URL, the visible tab, or another composer's state.
  return candidates.find(node => !candidates.some(other => {
    for (let parent = other.parent; parent; parent = parent.parent) if (parent === node) return true;
    return false;
  })) || null;
}

function codexFuelSameProject(left, right) {
  return (left?.projectId ?? null) === (right?.projectId ?? null)
    && (left?.type ?? null) === (right?.type ?? null);
}

function codexFuelNewTarget(get, scope, bindings) {
  if (bindings.newTargetSelectorsUnavailable) return null;
  if (bindings.cloudSelection && get(bindings.cloudSelection) !== false) return null;
  const selectedProject = bindings.selectedProject ? get(bindings.selectedProject) : null;
  if (selectedProject?.type === "remote") return null;
  const targets = [];
  const modes = [];
  for (const members of scope.node.familyBindings.values()) {
    if (!(members instanceof Map)) continue;
    for (const [key, descriptor] of members) {
      if (typeof key !== "string" || !descriptor?.value || key[0] !== "{") continue;
      let params;
      try { params = JSON.parse(key); } catch (_) { continue; }
      // These are the native composer's resolved execution target and mode.
      // Reading their signals tracks changes to project/worktree/cloud choice.
      if (Object.hasOwn(params, "existingWorkspaceRoot")
          && Object.keys(params).every(key => ["selectedProject", "homeRemoteProject", "existingWorkspaceRoot", "defaultCwd"].includes(key))
          && (!bindings.selectedProject || codexFuelSameProject(params.selectedProject, selectedProject))) {
        const target = get(descriptor.value);
        if (target?.target && Object.hasOwn(target, "projectKey")) targets.push(target);
      }
      if (Object.hasOwn(params, "availability") && Object.hasOwn(params, "projectKey")) {
        const mode = get(descriptor.value);
        if (mode && Object.hasOwn(mode, "effectiveMode") && Object.hasOwn(mode, "preferredMode")) {
          modes.push({ params, mode });
        }
      }
    }
  }
  if (targets.length !== 1) return null;
  const target = targets[0];
  const matches = modes.filter(({ params }) => params.projectKey === target.projectKey
    && (params.prefillKey ?? null) === (scope.value.focusComposerNonce ?? null));
  // Ambiguous retained selectors are safer to leave with the official gate.
  if (matches.length !== 1 || !["local", "worktree"].includes(matches[0].mode.effectiveMode)
      || target.target.hostId !== "local" || target.executionRemoteHostId != null || target.projectLoading !== false) return null;
  const cwd = matches[0].mode.effectiveMode === "worktree"
    ? target.target.cwd ?? target.resolvedCwd : target.resolvedCwd;
  return typeof cwd === "string" && cwd.trim() ? { cwd, provider: null } : null;
}

function codexFuelConfigMatchesRelay(config, state) {
  const provider = state?.provider;
  const entry = config?.model_providers?.[provider];
  return config?.model_provider === provider
    && typeof entry?.name === "string" && entry.name.toLowerCase() === "gaoge"
    && codexFuelNormalizedUrl(entry.base_url) === codexFuelNormalizedUrl(state.baseUrl);
}

function codexFuelCachedConfigUsesRelay(get, scope, cwd, state) {
  let found = false;
  // Native family keys are serialized arguments. Look up the two possible
  // property orders directly instead of walking thousands of unrelated keys.
  // A global scan budget used to reject busy clients before reaching this cwd.
  const keys = [JSON.stringify({ cwd, hostId: "local" }), JSON.stringify({ hostId: "local", cwd })];
  // Read only the native query descriptors for this exact host/directory.
  // get() retains native reactive subscriptions when its configuration changes.
  for (const node of scope.chain?.values?.() || [scope.node]) {
    for (const members of node?.familyBindings?.values?.() || []) {
      if (!(members instanceof Map)) continue;
      for (const key of keys) {
        const descriptor = members.get(key);
        if (!descriptor?.value) continue;
        const result = get(descriptor.value);
        if (result?.isError || result?.isLoading || result?.isPending) return false;
        // Other queries may share the same key. Only a configuration-shaped
        // result is proof of routing; pending/unknown results never grant it.
        if (!result?.data || !Object.hasOwn(result.data, "model_provider")) continue;
        if (!codexFuelConfigMatchesRelay(result.data, state)) return false;
        found = true;
      }
    }
  }
  return found;
}

function codexFuelFallbackContextUsesRelay(get, scope, bindings, state, note) {
  const value = scope.value;
  const accountKind = value.kind === "chatgpt";
  let target = null;
  let skipped = "";
  if ((value.kind === "local" || accountKind)
      && typeof value.conversationId === "string" && value.conversationId) {
    for (const manager of bindings.fallbackManagers || []) {
      if (manager.disposed || manager.hostId !== "local" || manager.requestClient?.hostId !== "local") {
        // A manager bound to another host cannot speak for this composer, but
        // its presence is still a reason no local workspace was found.
        skipped = "fallback-nonlocal-manager"; continue;
      }
      const thread = manager.getConversation(value.conversationId);
      if (!thread) { skipped ||= "fallback-thread-unknown"; continue; }
      if (thread.hostId !== "local") { note?.("fallback-nonlocal-thread"); return false; }
      if (accountKind) {
        // The account-backed kind reads the same workspace evidence, but an
        // unreadable or conflicting record defers to the helper rather than
        // re-locking the gate.
        if (typeof thread.cwd !== "string" || !thread.cwd.trim()) { skipped ||= "fallback-cwd-unreadable"; continue; }
        if (target && target.cwd !== thread.cwd) { skipped ||= "fallback-conflicting-cwd"; continue; }
        target = { cwd: thread.cwd };
        continue;
      }
      if (thread.modelProvider !== state.provider
          || typeof thread.cwd !== "string" || !thread.cwd.trim()) {
        note?.("fallback-provider-or-cwd-mismatch"); return false;
      }
      if (target && target.cwd !== thread.cwd) { note?.("fallback-conflicting-cwd"); return false; }
      target = { cwd: thread.cwd };
    }
  } else if (value.kind === "new") {
    target = codexFuelNewTarget(get, scope, bindings);
  }
  if (!target) {
    // Which kind of absence this is matters: the account-backed kind is the one
    // 已有账号登录 reaches when nothing readable is on disk, and it releases.
    note?.(accountKind ? (skipped || "fallback-account-workspace-unknown") : "fallback-target-unknown");
    return accountKind ? "deferred" : false;
  }
  // Retain a recognized config family even if a separate selector or the
  // composer source changed. The native query loads this exact cwd when its
  // cache is cold and subscribes the quota gate to completion/config changes.
  const routes = bindings.config
    ? codexFuelReadConfigUsesRelay(get, scope, bindings, target.cwd, state)
    : codexFuelCachedConfigUsesRelay(get, scope, target.cwd, state);
  note?.(routes ? "fallback-relay-confirmed" : "fallback-config-not-relay");
  return routes;
}

function codexFuelConfigResultUsesRelay(result, state) {
  return !!result && !result.isError && !result.isPending && !result.isLoading
    && codexFuelConfigMatchesRelay(result.data, state);
}

function codexFuelReadConfigUsesRelay(get, scope, bindings, cwd, state) {
  const result = get(bindings.config, { hostId: "local", cwd }, { enabled: true });
  if (!result || result.isPending || result.isLoading || result.isError) {
    bindings.requestConfig?.(scope, cwd, state);
  }
  return codexFuelConfigResultUsesRelay(result, state);
}

function codexFuelInspectManagers(fiber, managers) {
  const seen = new Set();
  const inspect = (value, depth = 0) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return;
    seen.add(value);
    if (Array.isArray(value)) { value.slice(0, 8).forEach(item => inspect(item, depth + 1)); return; }
    if (typeof value.getConversation === "function" && value.requestClient
        && value.hostId === "local" && value.requestClient.hostId === "local" && !value.disposed) managers.add(value);
    for (const key of ["manager", "value", "props", "children", "current"]) {
      inspect(Object.getOwnPropertyDescriptor(value, key)?.value, depth + 1);
    }
  };
  inspect(fiber.memoizedProps); inspect(fiber.pendingProps);
  let dependency = fiber.dependencies?.firstContext;
  for (let index = 0; dependency && index < 20; index += 1, dependency = dependency.next) inspect(dependency.memoizedValue);
  // A provider may retain its manager only in useMemo/useRef after upstream
  // refactoring. Keep the hook scan bounded across native controller changes.
  let hook = fiber.memoizedState;
  for (let index = 0; hook && index < 12; index += 1, hook = hook.next) inspect(hook.memoizedState);
}

// Kinds that only ever exist for a composer signed into the official service.
// Those tasks are not served by the relay, so the official gate must stand.
function codexFuelKindIsRemote(kind) {
  return !["local", "new", "chatgpt"].includes(kind);
}

function codexFuelContextUsesRelay(get, scope, bindings, state, report) {
  // `report` carries the branch that decided this read. It is a plain callback
  // so the routing rules below stay the only thing that can release the gate.
  // Returns `true` when the configuration proves the relay carries the request,
  // and the string "deferred" when no readable evidence exists for or against
  // it. Both release the gate, but a report must not confuse the two.
  const note = typeof report === "function" ? report : null;
  if (!codexFuelStateEnabled(state)) { note?.("relay-off"); return false; }
  if (scope.value?.cloudThreadPrototype === true) { note?.("cloud-prototype"); return false; }
  if (bindings.contextFallback) {
    const verdict = codexFuelFallbackContextUsesRelay(get, scope, bindings, state, note);
    // The fallback reports its own leaf reason; only label a silent refusal.
    if (!verdict) note?.("fallback-declined");
    return verdict;
  }
  let target;
  const value = scope.value;
  if (value.kind === "local") {
    const id = value.conversationId;
    if (typeof id !== "string" || !id || get(bindings.threadHost, id) !== "local") { note?.("local-host-unknown"); return false; }
    const provider = get(bindings.threadProvider, id);
    const cwd = get(bindings.threadCwd, id);
    if (provider !== state.provider || typeof cwd !== "string" || !cwd.trim()) { note?.("local-provider-mismatch"); return false; }
    target = { cwd, provider };
  } else if (value.kind === "chatgpt") {
    // The account-backed kind is read like a local thread, but a missing thread
    // record here is not proof of official work. Before v10 this kind fell to
    // `return false` below, so every composer in 已有账号登录 kept the native
    // blocked value and an exhausted account could never send via the relay.
    const resolution = codexFuelAccountContextTarget(get, value, bindings);
    if (resolution === false) { note?.("account-nonlocal-thread"); return false; }
    if (resolution === null) { note?.("account-workspace-unknown"); return "deferred"; }
    target = resolution;
  } else if (value.kind === "new") {
    target = codexFuelNewTarget(get, scope, bindings);
  } else { note?.("kind-not-relay"); return false; }
  if (!target) { note?.("target-unknown"); return false; }
  const routes = codexFuelReadConfigUsesRelay(get, scope, bindings, target.cwd, state);
  note?.(routes ? "relay-confirmed" : "config-not-relay");
  return routes;
}

// The account-backed composer kind, which only exists while 已有账号登录 is
// active. Returns false when the thread is provably not relay work, a { cwd }
// target when its workspace is readable, or null when this composer carries no
// readable thread evidence at all.
function codexFuelAccountContextTarget(get, value, bindings) {
  const id = value.conversationId;
  if (typeof id !== "string" || !id) return null;
  let host = null;
  let cwd = null;
  try {
    host = get(bindings.threadHost, id);
    cwd = get(bindings.threadCwd, id);
  } catch (_) { return null; }
  // A thread recorded against a readable non-local host is not served by this
  // relay, so it keeps the official gate.
  if (typeof host === "string" && host && host !== "local") return false;
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  return { cwd };
}

function codexFuelFindContexts(inspectFiber = null) {
  const contexts = new Set();
  const fibers = new Set();
  const inspect = value => {
    const chain = value instanceof Map ? value : value?.chain;
    if (chain instanceof Map && Array.from(chain.values()).some(node => node?.familyBindings instanceof Map)) {
      contexts.add(chain);
    }
  };
  const roots = [document.body,
    ...Array.from(document.querySelectorAll("[contenteditable='true'], form, main")).slice(0, 80),
    ...Array.from(document.querySelectorAll("button")).slice(0, 80)];
  for (const element of roots) {
    if (!element) continue;
    let startingFiber = null;
    for (let candidate = element, depth = 0; candidate && depth < 6; candidate = candidate.parentElement, depth += 1) {
      const key = Object.keys(candidate).find(name => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
      if (key) { startingFiber = candidate[key]; break; }
    }
    for (let fiber = startingFiber, depth = 0; fiber && depth < 100; fiber = fiber.return, depth += 1) {
      for (const current of [fiber, fiber.alternate]) {
        if (!current || fibers.has(current)) continue;
        fibers.add(current);
        inspectFiber?.(current);
        inspect(current.memoizedProps?.value);
        inspect(current.pendingProps?.value);
        let dependency = current.dependencies?.firstContext;
        for (let index = 0; dependency && index < 20; index += 1, dependency = dependency.next) inspect(dependency.memoizedValue);
      }
    }
  }
  return Array.from(contexts);
}

function createCodexFuelFamilyPatch({ bindings, getState, findContexts = codexFuelFindContexts,
  forceRelayGlobal = false }) {
  if (!bindings.hardBlocked?.scope || bindings.reserveActive?.scope !== bindings.hardBlocked.scope) {
    throw new Error("Unsupported Codex quota scope");
  }
  let disposed = false;
  const quotaScope = bindings.hardBlocked.scope;
  let composerScope = null;
  let routeError = "";
  let configRequestCount = 0;
  // Bounded, change-only decision log. The composer gate re-evaluates on every
  // tick, so an unconditional writer would flood and pin the buffer on one
  // frame. Only a changed (kind, released, blocked, reason) tuple is stored,
  // which keeps the last few seconds of real transitions rather than noise.
  const decisions = [];
  let lastDecision = "";
  function noteDecision(kind, released, reason) {
    const record = { at: Date.now(), kind: typeof kind === "string" ? kind : null,
      released: released === true, blocked: released !== true, reason: reason || "unknown" };
    // `blocked` mirrors what the composer actually receives: the returned value
    // is a submit-disabled flag, so true means the send button stayed locked.
    const key = `${record.kind}|${record.released}|${record.reason}`;
    if (key === lastDecision) return;
    lastDecision = key;
    decisions.push(record);
    // Keep the newest window; the oldest entries fall off first.
    if (decisions.length > 24) decisions.splice(0, decisions.length - 24);
  }
  // Which distinct branches the resolver actually took. The decision log above
  // is transition-based and its producers only run once the native gate reads
  // boolean `true`, so a composer that never gets there leaves the log empty —
  // indistinguishable from a patch that never loaded. These facts are latched
  // once per branch instead, in their own bounded buffer, so they cannot evict
  // the routing transitions above. Values are branch tags and internal kind
  // enums, never page text.
  const branches = [];
  const seenBranches = new Set();
  function noteBranch(reason, kind) {
    const label = typeof kind === "string" && kind ? `${reason}:${kind.slice(0, 24)}` : reason;
    if (seenBranches.has(label) || seenBranches.size >= 12) return label;
    seenBranches.add(label);
    branches.push({ at: Date.now(), branch: label });
    return label;
  }
  // Plain counters, one per branch of wrappedResolve and of the derived it
  // builds, so a single capture can tell which path ran even when both buffers
  // are empty or latched. Counts only, plus a type tag and a short enum.
  const stats = {
    resolveCalls: 0, resolveSkipped: 0, noContext: 0, remoteKind: 0, rootBranch: 0,
    derivedEvals: 0, derivedNativeNotBlocked: 0, derivedNativeOpen: 0, derivedDisposed: 0,
    derivedBlocked: 0, released: 0, kept: 0, globalForced: 0,
    lastNativeType: "", lastNativeShape: "", lastKind: null, lastReason: ""
  };
  function noteNative(value) {
    // A type tag plus one coarse shape word is enough to tell `true` from `1`,
    // from a truthy object, from `false` and from `undefined`, and it can never
    // carry composer text. Returned, not shared: two deriveds from different
    // families can observe two different native values in the same tick.
    stats.lastNativeType = value === null ? "null" : typeof value;
    return value === true || value === false
      ? String(value) : (value === undefined ? "undefined" : (value ? "truthy-nonboolean" : "falsy-nonboolean"));
  }
  // Kind strings are internal enums ("local", "new", "chatgpt", ...), never user
  // text, but they are still external input to this file: clamp before storing.
  function noteKind(kind) {
    const text = typeof kind === "string" ? kind : null;
    stats.lastKind = text === null ? null : text.slice(0, 24);
    return text;
  }
  const roots = new Map();
  const changes = [];
  const configReads = new WeakMap();
  const configNotifyTimers = new Set();
  function requestConfig(scope, cwd, state) {
    if (!bindings.config || typeof scope.query?.getOptions !== "function"
        || typeof scope.node?.queryClient?.fetchQuery !== "function") return;
    let requests = configReads.get(scope.node);
    if (!requests) { requests = new Map(); configReads.set(scope.node, requests); }
    const key = JSON.stringify([state.provider, state.baseUrl, cwd]);
    const previous = requests.get(key);
    if (previous?.pending || previous && Date.now() - previous.startedAt < 3000) return;
    // Capture options during the tracked read. Retaining scope.query across a
    // microtask throws in current Maitai (tracker read outside evaluation).
    const queryOptions = { ...scope.query.getOptions(bindings.config, { hostId: "local", cwd }) };
    if (queryOptions.enabled === false) return;
    const queryClient = scope.node.queryClient;
    const request = { pending: true, startedAt: Date.now() };
    requests.set(key, request);
    // Modern query signals may remain pending/idle when first read by a
    // derived gate. Fetch through the native scoped query API after render;
    // never grant access from the fetch result or dispatch a user message.
    queueMicrotask(async () => {
      try {
        const current = getState();
        if (disposed || !codexFuelStateEnabled(current) || current.provider !== state.provider
            || codexFuelNormalizedUrl(current.baseUrl) !== codexFuelNormalizedUrl(state.baseUrl)) return;
        configRequestCount += 1;
        await queryClient.fetchQuery(queryOptions);
      } catch (error) { routeError = String(error?.message || "configuration query failed"); }
      finally {
        request.pending = false;
        if (!disposed) {
          // Query observers batch completion notifications. Refresh after that
          // batch, so a pending snapshot cannot mask the newly loaded config.
          const timer = setTimeout(() => {
            configNotifyTimers.delete(timer);
            if (!disposed) {
              refresh();
            }
          }, 0);
          configNotifyTimers.add(timer);
        }
      }
    });
  }
  const tick = bindings.createSignal(quotaScope, 0);
  const rememberRoot = (node, chain) => {
    const root = chain.get(quotaScope.id) ?? node;
    if (root?.store && root.familyBindings instanceof Map && !roots.has(root)) roots.set(root, chain);
  };
  for (const family of [bindings.hardBlocked, bindings.reserveActive]) {
    const symbols = Object.getOwnPropertySymbols(family);
    const resolveKey = symbols.find(key => key.description === "maitai.resolveFamilyMemberInternal");
    const evictKey = symbols.find(key => key.description === "maitai.evictFamilyMemberInternal");
    if (!resolveKey || !evictKey || typeof family[resolveKey] !== "function" || typeof family[evictKey] !== "function") {
      for (const change of changes) change.family[change.key] = change.original;
      throw new Error("Unsupported Codex quota family lifecycle");
    }
    const original = family[resolveKey];
    const wrappers = new WeakMap();
    const rootWrappers = new WeakMap();
    const globalWrappers = new WeakMap();
    // A truthy snapshot changes the obsolete root subscription without ever
    // enabling it. React then re-renders and subscribes through the task scope.
    // Only the verified positive-OR submit consumer can receive this snapshot.
    const rebindBlocked = Object.freeze({ blocked: true });
    const wrappedResolve = function (node, chain, hostId) {
      stats.resolveCalls += 1;
      const native = original.call(this, node, chain, hostId);
      if (disposed || hostId !== "local") {
        // Counted, never logged: this fires for every non-local host read and
        // would drown the change-only decision buffer.
        stats.resolveSkipped += 1;
        return native;
      }
      // The relay status is authoritative for this opt-in mode. Resolve the
      // native signal without reading composer context so an unresolved or
      // retained React editor cannot leave the send gate locked.
      if (forceRelayGlobal === true && family === bindings.hardBlocked) {
        rememberRoot(node, chain);
        noteBranch("relay-global-force");
        let wrapped = globalWrappers.get(native);
        if (!wrapped) {
          wrapped = { ...native, value: bindings.createDerived(quotaScope, ({ get }) => {
            get(tick);
            const blocked = get(native.value);
            stats.derivedEvals += 1;
            if (disposed) {
              stats.derivedDisposed += 1;
              noteDecision("global", false, "disposed");
              return blocked;
            }
            if (!codexFuelStateEnabled(getState())) {
              noteDecision("global", false, "relay-off");
              return blocked;
            }
            stats.globalForced += 1;
            if (blocked === true) stats.derivedBlocked += 1;
            else stats.derivedNativeNotBlocked += 1;
            stats.released += 1;
            stats.lastReason = "relay-global-forced";
            noteDecision("global", true, "relay-global-forced");
            return false;
          }) };
          globalWrappers.set(native, wrapped);
        }
        return wrapped;
      }
      const context = codexFuelContextNode(chain);
      if (!context && composerScope && family === bindings.hardBlocked) {
        stats.rootBranch += 1;
        // This branch used to return silently. It hands React the root
        // subscription, which resolves the official gate with no task scope and
        // therefore no routing check at all — the one path that can pin the
        // send button while producing no decision record. Latched, not logged
        // per read: it is on the hot path.
        noteBranch("root-scope-fallback");
        let wrapped = rootWrappers.get(native);
        if (!wrapped) {
          wrapped = { ...native, value: bindings.createDerived(quotaScope, ({ get }) => {
            get(tick);
            const blocked = get(native.value);
            stats.derivedEvals += 1;
            if (disposed) { stats.derivedDisposed += 1; return blocked; }
            const shape = noteNative(blocked);
            if (blocked === true) { stats.derivedBlocked += 1; return rebindBlocked; }
            stats.derivedNativeNotBlocked += 1;
            if (blocked === false) {
              // Gate already open through the root subscription, so no release
              // is needed. Latched, because this derived re-evaluates per tick.
              stats.derivedNativeOpen += 1;
              noteBranch("native-open-root");
            }
            else noteBranch(`native-${shape}`);
            return blocked;
          }) };
          rootWrappers.set(native, wrapped);
        }
        return wrapped;
      }
      if (!context) {
        // No context node at all and no composer scope to fall back to: the
        // relay cannot be involved, so the native value is passed straight
        // through. Previously indistinguishable from "patch never loaded".
        stats.noContext += 1;
        noteBranch("no-context");
        return native;
      }
      // Kinds outside this list are cloud/remote work the relay cannot serve.
      // Before v10 this check also dropped the account-backed kind, so every
      // composer in 已有账号 mode silently kept the native blocked value.
      const contextKind = noteKind(context.value?.kind);
      if (codexFuelKindIsRemote(contextKind)) {
        stats.remoteKind += 1;
        noteBranch("remote-kind", contextKind);
        return native;
      }
      rememberRoot(node, chain);
      let byContext = wrappers.get(native);
      if (!byContext) { byContext = new WeakMap(); wrappers.set(native, byContext); }
      let wrapped = byContext.get(context);
      if (!wrapped) {
        // Keep a blocked-but-distinct snapshot until the task subscription
        // mounts. Returning the old `true` during a cold config read can make
        // React bail out and retain the obsolete root subscription instead.
        const rebinding = bindings.createSignal(context.token,
          bindings.composerVerified === true && context.token !== quotaScope,
          { onMount(set) { set(false); } });
        const value = bindings.createDerived(context.token, ({ get, scope }) => {
          get(tick);
          stats.derivedEvals += 1;
          const awaitingCommit = get(rebinding);
          const blocked = get(native.value);
          // The composer kind belongs to the context captured by this wrapper,
          // not to the family node this derived was created for.
          const kind = noteKind(context.value?.kind);
          if (disposed || blocked !== true) {
            // Second silent path. A native value that is not the boolean `true`
            // (undefined, a stale object, a falsy placeholder) skips the whole
            // routing block below, so before this the composer stayed locked
            // with an empty decision log. Recorded by shape, never by value,
            // and latched so a per-tick re-evaluation cannot flood it.
            if (disposed) stats.derivedDisposed += 1;
            else {
              stats.derivedNativeNotBlocked += 1;
              const shape = noteNative(blocked);
              if (blocked === false) {
                // The official gate is open on its own: no release is needed and
                // none is requested.
                stats.derivedNativeOpen += 1;
                noteBranch("native-open", kind);
              } else {
                // Not `true` and not `false`: the routing block cannot run, so
                // this raw value is what the composer receives.
                noteBranch(`native-${shape}`, kind);
              }
            }
            return blocked;
          }
          stats.derivedBlocked += 1;
          // Reaching here means the official gate is closed; only the routing
          // rules below can open it. Everything else stays in this branch.
          // Keep late fallback-manager/selector changes visible to the patch.
          const currentBindings = { ...bindings, requestConfig };
          let reason = "";
          try {
            const verdict = codexFuelContextUsesRelay(get, scope, currentBindings, getState(),
              branch => { reason = branch; });
            if (verdict === true || verdict === "deferred") {
              // A deferral is recorded under its own label: the route could not
              // be verified, so the release rests on the operator's setting and
              // the confirmed helper state, not on this composer's evidence.
              noteDecision(kind, true, reason || "relay-confirmed");
              stats.released += 1;
              return false;
            }
            if (!reason) reason = "route-declined";
          } catch (error) {
            routeError = String(error?.message || "route check failed");
            noteDecision(kind, false, "route-check-error");
          }
          // The official value stands. Record which branch kept it so a report
          // can tell an exhausted account apart from a genuine routing refusal.
          const keptReason = reason || (awaitingCommit ? "awaiting-commit" : "native-blocked");
          stats.kept += 1;
          stats.lastReason = keptReason.slice(0, 40);
          noteDecision(kind, false, keptReason);
          return awaitingCommit ? rebindBlocked : blocked;
        });
        wrapped = { ...native, value };
        byContext.set(context, wrapped);
      }
      return wrapped;
    };
    family[resolveKey] = wrappedResolve;
    changes.push({ family, key: resolveKey, original, wrappedResolve, evictKey });
  }
  let evicted = new WeakSet();
  function evictAndNotify(change, root, chain) {
    const cacheKeyMethod = Object.getOwnPropertySymbols(change.family)
      .find(symbol => symbol.description === "maitai.getFamilyCacheKeyInternal");
    const cacheKey = typeof change.family[cacheKeyMethod] === "function"
      ? change.family[cacheKeyMethod]("local") : "local";
    const disposal = root.familyBindings.get(change.family)?.get(cacheKey)?.disposal;
    // Native explicit eviction calls dispose() without notifying React's
    // lNt hook. dispose(true) is its normal scheduled-eviction path and marks
    // the disposal signal, so already mounted hooks resolve the new member.
    if (typeof disposal?.dispose === "function") disposal.dispose(true);
    else {
      change.family[change.evictKey](root, chain, "local");
      if (disposal?.atom) root.store.set(disposal.atom, true);
    }
  }
  function refresh(contexts = null) {
    if (disposed) return;
    contexts ||= findContexts();
    if (!composerScope && bindings.composerVerified) {
      const scopes = new Set(contexts.map(chain => chain.has(quotaScope.id) ? codexFuelContextNode(chain)?.token : null).filter(Boolean));
      if (scopes.size === 1) {
        composerScope = scopes.values().next().value;
        // The submit-only family must subscribe through the composer context.
        // New Maitai hooks otherwise resolve it using the root's chain, losing
        // the conversation even though imperative reads have the right chain.
        // Its native resolver still owns the original root/cache/usage values.
        bindings.hardBlocked.scope = composerScope;
        if (bindings.hardBlocked.scope !== composerScope) throw new Error("Codex submit scope is not writable");
        evicted = new WeakSet();
      }
    }
    for (const chain of contexts) {
      const root = chain.get(quotaScope.id);
      if (!root?.store || !(root.familyBindings instanceof Map)) continue;
      rememberRoot(root, chain);
      if (!evicted.has(root)) {
        evicted.add(root);
        for (const change of changes) evictAndNotify(change, root, chain);
      }
    }
    for (const [root, chain] of roots) {
      try { root.store.set(tick.resolve(root, chain), value => value + 1); } catch (_) {}
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const timer of configNotifyTimers) clearTimeout(timer);
    configNotifyTimers.clear();
    if (composerScope && bindings.hardBlocked.scope === composerScope) bindings.hardBlocked.scope = quotaScope;
    for (const change of changes) {
      if (change.family[change.key] === change.wrappedResolve) change.family[change.key] = change.original;
    }
    for (const [root, chain] of roots) {
      try {
        root.store.set(tick.resolve(root, chain), value => value + 1);
        for (const change of changes) evictAndNotify(change, root, chain);
      } catch (_) {}
    }
    roots.clear();
  }
  try { refresh(); } catch (error) { dispose(); throw error; }
  return { refresh, dispose, get ready() { return !disposed; }, get scopeBound() { return !disposed && composerScope != null; },
    get healthy() { return !disposed && changes.every(change => change.family[change.key] === change.wrappedResolve)
      && (!composerScope || bindings.hardBlocked.scope === composerScope); },
    get routeError() { return routeError; }, get configRequestCount() { return configRequestCount; },
    // A copy, so callers cannot mutate the retained window. Read-only facts
    // only: no account identity, token, credential or message content.
    get decisions() { return decisions.map(record => ({ ...record })); },
    // Which distinct branches the resolver took, one entry each. Needed because
    // the decision buffer is transition-based and a composer that never reaches
    // the gate-closed block leaves it empty — the same reading as a patch that
    // never loaded. Branch tags and internal kind enums only.
    get branches() { return branches.map(record => ({ ...record })); },
    // How often each branch ran. Counts only, plus a type tag and a short enum.
    get stats() { return { ...stats }; } };
}

// Shared with the usage adapter; this reader does not select a service tier.
function codexSpeedReadFamily(family, chain, key) {
  const node = chain.get(family?.scope?.id);
  const resolver = Object.getOwnPropertySymbols(family || {})
    .find(symbol => symbol.description === "maitai.resolveFamilyMemberInternal");
  if (!node?.store || !resolver) throw new Error("Codex configuration scope unavailable");
  const value = family[resolver](node, chain, key).value;
  return node.store.get(value.resolve(node, chain));
}

function createCodexConversationRecovery({ getState, canResume = () => false, resumeTimeoutMs = 8000 }) {
  let disposed = false;
  let recovered = 0;
  let lastReason = "idle";
  const clients = new Map();
  const orderedMethods = new Set(["turn/start", "turn/interrupt", "thread/rollback",
    "thread/revert", "thread/resume", "thread/settings/update"]);
  const routeKey = state => JSON.stringify([state?.mode, state?.provider, state?.baseUrl]);
  const eligible = (manager, params) => {
    try {
      const state = getState();
      const thread = manager.getConversation(params?.threadId);
      return !disposed && !manager.disposed && codexFuelStateEnabled(state)
        && manager.hostId === "local" && manager.requestClient?.hostId === "local"
        && typeof params?.threadId === "string" && thread?.hostId === "local"
        && thread.modelProvider === state.provider && typeof thread.cwd === "string"
        && thread.cwd.trim() ? { cwd: thread.cwd, key: routeKey(state) } : null;
    } catch (_) { return null; }
  };
  const missingThread = (error, id) => {
    const message = error?.message ?? error?.error?.message;
    return typeof message === "string"
      && message.trim().toLowerCase() === `thread not found: ${id}`.toLowerCase();
  };
  const resumeRouteConfirmed = owner => {
    try { return canResume(owner.cwd, getState()) === true; } catch (_) { return false; }
  };
  const boundedResume = async request => {
    let timer;
    try {
      return await Promise.race([request, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("恢复会话超时，请保留当前输入后重试。")), resumeTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  return {
    attach(manager) {
      const client = manager?.requestClient;
      if (disposed || manager?.hostId !== "local" || client?.hostId !== "local"
          || typeof manager.getConversation !== "function"
          || typeof client.sendRequest !== "function" || clients.has(client)) return;
      const own = Object.getOwnPropertyDescriptor(client, "sendRequest");
      const original = client.sendRequest;
      const pending = new Map();
      const wrapped = function (method, params, ...rest) {
        const owner = orderedMethods.has(method) ? eligible(manager, params) : null;
        if (!owner) {
          return original.call(this, method, params, ...rest);
        }
        const receiver = this;
        const predecessor = pending.get(params.threadId);
        const entry = { method, promise: null, blocksFollowing: method !== "turn/start" };
        const run = async () => {
          if (predecessor) {
            try { await predecessor.promise; } catch (error) {
              // A send queued behind a failed rollback must not use the
              // unedited branch. Later explicit user actions start fresh.
              if (predecessor.blocksFollowing) {
                entry.blocksFollowing = true;
                throw error;
              }
            }
          }
          const current = eligible(manager, params);
          if (!current || current.key !== owner.key || current.cwd !== owner.cwd) {
            throw new Error("会话路由已改变，请确认当前对话后重新发送。");
          }
          try {
            return await original.call(receiver, method, params, ...rest);
          } catch (error) {
            if (method === "turn/interrupt" || method === "thread/resume"
                || !missingThread(error, params.threadId)) throw error;
            const next = eligible(manager, params);
            if (!next || next.key !== owner.key || next.cwd !== owner.cwd) throw error;
            if (!resumeRouteConfirmed(owner) || params.cwd != null && params.cwd !== owner.cwd) {
              lastReason = "resume-route-unverified";
              throw error;
            }
            lastReason = "resuming-missing-thread";
            let resumed;
            try {
              resumed = await boundedResume(Promise.resolve().then(() => original.call(receiver,
                "thread/resume", { threadId: params.threadId, cwd: owner.cwd, excludeTurns: true })));
            } catch (resumeError) {
              lastReason = "resume-failed";
              throw resumeError;
            }
            const latest = eligible(manager, params);
            if (!latest || latest.key !== owner.key || latest.cwd !== owner.cwd || !resumeRouteConfirmed(owner)
                || resumed?.thread?.id !== params.threadId) {
              lastReason = "resume-owner-changed";
              throw error;
            }
            // Only this definite pre-acceptance error is retried, exactly once.
            // Timeouts, quota errors, stream errors and other failures pass through.
            let result;
            try { result = await original.call(receiver, method, params, ...rest); }
            catch (retryError) { lastReason = "retry-failed"; throw retryError; }
            recovered += 1;
            lastReason = "recovered";
            return result;
          }
        };
        entry.promise = Promise.resolve().then(run);
        pending.set(params.threadId, entry);
        const cleanup = () => { if (pending.get(params.threadId) === entry) pending.delete(params.threadId); };
        entry.promise.then(cleanup, cleanup);
        return entry.promise;
      };
      client.sendRequest = wrapped;
      clients.set(client, { own, original, wrapped });
    },
    get status() { return { installed: !disposed && clients.size > 0, recovered, lastReason }; },
    dispose() {
      disposed = true;
      for (const [client, entry] of clients) {
        if (client.sendRequest !== entry.wrapped) continue;
        if (entry.own) Object.defineProperty(client, "sendRequest", entry.own);
        else delete client.sendRequest;
      }
      clients.clear();
    },
  };
}

async function installCodexFuelRuntime(options) {
  const version = CODEX_FUEL_RUNTIME_VERSION;
  const previous = window.__gaogeCodexFuelRuntime;
  if (previous?.version === version && !previous.disposed
      && (previous.hasAdapter || previous.health?.monitoring === true && previous.usageCache?.installed === true)
      && previous.health?.healthy === true && previous.health?.needsReinstall !== true
      && codexFuelStateEnabled(options.state)) {
    previous.update(options);
    await previous.refresh();
    if (previous.health?.healthy === true && previous.health?.needsReinstall !== true) return previous;
  }
  previous?.dispose?.();
  let state = options.state;
  let freshAt = Date.now();
  let patch = null;
  let pending = null;
  let pollTimer = null;
  let renderTimer = null;
  let composerObserver = null;
  let epoch = 0;
  let bindings = null;
  let adapterFailure = '';
  let nativePending = null;
  let nativeRetryAt = 0;
  const fallbackManagers = new Set();
  const getState = () => !runtime.disposed && Date.now() - freshAt <= CODEX_FUEL_STATUS_GRACE_MS
    ? state : { enabled: false };
  const usage = createCodexUsageCacheAdapter({
    getPolicy: () => codexUsageVisiblePolicy(bindings, getState(), fallbackManagers,
      options.forceRelayGlobal === true),
  });
  // Native Codex owns interrupt, edit/revert, resume and send ordering.
  const nativeConversationState = Object.freeze({ installed: false, recovered: 0, reason: "native-codex" });
  const refreshAdapters = () => {
    try {
      fallbackManagers.clear();
      const queryClients = new Set([window.__REACT_QUERY_CLIENT__, window.__codexQueryClient]);
      for (const client of codexUsageFindClients(document)) queryClients.add(client);
      // A changed legacy composer shape must not hide an already discovered
      // root cache. Context-based authorization still uses its own policy.
      for (const client of queryClients) usage.attach(client);
      let contexts = [];
      let contextFailure = false;
      try {
        contexts = codexFuelFindContexts(fiber => {
          codexUsageInspectClient(fiber, client => queryClients.add(client));
          codexFuelInspectManagers(fiber, fallbackManagers);
        });
        for (const chain of contexts) for (const node of chain.values()) queryClients.add(node.queryClient);
      } catch (_) { contextFailure = true; }
      for (const client of queryClients) usage.attach(client);
      usage.refresh();
      if (!patch) {
        const cache = usage.status;
        runtime.hasAdapter = cache.installed && cache.supported > 0 && !cache.error;
        runtime.ready = runtime.hasAdapter;
        runtime.adapterMode = runtime.hasAdapter ? 'usage-cache' : 'unavailable';
        runtime.reason = runtime.hasAdapter ? 'usage-cache-ready' : 'awaiting-usage-query';
        runtime.error = runtime.hasAdapter ? '' : '额度缓存适配尚未识别，等待当前输入框完成加载。';
      }
      patch?.refresh(contexts);
      const cache = usage.status;
      adapterFailure = contextFailure && !(options.forceRelayGlobal === true
        && cache.installed && cache.supported > 0 && cache.healthy) ? 'adapter-refresh-failed' : '';
      runtime.ready = runtime.hasAdapter && runtime.health.healthy;
    } catch (_) {
      adapterFailure = 'adapter-refresh-failed';
      runtime.ready = false;
    }
  };
  const saveState = result => {
    epoch += 1;
    state = result; freshAt = Date.now(); runtime.enabled = codexFuelStateEnabled(state);
    refreshAdapters();
  };
  const runtime = {
    version, enabled: codexFuelStateEnabled(state), ready: false, disposed: false, hasAdapter: false, reason: "initializing", error: "",
    adapterMode: "none", discoveryError: "",
    get submitScopeBound() { return patch?.scopeBound === true; },
    get forceRelayGlobal() { return options.forceRelayGlobal === true; },
    get routeError() { return patch?.routeError || ""; },
    get decisions() { return patch?.decisions || []; },
    get stats() { return patch?.stats || null; },
    get branches() { return patch?.branches || []; },
    // Retain these diagnostic keys for older support tools. Native Codex now
    // owns speed controls and request parameters; Fuel installs no speed hook.
    speedReady: false, speedInstalled: false, speedLastRequest: null,
    get conversationRecovery() { return nativeConversationState; },
    get usageCache() { return usage.status; },
    // Adapter integrity is separate from helper availability and quota data.
    // Waiting for a query or a fresh bridge response needs polling, not repeated
    // reinjection. Only confirmed adapter damage requests replacement.
    get health() {
      let cache;
      try { cache = usage.status; } catch (_) { cache = { healthy: false, error: 'usage-status-failed' }; }
      const nativeHealthy = patch?.healthy === true;
      const usageHealthy = cache.healthy === true;
      const reason = runtime.disposed ? 'disposed'
        : patch && !nativeHealthy ? 'native-hook-lost'
        : !usageHealthy ? 'usage-cache-error'
        : adapterFailure || (nativeHealthy ? 'native-ready'
          : cache.installed && cache.supported > 0 ? 'usage-cache-ready' : 'awaiting-usage-query');
      const needsReinstall = !runtime.disposed && (!!patch && !nativeHealthy || !usageHealthy || !!adapterFailure);
      const monitoring = !runtime.disposed && pollTimer != null && renderTimer != null;
      return { healthy: !runtime.disposed && !needsReinstall, needsReinstall, reason, nativeHealthy, usageHealthy, monitoring };
    },
    update(next) { options = next; saveState(next.state); },
    // One object a support report can embed verbatim. It describes what the
    // patch decided and why, never what the user typed or who they are.
    diagnostics() {
      return { version: runtime.version, ready: runtime.ready && runtime.health.healthy, enabled: runtime.enabled,
        reason: runtime.reason, error: runtime.error, adapterMode: runtime.adapterMode,
        discoveryError: runtime.discoveryError, routeError: runtime.routeError,
        statusAgeMs: Math.max(0, Date.now() - freshAt), statusGraceMs: CODEX_FUEL_STATUS_GRACE_MS,
        submitScopeBound: runtime.submitScopeBound, forceRelayGlobal: runtime.forceRelayGlobal,
        speedInstalled: runtime.speedInstalled,
        decisions: runtime.decisions, branches: runtime.branches, stats: runtime.stats,
        conversationRecovery: nativeConversationState, usageCache: usage.status, health: runtime.health };
    },
    async refresh() {
      if (runtime.disposed) return runtime;
      if (pending) return pending;
      const generation = ++epoch;
      pending = (async () => {
        const requestStatus = async () => {
          let timeout;
          let timedOut = false;
          try {
            return await Promise.race([
              Promise.resolve().then(() => options.bridge("/fuel/status", {})),
              new Promise((_, reject) => {
                timeout = setTimeout(() => {
                  timedOut = true;
                  reject(new Error("Relay status unavailable"));
                }, 1800);
              }),
            ]);
          } catch (error) {
            if (timedOut && error && typeof error === "object") error.statusTimedOut = true;
            throw error;
          } finally {
            clearTimeout(timeout);
          }
        };
        const retryDelay = () => new Promise(resolve => setTimeout(resolve, 150));
        try {
          let result;
          try {
            result = await requestStatus();
          } catch (error) {
            // Account/auth files can be replaced atomically during login
            // switching. Retry quick failures once, but never stack another
            // long request after a timeout.
            if (error?.statusTimedOut) throw error;
            await retryDelay();
            result = await requestStatus();
          }
          if (runtime.disposed || generation !== epoch) return runtime;
          if (result?.ok !== true) throw new Error("Relay status unavailable");
          state = result; freshAt = Date.now(); runtime.enabled = codexFuelStateEnabled(state);
          runtime.reason = runtime.enabled ? "relay-provider-confirmed" : "relay-disabled";
          runtime.error = "";
        } catch (_) {
          if (!runtime.disposed && generation === epoch) {
            if (codexFuelStateEnabled(getState())) {
              // A brief helper outage must not relock a verified relay between
              // polls. Never extend the grace period, and honor explicit disable replies
              // immediately in the successful-response path above.
              runtime.reason = "relay-status-retrying";
            } else {
              state = { enabled: false }; runtime.enabled = false; runtime.reason = "relay-status-unavailable";
            }
          }
        } finally { pending = null; if (!runtime.disposed) refreshAdapters(); }
        return runtime;
      })();
      return pending;
    },
    dispose() {
      if (runtime.disposed) return;
      runtime.disposed = true; runtime.enabled = false; runtime.ready = false; runtime.hasAdapter = false; epoch += 1;
      state = { enabled: false }; clearInterval(pollTimer); clearInterval(renderTimer);
      composerObserver?.disconnect(); composerObserver = null;
      fallbackManagers.clear();
      usage.dispose();
      patch?.dispose(); patch = null; runtime.reason = "disposed";
    },
  };
  window.__gaogeCodexFuelRuntime = runtime;
  if (!runtime.enabled) { runtime.ready = true; runtime.reason = "relay-disabled"; return runtime; }
  // Cache discovery and helper polling must not wait for optional minified
  // modules. They can unlock the ordinary quota gate even if an import hangs.
  refreshAdapters();
  if (typeof MutationObserver === 'function' && document.body) {
    composerObserver = new MutationObserver(() => { if (!runtime.disposed) usage.refresh(); });
    composerObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'contenteditable'] });
  }
  pollTimer = setInterval(() => { void runtime.refresh(); }, 3000);
  renderTimer = setInterval(() => {
    if (Date.now() - freshAt > CODEX_FUEL_STATUS_GRACE_MS && runtime.enabled) {
      runtime.enabled = false; runtime.reason = "relay-status-expired";
    }
    refreshAdapters();
    void installNativeAdapter();
  }, 750);
  await installNativeAdapter();
  if (!runtime.disposed) await runtime.refresh();
  return runtime;

  async function discoverNativeBindings() {
    let bindings;
    let adapterMode;
    let discoveryError = '';
    const url = options.assetUrl("app-initial-");
    if (!url) throw new Error("Codex quota bundle unavailable");
    const [module, response] = await Promise.all([
      options.loadModule("app-initial-"), fetch(url),
    ]);
    if (!response.ok) throw new Error("Codex quota source unavailable");
    const source = await response.text();
    const dependencies = { __sources: {} };
    if (/from["']\.\/app-shared-[^"']+\.js["']/.test(source)) {
      dependencies["app-shared-"] = await options.loadModule("app-shared-");
      const sharedUrl = options.assetUrl("app-shared-");
      if (sharedUrl) {
        try {
          const sharedResponse = await fetch(sharedUrl);
          if (sharedResponse.ok) dependencies.__sources["app-shared-"] = await sharedResponse.text();
        } catch (_) { /* Imported factories may still satisfy the minimal adapter. */ }
      }
    }
    let composerSource = null;
    let composerError = null;
    try {
      const composerUrl = options.assetUrl("app-primary-");
      if (!composerUrl) throw new Error("Codex composer bundle unavailable");
      const composerResponse = await fetch(composerUrl);
      if (!composerResponse.ok) throw new Error("Codex composer source unavailable");
      composerSource = await composerResponse.text();
    } catch (error) { composerError = error; }
    try {
      bindings = discoverCodexFuelBindings(source, module, dependencies);
      // The consumer source is optional for scoped-force mode. A renamed or
      // temporarily unavailable composer asset must not skip its fallback.
      if (composerError) throw composerError;
      verifyCodexFuelComposer(composerSource, bindings.hardBlockedExport);
      bindings.composerVerified = true;
      adapterMode = "native";
    } catch (error) {
      // Forced relay mode still changes the native quota signal, not the DOM.
      // Stable thread/config data replaces optional minified selector names.
      bindings = discoverCodexFuelQuotaBindings(source, module, dependencies);
      try { bindings.config = discoverCodexFuelConfigBinding(source, module, dependencies); }
      catch (_) { /* Unknown config families require exact cached evidence. */ }
      if (composerSource != null) {
        try {
          verifyCodexFuelComposer(composerSource, bindings.hardBlockedExport);
          bindings.composerVerified = true;
        } catch (_) { /* An unknown consumer cannot change its subscription scope. */ }
      }
      bindings.contextFallback = true;
      bindings.fallbackManagers = fallbackManagers;
      adapterMode = "scoped-force";
      discoveryError = String(error?.message || "native selectors unavailable");
    }
    return { bindings, adapterMode, discoveryError };
  }

  function installNativeAdapter() {
    if (runtime.disposed || patch || !codexFuelStateEnabled(getState())) return Promise.resolve();
    if (nativePending) return nativePending;
    if (Date.now() < nativeRetryAt) return Promise.resolve();
    nativePending = (async () => {
      let timeout;
      try {
        const found = await Promise.race([
          discoverNativeBindings(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Codex quota discovery timed out')),
              CODEX_FUEL_NATIVE_LOAD_TIMEOUT_MS);
          }),
        ]);
        // A timed-out discovery only returns data; late imports must never
        // install hooks into a disposed/replaced runtime.
        if (runtime.disposed) return;
        bindings = found.bindings;
        patch = createCodexFuelFamilyPatch({ bindings, getState,
          forceRelayGlobal: options.forceRelayGlobal === true });
        runtime.adapterMode = found.adapterMode;
        runtime.discoveryError = found.discoveryError;
        runtime.hasAdapter = true;
        runtime.ready = true;
        runtime.error = '';
        runtime.reason = "relay-provider-confirmed";
      } catch (error) {
        if (runtime.disposed) return;
        patch?.dispose(); patch = null; bindings = null;
        runtime.ready = false; runtime.hasAdapter = false;
        runtime.reason = "unsupported-codex-quota-gate";
        runtime.adapterMode = "unavailable";
        runtime.discoveryError = String(error?.message || "quota adapter unavailable");
        runtime.error = "当前 Codex 版本的发送状态尚未识别，未完成中转解锁。";
        nativeRetryAt = Date.now() + CODEX_FUEL_NATIVE_RETRY_MS;
      } finally {
        clearTimeout(timeout);
        nativePending = null;
        if (!runtime.disposed) refreshAdapters();
      }
    })();
    return nativePending;
  }
}
