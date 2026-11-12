// Synthetic semantic fixture for the 26.924 split-bundle layout. This is not
// an executable application or a copy of the native bundle.
import{sharedDerived as derive,sharedSignal as signal}from"./app-shared-fixture.js";
const Root={},Composer={},Page={},gate={active:false,eligible:true,hardBlocked:true,banner:"luna_reserve"};
function family(){} function query(){}
const refresh=signal(Root,0);
const quota=family(Root,()=>gate),active=family(Root,(e,{get:t})=>t(quota,e).active),hard=family(Root,(e,{get:t})=>t(quota,e).hardBlocked);
const config=query(Root,({cwd:e=null,hostId:t},{get:n,queryClient:r,scope:i})=>({e,t,n,r,i}));
const cloud=derive(Composer,({get:e,scope:t})=>e(Feature)?e(Prototype)?e(Enabled)&&e(Mode)?.kind===`cloud`:e(Legacy):false);
const project=derive(Page,({get:e,scope:t})=>{if(t.value.persistentWorkspace!=null)return e(Workspace,t.value.clientThreadId);let n=t.value.routeKind===`home`?Path(t.value.pathname):null;if(n!=null)return{type:`local`,projectId:n};if(e(Flag)&&t.value.routeKind===`home`)return null;if((t.value.routeKind===`home`||t.value.routeKind===`local-thread`))return e(Project);return null});
export{hard as hardExport,active as activeExport,config as configExport,cloud as cloudExport,project as projectExport}
