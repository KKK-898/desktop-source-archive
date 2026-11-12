import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Main installers must remain usable without downloading the optional component.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const name of ['tauri.conf.json', 'tauri.windows.conf.json', 'tauri.macos.conf.json', 'tauri.linux.conf.json', 'tauri.mobile-test.conf.json']) {
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri', name), 'utf8'))
  const bundled = JSON.stringify({resources: config.bundle?.resources, files: config.bundle?.macOS?.files, externalBin: config.bundle?.externalBin})
  if (/mobile-bridge|gaoge-mobile-gateway|requirements-desktop/i.test(bundled)) {
    throw new Error(`${name} must not bundle the optional mobile runtime`)
  }
}
const key = (await readFile(path.join(root, 'resources/mobile-component-public-key.txt'), 'utf8')).trim()
if (!key || !Buffer.from(key, 'base64').toString('utf8').includes('minisign public key')) {
  throw new Error('The independent mobile-component verification public key is missing or invalid')
}
console.log('Lightweight app configuration verified; no mobile runtime build or download is required.')
