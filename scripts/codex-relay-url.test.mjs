import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isGaogeCodexRelayBaseUrl,
  normalizeGaogeCodexRelayBaseUrl,
} from '../src/codex-relay-url.ts'

test('accepts both first-party Codex relay domains with or without /v1', () => {
  for (const base of ['https://api.gaogeaii.com', 'https://api.gaogeaii.cc']) {
    assert.equal(isGaogeCodexRelayBaseUrl(base), true)
    assert.equal(isGaogeCodexRelayBaseUrl(`${base}/`), true)
    assert.equal(isGaogeCodexRelayBaseUrl(`${base}/v1`), true)
    assert.equal(isGaogeCodexRelayBaseUrl(`${base}/v1/`), true)
    assert.equal(normalizeGaogeCodexRelayBaseUrl(`${base}/v1/`), base)
  }
})

test('rejects official, third-party, lookalike, and malformed relay URLs', () => {
  for (const value of [
    'https://api.openai.com/v1',
    'https://other.example/v1',
    'https://evil-api.gaogeaii.com/v1',
    'https://api.gaogeaii.com.evil.example/v1',
    'http://api.gaogeaii.com/v1',
    'https://api.gaogeaii.com/v2',
    'https://api.gaogeaii.com/v1/models',
    'https://api.gaogeaii.com/v1?source=attacker',
    'https://user:pass@api.gaogeaii.com/v1',
    'api.gaogeaii.com/v1',
  ]) {
    assert.equal(isGaogeCodexRelayBaseUrl(value), false, value)
    assert.equal(normalizeGaogeCodexRelayBaseUrl(value), '', value)
  }
})
