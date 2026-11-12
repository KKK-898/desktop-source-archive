// Synthetic discovery input: captures native queued/commit/cleanup semantics
// without copying or executing a native bundle.
function clearSelection(e,t){e.get(inFlight,t.target)===t.selection&&(e.set(inFlight,t.target,null),e.get(queued,t.target)===t.selection&&e.set(queued,t.target,null),t.target[0]==="default"&&e.set(global,null))}
queued=family(Root,e=>null),inFlight=family(Root,e=>null);
function commit(e){store.set(inFlight,e.target,e.selection);return(async()=>{await e.write();clearSelection(store,e)})()}
function schedule(e){store.set(queued,e.target,e.selection);setTimeout(()=>commit(e),320)}
export{queued as queueExport,inFlight as savingExport}
