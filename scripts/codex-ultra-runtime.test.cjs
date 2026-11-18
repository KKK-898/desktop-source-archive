const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const runtimeSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_ultra_runtime.js'), 'utf8')
const pickerSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_ultra_picker.js'), 'utf8')
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
const filterSource = fixture('codex-model-filter-26.1007.js')

function harness({ version = '26.1007', auth = 'apikey', raw = true } = {}) {
  const callbackSource = fixture(`codex-ultra-query-${version}.js`)
  const callbackBody = callbackSource.match(/const nativeUltraQuery[\w]* = ([^\n]+);/)[1]
  const querySource = 'import{familyExport as Dl}from"./app-shared-fixture.js";q=Dl(scope,' + callbackBody + ');'
  const sharedSource = 'function NativeFamily(e,t,n){return Kk(Gk(e,n=>NativeQuery(e,e=>t(n,e)),{...n,autoDispose:n?.autoDispose??!0}))}export{NativeFamily as familyExport,NativeQuery as querySignalExport}'
  const context = vm.createContext({ querySource, sharedSource, callbackSource, filterSource, runtimeSource, auth, haveRaw: raw,
    modern: version === '26.1007.9446', configQuery: version === '26.1103',
    callbackName: /const (nativeUltraQuery[\w]*) =/.exec(callbackSource)[1],
    setTimeout, clearTimeout, AbortController, console })
  vm.runInContext(`
    window = globalThis;
    intervals = new Map(); let nextTimer = 0;
    setInterval = fn => { intervals.set(++nextTimer, fn); return nextTimer; };
    clearInterval = id => intervals.delete(id);
    sourceUrl = 'https://fixture.invalid/assets/app-initial.js';
    codexAppAssetUrl = name => name==='app-shared-'?'https://fixture.invalid/assets/app-shared-fixture.js':sourceUrl;
    fetch = async url => ({ok:true, text:async()=>url.includes('app-shared-')?sharedSource:querySource});
    loadCodexAppModule=async()=>({querySignalExport:(scope,getOptions)=>({scope,queryKind:'query',getOptions})});
    eval(filterSource);
    yte = value => ['none','minimal','low','medium','high','xhigh','max','ultra','persistent'].includes(value);
    eval(callbackSource + '\\nnativeCallback = ' + callbackName);
    Pd = undefined;
    let token = {id:Symbol('root')};
    atom = value => { const a={value}; return { scope:token, resolve:()=>a }; };
    remoteGate = false;
    const remote = {scope:token, read:()=>remoteGate};
    const efforts = atom(new Set(['low','medium','high','xhigh','max','ultra']));
    const selection = atom({availableModels:new Set(), defaultModel:'gpt-6.1-sol', useHiddenModels:false});
    GRi=efforts; BRi=modern?efforts:selection; FRi=selection; kc=remote; Dc=remote;
    Ie=atom(['local']); dHe=atom(false); pHe=dHe;
    zc=()=>undefined; Lc=zc;
    yee=(host,auth,limit)=>['models',host,auth,limit]; bee=yee;
    Qg={FIVE_MINUTES:300000}; qg=Qg; TRi=ARi;
    jg=()=>({sendRequest:async()=>rawData}); Dg=jg;
    Oi=undefined;Dh=zc;Ntr=dHe;VIn=yee;vvo=efforts;svo=selection;rg=remote;Ih=Ie;Zi=Qg;Vh=jg;lvo=ARi;
    Js=undefined;Jir=atom(undefined);Zir=dHe;_zn=yee;lIo=efforts;QFo=selection;Fh=remote;dh=Ie;fu=Qg;gh=jg;eIo=ARi;
    p={appServices:undefined};m={fI:'local'};f={i:Jir};h={dK:dHe};I={o:yee};x={pN:efforts};C={t:selection};v={JW:remote};s={Dj:Ie};y={D:Qg};d={V:jg};l={a:ARi};
    if(configQuery) {
      a={safeParse:value=>({success:value!=null&&typeof value==='object'&&!Array.isArray(value),data:value})};
      nativeConfig={model_provider:'custom',model_catalog_json:'/synthetic/gaoge-model-catalog.json',model_providers:{custom:{}}};
      configSignal=atom({data:{config:nativeConfig}});
      configSignal.read=(node,_chain,_host,reader,options)=>{if(reader!==undefined||options?.enabled!==false)throw Error('Native configuration reader/options shifted');return node.store.get(configSignal.resolve());};
      w={I2:configSignal};c={Y$:parseNativeConfig,cc:isNativeCustomProvider};g={appServices:undefined};
      p={fI:'local'};m={dK:dHe};y={o:yee};C={pN:efforts};j={t:selection};d={Dj:Ie};b={D:Qg};
      r={V:jg,eE:yte};o={a:i};s={bo:hasNativeCatalog};
    }
    models=[['gpt-6.1-sol',['low','medium','high','xhigh','max','ultra']],
      ['gpt-6-luna',['low','medium','high','xhigh','max']], ['gpt-5.5',['low','medium','high','xhigh']]]
      .map(([model,levels])=>({model,hidden:false,isDefault:model==='gpt-6.1-sol',
        supportedReasoningEfforts:levels.map(reasoningEffort=>({reasoningEffort,description:reasoningEffort}))}));
    rawData={data:models};
    args={additionalAvailableModels:[],authMethod:auth,enabledReasoningEfforts:null,
      hasConfiguredModelCatalog:true,hostId:'local',includeUltraReasoningEffort:true,
      isCustomModelProvider:true,limit:20,modelCatalogPath:'/synthetic/gaoge-model-catalog.json',modelProvider:'custom'};
    state={enabled:true,provider:'custom',modelCatalogPath:args.modelCatalogPath,scopeKey:'scope-a'};
    if(configQuery) for(const key of ['hasConfiguredModelCatalog','isCustomModelProvider','modelCatalogPath','modelProvider']) delete args[key];
    root={token,store:{get:a=>a.value},familyBindings:new Map()};
    chain=new Map([[token.id,root]]);
    root.queryClient={getQueryData:()=>rawData,removeQueries:()=>{}};
    nativeContext=()=>({get:(d,...a)=>d.read?(configQuery&&a.length===2?d.read(root,chain,a[0],undefined,a[1]):d.read(root,chain,...a)):root.store.get(d.resolve(root,chain,...a)),queryClient:root.queryClient});
    class Observer {
      constructor(options){this.options=options;this.result=haveRaw?options.select(rawData):undefined;this.calls=0;}
      setOptions(options){this.calls++;this.options=options;if(haveRaw)this.result=options.select(rawData);}
      publish(data){rawData=data;haveRaw=true;this.result=this.options.select(data);}
    }
    members=new Map(); consumers=new Map(); corruptOptions=false;
    resolveKey=Symbol('maitai.resolveFamilyMemberInternal');evictKey=Symbol('maitai.evictFamilyMemberInternal');
    family={scope:token};root.familyBindings.set(family,members);
    family[resolveKey]=(_node,_chain,boundArgs)=>{
      const key=JSON.stringify(boundArgs);if(members.has(key))return members.get(key);
      const descriptor={queryKind:'query',getOptions:context=>{
        const value=nativeCallback(boundArgs,context);
        return corruptOptions?{...value,select:input=>({models:input.data})}:value;
      }};
      const member={cacheKey:key,value:descriptor,disposal:{dispose(notify){members.delete(key);if(notify)renderConsumers();}}};
      members.set(key,member);return member;
    };
    nativeResolve=family[resolveKey];
    family[evictKey]=(_node,_chain,boundArgs)=>members.delete(JSON.stringify(boundArgs));
    nativeOptions=(boundArgs=args)=>family[resolveKey](root,chain,boundArgs).value.getOptions(nativeContext());
    renderConsumers=()=>{
      for(const [name,item]of consumers){const next=nativeOptions(name==='main'?args:item.args);
        if(item.observer)item.observer.setOptions(next);else item.observer=new Observer(next);}
      observer=consumers.get('main')?.observer;
    };
    addConsumer=(name,boundArgs)=>{consumers.set(name,{args:boundArgs});renderConsumers();};
    addConsumer('main',args);
    retain=()=>{members.clear();renderConsumers();};
    nativeSetOptions=observer.setOptions;
    button={__reactFiber$test:{memoizedProps:{value:chain},return:null}};
    document={querySelectorAll:()=>[button]};
    hasUltra=()=>observer.result?.models[0].supportedReasoningEfforts.some(e=>e.reasoningEffort==='ultra')||false;
    selectedModel='gpt-6.1-sol';visibleConsumer='main';pickerHidden=false;pickerUnresolved=false;
    // Visibility/React traversal is separately exercised by the picker tests.
    // Here each consumer supplies its own rendered options to the runtime.
    codexUltraVisiblePickerState=()=>{
      const selected=consumers.get(visibleConsumer)?.observer.result?.models.find(m=>m.model===selectedModel);
      return {pickers:pickerHidden||!selected?[]:[{model:selectedModel,roots:[root],selectedModelData:selected,
        efforts:selected.supportedReasoningEfforts.map(e=>e.reasoningEffort)}],
        unresolvedCount:pickerUnresolved?1:0};
    };
  `, context)
  vm.runInContext(runtimeSource, context)
  return { context, run: script => vm.runInContext(script, context),
    install: () => vm.runInContext('installCodexUltraRuntime({state})', context) }
}
for (const version of ['26.1007', '26.1007.9446', '26.1013', '26.1016', '26.1029', '26.1103']) {
  for (const auth of ['apikey', 'chatgpt']) test(`${version} ${auth}: native select retains Ultra across gate and options refresh`, async () => {
    const h = harness({ version, auth })
    assert.equal(h.run('hasUltra()'), false)
    const runtime = await h.install()
    assert.equal(h.run('hasUltra()'), true)
    assert.equal(runtime.status().verified, true)
    assert.equal(runtime.status().scopeKey, 'scope-a')
    for (const gate of [true, false, true, false]) {
      h.run(`remoteGate=${gate};observer.setOptions(nativeOptions())`)
      assert.equal(h.run('hasUltra()'), true)
      assert.equal(h.run('remoteGate'), gate, 'global remote flag is untouched')
    }
    assert.deepEqual(JSON.parse(h.run('JSON.stringify(observer.result.models.map(m=>m.supportedReasoningEfforts.at(-1).reasoningEffort))')),
      ['ultra', 'max', 'xhigh'])
    assert.equal(h.run('observer.result.models[0].supportedReasoningEfforts.at(-1)===models[0].supportedReasoningEfforts.at(-1)'), true)
    const again = await h.install()
    assert.equal(again, runtime)
    assert.equal(h.run('intervals.size'), 1)
    runtime.dispose()
    assert.equal(h.run('observer.setOptions===nativeSetOptions'), true)
    assert.equal(h.run('hasUltra()'), false)
    assert.equal(h.run('intervals.size'), 0)
  })
}

