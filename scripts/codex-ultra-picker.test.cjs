const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/codex_ultra_picker.js'), 'utf8')
function harness() {
  const context = vm.createContext({})
  vm.runInContext(`
    class HTMLElement {
      constructor() { this.isConnected=true; this.parentElement=null; this.attrs={}; this.style={}; }
      getBoundingClientRect() { return {width:30,height:20}; }
      getAttribute(name) { return this.attrs[name] ?? null; }
    }
    getComputedStyle = element => ({display:'block',visibility:'visible',opacity:'1',...element.style});
    elements=[];
    document={querySelectorAll:()=>elements};
    scope={familyBindings:new Map(),queryClient:{}};
    chain=new Map([['root',scope]]);
    options=(model,levels)=>levels.map(reasoningEffort=>({id:model+':'+reasoningEffort,model,reasoningEffort}));
    make=(props,visible=true)=>{
      const element=new HTMLElement();
      if(!visible)element.style.display='none';
      const host={stateNode:element,memoizedProps:{}};
      const owner={memoizedProps:props,child:host};
      const provider={memoizedProps:{value:chain},child:owner};
      const root={child:provider};root.stateNode={current:root};
      provider.return=root;owner.return=provider;host.return=owner;
      element.__reactFiber$fixture=host;elements.push(element);
      return {element,host,owner,provider,root};
    };
    local=(model='sol',levels=['max','ultra'])=>({
      model,reasoningEffort:'max',onSelectModel(){},powerSelections:options(model,levels),
      models:[{model,supportedReasoningEfforts:levels.map(reasoningEffort=>({reasoningEffort}))},
        {model:'unrelated',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]}]
    });
    power=(model='sol',levels=['max','ultra'])=>({
      selectedPowerSelection:{model,reasoningEffort:'max'},selectedLabelCandidate:{model},
      onSelectPower(){},powerSelections:options(model,levels)
    });
  `, context)
  vm.runInContext(source, context)
  return {
    run: script => vm.runInContext(script, context),
    state: () => vm.runInContext('codexUltraVisiblePickerState()', context),
    json: () => JSON.parse(vm.runInContext('JSON.stringify(codexUltraVisiblePickerState(),(key,value)=>["chains","selectedModelData"].includes(key)?undefined:key==="roots"?value.length:value)', context))
  }
}

test('native local picker reports only the selected model Power choices and its scope', () => {
  const h = harness()
  h.run(`a=make(local('luna',['low','max']));a.owner.memoizedProps.powerSelections.push(...options('sol',['ultra']))`)
  assert.deepEqual(h.json(), {pickers:[{model:'luna',efforts:['low','max'],roots:1}],unresolvedCount:0})
  assert.equal(h.state().pickers[0].roots[0], h.run('scope'))
  assert.equal(h.state().pickers[0].selectedModelData, h.run('a.owner.memoizedProps.models[0]'))
})

test('native shared Power picker excludes locked choices, persistent and other models', () => {
  const h = harness()
  h.run(`p=power();p.powerSelections.push(...options('sol',['persistent']),...options('other',['ultra']));
    p.powerSelections.find(x=>x.reasoningEffort==='ultra').isLocked=true;make(p)`)
  assert.deepEqual(h.json().pickers, [{model:'sol',efforts:['max'],roots:1}])
})

test('all visible composers are reported; a hidden composer cannot certify the visible one', () => {
  const h = harness()
  h.run(`make(local('luna',['max']));make(power('sol'));make(local('hidden'),false)`)
  assert.deepEqual(h.json().pickers.map(p=>[p.model,p.efforts]), [['luna',['max']],['sol',['max','ultra']]])
})

test('reads committed root.current even when the DOM pointer belongs to the old alternate', () => {
  const h = harness()
  h.run(`old=make(local());currentHost={stateNode:old.element,memoizedProps:{}};
    currentOwner={memoizedProps:local('luna',['max']),child:currentHost};
    currentProvider={memoizedProps:{value:chain},child:currentOwner};
    currentRoot={child:currentProvider,stateNode:old.root.stateNode};
    old.root.stateNode.current=currentRoot;
    old.owner.pendingProps=local('fake');old.host.alternate=currentHost;`)
  assert.deepEqual(h.json().pickers, [{model:'luna',efforts:['max'],roots:1}])
})

test('uncommitted and unavailable owners are unresolved, not rescued by stale models or pendingProps', () => {
  const h = harness()
  h.run(`a=make({models:local().models});a.owner.pendingProps=local();
    b=make(local());b.root.stateNode.current={stateNode:b.root.stateNode};
    c=make(local());c.element.attrs['aria-busy']='true'`)
  assert.deepEqual(h.json(), {pickers:[],unresolvedCount:3})
})

test('a conflicted selection or an owner without its scope is unresolved', () => {
  const h = harness()
  h.run(`p=power();p.selectedLabelCandidate.model='other';make(p);
    a=make(local());a.provider.memoizedProps={}`)
  assert.deepEqual(h.json(), {pickers:[],unresolvedCount:2})
})

test('no visible trigger yields no verified candidates', () => {
  const h = harness()
  h.run(`make(local(),false);a=make(local());a.element.parentElement=new HTMLElement();
    a.element.parentElement.attrs['aria-hidden']='true'`)
  assert.deepEqual(h.json(), {pickers:[],unresolvedCount:0})
})

test('disabled and locked current models have no selectable efforts', () => {
  const h = harness()
  h.run(`p=power();p.powerSelectionDisabled=true;make(p);
    p=local();p.lockedModelSlug='sol';make(p);
    p=local();p.modelOptions=[{model:{model:'sol'},disabledReason:'locked'}];make(p)`)
  assert.deepEqual(h.json().pickers.map(p=>p.efforts), [[],[],[]])
})

