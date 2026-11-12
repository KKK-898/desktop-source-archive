import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { verifyEnvelope, verifyTauriSignature } from './verify-mobile-component-signature.mjs'

const encode = (value) => Buffer.from(value).toString('base64')
const payload = Buffer.from('{"component":"mobile-connection","label":"手机连接"}\n')

function fixture({ algorithm = 'ED', id = Buffer.from('0102030405060708', 'hex') } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  const publicPacket = Buffer.concat([Buffer.from('Ed'), id, rawKey])
  const trustedComment = 'timestamp:12345\tfile:manifest.json\tprehashed'
  const message = algorithm === 'ED' ? createHash('blake2b512').update(payload).digest() : payload
  const primary = sign(null, message, privateKey)
  const global = sign(null, Buffer.concat([primary, Buffer.from(trustedComment)]), privateKey)
  const signature = encode('untrusted comment: fixture\n' + encode(Buffer.concat([Buffer.from(algorithm), id, primary])) +
    '\ntrusted comment: ' + trustedComment + '\n' + encode(global) + '\n')
  return { publicKey: encode('untrusted comment: fixture\n' + encode(publicPacket) + '\n'),
    envelope: { payload: encode(payload), signature } }
}

function mutateSignature(envelope, callback) {
  const lines = Buffer.from(envelope.signature, 'base64').toString('utf8').trimEnd().split('\n')
  callback(lines)
  return { ...envelope, signature: encode(lines.join('\n') + '\n') }
}

test('accepts minisign-verify 0.2.5 upstream prehash/global-signature test vector', () => {
  // Source: minisign-verify 0.2.5 src/lib.rs::tests::verify_prehashed (MIT license).
  const publicKey = encode('untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3')
  const signature = encode('untrusted comment: signature from minisign secret key\n' +
    'RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n' +
    'trusted comment: timestamp:1556193335\tfile:test\n' +
    'y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==')
  assert.equal(verifyTauriSignature(Buffer.from('test'), signature, publicKey), true)
  assert.throws(() => verifyTauriSignature(Buffer.from('Test'), signature, publicKey), /payload signature/)
})

test('verifies generated Ed25519 envelope without reserializing original JSON bytes', () => {
  const value = fixture()
  assert.deepEqual(verifyEnvelope(value.envelope, value.publicKey), payload)
})

test('rejects changed payload even when replacement JSON remains valid', () => {
  const value = fixture()
  assert.throws(() => verifyEnvelope({ ...value.envelope, payload: encode('{}') }, value.publicKey), /payload signature/)
})

test('rejects a different signing public key even with the same key ID', () => {
  const first = fixture(), second = fixture()
  assert.throws(() => verifyEnvelope(first.envelope, second.publicKey), /payload signature/)
})

test('rejects mismatched key IDs before accepting any signature', () => {
  const value = fixture(), other = fixture({ id: Buffer.from('1112131415161718', 'hex') })
  assert.throws(() => verifyEnvelope(value.envelope, other.publicKey), /key ID/)
})

test('rejects modified primary signature', () => {
  const value = fixture()
  const corrupted = mutateSignature(value.envelope, (lines) => {
    const bytes = Buffer.from(lines[1], 'base64'); bytes[30] ^= 1; lines[1] = encode(bytes)
  })
  assert.throws(() => verifyEnvelope(corrupted, value.publicKey), /payload signature/)
})

test('rejects modified global signature while primary signature still verifies', () => {
  const value = fixture()
  const corrupted = mutateSignature(value.envelope, (lines) => {
    const bytes = Buffer.from(lines[3], 'base64'); bytes[30] ^= 1; lines[3] = encode(bytes)
  })
  assert.throws(() => verifyEnvelope(corrupted, value.publicKey), /trusted-comment signature/)
})

test('rejects modified trusted comment while primary signature still verifies', () => {
  const value = fixture()
  const corrupted = mutateSignature(value.envelope, (lines) => { lines[2] += ' changed' })
  assert.throws(() => verifyEnvelope(corrupted, value.publicKey), /trusted-comment signature/)
})

test('rejects valid legacy signatures, matching the app allow_legacy=false policy', () => {
  const value = fixture({ algorithm: 'Ed' })
  assert.throws(() => verifyEnvelope(value.envelope, value.publicKey), /modern prehashed/)
})

test('rejects non-ASCII algorithm bytes instead of normalizing their high bits', () => {
  const value = fixture()
  const corrupted = mutateSignature(value.envelope, (lines) => {
    const bytes = Buffer.from(lines[1], 'base64'); bytes[0] |= 128; lines[1] = encode(bytes)
  })
  assert.throws(() => verifyEnvelope(corrupted, value.publicKey), /modern prehashed/)
})

test('rejects double encoded .sig and malformed base64', () => {
  const value = fixture()
  assert.throws(() => verifyEnvelope({ ...value.envelope, signature: encode(value.envelope.signature) }, value.publicKey), /text format/)
  assert.throws(() => verifyEnvelope({ ...value.envelope, payload: value.envelope.payload + '%' }, value.publicKey), /base64/)
})

test('rejects an unsigned or extended envelope', () => {
  const value = fixture()
  assert.throws(() => verifyEnvelope({ payload: value.envelope.payload }, value.publicKey), /envelope/)
  assert.throws(() => verifyEnvelope({ ...value.envelope, ignored: true }, value.publicKey), /envelope/)
})

test('command-line verifier accepts exact stdin bytes and exits nonzero for tampering', () => {
  const value = fixture()
  const directory = mkdtempSync(path.join(tmpdir(), 'gaoge-component-public-key-'))
  try {
    const keyPath = path.join(directory, 'public-key.txt')
    writeFileSync(keyPath, value.publicKey)
    const args = [fileURLToPath(new URL('./verify-mobile-component-signature.mjs', import.meta.url)), '--public-key', keyPath]
    const accepted = spawnSync(process.execPath, args, { input: JSON.stringify(value.envelope), encoding: 'utf8' })
    assert.equal(accepted.status, 0, accepted.stderr)
    assert.match(accepted.stdout, /signature verified/)
    const rejected = spawnSync(process.execPath, args, {
      input: JSON.stringify({ ...value.envelope, payload: encode('{}') }), encoding: 'utf8',
    })
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /payload signature verification failed/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
