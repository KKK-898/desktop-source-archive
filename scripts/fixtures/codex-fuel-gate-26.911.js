// Minimal semantic signatures from Codex 26.911.61220. This is discovery input,
// not a copied bundle or an application. Exports are supplied by the tests.
const Q = {}, Task = {}, Flag = {}, Enabled = {}, Mode = {}, Project = {}
const gate = { active: false, eligible: true, hardBlocked: true, banner: 'luna_reserve' }
function Hp() {}
function Y() {}
function Pp() {}
function select() {}
function Ip(e,t,n){let r=Pp(`signal`,e,(r,i)=>null);return r}
const Cro=Hp(Q,()=>gate),f1=Hp(Q,(e,{get:t})=>t(Cro,e).active),wro=Hp(Q,(e,{get:t})=>t(Cro,e).hardBlocked)
const provider=select(({modelProvider:e})=>e??null)
const directory=select(({cwd:e})=>e??null)
const host=select(({hostId:e})=>e??null)
const config=Hp(Q,({cwd:e=null,hostId:t},{get:n,queryClient:r,scope:i})=>({e,t,n,r,i}))
const cloud=Y(Task,({get:e,scope:t})=>e(Flag)?e(Enabled)&&e(Mode)?.kind===`cloud`:false)
const project=Y(Task,({get:e,scope:t})=>{if(e(Flag)&&t.value.routeKind===`home`)return null;if((t.value.routeKind===`home`||t.value.routeKind===`local-thread`))return e(Project);return null})
export{wro as UI,f1 as HI,Y as Pln,Ip as Bln,config as configExport,provider as providerExport,directory as cwdExport,host as hostExport,cloud as cloudExport,project as projectExport}
