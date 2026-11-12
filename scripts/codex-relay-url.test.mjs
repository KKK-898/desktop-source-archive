import assert from 'node:assert/strict'
import test from 'node:test'
import { isGaogeCodexRelayBaseUrl, normalizeGaogeCodexRelayBaseUrl } from '../src/codex-relay-url.ts'
import { desktopRegistrationEmailDomain, isConfiguredAccountRelay, parseDeploymentContactItems, parseTrustedRelayOrigins } from '../src/frontend-deployment.ts'
const trusted = ['https://relay.example.invalid', 'https://backup.example.invalid']

test('unconfigured source never recognizes any operator relay', () => {
  for (const base of trusted) {
    assert.equal(isGaogeCodexRelayBaseUrl(base, []), false)
    assert.equal(normalizeGaogeCodexRelayBaseUrl(base, []), '')
  }
})

test('accepts explicitly configured relay origins with or without /v1', () => {
  for (const base of trusted) {
    for (const suffix of ['', '/', '/v1', '/v1/']) {
      assert.equal(isGaogeCodexRelayBaseUrl(base + suffix, trusted), true)
      assert.equal(normalizeGaogeCodexRelayBaseUrl(base + suffix, trusted), base)
    }
  }
})

test('rejects third-party, lookalike, credentialed, and malformed relay URLs', () => {
  for (const value of [
    'https://api.openai.com/v1', 'https://other.example.invalid/v1',
    'https://evil-relay.example.invalid/v1', 'https://relay.example.invalid.evil.example/v1',
    'http://relay.example.invalid/v1', 'https://relay.example.invalid/v2',
    'https://relay.example.invalid/v1/models', 'https://relay.example.invalid/v1?source=attacker',
    'https://relay.example.invalid/v1#fragment', 'https://user:pass@relay.example.invalid/v1',
    'relay.example.invalid/v1',
  ]) {
    assert.equal(isGaogeCodexRelayBaseUrl(value, trusted), false, value)
    assert.equal(normalizeGaogeCodexRelayBaseUrl(value, trusted), '', value)
  }
})

test('deployment allowlist rejects unsafe origins and does not infer trust', () => {
  assert.deepEqual(parseTrustedRelayOrigins(''), [])
  assert.deepEqual(parseTrustedRelayOrigins('https://relay.example.invalid/,\nhttps://relay.example.invalid,http://unsafe.example.invalid,https://user:pass@unsafe.example.invalid,https://unsafe.example.invalid/path'), [trusted[0]])
})

test('account token enrollment requires an explicit exact trusted HTTPS service', () => {
  assert.equal(isConfiguredAccountRelay('https://relay.example.invalid/mobile', ''), false)
  assert.equal(isConfiguredAccountRelay('https://relay.example.invalid/mobile/', 'https://relay.example.invalid/mobile'), true)
  for(const value of ['http://relay.example.invalid/mobile', 'https://relay.example.invalid/other', 'https://relay.example.invalid/mobile?next=evil', 'https://user:pass@relay.example.invalid/mobile', 'https://evil.example.invalid/mobile']) {
    assert.equal(isConfiguredAccountRelay(value, 'https://relay.example.invalid/mobile'), false)
  }
})

test('public contacts default empty and accept only explicit text fields', () => {
  assert.deepEqual(parseDeploymentContactItems(''), [])
  assert.deepEqual(parseDeploymentContactItems('invalid'), [])
  assert.deepEqual(parseDeploymentContactItems('{"title":"x"}'), [])
  assert.deepEqual(parseDeploymentContactItems('[null,[],{"title":" Support ","content":"configured value","ignored":true}]'), [{title:'Support',content:'configured value'}])
})

test('generated account email has a neutral default and validates configured domains', () => {
  assert.equal(desktopRegistrationEmailDomain(''), 'desktop.example.invalid')
  assert.equal(desktopRegistrationEmailDomain('https://unsafe.example.invalid'), 'desktop.example.invalid')
  assert.equal(desktopRegistrationEmailDomain('Accounts.Example.Invalid'), 'accounts.example.invalid')
})
