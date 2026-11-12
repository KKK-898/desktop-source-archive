import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEPLOYMENT_KEYS, validateDeployment, syncDeployment } from './deployment-config.mjs'
function config() {
 const value = JSON.parse(fs.readFileSync(new URL('../.release.local.example.json', import.meta.url)))
 for (const key of DEPLOYMENT_KEYS) value.deployment[key] = value.deployment[key].replaceAll('example.invalid', 'deployment.test')
 return value
}
test('requires every explicit field; no silent production defaults', () => {
 const c=config(); assert.equal(Object.keys(validateDeployment(c)).length,9)
 delete c.deployment.GAOGE_ACCOUNT_RELAY_URL
 assert.throws(()=>validateDeployment(c), /GAOGE_ACCOUNT_RELAY_URL/)
 assert.throws(()=>validateDeployment({}), /Missing private/)
})
test('public template documents fields but cannot publish to placeholders', () => {
 const c=JSON.parse(fs.readFileSync(new URL('../.release.local.example.json', import.meta.url)))
 assert.throws(()=>validateDeployment(c), /placeholder/)
 assert.equal(Object.keys(validateDeployment(c,{release:false})).length,9)
})
test('relay frontend and backend must match exactly', () => {
 const c=config(); c.deployment.VITE_GAOGE_MOBILE_RELAY_URL='https://untrusted.test/mobile'
 assert.throws(()=>validateDeployment(c), /must match/)
})
test('rejects insecure URL, credentials, port, pathless manifest, origins with path', () => {
 for (const [key,value] of [
 ['GAOGE_DEFAULT_API_BASE_URL','http://relay.test/api'],
 ['GAOGE_ACCOUNT_RELAY_URL','https://user:secret@relay.test/mobile'],
 ['GAOGE_ACCOUNT_RELAY_URL','https://relay.test:8443/mobile'],
 ['GAOGE_MOBILE_COMPONENT_MANIFEST_URL','https://relay.test/stable.json'],
 ['VITE_GAOGE_CODEX_RELAY_ORIGINS','https://relay.test/api']]) {
  const c=config(); c.deployment[key]=value; assert.throws(()=>validateDeployment(c));
 }
})
test('unknown keys, control characters, invalid contacts and oversized values fail', () => {
 for (const [key,value] of [['UNKNOWN','secret-value'],['VITE_GAOGE_SUPPORT_GROUP','a\nb'],['VITE_GAOGE_CONTACT_ITEMS','{}'],['VITE_GAOGE_CONTACT_ITEMS','[{"imageUrl":"javascript:alert(1)"}]'],['VITE_GAOGE_SUPPORT_GROUP','x'.repeat(48000)]]) {
 const c=config(); c.deployment[key]=value; assert.throws(()=>validateDeployment(c));
 }
})
test('sync uses stdin and omits private values from command arguments', () => {
 const calls=[]; const c=config()
 assert.equal(syncDeployment(c,'owner/private-build',(command,args,options)=>{if(args[0]==='api') return {status:0,stdout:JSON.stringify({private:true,full_name:'owner/private-build'})}; calls.push({command,args,options});return {status:0}}).length,9)
 for (const call of calls) { assert.equal(call.command,'gh'); assert.equal(call.args.includes('--body'),false); assert.equal(call.options.input,c.deployment[call.args[2]]) }
})
test('sync validates all fields before first mutation and redacts failures', () => {
 const c=config(); c.deployment.VITE_GAOGE_CONTACT_ITEMS='broken'; let called=false
 assert.throws(()=>syncDeployment(c,'owner/private-build',()=>{called=true;return {status:0}})); assert.equal(called,false)
 assert.throws(()=>syncDeployment(config(),'owner/private-build',()=>({status:1,stderr:'PRIVATE_VALUE',error:new Error('PRIVATE_VALUE')})), e=>!e.message.includes('PRIVATE_VALUE'))
})
test('private build and component workflow inject deployment fields, never inline defaults',()=>{
 const release=fs.readFileSync(new URL('../.github/workflows/release-build.yml',import.meta.url),'utf8')
 for(const key of DEPLOYMENT_KEYS) assert.ok(release.includes(key + ': $' + '{{ vars.' + key + ' }}'))
})

test('sync refuses public or unverifiable repositories before transmitting configuration', () => {
 for (const response of [
  {status:0,stdout:JSON.stringify({private:false,full_name:'owner/private-build'})},
  {status:0,stdout:JSON.stringify({private:true,full_name:'other/repo'})},
  {status:1,stdout:'PRIVATE_VALUE'},
  {status:0,stdout:'not-json'},
 ]) {
  let writes=0
  assert.throws(()=>syncDeployment(config(),'owner/private-build',(_command,args)=>{if(args[0]==='variable') writes++;return response}), e=>!e.message.includes('PRIVATE_VALUE'))
  assert.equal(writes,0)
 }
})
