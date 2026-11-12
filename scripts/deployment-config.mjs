import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const DEPLOYMENT_KEYS = Object.freeze([
  'GAOGE_DEFAULT_API_BASE_URL', 'GAOGE_ACCOUNT_RELAY_URL', 'GAOGE_MOBILE_COMPONENT_MANIFEST_URL',
  'VITE_GAOGE_CODEX_RELAY_ORIGINS', 'VITE_GAOGE_MOBILE_RELAY_URL', 'VITE_GAOGE_CONTACT_ITEMS',
  'VITE_GAOGE_DESKTOP_EMAIL_DOMAIN', 'VITE_GAOGE_SUPPORT_GROUP', 'VITE_GAOGE_SUPPORT_QR_URL',
])
function fail(key, reason) { throw new Error(`deployment.${key}: ${reason}`) }
function https(value, key, release = true) {
  let url
  try { url = new URL(value) } catch { fail(key, 'requires an absolute HTTPS URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || /\s/.test(value)) {
    fail(key, 'requires clean HTTPS on port 443, without credentials, query or fragment')
  }
  if (release && (/(?:^|\.)(?:invalid|example\.com|example\.org|example\.net)$/.test(url.hostname) || url.hostname === 'localhost')) {
    fail(key, 'placeholder address cannot be used for a production release')
  }
  return url
}
function image(value, key, release) {
  if (!value) return
  if (/^data:image\/(?:png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return
  https(value, key, release)
}
export function validateDeployment(config, { release = true } = {}) {
  const values = config?.deployment
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Missing private deployment configuration')
  for (const key of Object.keys(values)) if (!DEPLOYMENT_KEYS.includes(key)) fail(key, 'unknown configuration key')
  for (const key of DEPLOYMENT_KEYS) {
    if (typeof values[key] !== 'string') fail(key, 'must be explicitly configured as a string')
    if (/[\u0000-\u001f\u007f]/.test(values[key])) fail(key, 'control characters are not allowed')
    if (Buffer.byteLength(values[key]) > 47000) fail(key, 'exceeds safe repository-variable size; use your hosted image URL instead')
  }
  https(values.GAOGE_DEFAULT_API_BASE_URL, 'GAOGE_DEFAULT_API_BASE_URL', release)
  const relay = https(values.GAOGE_ACCOUNT_RELAY_URL, 'GAOGE_ACCOUNT_RELAY_URL', release)
  const frontendRelay = https(values.VITE_GAOGE_MOBILE_RELAY_URL, 'VITE_GAOGE_MOBILE_RELAY_URL', release)
  if (relay.href.replace(/\/+$/, '') !== frontendRelay.href.replace(/\/+$/, '')) fail('VITE_GAOGE_MOBILE_RELAY_URL', 'must match GAOGE_ACCOUNT_RELAY_URL')
  const manifest = https(values.GAOGE_MOBILE_COMPONENT_MANIFEST_URL, 'GAOGE_MOBILE_COMPONENT_MANIFEST_URL', release)
  if (!manifest.pathname.includes('/') || manifest.pathname.slice(1).split('/').filter(Boolean).length < 2 || !manifest.pathname.endsWith('.json')) {
    fail('GAOGE_MOBILE_COMPONENT_MANIFEST_URL', 'requires a JSON manifest inside a dedicated directory')
  }
  const origins = values.VITE_GAOGE_CODEX_RELAY_ORIGINS.split(',').map(v => v.trim()).filter(Boolean)
  if (!origins.length) fail('VITE_GAOGE_CODEX_RELAY_ORIGINS', 'requires at least one explicitly trusted origin')
  for (const origin of origins) if (https(origin, 'VITE_GAOGE_CODEX_RELAY_ORIGINS', release).pathname !== '/') fail('VITE_GAOGE_CODEX_RELAY_ORIGINS', 'origins cannot contain paths')
  const emailDomain = values.VITE_GAOGE_DESKTOP_EMAIL_DOMAIN
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(emailDomain)) fail('VITE_GAOGE_DESKTOP_EMAIL_DOMAIN', 'invalid email domain')
  if (release && emailDomain.endsWith('.invalid')) fail('VITE_GAOGE_DESKTOP_EMAIL_DOMAIN', 'placeholder domain cannot be used for production')
  let contacts
  try { contacts = JSON.parse(values.VITE_GAOGE_CONTACT_ITEMS) } catch { fail('VITE_GAOGE_CONTACT_ITEMS', 'requires JSON array text') }
  if (!Array.isArray(contacts)) fail('VITE_GAOGE_CONTACT_ITEMS', 'requires JSON array text')
  for (const item of contacts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('VITE_GAOGE_CONTACT_ITEMS', 'invalid contact object')
    for (const key of Object.keys(item)) if (!['id', 'title', 'content', 'description', 'icon', 'imageUrl'].includes(key) || typeof item[key] !== 'string') fail('VITE_GAOGE_CONTACT_ITEMS', 'unknown or non-string contact field')
    image(item.imageUrl || '', 'VITE_GAOGE_CONTACT_ITEMS.imageUrl', release)
  }
  image(values.VITE_GAOGE_SUPPORT_QR_URL, 'VITE_GAOGE_SUPPORT_QR_URL', release)
  return Object.fromEntries(DEPLOYMENT_KEYS.map(key => [key, values[key]]))
}
export function syncDeployment(config, repository, run = spawnSync) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid private build repository')
  const values = validateDeployment(config)
  // Never publish operator configuration to a mistakenly selected public repository.
  const visibility = run('gh', ['api', `repos/${repository}`], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  let info
  try { info = JSON.parse(visibility.stdout || '') } catch { throw new Error('Cannot verify private build repository; output omitted') }
  if (visibility.error || visibility.status !== 0 || info?.private !== true || info?.full_name?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Deployment configuration may only be synced to the verified private build repository')
  }
  // Values go over stdin, not command arguments; failures never echo credentials or operator configuration.
  for (const [key, value] of Object.entries(values)) {
    const result = run('gh', ['variable', 'set', key, '--repo', repository], { input: value, encoding: 'utf8', windowsHide: true, timeout: 60000 })
    if (result.error || result.status !== 0) throw new Error(`Failed to sync ${key}; private value/output omitted`)
  }
  return Object.keys(values)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, configPath, repository] = process.argv.slice(2)
    if (!['validate', 'sync'].includes(mode) || !configPath) throw new Error('Usage: node scripts/deployment-config.mjs validate|sync <private-config.json> [private-build-repository]')
    let config
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) } catch { throw new Error('Cannot read private release configuration; contents omitted') }
    const keys = mode === 'sync' ? syncDeployment(config, repository) : Object.keys(validateDeployment(config))
    console.log(`${mode}: ${keys.length} deployment fields checked; private values omitted`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