test('scope roots are also read from the committed dependency context', () => {
  const h = harness()
  h.run(`a=make(power());a.provider.memoizedProps={};
    a.owner.dependencies={firstContext:{memoizedValue:{chain},next:null}}`)
  assert.equal(h.state().pickers[0].roots[0], h.run('scope'))
  assert.equal(h.state().chains[0], h.run('chain'))
})

test('a missing selected bundle can use the native selectedLabelCandidate model', () => {
  const h = harness()
  h.run(`p=power();p.selectedPowerSelection=null;make(p)`)
  assert.deepEqual(h.json().pickers, [{model:'sol',efforts:['max','ultra'],roots:1}])
})

test('discovery retains committed scope chains before the picker props are ready', () => {
  const h = harness()
  h.run(`make({loading:true});make(local())`)
  const state = h.state()
  assert.equal(state.unresolvedCount, 1)
  assert.equal(state.chains.length, 1)
  assert.equal(state.chains[0], h.run('chain'))
})

test('shared native picker retains the exact selected model object from its directly linked local wrapper', () => {
  const h = harness()
  h.run(`p=power();p.triggerConfig={hideLabel:false};a=make(p);
    wrapper={memoizedProps:{...local(),modelPickerTriggerConfig:p.triggerConfig},child:a.owner,return:a.provider};
    a.provider.child=wrapper;a.owner.return=wrapper;`)
  assert.equal(h.state().pickers[0].selectedModelData, h.run('wrapper.memoizedProps.models[0]'))
})

test('shared native picker rejects the current model disabled by its linked local wrapper', () => {
  const h = harness()
  h.run(`p=power();p.triggerConfig={hideLabel:false};a=make(p);
    wrapper={memoizedProps:{...local(),modelPickerTriggerConfig:p.triggerConfig},child:a.owner,return:a.provider};
    a.provider.child=wrapper;a.owner.return=wrapper;
    wrapper.memoizedProps.modelOptions=[{model:{model:'sol'},disabledReason:'blocked'}]`)
  assert.deepEqual(h.json().pickers[0].efforts, [])
  assert.equal(h.state().pickers[0].selectedModelData, h.run('wrapper.memoizedProps.models[0]'))
  h.run(`wrapper.memoizedProps.modelOptions[0].model.model='another-model'`)
  assert.deepEqual(h.json().pickers[0].efforts, ['max', 'ultra'])
  h.run(`wrapper.memoizedProps.modelOptions[0].model.model='sol';wrapper.memoizedProps.modelOptions[0].disabledReason=null`)
  assert.deepEqual(h.json().pickers[0].efforts, ['max', 'ultra'])
})

test('shared native picker remains unavailable until its linked local wrapper finishes saving', () => {
  const h = harness()
  h.run(`p=power();p.triggerConfig={hideLabel:false};a=make(p);
    wrapper={memoizedProps:{...local(),modelPickerTriggerConfig:p.triggerConfig,daybreak:{isSaving:true}},child:a.owner,return:a.provider};
    a.provider.child=wrapper;a.owner.return=wrapper;`)
  assert.deepEqual(h.json().pickers[0].efforts, [])
  h.run('wrapper.memoizedProps.daybreak.isSaving=false')
  assert.deepEqual(h.json().pickers[0].efforts, ['max', 'ultra'])
})

test('local native picker remains unavailable until its own daybreak change finishes saving', () => {
  const h = harness()
  h.run('p=local();p.daybreak={isSaving:true};make(p)')
  assert.deepEqual(h.json().pickers[0].efforts, [])
  h.run('p.daybreak.isSaving=false')
  assert.deepEqual(h.json().pickers[0].efforts, ['max', 'ultra'])
})

test('unrelated ancestor models and unmatched wrapper configs cannot provide consumer identity', () => {
  const h = harness()
  h.run(`p=power();p.triggerConfig={};a=make(p);
    a.provider.memoizedProps={...local(),value:chain,modelPickerTriggerConfig:{}};
    b=make(power());b.provider.memoizedProps={...local(),value:chain};`)
  assert.deepEqual(Array.from(h.state().pickers, p=>p.selectedModelData), [null,null])
})

test('a matching but nonadjacent local wrapper cannot be substituted for the current consumer', () => {
  const h = harness()
  h.run(`p=power();p.triggerConfig={};a=make(p);
    unrelated={memoizedProps:{},child:a.owner,return:a.provider};
    a.provider.child=unrelated;a.owner.return=unrelated;
    a.provider.memoizedProps={...local(),value:chain,modelPickerTriggerConfig:p.triggerConfig};`)
  assert.equal(h.state().pickers[0].selectedModelData, null)
})

test('a selected model identity is never inferred from another model or ambiguous duplicate entries', () => {
  const h = harness()
  h.run(`p=local();p.models=p.models.filter(model=>model.model!=='sol');make(p);
    p=local();p.models.push({...p.models[0]});make(p);`)
  assert.deepEqual(Array.from(h.state().pickers, p=>p.selectedModelData), [null,null])
})

test('26.1029 opaque pre-selection guard cannot falsely certify Ultra or run side effects', () => {
  const h = harness()
  h.run("guardCalls=0;p=local();p.reasoningEffort='max';p.onBeforeSelectModel=()=>{guardCalls++;return false};make(p)")
  assert.equal(h.json().pickers.length, 0)
  assert.equal(h.json().unresolvedCount, 1)
  assert.equal(h.run('guardCalls'), 0)
  h.run("p.reasoningEffort='ultra'")
  assert.deepEqual(h.json().pickers[0].efforts, ['max', 'ultra'])
  assert.equal(h.run('guardCalls'), 0)
})
