'use strict';
// Isolated, read-only extraction of the installed Codex renderer. Native factories
// and React compiler memo paths execute against a small hook/host fixture; no
// application process, user profile, native bridge, or network is accessed.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const DEFAULT_ARCHIVE = 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1103.7773.0_x64__2p2nqsd0c76g0/app/resources/app.asar';

async function createNativeLocaleRendererFixture(options = {}) {
  const archive = options.archivePath || process.env.GAOGE_CODEX_TEST_ASAR || DEFAULT_ARCHIVE;
  if (!fs.existsSync(archive)) return { available: false, reason: 'Installed Codex archive is unavailable' };
  const asar = await import('@electron/asar');
  const paths = asar.listPackage(archive);
  const filenames = ['182735.7f13786b92.js', '727403.da6b00f04b.js', '890434.9dbaee449e.js'];
  const code = filenames.map(name => {
    const found = paths.find(path => path.endsWith('\\' + name) || path.endsWith('/' + name));
    if (!found) return null;
    return { name, text: asar.extractFile(archive, found.replace(/^[\\/]/, '')).toString('utf8') };
  });
  if (code.some(item => !item)) return { available: false, reason: 'Installed Codex renderer fixture version differs' };
  let locale = options.locale ?? null, dirty = true, active = null, effectQueue = [], lastIntl = null, eventCount = 0;
  const writes = [], translationLoads = [], compilerCaches = [], frames = new Map(), timers = new Map(), storage = new Map();
  let nextTimer = 0;
  const document = { documentElement: { lang: 'en-US', dir: 'ltr' }, scripts: [{ type: 'module', src: 'https://codex.local/assets/main.fixture.js' }] };
  const window = { document, location: { href: 'https://codex.local/index.html' }, navigator: { language: 'en-US', languages: ['en-US'] },
    localStorage: { getItem:key=>storage.get(key)??null, setItem:(key,value)=>storage.set(key,String(value)), removeItem:key=>storage.delete(key) },
    setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);} };
  window.window=window;
  const context=vm.createContext({window,document,navigator:window.navigator,URL,console,Intl,Promise,Symbol,setTimeout:window.setTimeout,clearTimeout:window.clearTimeout});
  const factories={},sources={};
  for(const entry of code){
    if(!entry.text.includes('export const __webpack_modules__=')) throw Error('Unexpected renderer chunk shape');
    const extracted=vm.runInContext(entry.text.replaceAll('export const ','var ')+'\n;__webpack_modules__',context,{timeout:5000});
    Object.assign(factories,extracted);
    sources[entry.name]={sha256:crypto.createHash('sha256').update(entry.text).digest('hex')};
  }
  const sentinel=Symbol.for('react.memo_cache_sentinel');
  const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  function hook(){if(!active)throw Error('Hook called outside isolated renderer');const index=active.hookIndex++;return {frame:active,index,old:active.hooks[index]};}
  const React={
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE:{H:{useMemoCache(size){
      if(!active)throw Error('Memo cache outside render');const index=active.memoIndex++;let cache=active.memos[index];
      if(!cache){cache=Array(size).fill(sentinel);active.memos[index]=cache;compilerCaches.push({size,cache,type:active.type});}
      if(cache.length!==size)throw Error('Native compiler memo size changed');return cache;
    }}},
    createContext(value){const result={value};result.Provider={__context:result};return result;},
    useContext(ctx){return ctx.value;},
    useState(initial){const {frame,index,old}=hook();if(!old)frame.hooks[index]={value:typeof initial==='function'?initial():initial};const record=frame.hooks[index];return [record.value,next=>{const value=typeof next==='function'?next(record.value):next;if(!Object.is(record.value,value)){record.value=value;dirty=true;}}];},
    useMemo(factory,deps){const {frame,index,old}=hook();if(!old||!same(old.deps,deps))frame.hooks[index]={value:factory(),deps};return frame.hooks[index].value;},
    useCallback(fn,deps){return React.useMemo(()=>fn,deps);},
    useEffect(effect,deps){const {frame,index,old}=hook();if(!old||!same(old.deps,deps)){const record={deps,cleanup:old?.cleanup};frame.hooks[index]=record;effectQueue.push(()=>{record.cleanup?.();record.cleanup=effect();});}},
    useLayoutEffect(effect,deps){return React.useEffect(effect,deps);},
  };
  const log={error(){},warn(){}};
  const jsx=(type,props)=>({type,props:props||{}});
  const descriptor={key:'localeOverride',default:null};
  const settings={async read(key){if(key!=='localeOverride')throw Error('Unexpected setting read');return {effective:locale};},async write(key,value){if(key!=='localeOverride')throw Error('Unexpected setting write');writes.push(value);locale=value;dirty=true;}};
  const a={appServices:{settings}},s={P:value=>value};
  // Exact reviewed RxZZ entry functions, with its host dependency isolated above.
  async function b(e){if(a.appServices?.settings!=null)return(await (0,s.P)(a.appServices.settings.read(e.key))).effective;throw Error('Settings are unavailable on this host');}
  async function L(e,t){if(a.appServices?.settings!=null)return void await (0,s.P)(a.appServices.settings.write(e.key,t));throw Error('Settings are unavailable on this host');}
  const nativeScope={fixtureScope:true};
  const stubs={
    zd8w:React,ABep:{jsx,jsxs:jsx},
    gXxh:{Log:log,SDKType:{_setBindingType(){}}}, enUe:{isNoopClient:client=>client?.isNoop===true,NoopEvaluationsClient:{isNoop:true}},
    aclU:{useClientAsyncInit(){throw Error('Fixture must use the supplied native Statsig client');}},
    zTeN:{gh:()=>nativeScope,Ul:()=>({data:{ideLocale:'en-US',systemLocale:'en-US'}}),_U(){return null;}},
    DBCl:{Szl:{localeOverride:descriptor}}, RxZZ:{LA:b,cz:L,iK:()=>locale},
    iRMi:{CodexI18nLocaleResolved:'locale-resolved'}, X1mr:{}, yGJW:{yy(){}},OWtl:{u:{}},WFY2:{v:log},yC2B:{b:()=> 'ltr'},BhpD:{v:{}},OMIV:{},
    W0tK:{sd:value=>value==='en'||value==='en-US',bW:value=>typeof value==='string'?value:null,
      UK:value=>value&&value!=='en-US'?{locale:value}:null,
      async d5(target){translationLoads.push(target.locale);if(options.translationBarrier)await options.translationBarrier;return {fixtureSettings:target.locale==='zh-CN'?'设置':'Settings',fixtureChat:'聊天'};}},
    k5JT:{DirectionProvider:({children})=>children},G8V1:{A:props=>{lastIntl={locale:props.locale,messages:props.messages};return props.children;}},
    VOB2:{},CAnX:{},urv6:{},qn8S:{Log:log},Sm3o:{},qWlF:{},z6n4:{},aU43:{},CItj:{},
  };
  const cache={};
  function requireNative(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;
    if(Object.prototype.hasOwnProperty.call(stubs,id)){module.exports=stubs[id];return module.exports;}
    const factory=factories[id];if(typeof factory!=='function')throw Error('Unexpected native dependency '+id);
    factory(module,module.exports,requireNative);return module.exports;
  }
  requireNative.c=cache;requireNative.m=factories;requireNative.j=348410;
  requireNative.d=(target,getters={},values={})=>{for(const[key,get]of Object.entries(getters))if(!Object.hasOwn(target,key))Object.defineProperty(target,key,{enumerable:true,get});for(const[key,value]of Object.entries(values))if(!Object.hasOwn(target,key))Object.defineProperty(target,key,{enumerable:true,value});};
  requireNative.r=target=>Object.defineProperty(target,'__esModule',{value:true});
  const Base=requireNative('FTVk').StatsigClientBase;
  const client=Object.create(Base.prototype);
  Object.assign(client,{loadingStatus:'Ready',_listeners:{},_errorBoundary:{logError(){}},_memoCache:{},flush:async()=>{}});
  const layer={name:'72216192',__value:{enable_i18n:options.gateEnabled===true,locale_source:'IDE'},get(key,fallback){return this.__value[key]??fallback;}};
  const dynamic={name:'72216192',value:{enable_i18n:options.gateEnabled===true,locale_source:'IDE'},get(key,fallback){return this.value[key]??fallback;}};
  client.getLayer=function(name){if(name!=='72216192')return {name,__value:{},get:(_key,fallback)=>fallback};return layer;};
  client.getDynamicConfig=function(name){if(name!=='72216192')return {name,value:{},get:(_key,fallback)=>fallback};return dynamic;};
  client.on('values_updated',()=>{eventCount+=1;});
  window.__STATSIG__={firstInstance:client,instances:{fixture:client},instance:()=>client};
  context.__STATSIG__=window.__STATSIG__;
  stubs.JlWK={useStatsigClient:requireNative('uw9G').useStatsigClient};
  const Provider=requireNative('keui').StatsigProvider,LocaleProvider=requireNative('HHvo').M;
  // Ensure adapter discovery sees the real compiler/Intl identities in cache.
  requireNative('QosV');requireNative('F0CT');requireNative('GrLh');
  function visit(node){
    if(node==null||typeof node==='string'||typeof node==='number')return node;
    if(Array.isArray(node))return node.map(visit);
    if(node.type?.__context){const ctx=node.type.__context,previous=ctx.value;ctx.value=node.props.value;try{return visit(node.props.children);}finally{ctx.value=previous;}}
    if(typeof node.type!=='function')return visit(node.props?.children);
    let frame=frames.get(node.type);if(!frame){frame={type:node.type,hooks:[],memos:[]};frames.set(node.type,frame);}frame.hookIndex=0;frame.memoIndex=0;
    const previous=active;active=frame;let child;try{child=node.type(node.props);}finally{active=previous;}return visit(child);
  }
  function render(){dirty=false;visit(jsx(Provider,{client,children:jsx(LocaleProvider,{children:'fixture-app'})}));const effects=effectQueue;effectQueue=[];for(const effect of effects)effect();}
  async function settle(){for(let i=0;i<45;i++){if(dirty)render();await Promise.resolve();await Promise.resolve();}if(dirty)render();}
  const entryUrl='https://codex.local/assets/main.fixture.js';
  const runtimeOptions={assetUrl:name=>name==='main.fixture.js'?entryUrl:'',loadModule:async name=>{if(name!=='main.fixture.js')throw Error('Unexpected native module request');return {__webpack_require__:requireNative};}};
  function install(source,extra={}){vm.runInContext(source,context,{timeout:5000});return context.installCodexLocaleRuntime({enabled:true,revision:'native-fixture:1',...runtimeOptions,...extra});}
  return {available:true,archive,window,context,module:{__webpack_require__:requireNative},client,layer,runtimeOptions,
    render,settle,locale:()=>locale,messages:()=>lastIntl?.messages,intl:()=>lastIntl,translationLoads,events:()=>eventCount,writes,compilerCaches,
    install,sources,timers,setLocale(value){locale=value;dirty=true;},snapshot(){return {locale,lastIntl,translationLoads:[...translationLoads],events:eventCount};}};
}
module.exports={createNativeLocaleRendererFixture};
