// Minimal semantic signatures from Codex 26.917.6896. The derived factory is
// imported from app-shared and the thread host is now a family selector.
import{sharedDerived as as,sharedSignal as Uo}from"./app-shared-fixture.js";
const X={},QR={},Rb={},gate={active:false,eligible:true,hardBlocked:true,banner:"luna_reserve"};
function es(){} function tE(){} function Qr(){}
const refresh=Uo(X,0);
const aha=es(X,()=>gate),oq=es(X,(e,{get:t})=>t(aha,e).active),oha=es(X,(e,{get:t})=>t(aha,e).hardBlocked);
const provider=tE(({modelProvider:e})=>e??null),cwd=tE(({cwd:e})=>e??null);
const host=es(X,(e,{get:t})=>{let n=e==null?null:t(Hosts,e);return Direct(t,e)??(n?.has(`local`)?`local`:n?.values().next().value)??t(Manager,e)?.getHostId()??`local`});
const config=Qr(X,({cwd:e=null,hostId:t},{get:n,queryClient:r,scope:i})=>({e,t,n,r,i}));
const cloud=as(QR,({get:e,scope:t})=>e(Flag)?e(Enabled)&&e(Mode)?.kind===`cloud`:false);
const project=as(Rb,({get:e,scope:t})=>{if(e(Flag)&&t.value.routeKind===`home`)return null;if((t.value.routeKind===`home`||t.value.routeKind===`local-thread`))return e(Project);return null});
export{oha as hardExport,oq as activeExport,config as configExport,provider as providerExport,cwd as cwdExport,host as hostExport,cloud as cloudExport,project as projectExport}
