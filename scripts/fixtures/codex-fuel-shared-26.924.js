// Synthetic shared-framework and thread-selector signatures, supplied with
// inert module exports by discovery tests.
const Root={};
function derived(e,t,n){return makeDerived(e,t,void 0,n)}
function makeDerived(e,t,n,r){return {createSubscriberAtom:()=>null,kind:`derived`}}
function signal(e,t,n){let r=descriptor(`signal`,e,(r,i)=>null);return r}
function select(){} function family(){}
const provider=select(({modelProvider:e})=>e??null),cwd=select(({cwd:e})=>e??null);
const host=family(Root,(e,{get:t})=>{let n=e==null?null:t(Hosts,e);return Direct(t,e)??(n?.has(`local`)?`local`:n?.values().next().value)??t(Manager,e)?.getHostId()??`local`});
export{derived as sharedDerived,signal as sharedSignal,provider as providerExport,cwd as cwdExport,host as hostExport}
