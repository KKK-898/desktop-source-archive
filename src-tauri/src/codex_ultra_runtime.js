// Local, reversible model-query adaptation using declared catalog capabilities.
// Never changes an account-wide flag, application files, or desktop opt-in.
var CODEX_ULTRA_RUNTIME_VERSION = 9;
var CODEX_ULTRA_RUNTIME_QUERY_SHAPE = '({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,hostId:i,includeUltraReasoningEffort:a,isCustomModelProvider:o,limit:s,modelCatalogPath:c,modelProvider:l},{get:u,queryClient:d,scope:f})=>{let p=Pd?.daybreakPreferences!=null&&i===`local`&&t===`apikey`,m=p?zc(u,`api_key_daybreak_preference`)?.apiKeySession:void 0,h=m!=null&&u(dHe,i),g=yee(i,t,s,p?m??`unavailable`:void 0),_=n==null?u(GRi):new Set([...n,`persistent`]),v=u(BRi),y=a&&u(kc,`1186680773`);return{queryKey:[...g,...o?[l]:[],...c==null?[]:[c]],enabled:u(Ie).includes(i),refetchOnWindowFocus:!0,staleTime:Qg.FIVE_MINUTES,queryFn:({queryKey:e})=>{let t=d.getQueryData(e)==null?`interactive`:`background`;return o&&d.removeQueries({exact:!0,queryKey:g}),jg(f,i).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:s},{priority:t})},select:({data:n})=>ARi({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:h,authMethod:t,availableModels:v.availableModels,defaultModel:v.defaultModel,enabledReasoningEfforts:_,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:y,isCustomModelProvider:o,models:n,useHiddenModels:v.useHiddenModels})}}';
// 26.1013 adds a team catalog and a cancellation signal. Keep its native query
// identity/enablement intact; team consumers are never eligible for our hook.
var CODEX_ULTRA_RUNTIME_TEAM_QUERY_SHAPE = '({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,hostId:i,includeUltraReasoningEffort:a,isCustomModelProvider:o,limit:s,modelCatalogPath:c,modelProvider:l,teamCatalog:u},{get:d,queryClient:f,scope:p})=>{let m=u!=null,h=Oi?.daybreakPreferences!=null&&i===`local`&&t===`apikey`,g=h?Dh(d,`api_key_daybreak_preference`)?.apiKeySession:void 0,_=g!=null&&d(Ntr,i),v=VIn(i,t,s,h?g??`unavailable`:void 0),y=n==null?d(vvo):new Set([...n,`persistent`]),b=d(svo),x=a&&d(rg,`1186680773`);return{queryKey:m?[`models`,`list`,i,`team`,u]:[...v,...o?[l]:[],...c==null?[]:[c]],enabled:m?u.accountId!=null&&u.userId!=null:d(Ih).includes(i),refetchOnWindowFocus:!0,staleTime:Zi.FIVE_MINUTES,queryFn:({queryKey:e,signal:t})=>{let n=f.getQueryData(e)==null?`interactive`:`background`;return o&&f.removeQueries({exact:!0,queryKey:v}),Vh(p,i).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:s},{priority:n})},select:({data:n})=>lvo({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:_,authMethod:t,availableModels:b.availableModels,defaultModel:b.defaultModel,enabledReasoningEfforts:y,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:x,isCustomModelProvider:o,models:n,useHiddenModels:b.useHiddenModels})}}';
// 26.1016 reads the API-key daybreak preference through a subscribed native
// signal. Preserve that reactive read and all team/query semantics unchanged.
var CODEX_ULTRA_RUNTIME_SIGNAL_QUERY_SHAPE = '({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,hostId:i,includeUltraReasoningEffort:a,isCustomModelProvider:o,limit:s,modelCatalogPath:c,modelProvider:l,teamCatalog:u},{get:d,queryClient:f,scope:p})=>{let m=u!=null,h=Js?.daybreakPreferences!=null&&i===`local`&&t===`apikey`,g=h?d(Jir)?.apiKeySession:void 0,_=g!=null&&d(Zir,i),v=_zn(i,t,s,h?g??`unavailable`:void 0),y=n==null?d(lIo):new Set([...n,`persistent`]),b=d(QFo),x=a&&d(Fh,`1186680773`);return{queryKey:m?[`models`,`list`,i,`team`,u]:[...v,...o?[l]:[],...c==null?[]:[c]],enabled:m?u.accountId!=null&&u.userId!=null:d(dh).includes(i),refetchOnWindowFocus:!0,staleTime:fu.FIVE_MINUTES,queryFn:({queryKey:e,signal:t})=>{let n=f.getQueryData(e)==null?`interactive`:`background`;return o&&f.removeQueries({exact:!0,queryKey:v}),gh(p,i).sendRequest(`model/list`,{includeHidden:!0,cursor:null,limit:s},{priority:n})},select:({data:n})=>eIo({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:_,authMethod:t,availableModels:b.availableModels,defaultModel:b.defaultModel,enabledReasoningEfforts:y,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:x,isCustomModelProvider:o,models:n,useHiddenModels:b.useHiddenModels})}}';

// 26.1029 uses cached Rspack modules, a loading team sentinel and a tagged
// select envelope. Only this reviewed callback is eligible; team consumers stay native.
var CODEX_ULTRA_RUNTIME_WEBPACK_QUERY_SHAPE = "({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:n,hasConfiguredModelCatalog:r,hostId:a,includeUltraReasoningEffort:o,isCustomModelProvider:i,limit:u,modelCatalogPath:c,modelProvider:g,teamCatalog:w},{get:b,queryClient:E,scope:_})=>{let M=null!=w,D=\"loading\"===w?null:w,A=p.appServices?.daybreakPreferences!=null&&a===m.fI&&\"apikey\"===t,R=A?b(f.i)?.apiKeySession:void 0,k=null!=R&&b(h.dK,a),O=(0,I.o)(a,t,u,A?R??\"unavailable\":void 0),S=null==n?b(x.pN):new Set([...n,\"persistent\"]),U=b(C.t),F=o&&b(v.JW,\"1186680773\");return{queryKey:M?[\"models\",\"list\",a,\"team\",w]:[...O,...i?[g]:[],...null==c?[]:[c]],enabled:M?D?.accountId!=null&&null!=D.userId:b(s.Dj).includes(a),refetchOnWindowFocus:!0,staleTime:y.D.FIVE_MINUTES,queryFn:async({queryKey:e,signal:t})=>{let n=null==E.getQueryData(e)?\"interactive\":\"background\";return i&&E.removeQueries({exact:!0,queryKey:O}),(0,d.V)(_,a).sendRequest(\"model/list\",{includeHidden:!0,cursor:null,limit:u},{priority:n})},select:({data:n,isTeamCatalog:a=!1})=>({...(0,l.a)({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:k,authMethod:t,availableModels:U.availableModels,defaultModel:U.defaultModel,enabledReasoningEfforts:S,hasConfiguredModelCatalog:r,includeUltraReasoningEffort:F,isCustomModelProvider:i,models:n,useHiddenModels:U.useHiddenModels}),isTeamCatalog:a})}}";