test('cold startup does not report verified before the native select consumes a model response', async () => {
  const h = harness({ raw: false })
  const runtime = await h.install()
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().reason, 'awaiting-model-query')
  h.run('observer.publish(rawData)')
  assert.equal(runtime.status().verified, true)
  runtime.dispose()
})

test('desktop opt-out, allowed efforts, and native model capability caps remain authoritative', async () => {
  const h = harness()
  const runtime = await h.install()
  h.run('args.includeUltraReasoningEffort=false;retain();observer.setOptions(nativeOptions())')
  await runtime.refresh()
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(runtime.status().reason, 'setting-disabled')
  h.run('args.includeUltraReasoningEffort=true;args.enabledReasoningEfforts=["medium","max"];retain();observer.setOptions(nativeOptions())')
  await runtime.refresh()
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(runtime.status().reason, 'setting-disabled')
  h.run('args.enabledReasoningEfforts=null;retain();observer.setOptions(nativeOptions());models=models.slice(1);rawData={data:models};selectedModel="gpt-6-luna";observer.publish(rawData)')
  await runtime.refresh()
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().healthy, true)
  assert.equal(runtime.status().reason, 'model-unsupported')
  runtime.dispose()
})

test('official, foreign catalog, remote host and unsupported auth queries are never hooked', async () => {
  for (const change of ['args.modelProvider="openai";args.isCustomModelProvider=false',
    'args.modelCatalogPath="/another/catalog.json"', 'args.hostId="remote"', 'args.authMethod="copilot"']) {
    const h = harness()
    h.run(change + ';retain();observer.setOptions(nativeOptions())')
    const runtime = await h.install()
    assert.equal(h.run('observer.setOptions===nativeSetOptions'), true)
    assert.equal(runtime.status().verified, false)
    assert.equal(runtime.status().reason, 'awaiting-model-query')
    runtime.dispose()
  }
})

test('reload, cache removal and ownership change clear verification and restore native selectors', async () => {
  const h = harness()
  const runtime = await h.install()
  h.run('members.clear();consumers.clear()')
  await runtime.refresh()
  assert.equal(runtime.status().verified, false)
  assert.equal(h.run('observer.setOptions===nativeSetOptions'), true)
  h.run('addConsumer("main",args);sourceUrl="https://fixture.invalid/assets/app-initial-reloaded.js"')
  await runtime.refresh()
  assert.equal(runtime.status().verified, true)
  h.run('state={...state,scopeKey:"scope-b"}')
  const next = await h.install()
  assert.notEqual(next, runtime)
  assert.equal(runtime.disposed, true)
  assert.equal(next.status().scopeKey, 'scope-b')
  h.run('state={...state,enabled:false}')
  const disabled = await h.install()
  assert.equal(disabled.status().reason, 'disabled')
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(h.run('intervals.size'), 0)
})

for (const version of ['26.1007', '26.1013', '26.1016', '26.1029', '26.1103']) test(`${version} unknown callback fails explicitly without a global bypass`, async () => {
  const h = harness({ version })
  h.run('querySource=querySource.replace(".FIVE_MINUTES", ".ONE_MINUTE")')
  const runtime = await h.install()
  assert.equal(runtime.status().healthy, false)
  assert.equal(runtime.status().reason, 'unsupported-query')
  assert.equal(h.run('observer.setOptions===nativeSetOptions'), true)
  runtime.dispose()
})

