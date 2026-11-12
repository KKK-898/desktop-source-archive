const assert = require('node:assert/strict')
const ts = require('typescript')
const asar = require('@electron/asar')

// Read only the bundled ProseMirror model/state/view/history modules. No app
// entrypoint, Electron service, account setting, or installed file is executed.
function nativePasteFixture(packagePath) {
  const wanted = new Set(['rTVh', 'Hpb6', 'HLFh', 'f6KK', 'SAxP', 'GTmQ'])
  const found = new Map()
  const candidates = new Map()
  const anchors = { composer: false, paste: false, viewDesc: false }
  let composerSource = '', plainInsertSource = ''
  for (const name of asar.listPackage(packagePath).map(file => file.replace(/^[\\/]/, ''))) {
    if (!/\.js$/.test(name) || !/webview[\\/]assets[\\/]/.test(name)) continue
    const source = asar.extractFile(packagePath, name).toString('utf8')
    if (source.includes('handlePaste(') && source.includes('wON9(') && (!composerSource || source.length < composerSource.length)) composerSource = source
    if (source.includes('MnjQ(') && (!plainInsertSource || source.length < plainInsertSource.length)) plainInsertSource = source
    anchors.composer ||= source.includes('"data-codex-composer-root":""')
    anchors.paste ||= source.includes('handlePaste(') && source.includes('"pasted-text"') && source.includes('"pasted-files"')
    anchors.viewDesc ||= source.includes('.pmViewDesc=this') && source.includes('this.view=')
    if (![...wanted].some(id => source.includes(id + '('))) continue
    for (const id of wanted) if (source.includes(id + '(') && (!candidates.has(id) || source.length < candidates.get(id).source.length)) candidates.set(id, { name, source })
  }
  for (const { name, source } of new Map([...candidates.values()].map(candidate => [candidate.name, candidate])).values()) {
    const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    function visit(node) {
      if (ts.isMethodDeclaration(node) && wanted.has(node.name?.getText(tree))) {
        const id = node.name.getText(tree)
        found.set(id, node.getText(tree))
        wanted.delete(id)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  assert.deepEqual([...wanted], [], 'Installed renderer must contain the reviewed ProseMirror modules')
  assert.equal(anchors.composer, true, 'Installed composer root marker changed')
  assert.equal(anchors.paste, true, 'Installed composer native paste handling changed')
  assert.equal(anchors.viewDesc, true, 'Installed ProseMirror view descriptor changed')
  const composerTree = ts.createSourceFile('native-composer.js', composerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let nativeHandler = ''
  function findHandler(node) {
    if (ts.isMethodDeclaration(node) && node.name?.getText(composerTree) === 'handlePaste' && node.getText(composerTree).includes('"pasted-images"')) nativeHandler = node.getText(composerTree)
    ts.forEachChild(node, findHandler)
  }
  findHandler(composerTree)
  assert.ok(nativeHandler, 'Installed native composer paste handler must be found')
  const insertTree = ts.createSourceFile('native-insert.js', plainInsertSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let nativeInsert = ''
  function findInsert(node) {
    if (ts.isPropertyAssignment(node) && node.name?.getText(insertTree) === '_g' && node.initializer.getText(insertTree).includes('replaceSelection(new')) nativeInsert = node.initializer.getText(insertTree)
    ts.forEachChild(node, findInsert)
  }
  findInsert(insertTree)
  assert.ok(nativeInsert, 'Installed native literal-text insertion must be found')
  const script = `(() => {
    const factories = {${[...found.values()].join(',')}};
    const cache = Object.create(null);
    function requireNative(id) {
      if (cache[id]) return cache[id].exports;
      if (!factories[id]) throw Error('Unreviewed ProseMirror dependency: ' + id);
      const entry = {exports:{}}; cache[id] = entry;
      factories[id](entry,entry.exports,requireNative); return entry.exports;
    }
    requireNative.j = 348410;
    requireNative.d = (target,getters,constants) => {
      for(const [key,get] of Object.entries(getters || {})) Object.defineProperty(target,key,{enumerable:true,get});
      for(const [key,value] of Object.entries(constants || {})) Object.defineProperty(target,key,{enumerable:true,value});
    };
    const model = requireNative('Hpb6'), state = requireNative('f6KK'), views = requireNative('SAxP'), history = requireNative('GTmQ');
    const schema = new model.Sj({nodes:{
      doc:{content:'block+'},paragraph:{content:'inline*',group:'block',toDOM:()=>['p',0],parseDOM:[{tag:'p'}]},
      code_block:{content:'text*',group:'block',code:true,marks:'',toDOM:()=>['pre',['code',0]],parseDOM:[{tag:'pre',preserveWhitespace:'full'}]},
      text:{group:'inline'},hard_break:{inline:true,group:'inline',selectable:false,toDOM:()=>['br'],parseDOM:[{tag:'br'}]}
    },marks:{strong:{toDOM:()=>['strong',0],parseDOM:[{tag:'strong'}]}}});
    const literalPaste = (function(s) { return ${nativeInsert}; })(model);
    function composerHandler() {
      // Execute the ACTUAL reviewed native handlePaste method, with network,
      // mentions and file-upload services replaced by inert isolated fixtures.
      const tt={consume:()=>false},te=false,e3={pastePreferredHtml:()=>false,pasteLiteralText:(view,text)=>{literalPaste(view,text);return true}},
        r={h3:()=>null},C={I0:()=>null},x={huD:5000},a={xq:history.xq,_B:history._B},
        L={jk:data=>{const files=Array.from(data?.files||[]);return {files,imageFiles:files.filter(file=>file.type.startsWith('image/')),otherFiles:files.filter(file=>!file.type.startsWith('image/'))}}},
        E={S:(_text,_html,images)=>images.length>0},e9={emit:()=>false},
        m={a:()=>null,p:()=>false},O={_g:literalPaste},D={UX:()=>null},
        B={jT:()=>null,VT:()=>false},R={uY:()=>false},i={xz:()=>null},
        U={Gq:{getState:()=>null}},eM=false,K={O9:()=>null},eT={H:()=>null},y=model,p=state;
      return ({${nativeHandler}}).handlePaste;
    }
    window.__nativePasteFixture = {
      create(text='',from=1,to=from,code=false) {
        window.__nativePasteView?.destroy();
        document.body.innerHTML='<div data-codex-composer-root><div id="editor"></div></div>';
        const content = schema.nodes[code?'code_block':'paragraph'].create(null,text?schema.text(text):null);
        const doc=schema.nodes.doc.create(null,content);
        const view = new views.Lz(document.getElementById('editor'),{state:state.$t.create({schema,doc,selection:state.U3.create(doc,from,to),plugins:[history.b6()]}),handlePaste:composerHandler()});
        window.__nativePasteView=view; return view;
      },
      undo(){const view=window.__nativePasteView;return history.tN(view.state,view.dispatch.bind(view));},
      result(){const view=window.__nativePasteView;return {text:view.state.doc.textBetween(0,view.state.doc.content.size,'\\n'),json:view.state.doc.toJSON(),from:view.state.selection.from,to:view.state.selection.to};},
      paste(text,html='',files=[],rtf='') {
        const clipboardData=new DataTransfer();clipboardData.setData('text/plain',text);
        if(html)clipboardData.setData('text/html',html);if(rtf)clipboardData.setData('text/rtf',rtf);
        for(const file of files)clipboardData.items.add(new File(['fixture'],file.name,{type:file.type}));
        const event=new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true});
        window.__nativePasteView.dom.dispatchEvent(event);return event.defaultPrevented;
      },
      passCounter(){window.__nativePasses=0;const listener=()=>{window.__nativePasses++};document.addEventListener('paste',listener,true);return()=>document.removeEventListener('paste',listener,true);}
    };
  })();`
  return { script, modules: [...found.keys()], anchors }
}
module.exports = { nativePasteFixture }