// 26.1103 derives provider/catalog from the reactive native configuration and
// filters model specialties. Keep both decisions native and verify the read route.
var CODEX_ULTRA_RUNTIME_CONFIG_QUERY_SHAPE = "({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:a,hostId:n,includeUltraReasoningEffort:l=!0,limit:i=100,specialty:u,teamCatalog:h},{get:x,queryClient:k,scope:I})=>{let{data:M}=x(w.I2,n,{enabled:!1}),S=null==M?null:(0,c.Y$)(M.config),A=(0,c.cc)(S),L=\"string\"==typeof S?.model_provider?S.model_provider:null,N=\"string\"==typeof S?.model_catalog_json?S.model_catalog_json:null,_=null!=h,z=\"loading\"===h?null:h,P=g.appServices?.daybreakPreferences!=null&&n===p.fI&&\"apikey\"===t,T=P?x(f.i)?.apiKeySession:void 0,R=null!=T&&x(m.dK,n),E=(0,y.o)(n,t,i,P?T??\"unavailable\":void 0),D=null==a?x(C.pN):new Set([...a,\"persistent\"]),U=x(j.t),K=l&&x(v.JW,\"1186680773\");return{queryKey:_?[\"models\",\"list\",n,\"team\",h]:[...E,...A?[L]:[],...null==N?[]:[N]],enabled:_?z?.accountId!=null&&null!=z.userId:x(d.Dj).includes(n),refetchOnWindowFocus:!0,staleTime:b.D.FIVE_MINUTES,queryFn:async({queryKey:e,signal:t})=>{let a=null==k.getQueryData(e)?\"interactive\":\"background\";return A&&k.removeQueries({exact:!0,queryKey:E}),(0,r.V)(I,n).sendRequest(\"model/list\",{includeHidden:!0,cursor:null,limit:i},{priority:a})},select:({data:a,isTeamCatalog:n=!1})=>({...(0,o.a)({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:R,authMethod:t,availableModels:U.availableModels,defaultModel:U.defaultModel,enabledReasoningEfforts:D,hasConfiguredModelCatalog:(0,s.bo)(S),includeUltraReasoningEffort:K,isCustomModelProvider:A,models:null==u?a:a.filter(e=>e.modelSpecialty===u),useHiddenModels:U.useHiddenModels}),isTeamCatalog:n})}}";

// Alpha-equivalence permits build-specific minified binding names, but preserves
// property names, literals, operators and the entire reviewed control flow.
// 26.1111 preserves the reviewed reactive config/query/filter contract, but
// minifier scope reuse differs. Keep its complete callback as a separate exact
// contract instead of weakening identifier/control-flow validation globally.
var CODEX_ULTRA_RUNTIME_261111_QUERY_SHAPE = "({additionalAvailableModels:e,authMethod:t,enabledReasoningEfforts:r,hostId:n,includeUltraReasoningEffort:i=!0,limit:o=100,specialty:u,teamCatalog:h},{get:x,queryClient:k,scope:I})=>{let{data:S}=x(y.I2,n,{enabled:!1}),j=null==S?null:(0,c.Y$)(S.config),A=(0,c.cc)(j),T=\"string\"==typeof j?.model_provider?j.model_provider:null,P=\"string\"==typeof j?.model_catalog_json?j.model_catalog_json:null,E=null!=h,N=\"loading\"===h?null:h,M=m.appServices?.daybreakPreferences!=null&&n===g.fI&&\"apikey\"===t,O=M?x(p.i)?.apiKeySession:void 0,F=null!=O&&x(f.dK,n),R=(0,_.o)(n,t,o,M?O??\"unavailable\":void 0),D=null==r?x(C.pN):new Set([...r,\"persistent\"]),L=x(w.t),z=i&&x(v.JW,\"1186680773\");return{queryKey:E?[\"models\",\"list\",n,\"team\",h]:[...R,...A?[T]:[],...null==P?[]:[P]],enabled:E?N?.accountId!=null&&null!=N.userId:x(d.Dj).includes(n),refetchOnWindowFocus:!0,staleTime:b.D.FIVE_MINUTES,queryFn:async({queryKey:e,signal:t})=>{let r=null==k.getQueryData(e)?\"interactive\":\"background\";return A&&k.removeQueries({exact:!0,queryKey:R}),(0,s.V)(I,n).sendRequest(\"model/list\",{includeHidden:!0,cursor:null,limit:o},{priority:r})},select:({data:r,isTeamCatalog:n=!1})=>({...(0,a.a)({additionalAvailableModels:new Set(e),apiKeyDaybreakSupported:F,authMethod:t,availableModels:L.availableModels,defaultModel:L.defaultModel,enabledReasoningEfforts:D,hasConfiguredModelCatalog:(0,l.bo)(j),includeUltraReasoningEffort:z,isCustomModelProvider:A,models:null==u?r:r.filter(e=>e.modelSpecialty===u),useHiddenModels:L.useHiddenModels}),isTeamCatalog:n})}}";