for (const version of ['26.1007', '26.1013', '26.1016', '26.1029', '26.1103']) test(`${version} declared capabilities recover a changed native query through response adaptation`, async () => {
  const h = harness({ version })
  h.run(`
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra'],'gpt-6-luna':['medium','max']};
    querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');
    models[0].supportedReasoningEfforts=models[0].supportedReasoningEfforts.filter(entry=>entry.reasoningEffort!=='ultra');
    retain();
  `)
  const runtime = await h.install()
  assert.equal(runtime.status().adaptation, 'model-response')
  assert.equal(h.run('hasUltra()'), true)
  assert.equal(h.run('observer.result.hasModelSupportingUltraReasoningEffort'), true)
  assert.equal(h.run('observer.result.defaultModel===observer.result.models[0]'), true)
  assert.equal(runtime.status().verified, true)
  assert.equal(h.run('remoteGate'), false)
  h.run('observer.setOptions(nativeOptions());selectedModel="gpt-6-luna"')
  assert.equal(runtime.status().verified, false)
  assert.equal(h.run('observer.result.models.find(model=>model.model==="gpt-6-luna").supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), false)
  h.run('selectedModel="gpt-6.1-sol";args.includeUltraReasoningEffort=false;retain()')
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(runtime.status().reason, 'setting-disabled')
  h.run('args.includeUltraReasoningEffort=true;args.enabledReasoningEfforts=["medium","max"];retain()')
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(runtime.status().reason, 'setting-disabled')
  h.run('args.enabledReasoningEfforts=null;retain();pickerHidden=true')
  assert.equal(runtime.status().verified, false, 'a prepared response is not visible-picker verification')
  runtime.dispose()
  assert.equal(h.run('hasUltra()'), false)
})

test('declared response capabilities reach queryFn and the exact native cache without touching other routes', async () => {
  const h = harness()
  h.run(`
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra']};
    querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');
    models[0].supportedReasoningEfforts=models[0].supportedReasoningEfforts.filter(entry=>entry.reasoningEffort!=='ultra');
    retain();
    cacheQueries=[{queryKey:observer.options.queryKey,state:{data:rawData,dataUpdatedAt:42}},
      {queryKey:['models','remote','apikey',20,'custom',args.modelCatalogPath],state:{data:rawData,dataUpdatedAt:43}},
      {queryKey:['models','local','apikey',20,'openai','/official/catalog.json'],state:{data:rawData,dataUpdatedAt:44}}];
    cacheWrites=[];
    root.queryClient.getQueryCache=()=>({getAll:()=>cacheQueries});
    root.queryClient.setQueryData=(key,value,options)=>{
      const query=cacheQueries.find(query=>JSON.stringify(query.queryKey)===JSON.stringify(key));
      query.state={data:value,dataUpdatedAt:options.updatedAt};cacheWrites.push({key,options});
      if(query===cacheQueries[0]){rawData=value;renderConsumers();}
      return value;
    };
  `)
  const runtime = await h.install()
  assert.equal(h.run('cacheWrites.length'), 1)
  assert.equal(h.run('cacheQueries[0].state.dataUpdatedAt'), 42)
  assert.equal(h.run('cacheQueries[0].state.data.data[0].supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), true)
  assert.equal(h.run('cacheQueries[1].state.data.data[0].supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), false)
  assert.equal(h.run('cacheQueries[2].state.data.data[0].supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), false)
  const response = await h.run('observer.options.queryFn({queryKey:observer.options.queryKey})')
  assert.equal(response.data[0].supportedReasoningEfforts.some(entry => entry.reasoningEffort === 'ultra'), true)
  await runtime.refresh()
  assert.equal(h.run('cacheWrites.length'), 1, 'no repeated cache writes for already normalized metadata')
  runtime.dispose()
  assert.equal(h.run('cacheWrites.length'), 2)
  assert.equal(h.run('cacheQueries[0].state.data.data[0].supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), false)
})

test('CodexPlusPlus model runtime and its existing efforts are preserved without duplicate Ultra', async () => {
  const h = harness()
  h.run(`
    upstreamRuntime={catalog:{model_provider:'custom',models:['gpt-6.1-sol']},patchJson:()=>{}};
    window.__codexPlusModelCatalogRuntime=upstreamRuntime;
    models[0].supportedReasoningEfforts.push({reasoningEffort:'ultra',description:'upstream duplicate'});
    models[0].supported_reasoning_levels=[{effort:'ultra',description:'upstream snake case'}];
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra']};
    querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');retain();
  `)
  const runtime = await h.install()
  assert.equal(h.run('window.__codexPlusModelCatalogRuntime===upstreamRuntime'), true)
  assert.equal(h.run('observer.result.models[0].supportedReasoningEfforts.filter(entry=>entry.reasoningEffort==="ultra").length'), 1)
  assert.equal(h.run('codexUltraModelResponse({models:[{model:"gpt-6.1-sol",supported_reasoning_levels:[{effort:"max"}]}]},state.modelReasoningEfforts).models[0].supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), true)
  assert.equal(runtime.status().verified, true)
  runtime.dispose()
  assert.equal(h.run('window.__codexPlusModelCatalogRuntime===upstreamRuntime'), true)
})

test('response fallback accepts explicitly managed alternate catalogs and refreshes declarations in the same route', async () => {
  const h = harness()
  h.run(`
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra']};
    state.managedCatalogPaths=['/synthetic/codex-plus-model-catalog.json'];
    args.modelCatalogPath=state.managedCatalogPaths[0];
    querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');retain();
  `)
  const previous = await h.install()
  assert.equal(previous.status().verified, true)
  h.run('state={...state,modelReasoningEfforts:{"gpt-6-luna":["medium","max","ultra"]}};selectedModel="gpt-6-luna"')
  const next = await h.install()
  assert.notEqual(next, previous)
  assert.equal(previous.disposed, true)
  assert.equal(next.status().verified, true)
  next.dispose()
})

for (const change of ['args.modelProvider="openai";args.isCustomModelProvider=false',
  'args.modelCatalogPath="/foreign/catalog.json"', 'args.hostId="remote"', 'args.authMethod="copilot"',
  'args.teamCatalog={accountId:"team",userId:"member"}']) test(`response fallback does not broaden ${change}`, async () => {
  const h = harness({ version: '26.1016' })
  h.run(`state.modelReasoningEfforts={'gpt-6.1-sol':['ultra']};querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');${change};retain()`)
  const runtime = await h.install()
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().queryCount, 0)
  assert.equal(h.run('family[resolveKey]===nativeResolve'), true)
  assert.equal(h.run('remoteGate'), false)
  runtime.dispose()
})

test('response fallback inspects changed source without evaluating it or widening native specialty filters', async () => {
  const h = harness({ version: '26.1103' })
  h.run(`
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra']};
    querySource=querySource.replace('=>{let', '=>{globalThis.unrecognizedCallbackExecuted=true;let');
    models[0].modelSpecialty='other';models[1].modelSpecialty='coding';
    args.specialty='coding';retain();selectedModel='gpt-6-luna';
  `)
  const runtime = await h.install()
  assert.equal(runtime.status().adaptation, 'model-response')
  assert.equal(h.run('typeof unrecognizedCallbackExecuted'), 'undefined')
  assert.equal(h.run('observer.result.models.some(model=>model.model==="gpt-6.1-sol")'), false)
  assert.equal(runtime.status().verified, false)
  assert.equal(h.run('hasUltra()'), false)
  runtime.dispose()
})

test('response fallback leaves a newer native cache publication intact on disposal', async () => {
  const h = harness()
  h.run(`
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra']};
    querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');
    models[0].supportedReasoningEfforts=models[0].supportedReasoningEfforts.filter(entry=>entry.reasoningEffort!=='ultra');retain();
    cacheQuery={queryKey:observer.options.queryKey,state:{data:rawData,dataUpdatedAt:50}};cacheWrites=0;
    root.queryClient.getQueryCache=()=>({getAll:()=>[cacheQuery]});
    root.queryClient.setQueryData=(_key,data,options)=>{cacheWrites++;cacheQuery.state={data,dataUpdatedAt:options.updatedAt};return data;};
  `)
  const runtime = await h.install()
  h.run('newNativeResponse={data:[{model:"new-native-model",supportedReasoningEfforts:[]}]};cacheQuery.state={data:newNativeResponse,dataUpdatedAt:60}')
  runtime.dispose()
  assert.equal(h.run('cacheWrites'), 1)
  assert.equal(h.run('cacheQuery.state.data===newNativeResponse'), true)
  assert.equal(h.run('cacheQuery.state.dataUpdatedAt'), 60)
})

test('reviewed native queries consume declared upstream snake-case capabilities without replacing their selector contract', async () => {
  const h = harness()
  h.run(`
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra'],'unknown-model':['low','high','max']};
    models[0].supportedReasoningEfforts=[];
    models[0].supported_reasoning_levels=[{effort:'medium'},{effort:'max'}];
    models.push({model:'unknown-model',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'},{reasoningEffort:'max'}]});
    retain();
  `)
  const runtime = await h.install()
  assert.equal(runtime.status().adaptation, 'native-query')
  assert.equal(runtime.status().verified, true)
  assert.equal(h.run('observer.result.models.find(model=>model.model==="unknown-model").supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), false)
  runtime.dispose()
})

test('config-query response fallback relinquishes official routing synchronously and respects its native default opt-in', async () => {
  const h = harness({ version: '26.1103' })
  h.run(`
    state.modelReasoningEfforts={'gpt-6.1-sol':['medium','max','ultra']};
    querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');
    delete args.includeUltraReasoningEffort;retain();
  `)
  const runtime = await h.install()
  assert.equal(runtime.status().verified, true)
  h.run('managedConfig=configSignal.resolve().value;configSignal.resolve().value={data:{config:{model_provider:"openai",model_providers:{}}}};renderConsumers()')
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().queryCount, 0)
  assert.equal(runtime.status().healthy, true)
  assert.equal(h.run('hasUltra()'), false)
  h.run('configSignal.resolve().value=managedConfig;renderConsumers()')
  assert.equal(runtime.status().verified, true)
  runtime.dispose()
})

test('26.1016 native preference signal changes preserve query identity and model access rules', async () => {
  const h = harness({ version: '26.1016' })
  h.run(`
    Js={daybreakPreferences:{}};
    Jir.resolve().value={apiKeySession:'session-one'};
    Zir.resolve().value=true;
    _zn=(host,auth,limit,session)=>['models',host,auth,limit,session];
    models[0].availableAccessPrograms={cyber:['restricted']};
    renderConsumers();
  `)
  const originalKey = h.run('JSON.stringify(observer.options.queryKey)')
  const runtime = await h.install()
  assert.equal(runtime.status().verified, true)
  assert.equal(h.run('JSON.stringify(observer.options.queryKey)'), originalKey)
  assert.equal(h.run('observer.options.queryKey.includes("session-one")'), true)
  h.run('Jir.resolve().value={apiKeySession:"session-two"};renderConsumers()')
  assert.equal(h.run('observer.options.queryKey.includes("session-two")'), true)
  assert.equal(h.run('hasUltra()'), true)
  h.run('Jir.resolve().value=undefined;renderConsumers()')
  assert.equal(h.run('observer.options.queryKey.includes("unavailable")'), true)
  assert.equal(h.run('observer.result.models.some(model=>model.model==="gpt-6.1-sol")'), false)
  assert.equal(runtime.status().verified, false)
  h.run('Jir.resolve().value={apiKeySession:"session-three"};Zir.resolve().value=false;renderConsumers()')
  assert.equal(h.run('observer.result.models.some(model=>model.model==="gpt-6.1-sol")'), false)
  assert.equal(h.run('remoteGate'), false)
  runtime.dispose()
})

test('a failed previous runtime is disposed before the new contract is installed', async () => {
  const h = harness({ version: '26.1016' })
  const version = h.run('CODEX_ULTRA_RUNTIME_VERSION')
  h.run(`CODEX_ULTRA_RUNTIME_VERSION=${version - 1};originalSource=querySource;querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE')`)
  const previous = await h.install()
  assert.equal(previous.status().reason, 'unsupported-query')
  h.run(`CODEX_ULTRA_RUNTIME_VERSION=${version};querySource=originalSource`)
  const runtime = await h.install()
  assert.notEqual(runtime, previous)
  assert.equal(previous.disposed, true)
  assert.equal(runtime.version, version)
  assert.equal(runtime.status().verified, true)
  assert.equal(h.run('intervals.size'), 1)
  runtime.dispose()
})

for (const version of ['26.1013', '26.1016', '26.1029', '26.1103']) test(`${version} team catalogs keep their native query identity, enablement and gate`, async () => {
  const h = harness({ version })
  h.run('args.teamCatalog={accountId:"synthetic",userId:"test"};retain();observer.setOptions(nativeOptions())')
  const before = h.run('JSON.stringify(observer.options.queryKey)')
  const runtime = await h.install()
  assert.equal(runtime.status().queryCount, 0)
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(h.run('JSON.stringify(observer.options.queryKey)'), before)
  assert.equal(h.run('observer.options.enabled'), true)
  h.run('args.teamCatalog={accountId:null,userId:null};retain();observer.setOptions(nativeOptions())')
  assert.equal(h.run('observer.options.enabled'), false)
  runtime.dispose()
})

test('verification follows the visible selected model and consumer, not another Ultra model', async () => {
  const h = harness({ version: '26.1013' })
  h.run('addConsumer("limited",{...args,enabledReasoningEfforts:["medium","max"]})')
  const runtime = await h.install()
  assert.equal(runtime.status().verified, true)
  h.run('selectedModel="gpt-6-luna"')
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().reason, 'visible-model-unsupported')
  h.run('selectedModel="gpt-6.1-sol";visibleConsumer="limited"')
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().reason, 'setting-disabled')
  h.run('visibleConsumer="main";pickerHidden=true')
  assert.equal(runtime.status().reason, 'awaiting-visible-picker')
  h.run('pickerHidden=false;pickerUnresolved=true')
  assert.equal(runtime.status().verified, false)
  h.run('pickerUnresolved=false')
  assert.equal(runtime.status().verified, true)
  runtime.dispose()
})

test('a visible foreign consumer cannot borrow verification from a managed hidden consumer in the same scope', async () => {
  const h = harness({ version: '26.1013' })
  h.run('addConsumer("otherRoute",{...args,modelProvider:"unmanaged",modelCatalogPath:"/another/catalog.json"});remoteGate=true;renderConsumers();visibleConsumer="otherRoute"')
  const runtime = await h.install()
  assert.equal(h.run('consumers.get("otherRoute").observer.result.models[0].supportedReasoningEfforts.at(-1).reasoningEffort'), 'ultra')
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().reason, 'awaiting-visible-picker')
  h.run('visibleConsumer="main"')
  assert.equal(runtime.status().verified, true)
  runtime.dispose()
})

test('verification reads the exact native member snapshot after structural sharing', async () => {
  const h = harness({ version: '26.1013' })
  const runtime = await h.install()
  h.run(`
    beforeSharing=observer.result;
    afterSharing={...beforeSharing,models:beforeSharing.models.map(model=>({...model,displayName:'changed'}))};
    observer.result=afterSharing;
    members.get(JSON.stringify(args)).value.resolve=()=>({value:{data:afterSharing}});
  `)
  assert.equal(runtime.status().verified, true, 'current native snapshot owns the shared model object')
  h.run('observer.result=beforeSharing')
  assert.equal(runtime.status().verified, false, 'an old selected object cannot override the current native snapshot')
  h.run('members.get(JSON.stringify(args)).value.resolve=()=>{throw new Error("snapshot unavailable")}')
  assert.equal(runtime.status().reason, 'awaiting-visible-picker')
  runtime.dispose()
})

test('a lazy native snapshot failure cannot certify the result captured before the read', async () => {
  const h = harness({ version: '26.1013' })
  const runtime = await h.install()
  h.run(`
    previousResult=observer.result;
    descriptor=members.get(JSON.stringify(args)).value;
    descriptor.resolve=()=>{
      corruptOptions=true;
      descriptor.getOptions(nativeContext());
      return {value:{data:previousResult}};
    };
  `)
  const status = runtime.status()
  assert.equal(status.verified, false)
  assert.equal(status.healthy, false)
  assert.equal(status.reason, 'unsupported-query')
  runtime.dispose()
})

for (const phase of ['fetch', 'body', 'module']) test(`${phase} loading timeout releases pending refresh and recovers without reinjection`, async () => {
  const h = harness({ version: '26.1013' })
  h.run(`originalFetch=fetch;originalLoad=loadCodexAppModule;
    late=new Promise(resolve=>resolveLate=resolve);
    ${phase === 'fetch' ? 'fetch=()=>late' : phase === 'body' ? 'fetch=async()=>({ok:true,text:()=>late})' : 'loadCodexAppModule=()=>late'}`)
  const runtime = await h.run('installCodexUltraRuntime({state,assetTimeoutMs:20})')
  assert.equal(runtime.status().reason, 'asset-timeout')
  assert.equal(runtime.status().healthy, true)
  assert.equal(runtime.status().verified, false)
  h.run('fetch=originalFetch;loadCodexAppModule=originalLoad')
  await runtime.refresh()
  assert.equal(runtime.status().verified, true)
  h.run('resolveLate(null)')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.status().verified, true, 'a late timed-out load must not replace the recovered adapter')
  runtime.dispose()
})

test('same server key has independent per-consumer capabilities, allowed efforts and desktop opt-in', async () => {
  const h = harness()
  h.run('addConsumer("limited",{...args,additionalAvailableModels:["gpt-6.1-sol"],enabledReasoningEfforts:["medium","max"]});addConsumer("hidden",{...args,includeUltraReasoningEffort:false})')
  const runtime = await h.install()
  assert.equal(h.run('hasUltra()'), true)
  for (const name of ['limited', 'hidden']) assert.equal(h.run(`consumers.get('${name}').observer.result.models[0].supportedReasoningEfforts.some(e=>e.reasoningEffort==='ultra')`), false)
  assert.equal(runtime.status().verified, true)
  assert.equal(runtime.status().queryCount, 3)
  assert.equal(runtime.status().ultraQueryCount, 1)
  runtime.dispose()
})

test('a late main consumer becomes ready after limited and hidden consumers mount first', async () => {
  const h = harness()
  h.run('consumers.clear();members.clear();addConsumer("limited",{...args,additionalAvailableModels:["gpt-6.1-sol"],enabledReasoningEfforts:["medium","max"]});addConsumer("hidden",{...args,includeUltraReasoningEffort:false})')
  const runtime = await h.install()
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().reason, 'awaiting-visible-picker')
  assert.equal(runtime.status().healthy, true)
  assert.equal(runtime.status().queryCount, 2)
  h.run('addConsumer("main",args)')
  assert.equal(h.run('hasUltra()'), true, 'the existing native family hook adapts the late reader without reinjection')
  assert.equal(runtime.status().verified, true)
  assert.equal(runtime.status().reason, 'ready')
  assert.equal(runtime.status().queryCount, 3)
  assert.equal(runtime.status().ultraQueryCount, 1)
  for (const name of ['limited', 'hidden']) assert.equal(h.run(`consumers.get('${name}').observer.result.models[0].supportedReasoningEfforts.some(e=>e.reasoningEffort==='ultra')`), false)
  runtime.dispose()
})

test('unrecognized live selectors remain explicitly failed across refreshes', async () => {
  const h = harness()
  const runtime = await h.install()
  h.run('corruptOptions=true;renderConsumers()')
  assert.equal(runtime.status().healthy, false)
  for (let i = 0; i < 3; i += 1) {
    await runtime.refresh()
    assert.equal(runtime.status().reason, 'unsupported-query')
    assert.equal(runtime.status().healthy, false)
  }
  runtime.dispose()
})

test('incoming native settings are honored synchronously before the polling interval', async () => {
  const h = harness()
  const runtime = await h.install()
  h.run('args={...args,includeUltraReasoningEffort:false};retain();observer.setOptions(nativeOptions())')
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(runtime.status().verified, false)
  assert.equal(runtime.status().reason, 'setting-disabled')
  runtime.dispose()
})

test('Windows catalog separators and casing normalize, while macOS casing remains exact', async () => {
  const h = harness()
  h.run('state={...state,platform:"windows",modelCatalogPath:"C:\\\\Users\\\\Test\\\\gaoge-model-catalog.json"};args.modelCatalogPath="c:/users/test/gaoge-model-catalog.json";retain();observer.setOptions(nativeOptions())')
  const runtime = await h.install()
  assert.equal(runtime.status().verified, true)
  runtime.dispose()
  const mac = harness()
  mac.run('state={...state,platform:"macos",modelCatalogPath:"/Synthetic/gaoge-model-catalog.json"}')
  const unchanged = await mac.install()
  assert.equal(unchanged.status().verified, false)
  assert.equal(mac.run('observer.setOptions===nativeSetOptions'), true)
  unchanged.dispose()
})


test('26.1029 loading team catalog remains disabled and tagged envelope stays native', async () => {
  const h = harness({ version: '26.1029' })
  h.run('args.teamCatalog="loading";retain();observer.setOptions(nativeOptions());observer.publish({...rawData,isTeamCatalog:true})')
  const before = h.run('JSON.stringify(observer.options.queryKey)')
  const runtime = await h.install()
  assert.equal(runtime.status().queryCount, 0)
  assert.equal(h.run('observer.options.enabled'), false)
  assert.equal(h.run('observer.result.isTeamCatalog'), true)
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(h.run('JSON.stringify(observer.options.queryKey)'), before)
  h.run('args.teamCatalog=null;retain();observer.setOptions(nativeOptions());observer.publish({...rawData,isTeamCatalog:false})')
  await runtime.refresh()
  assert.equal(h.run('observer.result.isTeamCatalog'), false)
  assert.equal(h.run('hasUltra()'), true)
  runtime.dispose()
})

test('26.1029 quoted strings canonicalize without weakening literals or control flow', () => {
  const h = harness({ version: '26.1029' })
  h.run('quoted=querySource.replaceAll(String.fromCharCode(34),String.fromCharCode(39))')
  assert.equal(h.run('inspectCodexUltraRuntimeSource(quoted).select===inspectCodexUltraRuntimeSource(querySource).select'), true)
  for (const change of [
    ['"loading"','"loaded"'], ['isTeamCatalog:a=!1','isTeamCatalog:a=!0'],
    ['D?.accountId!=null','true'], ['"apikey"===t','"chatgpt"===t'],
    ['includeUltraReasoningEffort:F','includeUltraReasoningEffort:true'],
  ]) {
    assert.throws(() => h.run('inspectCodexUltraRuntimeSource(querySource.replace('+JSON.stringify(change[0])+','+JSON.stringify(change[1])+'))'), /Unsupported/)
  }
})

test('webpack discovery reads cached reviewed constructors without initializing account modules', () => {
  const h = harness({ version: '26.1029' })
  h.run(    "queryModule=Function('return ({module(e,t,n){var a=n(\"family\");let query=(0,a.v)(g.u,'+callbackSource.match(/const nativeUltraQuery[\\w]* = ([^\\n]+);/)[1]+');}})')().module;" +
    "queryConstructor=(scope,getOptions)=>({scope,queryKind:'query',getOptions});" +
    "factoryModule=({U1Tb(e,t,n){var i=n('family'),o=n('signal');function a(e,t,n){let r=(0,i.T)(e,n=>{let i=(0,o.R)(e,e=>t(n,e));return i.debugLabel=r.debugLabel,i},{...n,autoDispose:n?.autoDispose??!0});return(0,i.$)(r)}t.v=a;}}).U1Tb;" +
    "factoryExports={};factoryModule({},factoryExports,name=>name==='signal'?{R:queryConstructor}:{T(){},$(){}});" +
    "requireCalls=0;webpackRequire=()=>{requireCalls++;throw Error('must not execute')};webpackRequire.m={query:queryModule,family:factoryModule,account(){throw Error('private')}};webpackRequire.c={query:{exports:{}},family:{exports:factoryExports},signal:{exports:{R:queryConstructor}}};")
  assert.equal(h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire}).createQuery===queryConstructor'), true)
  assert.equal(h.run('requireCalls'), 0)
  h.run(`savedQueryFactory=webpackRequire.m.query;
    webpackRequire.m.query=Function('return ({module(e,t,n){var a=n("family");let query=(0,a.v)(g.u,'+
      callbackSource.match(/const nativeUltraQuery[\\w]* = ([^\\n]+);/)[1].replace('1186680773','future-ultra-gate')+');}})')().module;`)
  assert.equal(h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire},true).contract.responseFallback'), true)
  assert.equal(h.run('requireCalls'), 0)
  h.run('webpackRequire.m.query=savedQueryFactory')
  h.run('savedQuery=webpackRequire.c.query;delete webpackRequire.c.query')
  assert.throws(() => h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire})'), /ownership/)
  h.run('webpackRequire.c.query=savedQuery;originalFactory=webpackRequire.c.family.exports.v;webpackRequire.c.family.exports.v=()=>{}')
  assert.throws(() => h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire})'), /contract/)
  h.run('webpackRequire.c.family.exports.v=originalFactory')
  h.run('delete webpackRequire.c.signal')
  assert.throws(() => h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire})'), /not loaded/)
  assert.equal(h.run('requireCalls'), 0)
})


test('webpack entry discovery selects only one structural runtime among bounded same-document entries', async () => {
  const h = harness({ version:'26.1029' })
  h.context.URL = URL
  h.run('location={href:"app://-/index.html",origin:"null"};document.readyState="complete";loadedEntries=new Set();performance={getEntriesByName:url=>loadedEntries.has(url)?[{name:url,entryType:"resource",initiatorType:"script",responseEnd:1}]:[]};entrySources=new Map();fetch=async url=>({ok:true,text:async()=>entrySources.get(url)||"export const chunk=1;"});')
  h.run('document.scripts=Array.from({length:5},(_,i)=>({type:"module",src:"app://-/assets/"+(100+i)+".abc.js"}));runtimeEntrySource="export { nativeRequire as __webpack_require__ }; chunk.__rspack_esm_ids;chunk.__webpack_modules__;";entrySources.set(document.scripts[4].src,runtimeEntrySource);loadedEntries.add(document.scripts[4].src)')
  assert.equal(await h.run('codexUltraWebpackEntryUrl()'), 'app://-/assets/104.abc.js')
  h.run('entrySources.set(document.scripts[1].src,runtimeEntrySource)')
  await assert.rejects(h.run('codexUltraWebpackEntryUrl()'), /Ambiguous Codex Ultra runtime entries/)
  h.run('document.scripts=[{type:"module",src:"file:///D:/Unrelated/assets/348410.abc.js"},{type:"module",src:"app://foreign/assets/348410.abc.js"}]')
  assert.equal(await h.run('codexUltraWebpackEntryUrl()'), '')
  h.run('document.scripts=Array.from({length:17},(_,i)=>({type:"module",src:"app://-/assets/"+i+".abc.js"}))')
  await assert.rejects(h.run('codexUltraWebpackEntryUrl()'), /module entry count/)
  h.run('document.scripts=[{type:"module",src:"app://-/assets/104.abc.js"}];document.readyState="loading"')
  assert.equal(await h.run('codexUltraWebpackEntryUrl()'), '')
  h.run('document.readyState="interactive"')
  assert.equal(await h.run('codexUltraWebpackEntryUrl()'), '')
  h.run('document.readyState="complete";loadedEntries.clear()')
  assert.equal(await h.run('codexUltraWebpackEntryUrl()'), '')
  h.run('loadedEntries.add(document.scripts[0].src);codexAppAssetUrl=()=>"";loadCalls=0;loadCodexAppModule=()=>{loadCalls++;throw Error("must not import")};')
  const runtime = await h.install()
  assert.equal(runtime.status().reason, 'unsupported-query')
  assert.equal(h.run('loadCalls'), 0)
  assert.equal(h.run('remoteGate'), false)
  runtime.dispose()
})

test('webpack entry discovery fails closed on unreadable, oversized, changing and timed-out entries', async () => {
  const h = harness({ version:'26.1029' })
  h.context.URL = URL
  h.run('location={href:"app://-/index.html"};document.readyState="complete";document.scripts=[{type:"module",src:"app://-/assets/348410.abc.js"}];fetch=async()=>({ok:false})')
  await assert.rejects(h.run('codexUltraWebpackEntryUrl()'), /source is unavailable/)
  h.run('fetch=async()=>({ok:true,headers:{get:()=>String(25*1024*1024)},text:async()=>{throw Error("must not read oversized body")}})')
  await assert.rejects(h.run('codexUltraWebpackEntryUrl()'), /source size/)
  h.run('fetch=async()=>({ok:true,text:async()=>{document.scripts=[];return "export { r as __webpack_require__ };c.__rspack_esm_ids;c.__webpack_modules__;"}})')
  await assert.rejects(h.run('codexUltraWebpackEntryUrl()'), /entries changed/)
  h.run('document.scripts=[{type:"module",src:"app://-/assets/348410.abc.js"}];fetch=async()=>new Promise(()=>{})')
  await assert.rejects(h.run('codexUltraWebpackEntryUrl({assetTimeoutMs:10})'), /discovery timed out/)
})

test('webpack discovery never imports unloaded tags, fetch-only evidence, cancelled or replaced entries', async () => {
  const h = harness({ version:'26.1029' })
  h.context.URL = URL
  h.run('location={href:"app://-/index.html"};document.readyState="complete";entry="app://-/assets/348410.abc.js";document.scripts=[{type:"module",src:entry}];loaded=false;initiator="script";performance={getEntriesByName:url=>loaded?[{name:url,entryType:"resource",initiatorType:initiator,responseEnd:1}]:[]};source="export { r as __webpack_require__ };c.__rspack_esm_ids;c.__webpack_modules__;";fetch=async()=>({ok:true,text:async()=>source});loadCalls=0;loadCodexAppModule=()=>{loadCalls++;throw Error("must not import")};codexAppAssetUrl=prefix=>prefix==="app-initial-"?"":entry;')
  let runtime = await h.install()
  assert.equal(runtime.status().reason, 'awaiting-page')
  assert.equal(h.run('loadCalls'), 0)
  runtime.dispose()
  h.run('loaded=true;initiator="fetch"')
  runtime = await h.install()
  assert.equal(runtime.status().reason, 'awaiting-page')
  assert.equal(h.run('loadCalls'), 0)
  runtime.dispose()
  h.run('initiator="script"')
  runtime = await h.install()
  assert.equal(runtime.status().error, 'must not import') // The loaded positive canary reaches only the stub, never native code.
  assert.equal(h.run('loadCalls'), 1)
  runtime.dispose()
  h.run('loadCalls=0;initiator="script";fetch=()=>new Promise(resolve=>releaseFetch=resolve)')
  const installing = h.install()
  h.run('window.__gaogeCodexUltraRuntime.dispose();releaseFetch({ok:true,text:async()=>source})')
  runtime = await installing
  assert.equal(runtime.status().reason, 'disabled')
  assert.equal(h.run('loadCalls'), 0)
  h.run('fetch=async()=>({ok:true,text:async()=>source});codexAppAssetUrl=prefix=>{if(prefix==="app-initial-")return "";document.scripts=[{type:"module",src:"app://-/assets/replacement.abc.js"}];return entry;}')
  runtime = await h.install()
  assert.equal(runtime.status().reason, 'unsupported-query')
  assert.match(runtime.status().error, /loaded entry evidence changed/)
  assert.equal(h.run('loadCalls'), 0)
  runtime.dispose()
})

test('webpack loader revalidates inside its final import microtask after a same-name entry replacement', async () => {
  const h = harness({ version:'26.1029' })
  h.context.URL = URL
  h.run('location={href:"app://-/index.html"};document.readyState="complete";entry="app://-/assets/348410.abc.js";document.scripts=[{type:"module",src:entry}];performance={getEntriesByName:url=>[{name:url,entryType:"resource",initiatorType:"script",responseEnd:1}]};fetch=async()=>({ok:true,text:async()=>"export { r as __webpack_require__ };c.__rspack_esm_ids;c.__webpack_modules__;"});codexAppAssetUrl=prefix=>prefix==="app-initial-"?"":document.scripts[0].src;loaderCalls=0;nativeImports=0;loadCodexAppModule=(prefix,options)=>{loaderCalls++;if(options.expectedUrl!==entry||typeof options.validate!=="function")throw Error("missing final loader guard");return Promise.resolve().then(()=>{document.scripts=[{type:"module",src:"app://foreign/assets/348410.abc.js"}];return Promise.resolve().then(()=>{const current=codexAppAssetUrl(prefix);if(current!==options.expectedUrl||!options.validate(current))return null;nativeImports++;throw Error("must not import");});});};')
  const runtime = await h.install()
  assert.equal(h.run('loaderCalls'), 1)
  assert.equal(h.run('nativeImports'), 0)
  assert.equal(runtime.status().verified, false)
  runtime.dispose()
})

test('26.1111 reviewed query preserves its exact config, specialty, team and request contract', () => {
  const h = harness({ version:'26.1103' })
  const callback = h.run('CODEX_ULTRA_RUNTIME_261111_QUERY_SHAPE')
  const inspect = source => h.context.inspectCodexUltraRuntimeSource(source)
  const contract = inspect(callback)
  assert.equal(contract.configInQuery, true)
  assert.equal(contract.responseFallback, undefined)
  assert.equal(contract.callback, callback)
  for (const [from, to] of [
    ['.FIVE_MINUTES', '.ONE_MINUTE'],
    ['enabled:!1', 'enabled:!0'],
    ['model_provider', 'different_provider'],
    ['modelSpecialty===u', 'modelSpecialty!==u'],
    ['1186680773', 'other-gate'],
    ['includeHidden:!0', 'includeHidden:!1'],
  ]) {
    assert.notEqual(callback.replace(from, to), callback)
    assert.throws(() => inspect(callback.replace(from, to)), /model-query contract/)
  }
})

test('26.1103 stale startup routes are not attached before a managed configuration arrives', async () => {
  const h = harness({ version: '26.1103' })
  h.run('configSignal.resolve().value={data:{config:{model_provider:"openai",model_providers:{}}}};observer.setOptions(nativeOptions())')
  const runtime = await h.install()
  assert.equal(runtime.status().queryCount, 0)
  assert.equal(h.run('family[resolveKey]===nativeResolve'), true)
  assert.equal(h.run('hasUltra()'), false)
  h.run('configSignal.resolve().value={data:{config:nativeConfig}};observer.setOptions(nativeOptions())')
  await runtime.refresh()
  assert.equal(h.run('hasUltra()'), true)
  assert.equal(runtime.status().verified, true)
  runtime.dispose()
})

test('26.1103 reactive configuration changes clear verification before the next poll', async () => {
  const h = harness({ version: '26.1103' })
  assert.equal(h.run('Object.hasOwn(args,"modelProvider")'), false)
  const runtime = await h.install()
  assert.equal(h.run('hasUltra()'), true)
  for (const config of [
    { model_provider: 'openai', model_providers: {} },
    { model_provider: 'custom', model_providers: { custom: {} }, model_catalog_json: '/other/catalog.json' },
    { model_provider: 'custom', model_providers: {}, model_catalog_json: '/synthetic/gaoge-model-catalog.json' },
    { model_provider: 'foreign', model_providers: { foreign: {} }, model_catalog_json: '/synthetic/gaoge-model-catalog.json' },
  ]) {
    h.run('configSignal.resolve().value={data:{config:'+JSON.stringify(config)+'}};observer.setOptions(nativeOptions())')
    assert.equal(h.run('hasUltra()'), false)
    assert.equal(runtime.status().verified, false)
    assert.equal(runtime.status().queryCount, 0)
    assert.equal(h.run('remoteGate'), false)
    h.run('configSignal.resolve().value={data:{config:nativeConfig}};observer.setOptions(nativeOptions())')
    assert.equal(h.run('hasUltra()'), true)
    assert.equal(runtime.status().verified, true)
  }
  runtime.dispose()
})

test('26.1103 projects selected profiles and rejects foreign, remote and team routes', async () => {
  const h = harness({ version: '26.1103' })
  h.run('configSignal.resolve().value={data:{config:{model_provider:"openai",model_providers:{custom:{}},profile:"managed",profiles:{managed:{model_provider:"custom",model_catalog_json:state.modelCatalogPath,unrelated:null}}}}}')
  const runtime = await h.install()
  assert.equal(h.run('hasUltra()'), true)
  for (const change of ['args.hostId="remote"', 'args.authMethod="copilot"', 'args.teamCatalog="loading"']) {
    h.run('savedArgs={...args};'+change+';retain();observer.setOptions(nativeOptions())')
    await runtime.refresh()
    assert.equal(h.run('hasUltra()'), false)
    assert.equal(runtime.status().queryCount, 0)
    h.run('args=savedArgs;retain();observer.setOptions(nativeOptions())')
    await runtime.refresh()
    assert.equal(h.run('hasUltra()'), true)
  }
  h.run('configSignal.resolve().value.data.config.profile="missing";observer.setOptions(nativeOptions())')
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(runtime.status().verified, false)
  runtime.dispose()
})

test('26.1103 native specialty and cyber access filters stay authoritative', async () => {
  const h = harness({ version: '26.1103' })
  h.run('models[0].modelSpecialty="coding";models[1].modelSpecialty="general";models[2].modelSpecialty="coding";models[2].availableAccessPrograms={cyber:["restricted"]};args.specialty="coding";retain();observer.setOptions(nativeOptions())')
  const runtime = await h.install()
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(observer.result.models.map(model=>model.model))')), ['gpt-6.1-sol'])
  assert.equal(h.run('hasUltra()'), true)
  h.run('models[0].availableAccessPrograms={cyber:["restricted"]};observer.publish(rawData)')
  assert.deepEqual(JSON.parse(h.run('JSON.stringify(observer.result.models)')), [])
  assert.equal(runtime.status().verified, false)
  h.run('models[0].availableAccessPrograms={cyber:["standard"]};observer.publish(rawData)')
  assert.equal(h.run('hasUltra()'), true)
  runtime.dispose()
})

test('26.1103 default opt-in and strict callback matching preserve native decisions', async () => {
  const h = harness({ version: '26.1103' })
  h.run('delete args.includeUltraReasoningEffort;retain();observer.setOptions(nativeOptions())')
  const runtime = await h.install()
  assert.equal(h.run('hasUltra()'), true)
  assert.equal(runtime.status().verified, true)
  for (const [before, after] of [
    ['enabled:!1', 'enabled:!0'], ['includeUltraReasoningEffort:l=!0', 'includeUltraReasoningEffort:l=!1'],
    ['modelSpecialty===u', 'modelSpecialty!==u'], ['x(w.I2,n,{enabled:!1})', 'x(w.I2,"other",{enabled:!1})'],
  ]) assert.throws(() => h.run('inspectCodexUltraRuntimeSource(querySource.replace('+JSON.stringify(before)+','+JSON.stringify(after)+'))'), /Unsupported/)
  runtime.dispose()
})

test('26.1103 integrated query constructor must be an unchanged export of its loaded owning module', () => {
  const h = harness({ version: '26.1103' })
  h.run("queryModule=Function('return ({module(e,t,n){var a=n(\"family\");let query=(0,a.vU)(g.u,'+callbackSource.match(/const nativeUltraQuery[\\w]* = ([^\\n]+);/)[1]+');}})')().module;" +
    "factoryModule=({zTeN(e,t,n){var o=n('foundation');function b(scope,getOptions){return {scope,queryKind:'query',getOptions}}function L(e,t,n){let i=(0,o.T)(e,n=>{let r=b(e,e=>t(n,e));return r.debugLabel=i.debugLabel,r},{...n,autoDispose:n?.autoDispose??!0});return(0,o.$)(i)}t.vU=L;t.RD=b;}}).zTeN;" +
    "factoryExports={};factoryModule({},factoryExports,()=>({T(){},$(){}}));queryConstructor=factoryExports.RD;" +
    "requireCalls=0;webpackRequire=()=>{requireCalls++;throw Error('must not execute')};webpackRequire.m={query:queryModule,family:factoryModule,account(){throw Error('private')}};webpackRequire.c={query:{exports:{}},family:{exports:factoryExports}};")
  assert.equal(h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire}).createQuery===queryConstructor'), true)
  h.run('delete factoryExports.RD')
  assert.throws(() => h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire})'), /not loaded/)
  h.run('factoryExports.RD=()=>({queryKind:"query"})')
  assert.throws(() => h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire})'), /not loaded/)
  h.run('factoryExports.RD=queryConstructor;delete webpackRequire.c.family')
  assert.throws(() => h.run('discoverCodexUltraWebpackRuntime({__webpack_require__:webpackRequire})'), /not loaded/)
  assert.equal(h.run('requireCalls'), 0)
})

