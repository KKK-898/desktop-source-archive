// Read-only extraction of the reviewed native settings adapter. Native functions
// run against an isolated in-memory settings service; the app is never started.
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const ts = require('typescript');

function nativeLocaleFixture(packagePath) {
  const wanted=new Set(['RxZZ','kHsu','DBCl','PNIT','GaA7','gXrz']);
  const candidates=new Map(),found=new Map();
  for(const name of asar.listPackage(packagePath).map(p=>p.replace(/^[\\/]/,''))){
    if(!/webview[\\/]assets[\\/].*\.js$/.test(name))continue;
    const text=asar.extractFile(packagePath,name).toString('utf8');
    for(const id of wanted)if(text.includes(id+'(')&&(!candidates.has(id)||text.length<candidates.get(id).text.length))candidates.set(id,{name,text});
  }
  for(const {name,text} of new Map([...candidates.values()].map(item=>[item.name,item])).values()){
    const tree=ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    function visit(node){
      if(ts.isMethodDeclaration(node)&&wanted.has(node.name.getText(tree))){found.set(node.name.getText(tree),{node,tree,text:node.getText(tree),name});return;}
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  for(const id of wanted)assert.ok(found.has(id),'Missing native locale module '+id);
  const native=found.get('RxZZ');
  const functions={};
  for(const node of native.node.body.statements)if(ts.isFunctionDeclaration(node)&&['b','L'].includes(node.name?.text))functions[node.name.text]=node.getText(native.tree);
  assert.match(native.text,/LA:(?:\(\)=>)?b/);assert.match(native.text,/cz:(?:\(\)=>)?L/);
  assert.match(functions.b,/appServices\.settings\.read\(e\.key\)/);assert.match(functions.b,/\.effective/);
  assert.match(functions.L,/appServices\.settings\.write\(e\.key,t\)/);
  assert.match(found.get('DBCl').text,/Szl:\(\)=>e3\.Sz/);
  assert.match(found.get('DBCl').text,/e3=\w+\("PNIT"\)/);
  assert.match(found.get('PNIT').text,/Sz:\(\)=>l\.Sz/);
  assert.match(found.get('PNIT').text,/l=\w+\("kHsu"\)/);
  assert.match(found.get('GaA7').text,/appServices:\(\)=>o/);
  let descriptor;
  assert.match(found.get('kHsu').text,/Sz:\(\)=>h\.S/);
  assert.match(found.get('kHsu').text,/h=\w+\("gXrz"\)/);
  const schema=found.get('gXrz');
  function setting(node){
    if(ts.isPropertyAssignment(node)&&node.name.getText(schema.tree)==='localeOverride'){
      const definition=node.initializer.arguments?.[0];assert.ok(definition&&ts.isObjectLiteralExpression(definition));
      const key=definition.properties.find(p=>p.name?.getText(schema.tree)==='key')?.initializer;
      const fallback=definition.properties.find(p=>p.name?.getText(schema.tree)==='default')?.initializer;
      assert.ok(key&&ts.isStringLiteral(key));assert.equal(key.text,'localeOverride');assert.equal(fallback?.kind,ts.SyntaxKind.NullKeyword);
      descriptor={key:key.text,default:null};
    }
    ts.forEachChild(node,setting);
  }
  setting(schema.node);assert.ok(descriptor);
  const html=asar.extractFile(packagePath,'webview\\index.html').toString();
  const entries=[...html.matchAll(/<script type="module" src="([^"]+)"/g)].map(m=>m[1]);
  const entry=entries.find(name=>asar.extractFile(packagePath,'webview\\'+name.replace(/^\//,'').replaceAll('/','\\')).toString().includes('as __webpack_require__'));
  assert.ok(entry);
  let value=null, executedFactories=0;const calls=[];
  const services={appServices:{settings:{async read(key){assert.equal(key,'localeOverride');calls.push(['read',key]);return {effective:value};},async write(key,next){assert.equal(key,'localeOverride');calls.push(['write',key,next]);value=next;}}}};
  const nativeFunctions=Function('a','s',`"use strict";${functions.b};${functions.L};return {LA:b,cz:L};`)(services,{P:async promise=>await promise});
  const moduleExports={};Object.defineProperty(moduleExports,'Szl',{enumerable:true,get:()=>({localeOverride:descriptor})});
  function requireNative(){executedFactories++;throw Error('No native module factory may execute');}
  requireNative.c={RxZZ:{exports:nativeFunctions},DBCl:{exports:moduleExports}};
  requireNative.m=Object.fromEntries([...found].map(([id])=>[id,()=>{executedFactories++;throw Error('No factory');}]));
  return {module:{__webpack_require__:requireNative},calls,setValue:next=>{value=next;},value:()=>value,
    executedFactories:()=>executedFactories,anchors:{entry,modules:[...found.keys()],descriptor,readSource:functions.b,writeSource:functions.L}};
}
module.exports={nativeLocaleFixture};
