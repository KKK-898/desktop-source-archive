// Synthetic discovery input matching Codex 26.1007.21434 (MSIX 26.1007.2314.0).
// Native hRi clears only gRi/PG; queued writes replace older pending selections,
// wait 320ms, await the writer, and clear only that exact committed selection.
// Names are synthetic; this fixture is inspected, never executed against Codex.
function clearSelection(e,t){e.get(inFlight,t.target)===t.selection&&(e.set(inFlight,t.target,null),e.get(queued,t.target)===t.selection&&e.set(queued,t.target,null))}
queued=family(Root,e=>null),inFlight=family(Root,e=>null);
selectionQueue=controller(Root,(key,{scope:store})=>{let pending=null,saving=!1,timer=null;async function commit(){if(saving||pending==null)return;let e=pending;pending=null,saving=!0,store.set(inFlight,e.target,e.selection);let saved=!1;try{saved=await e.write()}catch{}clearSelection(store,e),e.resolve(saved),saving=!1,pending!=null&&timer==null&&commit()}function schedule(){timer!=null&&clearTimeout(timer),timer=setTimeout(()=>{timer=null,commit()},320)}return e=>{let previous=pending;store.set(queued,e.target,e.selection),pending=e,previous?.resolve(!1),schedule()}});
export{queued as queueExport,inFlight as savingExport}