const installedUltraCases = [false, true].flatMap(responseFallback => ['apikey', 'chatgpt']
  .map(auth => ({ responseFallback, auth, aggregate: false })))
installedUltraCases.push({ responseFallback: false, auth: 'apikey', aggregate: true })
for (const { responseFallback, auth, aggregate } of installedUltraCases) test(aggregate
  ? 'installed native aggregate full model IDs preserve Ultra selection and rerenders'
  : `installed native ${auth} ${responseFallback ? 'model-response fallback' : 'reviewed query'} scope, QueryObserver and React rerenders retain scoped Ultra`, {
  skip: !process.env.CODEX_NATIVE_APP_ASAR && 'Set CODEX_NATIVE_APP_ASAR for isolated installed-framework verification',
}, async t => {
  const http = require('node:http')
  const { chromium } = require('playwright')
  const asar = require('@electron/asar')
  const initialName = asar.listPackage(process.env.CODEX_NATIVE_APP_ASAR).map(file => file.split(/[\\/]/).at(-1))
    .find(name => /^app-initial-.*\.js$/.test(name))
  const webpack = !initialName
  const packaged = webpack
    ? require('./codex-ultra-webpack-native-fixture.cjs').nativeWebpackFixture(process.env.CODEX_NATIVE_APP_ASAR)
    : require('./codex-fuel-native-fixture.cjs').nativeFuelFixture(process.env.CODEX_NATIVE_APP_ASAR)
  const initialSource = webpack ? packaged.initialSource : packaged.read(initialName).toString()
  const { factorySource } = require('./codex-ultra-native-query-fixture.cjs').nativeUltraQueryFixture(initialSource, packaged)
  const exposedShared = packaged.read(packaged.appName).toString()
  const sharedSource = exposedShared.slice(0, exposedShared.lastIndexOf('\nexport{'))
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1)
    if (!name) { response.end('<!doctype html><div id="root"></div>'); return }
    if (/^assets\/10000[1-4]\.chunk\.js$/.test(name)) { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end('export const __rspack_esm_ids=[];export const __webpack_modules__={};'); return }
    const file = name.includes('..') || (!webpack && name.includes('/')) ? null : packaged.read(name)
    response.writeHead(file ? 200 : 404, { 'content-type': 'text/javascript' }); response.end(file || '')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  t.after(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)) })
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  const page = await browser.newPage()
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.message))
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(origin)
  await page.addScriptTag({ content: pickerSource + '\n' + runtimeSource })
  await page.evaluate(async ({ appName, factorySource, initialSource, sharedSource, auth, webpack, configQuery, responseFallback, aggregate }) => {
    const native = await import('/' + appName)
    if (responseFallback) {
      initialSource = initialSource.replace('.FIVE_MINUTES', '.ONE_MINUTE')
      if (webpack) for (const [id, factory] of Object.entries(native.__webpack_require__.m)) {
        const source = typeof factory === 'function' ? Function.prototype.toString.call(factory) : ''
        if (source.includes('additionalAvailableModels:') && source.includes('1186680773')) {
          // Only change discovery text in this isolated fixture. The cached
          // application module and all live native functions remain unchanged.
          const changed = source.replace('.FIVE_MINUTES', '.ONE_MINUTE')
          native.__webpack_require__.m[id] = /^function\b/.test(changed)
            ? new Function('return (' + changed + ')')()
            : new Function('return Object.values({' + changed + '})[0]')()
        }
      }
    }
    native.__fuel_uln(); native.__fuel_queryInit()
    const React = native.__fuel_react(), dom = native.__fuel_client()
    const scope = native.__fuel_lun('ultra-isolated-root')
    const client = new native.__fuel_queryClient({ defaultOptions: { queries: { retry: false } } })
    const efforts = native.__fuel_Bln(scope, new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']))
    window.testUltraModels = aggregate ? ['gaoge/openai/1/gpt-6-astra',
      'gaoge/external-user/custom/gpt-6-astra', 'gaoge/custom/openai/1/gpt-6-astra'] : ['gpt-6.1-sol']
    window.testPrimaryModel = testUltraModels[0]
    window.testUnsupportedModel = aggregate ? 'gaoge/openai/1/gpt-6-luna' : 'gpt-6-luna'
    const catalog = native.__fuel_Bln(scope, { availableModels: new Set(), defaultModel: testPrimaryModel, useHiddenModels: false })
    const gateSignal = native.__fuel_Bln(scope, false)
    const gate = native.__fuel_Aln(scope, (_flag, { get }) => get(gateSignal))
    const hosts = native.__fuel_Bln(scope, ['local'])
    const routeConfig = native.__fuel_Bln(scope, { data: { config: { model_provider: 'custom', model_catalog_json: '/synthetic/gaoge-model-catalog.json', model_providers: { custom: {} } } } })
    const config = native.__fuel_Aln(scope, (_host, { get }) => get(routeConfig))
    let raw = { data: [
      ...testUltraModels.map((model, index) => ({ model, hidden: false, isDefault: index === 0,
        supportedReasoningEfforts: (aggregate ? ['medium', 'max'] : ['medium', 'max', 'ultra'])
          .map(reasoningEffort => ({ reasoningEffort })) })),
      { model: testUnsupportedModel, hidden: false, isDefault: false,
        supportedReasoningEfforts: ['medium', 'max'].map(reasoningEffort => ({ reasoningEffort })) },
    ] }
    const callback = new Function('bindings', factorySource)({
      efforts, catalog, gate, hosts, config, sendRequest: async () => raw,
    })
    const query = native.__fuel_queryFamily(scope, callback, { key: value => JSON.stringify(value) })
    window.args = { additionalAvailableModels: [], authMethod: auth, enabledReasoningEfforts: null,
      hasConfiguredModelCatalog: true, hostId: 'local', includeUltraReasoningEffort: true,
      isCustomModelProvider: true, limit: 20, modelCatalogPath: '/synthetic/gaoge-model-catalog.json', modelProvider: 'custom' }
    window.ultraState = { enabled: true, provider: 'custom', modelCatalogPath: args.modelCatalogPath, scopeKey: 'native-scope',
      ...(responseFallback || aggregate ? { modelReasoningEfforts: Object.fromEntries(testUltraModels.map(model => [model, ['medium', 'max', 'ultra']])) } : {}) }
    if (configQuery) for (const key of ['hasConfiguredModelCatalog', 'isCustomModelProvider', 'modelCatalogPath', 'modelProvider']) delete args[key]
    window.setNativeConfig = value => nativeScope.set(routeConfig, { data: { config: value } })
    window.selectedModel = testPrimaryModel
    window.selectedEffort = 'medium'
    window.showLimited = false
    window.nativeSelectionCalls = []
    function Picker({ kind, model, powerSelections, onSelectModel, reasoningEffort, onSelectPower }) {
      const available = powerSelections.filter(item => item.model === model)
      return React.createElement('div', { style: { display: kind === 'main' || (kind === 'limited' && showLimited) ? 'block' : 'none' } },
        React.createElement('button', { id: kind, 'data-codex-intelligence-trigger': true,
          'data-selected-reasoning-effort': reasoningEffort }, available.map(item => item.reasoningEffort).join(',') || 'waiting'),
        ...available.map(item => React.createElement('button', { id: kind + '-' + item.reasoningEffort,
          key: item.id, onClick: () => onSelectPower(item) }, item.reasoningEffort)))
    }
    function Composer({ kind }) {
      window.nativeScope = native.__fuel_fln(scope)
      const currentArgs = kind === 'limited' ? { ...args, additionalAvailableModels: [testPrimaryModel], enabledReasoningEfforts: ['medium', 'max'] }
        : kind === 'hidden' ? { ...args, includeUltraReasoningEffort: false } : args
      const result = native.__fuel_hln(query, currentArgs)
      const powerSelections = (result?.data?.models || []).flatMap(model => model.supportedReasoningEfforts.map(level => ({
        id: model.model + '/' + level.reasoningEffort, model: model.model, reasoningEffort: level.reasoningEffort, isLocked: false,
      })))
      return React.createElement(Picker, { kind, model: selectedModel, reasoningEffort: selectedEffort, powerSelections,
        models: result?.data?.models || [],
        selectedPowerSelection: { model: selectedModel, reasoningEffort: selectedEffort },
        onSelectModel: model => { selectedModel = model; renderNative() },
        onSelectPower: selection => { nativeSelectionCalls.push({ model: selection.model, effort: selection.reasoningEffort }); selectedModel = selection.model; selectedEffort = selection.reasoningEffort; renderNative() } })
    }
    const root = dom.createRoot(document.getElementById('root'))
    window.renderNative = () => root.render(React.createElement(native.__fuel_queryProvider, { queryClient: client },
      React.createElement(native.__fuel_vln, { scope }, ['main', 'limited', 'hidden'].map(kind => React.createElement(Composer, { key: kind, kind })))))
    window.setNativeGate = value => nativeScope.set(gateSignal, value)
    window.setNativeEfforts = value => nativeScope.set(efforts, new Set(value))
    window.nativeClient = client
    window.updateNativeModels = () => {
      raw = { data: raw.data.map(model => ({ ...model, displayName: 'updated-' + model.model })) }
      return client.invalidateQueries()
    }
    if (webpack) {
      for (const name of ['100001.chunk.js','100002.chunk.js','100003.chunk.js','100004.chunk.js', appName.split('/').at(-1)]) {
        const script = document.createElement('script'); script.type='module'; script.src='/assets/' + name; document.head.appendChild(script)
      }
    }
    window.codexAppAssetUrl = prefix => webpack ? (prefix === appName.split('/').at(-1) ? new URL('/'+appName, location.href).href : '')
      : prefix === 'app-shared-' ? '/' + appName : '/native-model-query-fixture.js'
    window.loadCodexAppModule = async (prefix, options) => {
      const address = new URL('/' + appName, location.href).href
      if (options && (options.expectedUrl !== address || options.validate(address) !== true)) return null
      if (prefix !== (webpack ? appName.split('/').at(-1) : 'app-shared-')) throw new Error('Unexpected native module')
      return native
    }
    const originalFetch = window.fetch
    window.fetch = (url, options) => url === '/native-model-query-fixture.js'
      ? Promise.resolve({ ok: true, text: async () => initialSource })
      : url === '/' + appName ? Promise.resolve({ ok: true, text: async () => sharedSource }) : originalFetch(url, options)
    renderNative()
  }, { appName: packaged.appName, factorySource, initialSource, sharedSource, auth, webpack, configQuery: packaged.profile === '26.1103', responseFallback, aggregate })
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max')
  const nativeObserverCount = await page.evaluate(() => nativeClient.getQueryCache().getAll().reduce((count, query) => count + query.observers.length, 0))
  await page.evaluate(async () => { window.runtime = await installCodexUltraRuntime({ state: ultraState }) })
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max,ultra').catch(async error => {
    const diagnostic = await page.evaluate(() => ({ status: runtime.status(), main: document.getElementById('main')?.textContent,
      scopes: Array.from(codexUltraScopeChains()).map(chain => [...chain.values()].map(root => ({ queryClient: !!root.queryClient,
        families: [...(root.familyBindings || [])].map(([family, members]) => ({ keys: [...members.keys()],
          kinds: [...members.values()].map(member => member.value?.queryKind), symbols: Object.getOwnPropertySymbols(family).map(key => key.description) })) }))) }))
    error.message += '\nNative fixture diagnostics: ' + JSON.stringify({ ...diagnostic, browserErrors })
    throw error
  })
  assert.equal(await page.evaluate(() => runtime.status().verified), true)
  assert.equal(await page.evaluate(() => runtime.status().adaptation), responseFallback ? 'model-response' : 'native-query')
  assert.deepEqual(await page.evaluate(() => ['limited', 'hidden'].map(id => document.getElementById(id).textContent)), ['medium,max', 'medium,max'])
  assert.equal(await page.evaluate(() => runtime.status().queryCount), 3)
  await page.locator('#main-ultra').click()
  assert.equal(await page.evaluate(() => selectedEffort), 'ultra')
  if (aggregate) {
    for (const model of await page.evaluate(() => testUltraModels)) {
      await page.evaluate(model => { selectedModel = model; selectedEffort = 'medium'; renderNative() }, model)
      await page.waitForFunction(model => runtime.status().verified
        && codexUltraVisiblePickerState().pickers[0]?.model === model, model)
      await page.locator('#main-ultra').click()
      await page.waitForFunction(model => selectedModel === model && selectedEffort === 'ultra'
        && document.getElementById('main').dataset.selectedReasoningEffort === 'ultra', model)
      assert.deepEqual(await page.evaluate(() => nativeSelectionCalls.at(-1)), { model, effort: 'ultra' })
      await page.evaluate(() => updateNativeModels())
      await page.waitForFunction(model => runtime.status().verified
        && codexUltraVisiblePickerState().pickers[0]?.selectedModelData?.displayName === 'updated-' + model, model)
      assert.equal(await page.evaluate(() => selectedEffort), 'ultra')
    }
    await page.evaluate(() => { selectedModel = testPrimaryModel; renderNative() })
    await page.waitForFunction(() => codexUltraVisiblePickerState().pickers[0]?.model === testPrimaryModel)
  }
  await page.evaluate(() => updateNativeModels())
  await page.waitForFunction(() => codexUltraVisiblePickerState().pickers[0]?.selectedModelData?.displayName === 'updated-' + testPrimaryModel)
  assert.equal(await page.evaluate(() => runtime.status().verified), true, 'native structurally shared model updates retain consumer identity')
  await page.evaluate(() => { selectedModel = testUnsupportedModel; selectedEffort = 'max'; renderNative() })
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max' && !runtime.status().verified)
  assert.equal(await page.evaluate(() => runtime.status().reason), 'visible-model-unsupported')
  await page.evaluate(() => { selectedModel = testPrimaryModel; renderNative() })
  await page.waitForFunction(() => runtime.status().verified)
  await page.evaluate(() => { showLimited = true; renderNative() })
  await page.waitForFunction(() => !runtime.status().verified)
  await page.evaluate(() => { showLimited = false; renderNative() })
  await page.waitForFunction(() => runtime.status().verified)
  await page.waitForFunction(count => nativeClient.getQueryCache().getAll().reduce((sum, query) => sum + query.observers.length, 0) === count, nativeObserverCount)
  for (const value of [true, false, true, false]) {
    await page.evaluate(value => setNativeGate(value), value)
    await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max,ultra')
  }
  await page.evaluate(() => setNativeEfforts(['medium', 'max']))
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max')
  await page.evaluate(() => setNativeEfforts(['medium', 'max', 'ultra']))
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max,ultra')
  await page.evaluate(() => { args = { ...args, includeUltraReasoningEffort: false }; renderNative() })
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max')
  await page.evaluate(() => { args = { ...args, includeUltraReasoningEffort: true }; renderNative() })
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max,ultra')
  if (packaged.profile === '26.1103') {
    await page.evaluate(() => setNativeConfig({ model_provider: 'openai', model_providers: {} }))
    await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max' && !runtime.status().verified)
    assert.equal(await page.evaluate(() => runtime.status().queryCount), 0)
    await page.evaluate(() => setNativeConfig({ model_provider: 'custom', model_catalog_json: '/synthetic/gaoge-model-catalog.json', model_providers: { custom: {} } }))
    await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max,ultra' && runtime.status().verified)
  }
  await page.evaluate(() => runtime.dispose())
  await page.waitForFunction(() => document.getElementById('main')?.textContent === 'medium,max')
  await page.waitForFunction(count => nativeClient.getQueryCache().getAll().reduce((sum, query) => sum + query.observers.length, 0) === count, nativeObserverCount)
  assert.deepEqual(browserErrors, [], 'native query lifecycle must have no browser errors or leaked readers')
})