function codexUltraCanonical(source) {
  const tokens = source.match(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\?\.|\S/g) || [];
  const names = new Map();
  const reserved = new Set(['let', 'const', 'var', 'return', 'new', 'null', 'void', 'true', 'false', 'Set']);
  return tokens.map((token, index) => {
    // Quotes are a bundler formatting detail, not a capability or control-flow change.
    if (/^["'`]/.test(token) && !token.includes("\\") && !token.includes("${")) return JSON.stringify(token.slice(1, -1));
    if (!/^[A-Za-z_$][\w$]*$/.test(token) || reserved.has(token)
        || tokens[index + 1] === ':' || ['.', '?.'].includes(tokens[index - 1])) return token;
    if (!names.has(token)) names.set(token, `#${names.size}`);
    return names.get(token);
  }).join('');
}

function codexUltraBlockEnd(source, start) {
  let depth = 0;
  let quote = '';
  for (let index = start; index < Math.min(source.length, start + 16000); index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') { index += 1; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if ('"\'`'.includes(char)) quote = char;
    else if (char === '/') return -1;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return index + 1;
  }
  return -1;
}

function inspectCodexUltraRuntimeSource(source, allowResponseFallback = false) {
  const candidates = [];
  for (const match of source.matchAll(/\(\s*\{\s*additionalAvailableModels\s*:[^{}]{1,1200}\}\s*,\s*\{[^{}]{1,500}\}\s*\)\s*=>\s*\{/g)) {
    if (!match[0].includes('includeUltraReasoningEffort') || !match[0].includes('queryClient')) continue;
    const end = codexUltraBlockEnd(source, match.index + match[0].length - 1);
    if (end < 0) throw new Error('Unsupported Codex Ultra query boundary');
    candidates.push(source.slice(match.index, end));
  }
  const reference = CODEX_ULTRA_RUNTIME_QUERY_SHAPE;
  const patched = reference.replace('a&&u(kc,`1186680773`)', 'a&&(u(kc,`1186680773`)||t===`apikey`&&o&&r)');
  const matched = candidates.length === 1 && [reference, patched, CODEX_ULTRA_RUNTIME_TEAM_QUERY_SHAPE, CODEX_ULTRA_RUNTIME_SIGNAL_QUERY_SHAPE, CODEX_ULTRA_RUNTIME_WEBPACK_QUERY_SHAPE, CODEX_ULTRA_RUNTIME_CONFIG_QUERY_SHAPE, CODEX_ULTRA_RUNTIME_261111_QUERY_SHAPE].find(value =>
    codexUltraCanonical(value) === codexUltraCanonical(candidates[0]));
  if (!matched) {
    // A live native query may outlive the exact bundled callback contract. Only
    // its already loaded, reviewed query-family lifecycle is reused below; no
    // callback source is evaluated. Capability declarations authorize the
    // response adapter, not a global feature gate or a guessed model list.
    if (allowResponseFallback && candidates.length === 1 && candidates[0].includes('model/list')) {
      return { callback: candidates[0], responseFallback: true,
        configInQuery: candidates[0].includes('model_catalog_json'),
        defaultUltra: /includeUltraReasoningEffort\s*:\s*[\w$]+\s*=\s*(?:!0|true)(?=,|\})/.test(candidates[0]) };
    }
    throw new Error('Unsupported Codex Ultra model-query contract');
  }
  return {
    callback: candidates[0],
    configInQuery: [CODEX_ULTRA_RUNTIME_CONFIG_QUERY_SHAPE, CODEX_ULTRA_RUNTIME_261111_QUERY_SHAPE].includes(matched),
    select: codexUltraCanonical(matched.slice(matched.indexOf('select:') + 7, -2)),
    queryFn: codexUltraCanonical(matched.slice(matched.indexOf('queryFn:') + 8, matched.indexOf(',select:'))),
  };
}

// Match the reviewed native profile projection using only the configuration
// returned by this query's own reactive read. Do not consult global account state.
function codexUltraProjectedConfig(raw) {
  const record = value => value != null && typeof value === 'object' && !Array.isArray(value);
  if (!record(raw)) return null;
  const profile = typeof raw.profile === 'string' && record(raw.profiles)
    && Object.prototype.hasOwnProperty.call(raw.profiles, raw.profile) ? raw.profiles[raw.profile] : null;
  const config = record(profile) ? { ...raw, ...Object.fromEntries(Object.entries(profile).filter(([, value]) => value != null)) } : raw;
  if (typeof config.model_provider !== 'string' || !record(config.model_providers)
      || !Object.prototype.hasOwnProperty.call(config.model_providers, config.model_provider)
      || typeof config.model_catalog_json !== 'string' || !config.model_catalog_json.trim()) return null;
  return { provider: config.model_provider, catalog: config.model_catalog_json };
}

function codexUltraNativeGet(root, chain, descriptor, ...args) {
  if (!descriptor) throw new Error('Codex Ultra native setting is unavailable');
  if (typeof descriptor.read === 'function' && descriptor.scope) {
    return descriptor.read(root, chain, ...args);
  }
  const owner = descriptor.scope?.id ? chain.get(descriptor.scope.id) : root;
  if (!owner?.store || typeof owner.store.get !== 'function') {
    throw new Error('Codex Ultra native setting store is unavailable');
  }
  if (descriptor.store && descriptor.atom) {
    if (descriptor.store !== owner.store) throw new Error('Codex Ultra setting belongs to another store');
    return owner.store.get(descriptor.atom);
  }
  if (typeof descriptor.resolve !== 'function') throw new Error('Unsupported Codex Ultra setting descriptor');
  return owner.store.get(descriptor.resolve(owner, chain, ...args));
}

// The 26.1103 family read signature reserves its fourth argument for an atom
// reader. Native query options are the fifth argument, as in its scope.get.
function codexUltraNativeConfigGet(root, chain, descriptor, ...args) {
  if (args.length < 2) return codexUltraNativeGet(root, chain, descriptor, ...args);
  if (args.length !== 2 || args[1]?.enabled !== false || Object.keys(args[1]).length !== 1
      || !descriptor?.scope || typeof descriptor.read !== 'function') {
    throw new Error('Unsupported Codex Ultra native configuration read');
  }
  const owner = descriptor.scope.id ? chain.get(descriptor.scope.id) : root;
  if (!owner?.store) throw new Error('Codex Ultra native configuration owner is unavailable');
  return descriptor.read(owner, chain, args[0], undefined, args[1]);
}

function codexUltraScopeChains() {
  const chains = new Set(typeof codexUltraVisiblePickerState === 'function'
    ? codexUltraVisiblePickerState().chains || [] : []);
  const elements = Array.from(document.querySelectorAll(
    '[data-codex-intelligence-trigger], [data-composer-navigation-target="reasoning"], #root, #root > *, body > *',
  )).slice(0, 100);
  const inspect = value => {
    const chain = value instanceof Map ? value : value?.chain;
    if (chain instanceof Map) chains.add(chain);
  };
  for (const element of elements) {
    const key = Object.keys(element).find(value => value.startsWith('__reactFiber$')
      || value.startsWith('__reactInternalInstance$'));
    let start = key ? element[key] : null;
    let top = start;
    while (top?.return) top = top.return;
    if (top?.stateNode?.current && top.stateNode.current !== top) start = start?.alternate || start;
    for (let fiber = start, depth = 0; fiber && depth < 100; fiber = fiber.return, depth += 1) {
      inspect(fiber.memoizedProps?.value);
      for (let context = fiber.dependencies?.firstContext, count = 0;
        context && count < 40; context = context.next, count += 1) inspect(context.memoizedValue);
    }
  }
  return chains;
}

function codexUltraExport(source, module, local) {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = Array.from(source.slice(source.lastIndexOf('export{')).matchAll(
    new RegExp('(?:[,{])' + escape(local) + ' as ([\\w$]+)(?=[,}])', 'g'),
  ));
  if (matches.length !== 1 || typeof module?.[matches[0][1]] !== 'function') {
    throw new Error('Codex Ultra native query factory export is unavailable');
  }
  return module[matches[0][1]];
}

function discoverCodexUltraQueryFactory(initial, shared, module) {
  // The query family owns each consumer's actual arguments. Resolve its native
  // querySignal constructor from the reviewed factory, not a minified name.
  const declaration = Array.from(initial.matchAll(/([\w$]+)=([\w$]+)\(([\w$]+),\(\{additionalAvailableModels:/g));
  if (declaration.length !== 1) throw new Error('Unsupported Codex Ultra query-family declaration');
  const local = declaration[0][2];
  let imported = null;
  for (const match of initial.matchAll(/import\{([^;]+)\}from["`]([^"`]+)["`]/g)) {
    if (!/app-shared-[^/]+\.js$/.test(match[2])) continue;
    for (const item of match[1].split(',')) {
      const parts = item.trim().split(/\s+as\s+/);
      if (parts[1] === local) {
        if (imported) throw new Error('Ambiguous Codex Ultra query-family import');
        imported = parts[0];
      }
    }
  }
  if (!imported) throw new Error('Codex Ultra query-family import is unavailable');
  const exports = Array.from(shared.slice(shared.lastIndexOf('export{')).matchAll(/(?:[,{])([\w$]+) as ([\w$]+)(?=[,}])/g));
  const names = exports.filter(match => match[2] === imported);
  if (names.length !== 1) throw new Error('Codex Ultra query-family export is unavailable');
  const at = shared.indexOf('function ' + names[0][1] + '(');
  const body = shared.indexOf('{', at), end = codexUltraBlockEnd(shared, body);
  if (at < 0 || end < 0) throw new Error('Unsupported Codex Ultra query-family factory');
  const declarationSource = shared.slice(at, end);
  const reference = 'function $k(e,t,n){return Kk(Gk(e,n=>Qk(e,e=>t(n,e)),{...n,autoDispose:n?.autoDispose??!0}))}';
  if (codexUltraCanonical(declarationSource) !== codexUltraCanonical(reference)) {
    throw new Error('Unsupported Codex Ultra query-family lifecycle');
  }
  const querySignal = /=>([\w$]+)\([\w$]+,[\w$]+=>/.exec(declarationSource)?.[1];
  if (!querySignal) throw new Error('Codex Ultra native query signal is unavailable');
  return codexUltraExport(shared, module, querySignal);
}

// Inspect only same-document module entries, never imports or lazy chunks. A
// newer native document may publish several Rspack chunks before its runtime.
// All candidates must be read before selecting one; ambiguity stays fail-closed.
function codexUltraWebpackEntryUrls() {
  if (typeof document === 'undefined' || typeof location === 'undefined') return [];
  if (document.readyState !== 'complete') return [];
  const scripts = Array.from(document.scripts || []);
  if (scripts.length > 128) throw new Error('Unsupported Codex Ultra document script count');
  const base = new URL(location.href), directory = new URL('./assets/', base);
  const urls = Array.from(new Set(scripts.filter(script => script.type === 'module')
    .map(script => script.src).filter(Boolean).filter(address => {
      try { const url = new URL(address, base);
        return url.protocol === base.protocol && url.host === base.host
          && url.origin === base.origin && !url.username && !url.password && !url.search && !url.hash
          && url.pathname.startsWith(directory.pathname)
          && !url.pathname.slice(directory.pathname.length).includes('/')
          && /\/assets\/[\w-]+\.[\w-]+\.js$/.test(url.pathname);
      } catch (_) { return false; }
    })));
  if (urls.length > 16) throw new Error('Unsupported Codex Ultra module entry count');
  return urls;
}

function codexUltraIsWebpackRuntimeSource(source) {
  return typeof source === 'string' && /\bas\s+__webpack_require__\b/.test(source)
    && source.includes('.__rspack_esm_ids') && source.includes('.__webpack_modules__');
}

// A script tag alone is not evidence that its module was loaded. In
// particular, our source-only fetch must never authorize importing a newly
// inserted tag. Require the browser's completed script-resource record.
function codexUltraWebpackEntryLoaded(url) {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return false;
  return performance.getEntriesByName(url, 'resource').some(entry => entry.name === url
    && entry.entryType === 'resource' && entry.initiatorType === 'script'
    && Number.isFinite(entry.responseEnd) && entry.responseEnd > 0);
}

async function codexUltraWebpackEntryUrl(options = {}) {
  const urls = codexUltraWebpackEntryUrls();
  if (!urls.length) return '';
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeout, bytes = 0;
  try {
    return await Promise.race([
      (async () => {
        const matches = [];
        for (const url of urls) {
          if (controller?.signal.aborted) throw new Error('Codex Ultra entry discovery cancelled');
          const response = await fetch(url, { cache: 'force-cache', ...(controller ? { signal: controller.signal } : {}) });
          if (!response.ok) throw new Error('Codex Ultra entry source is unavailable');
          const length = Number(response.headers?.get?.('content-length'));
          if (Number.isFinite(length) && length > 24 * 1024 * 1024) throw new Error('Unsupported Codex Ultra entry source size');
          const source = await response.text();
          if (controller?.signal.aborted) throw new Error('Codex Ultra entry discovery cancelled');
          bytes += source.length;
          if (bytes > 24 * 1024 * 1024) throw new Error('Unsupported Codex Ultra entry source size');
          if (codexUltraIsWebpackRuntimeSource(source)) matches.push(url);
        }
        if (matches.length > 1) throw new Error('Ambiguous Codex Ultra runtime entries');
        if (JSON.stringify(urls) !== JSON.stringify(codexUltraWebpackEntryUrls())) throw new Error('Codex Ultra document entries changed');
        return matches.length === 1 && codexUltraWebpackEntryLoaded(matches[0]) ? matches[0] : '';
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => {
        controller?.abort();
        reject(new Error('Codex Ultra entry discovery timed out'));
      }, options.assetTimeoutMs ?? 3000); }),
    ]);
  } finally { clearTimeout(timeout); }
}

function discoverCodexUltraWebpackRuntime(module, allowResponseFallback = false) {
  const require = module?.__webpack_require__;
  if (typeof require !== 'function' || !require.m || !require.c) throw new Error('Unsupported Codex Ultra module registry');
  const entries = Object.entries(require.m);
  if (entries.length > 20000) throw new Error('Unsupported Codex Ultra module count');
  const contracts = new Map(), constructors = new Set(), ownedFamilies = new Set();
  const imported = (source, local) => {
    const escaped = local.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
    const matches = Array.from(source.matchAll(new RegExp('(?:var |let |const |,)' + escaped + '=([\\w$]+)\\(["\']([^"\']+)["\']\\)', 'g')));
    if (matches.length !== 1) throw new Error('Ambiguous Codex Ultra native import');
    return require.c[matches[0][2]]?.exports;
  };
  const cachedSources = [];
  const factoryShape = 'function a(e,t,n){let r=(0,i.T)(e,n=>{let i=(0,o.R)(e,e=>t(n,e));return i.debugLabel=r.debugLabel,i},{...n,autoDispose:n?.autoDispose??!0});return(0,i.$)(r)}';
  const integratedFactoryShape = 'function L(e,t,n){let i=(0,o.T)(e,n=>{let r=b(e,e=>t(n,e));return r.debugLabel=i.debugLabel,r},{...n,autoDispose:n?.autoDispose??!0});return(0,o.$)(i)}';
  for (const [id, factory] of entries) {
    // Cached only: reading module exports cannot initialize auth/account services.
    const cached = require.c[id];
    if (!cached || cached.error || typeof factory !== 'function') continue;
    const source = Function.prototype.toString.call(factory);
    if (source.length > 2000000) continue;
    cachedSources.push({ source, cached });
    if (/\(\s*\{\s*additionalAvailableModels\s*:/.test(source)
        && (source.includes('1186680773') || allowResponseFallback && source.includes('model/list'))) {
      const contract = inspectCodexUltraRuntimeSource(source, allowResponseFallback);
      const prefix = source.slice(Math.max(0, source.indexOf(contract.callback) - 140), source.indexOf(contract.callback));
      const family = /=\(0,([\w$]+)\.([\w$]+)\)\([\w$]+\.[\w$]+,$/.exec(prefix);
      if (!family) throw new Error('Unsupported Codex Ultra query-family ownership');
      const owner = imported(source, family[1])?.[family[2]];
      if (typeof owner !== 'function') throw new Error('Codex Ultra query family is not loaded');
      ownedFamilies.add(owner);
      contracts.set(codexUltraCanonical(contract.callback), contract);
    }
  }
  if (ownedFamilies.size !== 1) throw new Error('Ambiguous Codex Ultra query-family ownership');
  for (const { source, cached } of cachedSources) {
    if (!source.includes('autoDispose') || !source.includes('debugLabel')) continue;
    for (const key of Object.keys(cached.exports || {})) {
      const value = cached.exports[key];
      if (typeof value !== 'function' || !ownedFamilies.has(value)) continue;
      const body = Function.prototype.toString.call(value);
      if (codexUltraCanonical(body) === codexUltraCanonical(factoryShape)) {
        const call = /=>\{let [\w$]+=\(0,([\w$]+)\.([\w$]+)\)\([\w$]+,[\w$]+=>/.exec(body);
        if (!call) throw new Error('Unsupported Codex Ultra native query constructor reference');
        const constructor = imported(source, call[1])?.[call[2]];
        if (typeof constructor !== 'function') throw new Error('Codex Ultra native query constructor is not loaded');
        constructors.add(constructor);
      } else if (codexUltraCanonical(body) === codexUltraCanonical(integratedFactoryShape)) {
        const call = /=>\{let [\w$]+=([\w$]+)\([\w$]+,[\w$]+=>/.exec(body);
        if (!call) throw new Error('Unsupported Codex Ultra native query constructor reference');
        const escaped = call[1].replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
        const declarations = Array.from(source.matchAll(new RegExp('\\bfunction ' + escaped + '\\([^)]*\\)\\{', 'g')));
        if (declarations.length !== 1) throw new Error('Ambiguous Codex Ultra local query constructor');
        const start = declarations[0].index;
        const end = codexUltraBlockEnd(source, start + declarations[0][0].length - 1);
        if (end < 0) throw new Error('Unsupported Codex Ultra local query constructor');
        const expected = source.slice(start, end);
        const matches = new Set(Object.values(cached.exports || {}).filter(value => typeof value === 'function'
          && Function.prototype.toString.call(value) === expected));
        if (matches.size !== 1) throw new Error('Codex Ultra native query constructor is not loaded');
        constructors.add(matches.values().next().value);
      }
    }
  }
  if (contracts.size !== 1 || constructors.size !== 1) throw new Error('Unsupported Codex Ultra loaded model-query contract');
  return { contract: contracts.values().next().value, createQuery: constructors.values().next().value };
}

// Normalize only declared capabilities of models already returned by the
// native model/list request. CodexPlusPlus can publish the same metadata first;
// unioning effort IDs keeps that runtime and its model objects intact.
function codexUltraEffortEntries(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
  const seen = new Set();
  return value.flatMap(entry => {
    const effort = typeof entry === 'string' ? entry : entry?.reasoningEffort ?? entry?.reasoning_effort ?? entry?.effort;
    if (!allowed.has(effort) || seen.has(effort)) return [];
    seen.add(effort);
    return [{ ...(entry != null && typeof entry === 'object' ? entry : {}), reasoningEffort: effort,
      description: typeof entry?.description === 'string' ? entry.description : `${effort} effort` }];
  });
}

function codexUltraModelEfforts(model, declarations, overrides) {
  const nativeLists = ['supportedReasoningEfforts', 'supported_reasoning_levels', 'supported_reasoning_efforts']
    .flatMap(key => Array.isArray(model?.[key]) ? [model[key]] : []);
  const native = codexUltraEffortEntries(nativeLists.flat());
  // Empty/none-only native capabilities are an explicit non-reasoning model.
  // A stale positive ceiling can be extended, but these must not be enabled by
  // another route's declaration or by a saved catalog from before a downgrade.
  if (nativeLists.length && native.every(entry => entry.reasoningEffort === 'none')) return native;
  const declared = typeof model?.model === 'string' && declarations && Object.hasOwn(declarations, model.model)
    ? declarations[model.model] : [];
  const efforts = codexUltraEffortEntries([...native, ...(Array.isArray(declared) ? declared : [])]);
  return typeof model?.model === 'string' && overrides && Object.hasOwn(overrides, model.model)
    && overrides[model.model] === false ? efforts.filter(entry => entry.reasoningEffort !== 'ultra') : efforts;
}

function codexUltraModelResponse(input, declarations, overrides) {
  if (!input || typeof input !== 'object') return input;
  const result = { ...input };
  let changed = false;
  for (const key of ['data', 'models']) {
    if (!Array.isArray(input[key])) continue;
    result[key] = input[key].map(model => {
      if (typeof model?.model !== 'string') return model;
      const efforts = codexUltraModelEfforts(model, declarations, overrides);
      const denied = overrides && Object.hasOwn(overrides, model.model) && overrides[model.model] === false;
      const staleAlias = denied && ['supported_reasoning_levels', 'supported_reasoning_efforts'].some(field =>
        codexUltraEffortEntries(model[field]).some(entry => entry.reasoningEffort === 'ultra'));
      if ((!efforts.length && !denied)
          || (!staleAlias && JSON.stringify(efforts) === JSON.stringify(model.supportedReasoningEfforts))) return model;
      changed = true;
      const next = { ...model, supportedReasoningEfforts: efforts };
      if (overrides && Object.hasOwn(overrides, model.model) && overrides[model.model] === false) {
        for (const field of ['supported_reasoning_levels', 'supported_reasoning_efforts']) {
          if (Array.isArray(model[field])) next[field] = model[field].filter(entry =>
            (typeof entry === 'string' ? entry : entry?.reasoningEffort ?? entry?.reasoning_effort ?? entry?.effort) !== 'ultra');
        }
      }
      return next;
    });
  }
  return changed ? result : input;
}

async function installCodexUltraRuntime(options) {
  const state = options?.state || {};
  const scopeKey = String(state.scopeKey || '');
  const platform = String(state.platform || (typeof navigator !== 'undefined' ? navigator.platform : ''));
  const windows = /^(?:windows|win)/i.test(platform);
  const catalogPath = value => typeof value !== 'string' ? ''
    : windows ? value.replace(/\\/g, '/').replace(/^\/\/\?\//, '').toLowerCase() : value;
  const catalogs = Array.from(new Set([state.modelCatalogPath, ...(Array.isArray(state.managedCatalogPaths) ? state.managedCatalogPaths : [])]
    .map(catalogPath).filter(Boolean)));
  const declarations = state.modelReasoningEfforts && typeof state.modelReasoningEfforts === 'object'
    && !Array.isArray(state.modelReasoningEfforts) ? state.modelReasoningEfforts : {};
  const overrides = state.modelUltraOverrides && typeof state.modelUltraOverrides === 'object'
    && !Array.isArray(state.modelUltraOverrides) ? state.modelUltraOverrides : {};
  const allowResponseFallback = Object.values(declarations).some(value => codexUltraEffortEntries(value)
    .some(entry => entry.reasoningEffort === 'ultra')) || Object.values(overrides).some(value => value === false);
  const routeKey = JSON.stringify([state.enabled === true, state.provider, catalogs, scopeKey, windows, declarations, overrides]);
  const previous = window.__gaogeCodexUltraRuntime;
  if (previous?.version === CODEX_ULTRA_RUNTIME_VERSION && previous.routeKey === routeKey && !previous.disposed) {
    await previous.refresh();
    return previous;
  }
  previous?.dispose?.();
  const enabled = state.enabled === true && !!state.provider && !!state.modelCatalogPath && !!scopeKey;
  const changes = new Map();
  const records = new Set();
  const cacheChanges = new Map();
  // queryFn publications can replace a cache entry after updateCaches ran.
  // Remember only responses this runtime transformed, never arbitrary native data.
  const responseSources = new WeakMap();
  const publishers = new Map();
  const responseSource = value => responseSources.get(value) || value;
  const normalizeResponse = input => {
    const output = codexUltraModelResponse(input, declarations, overrides);
    if (output !== input) responseSources.set(output, responseSource(input));
    return output;
  };
  const wrappedMembers = new WeakMap();
  let disposed = false, timer, pending = null, contract = null, createQuery = null, assetUrl = '', entrySignature = '';
  let reason = enabled ? 'awaiting-page' : 'disabled', error = '', generation = 0;
  const isManaged = args => args?.hostId === 'local' && ['apikey', 'chatgpt'].includes(args.authMethod)
    && args.teamCatalog == null
    && (contract?.configInQuery || (args.isCustomModelProvider === true && args.hasConfiguredModelCatalog === true
      && args.modelProvider === state.provider && catalogs.includes(catalogPath(args.modelCatalogPath))));
  const includesUltra = args => contract?.responseFallback
    ? args.includeUltraReasoningEffort === true || (contract.defaultUltra && args.includeUltraReasoningEffort == null)
    : contract?.configInQuery ? args.includeUltraReasoningEffort !== false : !!args.includeUltraReasoningEffort;
  const isManagedConfig = (args, original, configReads) => {
    if (!contract?.configInQuery) return true;
    if (configReads.length !== 1) return false;
    const route = codexUltraProjectedConfig(configReads[0]);
    return route?.provider === state.provider && catalogs.includes(catalogPath(route.catalog))
      && original.queryKey.at(-2) === route.provider && catalogPath(original.queryKey.at(-1)) === catalogPath(route.catalog);
  };
  const allowedSelector = select => typeof select === 'function'
    && codexUltraCanonical(Function.prototype.toString.call(select)) === contract?.select;
  const fail = failure => { reason = 'unsupported-query'; error = String(failure?.message || failure || ''); };
  const validateOptions = native => {
    if (contract?.responseFallback) {
      if (typeof native?.select !== 'function' || typeof native.queryFn !== 'function'
          || !Array.isArray(native.queryKey) || !['models', 'model/list', 'model-list', 'list-models-for-host', 'available-models'].includes(native.queryKey[0])
          || !native.queryKey.includes('local') || native.queryKey.includes('team')
          || native.queryKey.at(-2) !== state.provider || !catalogs.includes(catalogPath(native.queryKey.at(-1)))) {
        throw new Error('Unsupported Codex Ultra managed model-list response route');
      }
      return;
    }
    if (!allowedSelector(native?.select) || typeof native.queryFn !== 'function'
        || codexUltraCanonical(Function.prototype.toString.call(native.queryFn)) !== contract?.queryFn
        || !Array.isArray(native.queryKey)) throw new Error('Unsupported Codex Ultra retained query');
  };
  const localOptions = (descriptor, args, context, record) => {
    // Read original options with the real reactive reader first. This retains
    // native dependencies (including the remote flag), network behavior and
    // scope. The override exists only in this exact callback invocation.
    const configReads = [];
    const original = descriptor.getOptions(contract?.configInQuery ? { ...context, get: (setting, ...keys) => {
      const value = context.get(setting, ...keys);
      if (keys.length === 2 && keys[0] === args.hostId && keys[1]?.enabled === false
          && Object.keys(keys[1]).length === 1) configReads.push(value?.data?.config);
      return value;
    } } : context);
    const managed = isManaged(args) && isManagedConfig(args, original, configReads);
    if (record) {
      record.managed = managed; record.observed = false; record.verified = false;
      record.models = []; record.error = ''; record.allowed = null; record.queryKey = null;
    }
    if (!managed) return record ? original : null;
    validateOptions(original);
    let gateReads = 0;
    let allowed = args.enabledReasoningEfforts == null ? null : Array.from(args.enabledReasoningEfforts).includes('ultra');
    const local = contract?.responseFallback ? original : descriptor.getOptions({ ...context, get: (setting, ...keys) => {
      if (keys.length === 1 && keys[0] === '1186680773') { gateReads += 1; return true; }
      const value = context.get(setting, ...keys);
      if (args.enabledReasoningEfforts == null && value instanceof Set) allowed = value.has('ultra');
      return value;
    } });
    validateOptions(local);
    if ((!contract?.responseFallback && gateReads !== (includesUltra(args) ? 1 : 0))
        || JSON.stringify(original.queryKey) !== JSON.stringify(local.queryKey)) {
      throw new Error('Codex Ultra native query identity changed');
    }
    if (!record) return original;
    if (contract?.responseFallback && args.enabledReasoningEfforts == null) {
      // Reuse native subscribed settings, rather than changing a Statsig flag.
      const readSets = [];
      descriptor.getOptions({ ...context, get: (setting, ...keys) => {
        const value = context.get(setting, ...keys);
        if (value instanceof Set && [...value].some(entry => ['low', 'medium', 'high', 'max', 'ultra'].includes(entry))) readSets.push(value);
        return value;
      } });
      allowed = readSets.length === 1 ? readSets[0].has('ultra') : false;
    }
    record.allowed = allowed;
    record.queryKey = original.queryKey;
    record.observed = false;
    record.verified = false;
    record.models = [];
    record.error = '';
    return { ...original, queryFn: async (...request) => {
      const input = await Reflect.apply(original.queryFn, original, request);
      return disposed || !record.managed || !isManaged(args) ? input : normalizeResponse(input);
    }, select: input => {
      if (disposed || !isManaged(args)) return original.select(input);
      try {
        const normalized = codexUltraModelResponse(input, declarations, overrides);
        let result = local.select(normalized);
        const nativeModels = Array.isArray(normalized?.data) ? normalized.data : normalized?.models;
        if (!Array.isArray(nativeModels) || !Array.isArray(result?.models)) throw new Error('Unsupported Codex model-list response');
        const capabilities = new Map(nativeModels.map(model => [model.model, model]));
        if (contract?.responseFallback && includesUltra(args) && allowed === true) {
          const replacements = new Map();
          const models = result.models.map(model => {
            const capability = capabilities.get(model.model);
            if (!codexUltraModelEfforts(capability, declarations, overrides).some(entry => entry.reasoningEffort === 'ultra')
                || model.disabled === true || model.locked === true
                || model.supportedReasoningEfforts?.some(entry => entry.reasoningEffort === 'ultra')) return model;
            const updated = { ...model, supportedReasoningEfforts: [...(model.supportedReasoningEfforts || []),
              codexUltraModelEfforts(capability, declarations, overrides).find(entry => entry.reasoningEffort === 'ultra')] };
            replacements.set(model, updated);
            return updated;
          });
          result = { ...result, models,
            ...(result.defaultModel && replacements.has(result.defaultModel) ? { defaultModel: replacements.get(result.defaultModel) } : {}),
            ...(typeof result.hasModelSupportingUltraReasoningEffort === 'boolean' ? {
              hasModelSupportingUltraReasoningEffort: models.some(model => model.supportedReasoningEfforts?.some(entry => entry.reasoningEffort === 'ultra')),
            } : {}) };
        }
        for (const model of result.models) {
          if (!Array.isArray(model.supportedReasoningEfforts)) throw new Error('Unsupported Codex reasoning capabilities');
          if (model.supportedReasoningEfforts.some(level => level.reasoningEffort === 'ultra')
              && !capabilities.get(model.model)?.supportedReasoningEfforts?.some(level => level.reasoningEffort === 'ultra')) {
            throw new Error('Codex Ultra selection exceeded native model capabilities');
          }
        }
        record.observed = true;
        record.models = result.models;
        // TanStack can retain an earlier selected object through structural
        // sharing. Keep identities for this member only, without retaining it.
        for (const model of result.models) record.selectedModels.add(model);
        record.error = '';
        record.verified = result.models.some(model => model.supportedReasoningEfforts.some(level => level.reasoningEffort === 'ultra'));
        return result;
      } catch (failure) {
        record.error = String(failure?.message || failure);
        record.models = [];
        record.verified = false;
        fail(failure);
        return original.select(input);
      }
    } };
  };
  const notifyEviction = (change, root, chain, key, member, args) => {
    // dispose(true) is Maitai's scheduled-eviction path: it marks the disposal
    // signal so already mounted React readers resolve the replaced member.
    if (typeof member?.disposal?.dispose === 'function') member.disposal.dispose(true);
    else {
      change.family[change.evictKey](root, chain, args);
      if (member?.disposal?.atom) root.store.set(member.disposal.atom, true);
      else throw new Error('Codex Ultra query reader notification is unavailable');
    }
  };
  const attachFamily = (family, root, chain) => {
    let change = changes.get(family);
    if (!change) {
      const symbols = Object.getOwnPropertySymbols(family);
      const resolveKey = symbols.find(key => key.description === 'maitai.resolveFamilyMemberInternal');
      const evictKey = symbols.find(key => key.description === 'maitai.evictFamilyMemberInternal');
      if (!resolveKey || !evictKey || typeof family[resolveKey] !== 'function' || typeof family[evictKey] !== 'function') {
        throw new Error('Unsupported Codex Ultra family lifecycle');
      }
      change = { family, resolveKey, evictKey, original: family[resolveKey], roots: new Map(), wrapped: null };
      change.wrapped = function (node, currentChain, args, ...rest) {
        const member = change.original.call(this, node, currentChain, args, ...rest);
        if (disposed || !isManaged(args)) return member;
        const existing = wrappedMembers.get(member);
        if (existing) return member;
        const owner = currentChain.get(family.scope?.id) || node;
        if (!(owner?.familyBindings instanceof Map) || !owner.store) throw new Error('Codex Ultra query owner is unavailable');
        const descriptor = member?.value;
        if (descriptor?.queryKind !== 'query' || typeof descriptor.getOptions !== 'function') return member;
        change.roots.set(owner, currentChain);
        const record = { root: owner, chain: currentChain, args, key: member.cacheKey,
          native: member, member: null, family, observed: false, verified: false, models: [],
          selectedModels: new WeakSet(), allowed: null, error: '' };
        const value = createQuery(family.scope, context => {
          try { return localOptions(descriptor, args, context, record); }
          catch (failure) {
            record.error = String(failure?.message || failure); record.verified = false; fail(failure);
            return descriptor.getOptions(context);
          }
        });
        if (value?.queryKind !== 'query' || typeof value.getOptions !== 'function') {
          throw new Error('Unsupported Codex Ultra query signal');
        }
        const wrapped = { ...member, value };
        const members = owner.familyBindings.get(family);
        if (!(members instanceof Map) || members.get(member.cacheKey) !== member) throw new Error('Codex Ultra family ownership changed');
        // Store the wrapper in the native family so normal eviction disposes
        // its actual query observers, rather than leaving an orphan subscriber.
        members.set(member.cacheKey, wrapped);
        record.member = wrapped;
        records.add(record);
        wrappedMembers.set(wrapped, record);
        return wrapped;
      };
      family[resolveKey] = change.wrapped;
      changes.set(family, change);
    } else if (family[change.resolveKey] !== change.wrapped) throw new Error('Codex Ultra query resolver was replaced');
    if (!change.roots.has(root)) {
      change.roots.set(root, chain);
      for (const [key, member] of Array.from(root.familyBindings.get(family) || [])) {
        let args;
        try { args = JSON.parse(key); } catch (_) { continue; }
        if (isManaged(args) && !wrappedMembers.has(member)) notifyEviction(change, root, chain, key, member, args);
      }
    }
  };
  const trackPublisher = (query, client, record) => {
    if (typeof query.setData !== 'function' || publishers.has(query)) return;
    const original = query.setData;
    const descriptor = Object.getOwnPropertyDescriptor(query, 'setData');
    const key = JSON.stringify(record.queryKey);
    let revision = 0;
    const publication = { original, descriptor, wrapped: null };
    function wrapped(input, ...args) {
      if (disposed || publishers.get(query) !== publication || this !== query
          || JSON.stringify(query.queryKey) !== key || !record.managed || !isManaged(record.args)) {
        return Reflect.apply(original, this, [input, ...args]);
      }
      const currentRevision = ++revision;
      const source = responseSources.get(input);
      const stored = Reflect.apply(original, this, [input, ...args]);
      // Native structural sharing can replace the response root. Bind ownership
      // to the actual publication, but never reclaim a nested newer response.
      if (revision === currentRevision) {
        const published = query.state?.data;
        if (source && published && typeof published === 'object') {
          responseSources.set(published, source);
          cacheChanges.set(query, { client, key: query.queryKey,
            original: source, patched: published, updatedAt: query.state?.dataUpdatedAt });
        } else {
          // A genuine native publication owns its data even if structural
          // sharing reuses the exact previous injected object identity.
          if (published && typeof published === 'object') responseSources.delete(published);
          cacheChanges.delete(query);
        }
      }
      return stored;
    }
    publication.wrapped = wrapped;
    Object.defineProperty(query, 'setData', { configurable: true, writable: true, value: wrapped });
    publishers.set(query, publication);
  };
  const restorePublishers = () => {
    for (const [query, publication] of publishers) {
      if (query.setData !== publication.wrapped) continue;
      if (publication.descriptor) Object.defineProperty(query, 'setData', publication.descriptor);
      else delete query.setData;
    }
    publishers.clear();
  };
  const restoreCache = () => {
    // A queryFn may have published since our last refresh. Restrict discovery
    // to this runtime's exact managed queries and transformed object identities.
    for (const record of records) {
      if (!record.managed || !record.queryKey) continue;
      const client = record.root.queryClient;
      if (typeof client?.getQueryCache !== 'function' || typeof client.setQueryData !== 'function') continue;
      const queries = client.getQueryCache()?.getAll?.();
      if (!Array.isArray(queries)) continue;
      for (const query of queries) {
        if (JSON.stringify(query.queryKey) !== JSON.stringify(record.queryKey)) continue;
        const patched = query.state?.data;
        const original = responseSources.get(patched);
        if (original) cacheChanges.set(query, { client, key: query.queryKey,
          original, patched, updatedAt: query.state?.dataUpdatedAt });
      }
    }
    for (const [query, change] of cacheChanges) {
      // Do not overwrite a newer native/server publication or another plugin.
      if (query.state?.data === change.patched) {
        try { change.client.setQueryData(change.key, change.original, { updatedAt: change.updatedAt }); } catch (_) {}
      }
    }
    cacheChanges.clear();
  };
  const updateCaches = () => {
    const visited = new Set();
    for (const record of records) {
      if (!record.managed || !record.queryKey || record.root.familyBindings.get(record.family)?.get(record.key) !== record.member) continue;
      const client = record.root.queryClient;
      if (typeof client?.getQueryCache !== 'function' || typeof client.setQueryData !== 'function') continue;
      const queries = client.getQueryCache()?.getAll?.();
      if (!Array.isArray(queries)) continue;
      for (const query of queries) {
        if (visited.has(query) || JSON.stringify(query.queryKey) !== JSON.stringify(record.queryKey)) continue;
        visited.add(query);
        trackPublisher(query, client, record);
        const original = query.state?.data;
        const patched = normalizeResponse(original);
        const updatedAt = query.state?.dataUpdatedAt;
        if (patched === original) {
          const source = responseSources.get(original);
          if (source) cacheChanges.set(query, { client, key: query.queryKey,
            original: source, patched: original, updatedAt });
          continue;
        }
        const before = cacheChanges.get(query);
        const published = client.setQueryData(query.queryKey, patched, { updatedAt });
        cacheChanges.set(query, { client, key: query.queryKey,
          original: responseSources.get(original) || (before?.patched === original ? before.original : original),
          patched: published ?? query.state?.data, updatedAt });
      }
    }
  };
  const restoreAll = () => {
    for (const change of changes.values()) if (change.family[change.resolveKey] === change.wrapped) {
      change.family[change.resolveKey] = change.original;
    }
    for (const change of changes.values()) for (const [root, chain] of change.roots) {
      for (const [key, member] of Array.from(root.familyBindings.get(change.family) || [])) {
        let args;
        try { args = JSON.parse(key); } catch (_) { continue; }
        if (isManaged(args)) {
          try { notifyEviction(change, root, chain, key, member, args); } catch (_) {}
        }
      }
    }
    restorePublishers(); restoreCache(); changes.clear(); records.clear();
  };
  const refreshOnce = async () => {
    if (disposed || !enabled) return;
    const currentGeneration = generation;
    try {
      const legacyUrl = codexAppAssetUrl('app-initial-');
      const entries = legacyUrl ? '' : JSON.stringify(codexUltraWebpackEntryUrls());
      const url = legacyUrl || (assetUrl && contract && createQuery && entries === entrySignature && codexUltraWebpackEntryLoaded(assetUrl)
        ? assetUrl : await codexUltraWebpackEntryUrl(options));
      if (disposed || !enabled || generation !== currentGeneration) return;
      if (!legacyUrl && entries !== JSON.stringify(codexUltraWebpackEntryUrls())) throw new Error('Codex Ultra document entries changed');
      if (!url) { reason = 'awaiting-page'; restoreAll(); return; }
      if (url !== assetUrl || !contract || !createQuery) {
        restoreAll(); contract = null; createQuery = null;
        const sharedUrl = legacyUrl ? codexAppAssetUrl('app-shared-') : url;
        if (!sharedUrl) { reason = 'awaiting-page'; return; }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let timeout;
        const read = async address => {
          const response = await fetch(address, { cache: 'force-cache', ...(controller ? { signal: controller.signal } : {}) });
          if (!response.ok) throw new Error('Codex Ultra native query sources are unavailable');
          return response.text();
        };
        let source, shared, module;
        const webpackEntry = url.split('/').at(-1).split('?')[0];
        if (!legacyUrl && codexAppAssetUrl(webpackEntry) !== url) {
          throw new Error('Ambiguous Codex Ultra entry resource');
        }
        const loadEntry = () => {
          if (disposed || !enabled || generation !== currentGeneration) throw new Error('Codex Ultra entry loading cancelled');
          if (entries !== JSON.stringify(codexUltraWebpackEntryUrls()) || !codexUltraWebpackEntryLoaded(url)) {
            throw new Error('Codex Ultra loaded entry evidence changed');
          }
          return loadCodexAppModule(webpackEntry, { expectedUrl: url,
            validate: address => !disposed && enabled && generation === currentGeneration && address === url
              && entries === JSON.stringify(codexUltraWebpackEntryUrls()) && codexUltraWebpackEntryLoaded(url),
          });
        };
        try {
          [source, shared, module] = await Promise.race([
            legacyUrl ? Promise.all([read(url), read(sharedUrl), loadCodexAppModule('app-shared-')])
              : Promise.resolve().then(loadEntry).then(module => [null, null, module]),
            new Promise((_, reject) => {
              timeout = setTimeout(() => {
                const failure = new Error('Codex Ultra asset loading timed out');
                failure.code = 'ULTRA_ASSET_TIMEOUT';
                reject(failure);
                controller?.abort();
              }, options?.assetTimeoutMs ?? 3000);
            }),
          ]);
        } finally { clearTimeout(timeout); }
        if (disposed || generation !== currentGeneration) return;
        if (legacyUrl) {
          contract = inspectCodexUltraRuntimeSource(source, allowResponseFallback);
          createQuery = discoverCodexUltraQueryFactory(source, shared, module);
        } else {
          const discovered = discoverCodexUltraWebpackRuntime(module, allowResponseFallback);
          contract = discovered.contract; createQuery = discovered.createQuery;
        }
        assetUrl = url; entrySignature = entries;
      }
      reason = 'awaiting-model-query'; error = '';
      const visited = new Set();
      for (const chain of codexUltraScopeChains()) for (const root of chain.values()) {
        if (visited.has(root) || !(root?.familyBindings instanceof Map) || !root.queryClient) continue;
        visited.add(root);
        for (const [family, members] of Array.from(root.familyBindings)) {
          if (!(members instanceof Map)) continue;
          let found = changes.has(family);
          if (!found) for (const [key, member] of members) {
            if (typeof key !== 'string' || key.length > 16000) continue;
            let args;
            try { args = JSON.parse(key); } catch (_) { continue; }
            const descriptor = member?.value;
            if (!isManaged(args) || (!contract.configInQuery && !Object.prototype.hasOwnProperty.call(args, 'includeUltraReasoningEffort'))
                || descriptor?.queryKind !== 'query' || typeof descriptor.getOptions !== 'function') continue;
            const inspected = localOptions(descriptor, args, { get: (value, ...keys) => (contract.configInQuery ? codexUltraNativeConfigGet : codexUltraNativeGet)(root, chain, value, ...keys),
              queryClient: root.queryClient, scope: undefined }, null);
            if (inspected) { found = true; break; }
          }
          if (found) attachFamily(family, root, chain);
        }
      }
      for (const record of Array.from(records)) {
        if (record.root.familyBindings.get(record.family)?.get(record.key) !== record.member) records.delete(record);
      }
      for (const change of changes.values()) if (change.family[change.resolveKey] !== change.wrapped) {
        throw new Error('Codex Ultra query resolver was replaced');
      }
      updateCaches();
    } catch (failure) {
      if (disposed || generation !== currentGeneration) return;
      restoreAll();
      if (failure?.code === 'ULTRA_ASSET_TIMEOUT') { reason = 'asset-timeout'; error = ''; }
      else fail(failure);
    }
  };
  const runtime = {
    version: CODEX_ULTRA_RUNTIME_VERSION, routeKey,
    get disposed() { return disposed; },
    status() {
      const currentRecords = () => Array.from(records).filter(record =>
        record.root.familyBindings.get(record.family)?.get(record.key) === record.member && record.managed !== false);
      let live = currentRecords();
      let observed = live.filter(record => record.observed);
      const visible = typeof codexUltraVisiblePickerState === 'function'
        ? codexUltraVisiblePickerState() : { pickers: [], unresolvedCount: 1 };
      const ownsModel = (record, model) => {
        if (!model) return false;
        const descriptor = record.member.value;
        if (typeof descriptor.resolve !== 'function') return record.selectedModels.has(model);
        try {
          // Read this member's existing native snapshot, after TanStack's
          // structural sharing. It may contain a third object that is neither
          // the old snapshot nor the object returned from select.
          const snapshot = record.root.store.get(descriptor.resolve(record.root, record.chain));
          return Array.isArray(snapshot?.data?.models) && snapshot.data.models.includes(model);
        } catch (_) { return false; }
      };
      let pickerRecords = visible.pickers.map(picker => observed.filter(record =>
        picker.roots.includes(record.root) && ownsModel(record, picker.selectedModelData)));
      // A native store read can synchronously recompute its query. Recheck
      // health and membership after those reads, never certify an old result.
      live = currentRecords();
      observed = live.filter(record => record.observed);
      const activeError = error || live.find(record => record.error)?.error || '';
      const activeRecords = new Set(observed.filter(record => !record.error));
      pickerRecords = pickerRecords.map(matches => matches.filter(record => activeRecords.has(record)));
      const pickerMatches = visible.pickers.map((picker, index) => pickerRecords[index].some(record =>
        includesUltra(record.args) && record.allowed !== false
        && record.models.some(model => model.model === picker.model
          && model.supportedReasoningEfforts.some(level => level.reasoningEffort === 'ultra'))
        && picker.efforts.includes('ultra')));
      const verified = !disposed && !activeError && visible.unresolvedCount === 0
        && pickerMatches.length > 0 && pickerMatches.every(Boolean);
      const settingsOff = pickerRecords.some(matches => matches.length > 0
        && matches.every(record => !includesUltra(record.args) || record.allowed === false));
      const unresolvedPicker = visible.unresolvedCount || !visible.pickers.length || pickerRecords.some(matches => !matches.length);
      const currentReason = activeError ? 'unsupported-query' : !enabled || disposed ? 'disabled' : verified ? 'ready'
        : observed.length ? settingsOff ? 'setting-disabled'
          : unresolvedPicker ? 'awaiting-visible-picker'
          : !observed.some(record => record.verified) ? 'model-unsupported'
          : 'visible-model-unsupported' : reason;
      return { enabled, ready: !activeError && observed.length > 0, verified, version: CODEX_ULTRA_RUNTIME_VERSION,
        scopeKey, reason: currentReason, error: activeError, healthy: !disposed && !activeError,
        needsReinstall: !disposed && !!activeError, queryCount: live.length, adaptation: contract?.responseFallback ? 'model-response' : 'native-query',
        observedQueryCount: observed.length, ultraQueryCount: observed.filter(record => record.verified).length,
        visiblePickerCount: visible.pickers.length, verifiedPickerCount: pickerMatches.filter(Boolean).length };
    },
    refresh() {
      if (!pending) pending = refreshOnce().finally(() => { pending = null; });
      return pending;
    },
    dispose() {
      if (disposed) return;
      disposed = true; generation += 1; clearInterval(timer); restoreAll(); reason = 'disabled';
      if (window.__gaogeCodexUltraRuntime === runtime) delete window.__gaogeCodexUltraRuntime;
    },
  };
  window.__gaogeCodexUltraRuntime = runtime;
  if (enabled) { timer = setInterval(() => { void runtime.refresh(); }, 400); await runtime.refresh(); }
  return runtime;
}
