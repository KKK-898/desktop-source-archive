import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// Real Vite production compilation, with no local/private environment files.
test('production deployment values are injected through an explicit allowlist', async () => {
  const values = {
    VITE_GAOGE_CODEX_RELAY_ORIGINS: 'https://sentinel-relay.example.invalid',
    VITE_GAOGE_MOBILE_RELAY_URL: 'https://sentinel-mobile.example.invalid/mobile',
    VITE_GAOGE_CONTACT_ITEMS: '[{"id":"sentinel-support","title":"Support"}]',
    VITE_GAOGE_DESKTOP_EMAIL_DOMAIN: 'sentinel-accounts.example.invalid',
    VITE_GAOGE_SUPPORT_GROUP: 'sentinel-support-group',
    VITE_GAOGE_SUPPORT_QR_URL: 'https://sentinel-assets.example.invalid/support.png',
    VITE_UNRELATED_PRIVATE_DEPLOYMENT_VALUE: 'sentinel-must-not-be-bundled',
  }
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  try {
    Object.assign(process.env, values)
    const result = await build({
      configFile: false,
      envDir: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL('../src/frontend-deployment.ts', import.meta.url)), formats: ['es'] },
      },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output || [])
    const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry)
    assert.ok(entry, 'production build must return an ES module')
    const module = await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`)
    for (const [key, value] of Object.entries(values)) {
      if (key === 'VITE_UNRELATED_PRIVATE_DEPLOYMENT_VALUE') continue
      assert.equal(module.readFrontendDeploymentValue(key), value, `${key} must be present in the production module`)
    }
    assert.equal(entry.code.includes(values.VITE_UNRELATED_PRIVATE_DEPLOYMENT_VALUE), false)
    assert.equal(module.readFrontendDeploymentValue('VITE_UNRELATED_PRIVATE_DEPLOYMENT_VALUE'), '')
    assert.equal(module.readFrontendDeploymentValue('constructor'), '')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