for (const responseFallback of [false, true]) test(`aggregate public IDs keep their highest native effort with ${responseFallback ? 'response fallback' : 'reviewed query'}`, async () => {
  const h = harness({ version: '26.1103' })
  h.run(`
    const ids=['gaoge/openai/1/gpt-6-astra','gaoge/custom/openai/1/gpt-6-astra',
      'gaoge/external-user/custom/gpt-6-astra','gpt-6-astra',
      'gaoge/deepseek/1/deepseek-v4-pro','gaoge/kimi/1/kimi-k3','gaoge/glm/1/glm-5.3'];
    models=ids.map((model,index)=>({model,hidden:false,isDefault:index===0,
      supportedReasoningEfforts:['low','high','max'].map(reasoningEffort=>({reasoningEffort,description:'native '+reasoningEffort}))}));
    rawData={data:models};selectedModel=ids[0];
    state.modelReasoningEfforts=Object.fromEntries(ids.slice(0,3).map(model=>[model,['low','medium','high','xhigh','max','ultra']]));
    ${responseFallback ? "querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');" : ''}
    retain();
  `)
  assert.equal(h.run('hasUltra()'), false, 'native remote gate initially filters Ultra')
  const runtime = await h.install()
  assert.equal(runtime.status().verified, true)
  const levels = h.run('observer.result.models.map(model=>model.supportedReasoningEfforts.map(level=>level.reasoningEffort).join(","))')
  assert.deepEqual(Array.from(levels.slice(0, 3)), Array(3).fill('low,high,max,medium,xhigh,ultra'))
  assert.deepEqual(Array.from(levels.slice(3)), Array(4).fill('low,high,max'))
  for (const id of ['gaoge/openai/1/gpt-6-astra', 'gaoge/custom/openai/1/gpt-6-astra', 'gaoge/external-user/custom/gpt-6-astra']) {
    h.run(`selectedModel=${JSON.stringify(id)}`)
    assert.equal(runtime.status().verified, true, id)
  }
  assert.equal(h.run('remoteGate'), false, 'account-wide native gate remains untouched')
  h.run('args.includeUltraReasoningEffort=false;retain();observer.setOptions(nativeOptions())')
  await runtime.refresh()
  assert.equal(h.run('hasUltra()'), false)
  assert.equal(runtime.status().reason, 'setting-disabled')
  runtime.dispose()
})

