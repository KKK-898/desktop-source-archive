import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const maxCatalog = 256 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })

function decodeBase64(value, label, maxBytes) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${label} base64 encoding`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length > maxBytes || decoded.toString('base64') !== value) {
    throw new Error(`Invalid ${label} base64 encoding`)
  }
  return decoded
}

function linesOf(bytes, count, label) {
  const lines = utf8.decode(bytes).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (lines.length !== count || !lines[0].startsWith('untrusted comment: ')) {
    throw new Error(`Invalid ${label} text format`)
  }
  return lines
}

// Same modern minisign contract as minisign-verify 0.2.5 PublicKey.verify(..., false):
// Ed25519(BLAKE2b-512(message)), plus Ed25519(signature64 || trusted_comment).
// This intentionally refuses legacy non-prehashed signatures, like the app does.
export function verifyTauriSignature(payload, signatureBase64, publicKeyBase64) {
  if (!Buffer.isBuffer(payload) || payload.length > maxCatalog) throw new Error('Invalid payload length')
  const publicLines = linesOf(decodeBase64(publicKeyBase64.trim(), 'public key', 4096), 2, 'public key')
  const key = decodeBase64(publicLines[1], 'public key packet', 42)
  if (key.length !== 42 || ![Buffer.from('Ed'), Buffer.from('ED')].some((algorithm) => key.subarray(0, 2).equals(algorithm))) {
    throw new Error('Unsupported public key algorithm')
  }
  const signatureLines = linesOf(decodeBase64(signatureBase64.trim(), 'signature', 4096), 4, 'signature')
  const packet = decodeBase64(signatureLines[1], 'signature packet', 74)
  const globalSignature = decodeBase64(signatureLines[3], 'global signature', 64)
  if (packet.length !== 74 || !packet.subarray(0, 2).equals(Buffer.from('ED'))) {
    throw new Error('Only modern prehashed minisign signatures are accepted')
  }
  if (globalSignature.length !== 64 || !signatureLines[2].startsWith('trusted comment: ')) {
    throw new Error('Invalid trusted comment or global signature')
  }
  if (!timingSafeEqual(key.subarray(2, 10), packet.subarray(2, 10))) {
    throw new Error('Signature key ID does not match the component public key')
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki',
  })
  const primarySignature = packet.subarray(10)
  const digest = createHash('blake2b512').update(payload).digest()
  if (!verify(null, digest, publicKey, primarySignature)) throw new Error('Component payload signature verification failed')
  const trustedComment = Buffer.from(signatureLines[2].slice('trusted comment: '.length), 'utf8')
  if (!verify(null, Buffer.concat([primarySignature, trustedComment]), publicKey, globalSignature)) {
    throw new Error('Component trusted-comment signature verification failed')
  }
  return true
}

export function verifyEnvelope(envelope, publicKeyBase64) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(',') !== 'payload,signature' ||
      typeof envelope.signature !== 'string' || envelope.signature.length > 4096) {
    throw new Error('Invalid component catalog envelope')
  }
  const payload = decodeBase64(envelope.payload, 'payload', maxCatalog)
  verifyTauriSignature(payload, envelope.signature, publicKeyBase64)
  return payload
}

async function main() {
  const args = process.argv.slice(2)
  let keyPath = path.join(root, 'resources/mobile-component-public-key.txt')
  let catalogPath = '-'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--public-key' && args[i + 1]) keyPath = path.resolve(args[++i])
    else if (args[i] === '--catalog' && args[i + 1]) catalogPath = args[++i]
    else throw new Error('Usage: node verify-mobile-component-signature.mjs [--catalog file|-] [--public-key file]')
  }
  let bytes
  if (catalogPath === '-') {
    const chunks = []
    let length = 0
    for await (const chunk of process.stdin) {
      length += chunk.length
      if (length > maxCatalog) throw new Error('Component catalog exceeds the size limit')
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
  } else bytes = await readFile(catalogPath)
  if (bytes.length > maxCatalog) throw new Error('Component catalog exceeds the size limit')
  const envelope = JSON.parse(utf8.decode(bytes))
  verifyEnvelope(envelope, await readFile(keyPath, 'utf8'))
  console.log('Mobile component catalog signature verified.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
