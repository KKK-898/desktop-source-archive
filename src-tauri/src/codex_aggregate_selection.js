// A model shown by the native picker can still be an optimistic selection.
// Observe its existing queued/in-flight selection members before saving
// an aggregate route. Do not invoke native writers or create family members.
function aggregateSelectionEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aggregateSelectionExport(source, module, localName) {
  const matches = Array.from(source.slice(source.lastIndexOf("export{")).matchAll(
    new RegExp(`(?:[,{])${aggregateSelectionEscape(localName)} as ([\\w$]+)(?=[,}])`, "g"),
  ));
  if (matches.length !== 1 || module?.[matches[0][1]] == null) {
    throw new Error("Codex native model-selection state is unavailable");
  }
  return module[matches[0][1]];
}

function discoverAggregateNativeSelectionBindings(source, module) {
  // Native cleanup clears only the exact selection being committed. This
  // relates the queued and in-flight families without assuming export names.
  const matches = Array.from(source.matchAll(
    /function ([\w$]+)\(([\w$]+),([\w$]+)\)\{\2\.get\(([\w$]+),\3\.target\)===\3\.selection&&\(\2\.set\(\4,\3\.target,null\),\2\.get\(([\w$]+),\3\.target\)===\3\.selection&&\2\.set\(\5,\3\.target,null\)/g,
  ));
  if (matches.length !== 1) throw new Error("Unsupported Codex native model-selection lifecycle");
  const [, cleanup, store, selection, inFlightName, queuedName] = matches[0];
  if (inFlightName === queuedName) throw new Error("Unsupported Codex native model-selection families");
  // 26.1007 ends after clearing these two families. 26.924 additionally clears
  // one global default-selection signal. Validate the complete known ending,
  // including its guard, rather than accepting an arbitrary comma continuation.
  const tailStart = matches[0].index + matches[0][0].length;
  const tailEnd = source.indexOf("}", tailStart);
  if (tailEnd < tailStart || tailEnd - tailStart > 600) {
    throw new Error("Unsupported Codex native model-selection lifecycle");
  }
  const tail = source.slice(tailStart, tailEnd + 1);
  const legacyTail = new RegExp(
    `^,${aggregateSelectionEscape(selection)}\\.target\\[0\\]={2,3}(["'\`])default\\1&&${aggregateSelectionEscape(store)}\\.set\\(([\\w$]+),null\\)\\)\\}$`,
  ).exec(tail);
  if (tail !== ")}" && (!legacyTail || [store, selection, cleanup, inFlightName, queuedName].includes(legacyTail[2]))) {
    throw new Error("Unsupported Codex native model-selection lifecycle");
  }
  const declarations = [queuedName, inFlightName].map(name => {
    const matches = Array.from(source.matchAll(new RegExp(
      `${aggregateSelectionEscape(name)}=([\\w$]+)\\(([\\w$]+),[\\w$]+=>null\\)`, "g",
    )));
    if (matches.length !== 1) throw new Error("Unsupported Codex native model-selection family declaration");
    return matches[0];
  });
  if (declarations[0][1] !== declarations[1][1] || declarations[0][2] !== declarations[1][2]) {
    throw new Error("Unsupported Codex native model-selection scope");
  }
  const queue = source.slice(Math.min(...declarations.map(match => match.index)),
    Math.max(...declarations.map(match => match.index)) + 4000);
  for (const name of [queuedName, inFlightName]) {
    if (!new RegExp(`[\\w$]+\\.set\\(${aggregateSelectionEscape(name)},([\\w$]+)\\.target,\\1\\.selection\\)`).test(queue)) {
      throw new Error("Unsupported Codex native model-selection queue");
    }
  }
  if (!/await [\w$]+\.write\(\)/.test(queue)
      || !new RegExp(`${aggregateSelectionEscape(cleanup)}\\([\\w$]+,[\\w$]+\\)`).test(queue)) {
    throw new Error("Unsupported Codex native model-selection commit");
  }
  const queued = aggregateSelectionExport(source, module, queuedName);
  const inFlight = aggregateSelectionExport(source, module, inFlightName);
  if (!queued.scope?.id || queued.scope !== inFlight.scope) {
    throw new Error("Codex native model-selection scope is unavailable");
  }
  return { queued, inFlight };
}


// Rspack entries expose their already-loaded registry through their cached ESM
// namespace. Never call require(), evaluate a factory, or load an async chunk.
function aggregateSelectionWebpackEntryUrls(doc, pageLocation) {
  const urls = new Set();
  for (const script of Array.from(doc?.scripts || [])) {
    if (script.type !== "module" || !script.src) continue;
    try {
      const url = new URL(script.src, pageLocation.href);
      const directory = new URL("./assets/", pageLocation.href);
      if (url.origin === pageLocation.origin && url.pathname.startsWith(directory.pathname)
          && !url.pathname.slice(directory.pathname.length).includes("/")
          && /\/assets\/[\w-]+\.[\w-]+\.js$/.test(url.pathname)) urls.add(url.href);
    } catch (_) {}
  }
  return Array.from(urls);
}

function aggregateSelectionWebpackExport(source, module, localName) {
  // Both Rspack export forms are name mappings. Inspect only the final export
  // registration, not similar object literals in a function's implementation.
  const registrations = Array.from(source.matchAll(/[\w$]+\.d\([\w$]+,\{/g));
  if (registrations.length !== 1) throw new Error("Unsupported Codex native selection exports");
  const exports = source.slice(registrations[0].index);
  const matches = Array.from(exports.matchAll(new RegExp(
    '(?:[,{])([\\w$]+):(?:\\(\\)=>)?' + aggregateSelectionEscape(localName) + '(?=[,}])', 'g',
  )));
  if (matches.length !== 1 || module?.[matches[0][1]] == null) {
    throw new Error("Codex native model-selection state is unavailable");
  }
  return module[matches[0][1]];
}

function aggregateSelectionCachedImport(registry, source, alias) {
  const matches = Array.from(source.matchAll(new RegExp(
    '(?:var |let |const |,)' + aggregateSelectionEscape(alias) + '=[\\w$]+\\(["\']([^"\']+)["\']\\)', 'g',
  )));
  if (matches.length !== 1) throw new Error("Unsupported Codex native selection import");
  const cached = registry.c[matches[0][1]];
  if (!cached || cached.error || !cached.exports) throw new Error("Codex native selection dependency is not loaded");
  return cached.exports;
}

function discoverAggregateNativeSelectionWebpackFamily(source, module, registry) {
  // 26.1103 inlines cleanup after await write(). Capture the whole guarded
  // commit/resolve relationship, including exact-selection identity and both
  // families. A changed lifecycle must fail closed rather than confirm a label.
  const matches = Array.from(source.matchAll(
    /try\{([\w$]+)=await ([\w$]+)\.write\(\)\}catch\{\}([\w$]+)=([\w$]+),([\w$]+)=\2,\3\.get\(([\w$]+),\5\.target\)===\5\.selection&&\(\3\.set\(\6,\5\.target,null\),\3\.get\(([\w$]+),\5\.target\)===\5\.selection&&\3\.set\(\7,\5\.target,null\)\),\2\.resolve\(\1\),([\w$]+)=!1,null!=([\w$]+)&&null==([\w$]+)&&([\w$]+)\(\)/g,
  ));
  if (matches.length !== 1) throw new Error("Unsupported Codex native model-selection lifecycle");
  const match = matches[0];
  const [, result, item, , store, , inFlightName, queuedName, busy, pending, timer, run] = match;
  const esc = aggregateSelectionEscape;
  if (inFlightName === queuedName) throw new Error("Unsupported Codex native model-selection families");
  const beforeCommit = new RegExp('if\\(' + esc(busy) + '\\|\\|null==' + esc(pending)
    + '\\)return;let ' + esc(item) + '=' + esc(pending) + ';' + esc(pending) + '=null,'
    + esc(busy) + '=!0,' + esc(store) + '\\.set\\(' + esc(inFlightName) + ',' + esc(item)
    + '\\.target,' + esc(item) + '\\.selection\\);let ' + esc(result) + '=!1;$');
  if (!beforeCommit.test(source.slice(0, match.index))) throw new Error("Unsupported Codex native model-selection commit");
  const queue = new RegExp('return ([\\w$]+)=>\\{let ([\\w$]+)=' + esc(pending) + ';'
    + esc(store) + '\\.set\\(' + esc(queuedName) + ',\\1\\.target,\\1\\.selection\\),'
    + esc(pending) + '=\\1,null!=\\2&&\\2\\.resolve\\(!1\\),null!=' + esc(timer)
    + '&&clearTimeout\\(' + esc(timer) + '\\),' + esc(timer) + '=setTimeout\\(\\(\\)=>\\{'
    + esc(timer) + '=null,async function ' + esc(run) + '\\(\\)\\{');
  if (!queue.test(source)) throw new Error("Unsupported Codex native model-selection queue");
  const declarations = [queuedName, inFlightName].map(name => {
    const found = Array.from(source.matchAll(new RegExp(esc(name)
      + '=\\(0,([\\w$]+)\\.([\\w$]+)\\)\\(([\\w$]+)\\.([\\w$]+),[\\w$]+=>null\\)', 'g')));
    if (found.length !== 1) throw new Error("Unsupported Codex native model-selection family declaration");
    return found[0];
  });
  if (declarations[0].slice(1).join('.') !== declarations[1].slice(1).join('.')) {
    throw new Error("Unsupported Codex native model-selection scope");
  }
  const declaration = declarations[0];
  const scope = aggregateSelectionCachedImport(registry, source, declaration[3])[declaration[4]];
  const queued = aggregateSelectionWebpackExport(source, module, queuedName);
  const inFlight = aggregateSelectionWebpackExport(source, module, inFlightName);
  if (!scope?.id || scope.__scopeBrand !== "AppScope" || queued.scope !== scope || inFlight.scope !== scope) {
    throw new Error("Codex native model-selection scope is unavailable");
  }
  return { queued, inFlight };
}

function discoverAggregateNativeSelectionWebpackBindings(module) {
  const registry = module?.__webpack_require__;
  if (typeof registry !== "function" || !registry.c || !registry.m) {
    throw new Error("Unsupported Codex native model-selection registry");
  }
  const entries = Object.entries(registry.m);
  if (entries.length > 20000) throw new Error("Unsupported Codex native model-selection module count");
  const families = [], composers = new Set();
  for (const [id, factory] of entries) {
    const cached = registry.c[id];
    if (!cached || cached.error || typeof factory !== "function") continue;
    const source = Function.prototype.toString.call(factory);
    if (source.length > 2000000) continue;
    if (source.includes(".target") && source.includes(".selection") && source.includes(".write()")
        && source.includes("setTimeout(")) {
      families.push(discoverAggregateNativeSelectionWebpackFamily(source, cached.exports, registry));
    }
    const declarations = Array.from(source.matchAll(/([\w$]+)=\(0,[\w$]+\.[\w$]+\)\(["']ComposerScope["'],\{key:/g));
    for (const declaration of declarations) {
      const token = aggregateSelectionWebpackExport(source, cached.exports, declaration[1]);
      if (!token?.id || token.__scopeBrand !== "ComposerScope"
          || token.parent?.__scopeBrand !== "RouteScope" || typeof token.getKey !== "function") {
        throw new Error("Codex native composer scope is unavailable");
      }
      composers.add(token);
    }
  }
  if (families.length !== 1 || composers.size !== 1) {
    throw new Error("Codex native model-selection modules are unavailable or ambiguous");
  }
  return { ...families[0], composerScope: composers.values().next().value };
}

async function loadAggregateNativeSelectionBindings(options) {
  const legacyUrl = options.assetUrl("app-initial-");
  if (legacyUrl) {
    const [module, response] = await Promise.all([
      options.loadModule("app-initial-"), (options.fetch || fetch)(legacyUrl),
    ]);
    if (!response.ok) throw new Error("无法读取 Codex 模型保存模块。");
    return discoverAggregateNativeSelectionBindings(await response.text(), module);
  }
  const urls = aggregateSelectionWebpackEntryUrls(options.document || document, options.location || location);
  if (!urls.length) throw new Error("Codex 模型保存模块尚未加载。");
  const registries = new Map();
  for (const url of urls) {
    const name = new URL(url).pathname.split('/').pop();
    if (options.assetUrl(name) !== url) throw new Error("Codex 模型保存模块来源不明确。");
    const module = await options.loadModule(name);
    if (typeof module?.__webpack_require__ === "function") registries.set(module.__webpack_require__, module);
  }
  if (registries.size !== 1) throw new Error("Codex 模型保存模块尚未就绪或来源不明确。");
  return discoverAggregateNativeSelectionWebpackBindings(registries.values().next().value);
}

function readAggregateNativeSelectionDetails(bindings, chain) {
  const unknown = () => ({ known: false, busy: true });
  try {
    const families = [bindings?.queued, bindings?.inFlight];
    const token = families[0]?.scope;
    if (!(chain instanceof Map) || !token?.id || token !== families[1]?.scope) return unknown();
    const root = chain.get(token.id);
    if (typeof root?.store?.get !== "function" || !(root.familyBindings instanceof Map)) return unknown();
    let busy = false;
    let inspected = 0;
    const queued = [];
    const inFlight = [];
    for (let familyIndex = 0; familyIndex < families.length; familyIndex += 1) {
      const family = families[familyIndex];
      const members = root.familyBindings.get(family);
      // Model settings normally read both families even when their value is
      // null. Missing retained reads are not evidence of a completed save.
      if (!(members instanceof Map) || members.size === 0) return unknown();
      for (const [target, member] of members.entries()) {
        if (++inspected > 1000) return unknown();
        const retained = member?.value;
        if (!retained || (typeof retained !== "object" && typeof retained !== "function")) return unknown();
        let atom;
        // Current native bindings retain an already-resolved writable handle.
        // Read its atom only through the exact owning store; never call a
        // handle's writer or mistake a foreign-store handle for a descriptor.
        if ("atom" in retained || "store" in retained) {
          if (retained.store !== root.store || retained.atom == null) return unknown();
          atom = retained.atom;
        } else {
          if (typeof retained.resolve !== "function") return unknown();
          atom = retained.resolve(root, chain);
          if (atom == null) return unknown();
        }
        const value = root.store.get(atom);
        if (value === undefined) return unknown();
        // Conservatively wait for all retained native model saves in this
        // exact store, including other default-directory keys. Never guess
        // which default target belongs to a not-yet-created conversation.
        if (value !== null) {
          busy = true;
          (familyIndex === 0 ? queued : inFlight).push({ target, selection: value });
        }
      }
    }
    return { known: true, busy, queued, inFlight };
  } catch (_) { return unknown(); }
}

function readAggregateNativeSelectionPending(bindings, chain) {
  const details = readAggregateNativeSelectionDetails(bindings, chain);
  return { known: details.known, busy: details.busy };
}