test('aggregate declarations never enable empty or none-only native reasoning capabilities', async () => {
  const h = harness({ version: '26.1103' })
  h.run(`
    const ids=['gaoge/openai/empty/gpt-6-astra','gaoge/openai/none/gpt-6-astra','gaoge/openai/stale/gpt-6-astra'];
    models=ids.map((model,index)=>({model,hidden:false,isDefault:index===2,
      supportedReasoningEfforts:(index===0?[]:index===1?['none']:['high','max']).map(reasoningEffort=>({reasoningEffort}))}));
    rawData={data:models};selectedModel=ids[2];
    state.modelReasoningEfforts=Object.fromEntries(ids.map(model=>[model,['high','max','ultra']]));
    args.enabledReasoningEfforts=['none','high','max','ultra'];retain();
  `)
  const runtime = await h.install()
  assert.equal(runtime.status().verified, true)
  const levels = h.run('observer.result.models.map(model=>model.supportedReasoningEfforts.map(level=>level.reasoningEffort).join(","))')
  assert.deepEqual(Array.from(levels), ['', 'none', 'high,max,ultra'])
  h.run('selectedModel=models[0].model')
  assert.equal(runtime.status().verified, false)
  h.run('selectedModel=models[1].model')
  assert.equal(runtime.status().verified, false)
  runtime.dispose()
})


