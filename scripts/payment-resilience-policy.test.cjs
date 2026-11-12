const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('runtime payment candidates always put the selected server first without fixed domains', () => {
  const source = read('src/domain-config.ts')
  const start = source.indexOf('export function getRuntimeApiCandidates')
  const end = source.indexOf('export function getSelectedRuntimeServer', start)
  const implementation = source.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(implementation, /sort\(\(left, right\) => Number\(right\.selected\) - Number\(left\.selected\)\)/)
  assert.match(implementation, /softwareAdminApiBaseUrl/)
  assert.match(implementation, /urls\.apiBaseUrl/)
  assert.doesNotMatch(implementation, /\.com|\.cc/)
})

test('desktop transport reuses one client and returns classified retryable failures', () => {
  const source = read('src-tauri/src/lib.rs')

  assert.match(source, /static GAOGE_API_HTTP_CLIENT: Lazy<Result<reqwest::Client, String>>/)
  assert.match(source, /connect_timeout\(Duration::from_secs\(GAOGE_API_CONNECT_TIMEOUT_SECS\)\)/)
  assert.match(source, /struct ApiTransportError/)
  assert.match(source, /"timeout"[\s\S]*"dns"[\s\S]*"tls"[\s\S]*"connect"/)
  assert.match(source, /"idempotency-key" \| "accept-language" \| "x-request-id"/)
})

test('payment writes opt into failover only when they are idempotent', () => {
  const source = read('src/api.ts')

  assert.match(source, /headers: \{ 'Idempotency-Key': idempotencyKey \}/)
  assert.match(source, /serviceScope: 'core',[\s\S]{0,100}retryPolicy: 'idempotent-write'/)
  assert.match(source, /serviceScope: 'software-admin', retryPolicy: 'idempotent-write'/)
  assert.match(source, /\.slice\(0, 2\)/)
  assert.match(source, /isRetryableGatewayError/)
  assert.doesNotMatch(source, /replace\([^\n]*(?:\.com|\.cc)/)
})

test('ordinary requests keep the original single-route timeout policy', () => {
  const source = read('src/api.ts')

  assert.match(source, /retryPolicy === 'none' \|\| !requestOptions\.retryPolicy \|\| !requestOptions\.serviceScope/)
  assert.match(source, /const timeoutMs = !isResilientRequest[\s\S]{0,80}\? undefined/)
  assert.match(source, /PAYMENT_PRIMARY_TIMEOUT_MS = 20_000/)
  assert.match(source, /PAYMENT_BACKUP_TIMEOUT_MS = 10_000/)
})