for (const version of ['26.1007', '26.1103']) for (const fallback of [false, true]) test(`${version} ${fallback ? 'fallback' : 'reviewed'} remote capabilities enable exact future IDs and revoke stale Ultra`, async () => {
  const h = harness({ version });
  h.run(`
    const ids=['gpt-6.2-astra','gpt-6.2-sol','vendor/future-model','gpt-6.1-sol','other/future-model'];
    models=ids.map((model,index)=>({model,hidden:false,isDefault:index===0,
      supportedReasoningEfforts:(index===3?['high','max','ultra']:['high','max']).map(reasoningEffort=>({reasoningEffort}))}));
    rawData={data:models};selectedModel=ids[0];
    state.modelReasoningEfforts=Object.fromEntries(ids.slice(0,3).map(model=>[model,['high','max','ultra']]));
    state.modelUltraOverrides={'gpt-6.2-astra':true,'gpt-6.2-sol':true,'vendor/future-model':true,'gpt-6.1-sol':false};
    ${fallback ? "querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');" : ''}
    retain();
  `);
  let runtime = await h.install();
  assert.equal(runtime.status().verified, true);
  assert.deepEqual(Array.from(h.run('observer.result.models.map(model=>model.supportedReasoningEfforts.map(level=>level.reasoningEffort).join(","))')),
    ['high,max,ultra','high,max,ultra','high,max,ultra','high,max','high,max']);
  h.run(`state.modelReasoningEfforts={};state.modelUltraOverrides={'gpt-6.2-astra':false,'gpt-6.1-sol':false};state.scopeKey='revoked';`);
  runtime = await h.install();
  assert.equal(h.run('hasUltra()'), false);
  assert.equal(h.run('remoteGate'), false);
  runtime.dispose();
});

test('remote revocation removes Ultra across alternate native fields without granting nonreasoning support', () => {
  const h=harness();
  const output=h.run(`codexUltraModelResponse({data:[{model:'future',supportedReasoningEfforts:[{reasoningEffort:'ultra'}],
    supported_reasoning_levels:[{effort:'ultra'}]},{model:'none',supportedReasoningEfforts:[{reasoningEffort:'none'}]}]},
    {future:['ultra'],none:['max','ultra']},{future:false,none:true})`);
  assert.deepEqual(Array.from(output.data[0].supportedReasoningEfforts), []);
  assert.deepEqual(Array.from(output.data[0].supported_reasoning_levels), []);
  assert.deepEqual(Array.from(output.data[1].supportedReasoningEfforts, value=>value.reasoningEffort), ['none']);
});


function remotePublicationHarness(version, fallback) {
  const h = harness({ version });
  h.run(`
    modelEntry=(model,index)=>({model,hidden:false,isDefault:index===0,
      supportedReasoningEfforts:['high','max'].map(reasoningEffort=>({reasoningEffort,description:reasoningEffort+' effort'}))});
    models=['future-model','other-model'].map(modelEntry);rawData={data:models};
    selectedModel='future-model';remoteGate=true;
    state.modelReasoningEfforts={'future-model':['high','max','ultra']};
    state.modelUltraOverrides={'future-model':true};
    ${fallback ? "querySource=querySource.replace('.FIVE_MINUTES','.ONE_MINUTE');" : ''}
    retain();
    cacheQuery={queryKey:observer.options.queryKey,state:{data:rawData,dataUpdatedAt:42}};
    root.queryClient.getQueryCache=()=>({getAll:()=>[cacheQuery]});
    root.queryClient.setQueryData=(_key,data,options)=>{
      cacheQuery.state={data,dataUpdatedAt:options.updatedAt};rawData=data;renderConsumers();return data;
    };
  `);
  return h;
}

for (const version of ['26.1007', '26.1103']) for (const fallback of [false, true]) {
  for (const refresh of [false, true]) for (const transition of ['disabled', 'default', 'changed']) {
    test(`${version} ${fallback ? 'fallback' : 'reviewed'} queryFn provenance restores own Ultra on ${transition} ${refresh ? 'after' : 'without'} refresh`, async () => {
      const h = remotePublicationHarness(version, fallback);
      let runtime = await h.install();
      assert.equal(h.run('hasUltra()'), true);
      h.run(`rawData={data:['future-model','other-model'].map(modelEntry)};
        rawData.data[0].displayName='new response';newOriginal=rawData;`);
      h.context.response = await h.run('observer.options.queryFn({queryKey:observer.options.queryKey})');
      h.run('root.queryClient.setQueryData(cacheQuery.queryKey,response,{updatedAt:60})');
      if (refresh) await runtime.refresh();
      h.run(`state={...state,enabled:${transition !== 'disabled'},
        modelReasoningEfforts:${transition === 'changed' ? "{'other-model':['high','max','ultra']}" : '{}'},
        modelUltraOverrides:${transition === 'changed' ? "{'other-model':true}" : '{}'}};`);
      runtime = await h.install();
      assert.equal(h.run('hasUltra()'), false);
      assert.equal(h.run('cacheQuery.state.data.data[0].displayName'), 'new response');
      assert.deepEqual(Array.from(h.run('cacheQuery.state.data.data[0].supportedReasoningEfforts.map(entry=>entry.reasoningEffort)')), ['high','max']);
      assert.equal(h.run('cacheQuery.state.dataUpdatedAt'), 60);
      assert.equal(h.run('remoteGate'), true);
      if (transition !== 'changed') assert.equal(h.run('cacheQuery.state.data===newOriginal'), true);
      else assert.equal(h.run('cacheQuery.state.data.data[1].supportedReasoningEfforts.some(entry=>entry.reasoningEffort==="ultra")'), true);
      runtime.dispose();
    });
  }
  test(`${version} ${fallback ? 'fallback' : 'reviewed'} queryFn provenance never retracts a genuinely newer native publication`, async () => {
    const h = remotePublicationHarness(version, fallback);
    const runtime = await h.install();
    h.run(`rawData={data:['future-model','other-model'].map(modelEntry)};`);
    h.context.response = await h.run('observer.options.queryFn({queryKey:observer.options.queryKey})');
    h.run(`root.queryClient.setQueryData(cacheQuery.queryKey,response,{updatedAt:60});
      nativePublication={data:[{...modelEntry('future-model',0),displayName:'native owns Ultra',
        supportedReasoningEfforts:['high','max','ultra'].map(reasoningEffort=>({reasoningEffort,description:reasoningEffort+' effort'}))}]};
      root.queryClient.setQueryData(cacheQuery.queryKey,nativePublication,{updatedAt:90});`);
    runtime.dispose();
    assert.equal(h.run('cacheQuery.state.data===nativePublication'), true);
    assert.equal(h.run('cacheQuery.state.dataUpdatedAt'), 90);
    assert.equal(h.run('hasUltra()'), true);
  });
}


for (const version of ['26.1007', '26.1103']) for (const fallback of [false, true]) {
  test(`${version} ${fallback ? 'fallback' : 'reviewed'} structurally copied queryFn publications lose only runtime-owned Ultra`, async () => {
    const h = remotePublicationHarness(version, fallback);
    h.run(`cacheQuery.setData=function(data,options){
      const stored={...data,data:data.data.map(model=>({...model}))};
      this.state={data:stored,dataUpdatedAt:options.updatedAt};rawData=stored;renderConsumers();return stored;
    };nativeSetData=cacheQuery.setData;
    root.queryClient.setQueryData=(_key,data,options)=>cacheQuery.setData(data,options);`);
    let runtime = await h.install();
    h.run(`rawData={data:['future-model','other-model'].map(modelEntry)};
      rawData.data[0].displayName='fresh copied native data';newOriginal=rawData;`);
    h.context.response = await h.run('observer.options.queryFn({queryKey:observer.options.queryKey})');
    h.run('root.queryClient.setQueryData(cacheQuery.queryKey,response,{updatedAt:60})');
    assert.equal(h.run('cacheQuery.state.data===response'), false);
    h.run('state={...state,enabled:false,modelReasoningEfforts:{},modelUltraOverrides:{}}');
    runtime = await h.install();
    assert.equal(h.run('hasUltra()'), false);
    assert.equal(h.run('cacheQuery.state.data.data[0].displayName'), 'fresh copied native data');
    assert.equal(h.run('cacheQuery.state.dataUpdatedAt'), 60);
    assert.equal(h.run('cacheQuery.setData===nativeSetData'), true);
    assert.deepEqual(Array.from(h.run('newOriginal.data[0].supportedReasoningEfforts.map(level=>level.reasoningEffort)')), ['high','max']);
    runtime.dispose();
  });
}


test('owned publication hook preserves native identity reuse, method semantics and external replacements', async () => {
  const h = remotePublicationHarness('26.1103', true);
  h.run(`const prototype={setData(data,...args){
    lastPublication={self:this,data,args};if(data?.throwPublication)throw expectedError;
    const stored=this.state.data?.data?.[0]?.displayName==='native-identical' && data.data?.[0]?.displayName==='native-identical'
      ? this.state.data : {...data};
    this.state={data:stored,dataUpdatedAt:args[0].updatedAt};rawData=stored;renderConsumers();return stored;
  }};Object.setPrototypeOf(cacheQuery,prototype);nativeSetData=cacheQuery.setData;
  foreignQuery={queryKey:['models','remote'],state:{data:rawData,dataUpdatedAt:1},setData:nativeSetData};
  root.queryClient.getQueryCache=()=>({getAll:()=>[cacheQuery,foreignQuery]});
  root.queryClient.setQueryData=(_key,data,options)=>cacheQuery.setData(data,options);
  expectedError=new Error('native publication error');`);
  const runtime = await h.install();
  assert.equal(h.run('foreignQuery.setData===nativeSetData'), true);
  h.run(`rawData={data:[{...modelEntry('future-model',0),displayName:'native-identical'}]};newOriginal=rawData;`);
  h.context.response = await h.run('observer.options.queryFn({queryKey:observer.options.queryKey})');
  h.run(`published=cacheQuery.setData(response,{updatedAt:60},'unchanged-extra');
    injected=cacheQuery.state.data;`);
  assert.equal(h.run('published===cacheQuery.state.data'), true);
  assert.equal(h.run('lastPublication.self===cacheQuery && lastPublication.data===response && lastPublication.args[1]==="unchanged-extra"'), true);
  assert.equal(h.run(`(()=>{try{cacheQuery.setData({throwPublication:true});return false}catch(error){return error===expectedError}})()`), true);
  h.run(`nativeIndependent=JSON.parse(JSON.stringify(response));
    cacheQuery.setData(nativeIndependent,{updatedAt:90});`);
  assert.equal(h.run('cacheQuery.state.data===injected'), true, 'native structural sharing intentionally reused identity');
  runtime.dispose();
  assert.equal(h.run('cacheQuery.state.data===injected'), true);
  assert.equal(h.run('cacheQuery.state.dataUpdatedAt'), 90);
  assert.equal(h.run('hasUltra()'), true, 'independent native Ultra is not runtime-owned');
  assert.equal(h.run('cacheQuery.setData===nativeSetData'), true);
  assert.equal(h.run('Object.hasOwn(cacheQuery,"setData")'), false, 'prototype descriptor restored');
  const again = await h.install();
  h.run('externalSetData=function(...args){return Reflect.apply(nativeSetData,this,args)};cacheQuery.setData=externalSetData');
  again.dispose();
  assert.equal(h.run('cacheQuery.setData===externalSetData'), true);
});
