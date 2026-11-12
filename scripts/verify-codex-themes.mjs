import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import yauzl from 'yauzl'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourceDir = path.join(rootDir, 'theme-resources')
const outputDir = path.join(rootDir, 'release', 'themes')
const requiredFiles = new Set([
  'theme.json',
  'background.webp',
  'preview.webp',
  'LICENSE.txt',
  'NOTICE.txt',
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function readZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipFile) => {
      if (openError) {
        reject(openError)
        return
      }
      const entries = new Map()
      zipFile.on('error', reject)
      zipFile.on('entry', (entry) => {
        const name = entry.fileName
        if (
          name.includes('/') ||
          name.includes('\\') ||
          name.includes('..') ||
          name.endsWith('/') ||
          entries.has(name)
        ) {
          zipFile.close()
          reject(new Error(`ZIP 包含非法条目：${name}`))
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError)
            return
          }
          const chunks = []
          stream.on('data', (chunk) => chunks.push(chunk))
          stream.on('error', reject)
          stream.on('end', () => {
            entries.set(name, Buffer.concat(chunks))
            zipFile.readEntry()
          })
        })
      })
      zipFile.on('end', () => resolve(entries))
      zipFile.readEntry()
    })
  })
}

async function validateWebp(buffer, minimumWidth, minimumHeight, maxBytes, label) {
  assert(buffer.length > 0 && buffer.length <= maxBytes, `${label}: 文件大小不合法`)
  const metadata = await sharp(buffer).metadata()
  assert(metadata.format === 'webp', `${label}: 不是 WebP`)
  assert(
    (metadata.width || 0) >= minimumWidth && (metadata.height || 0) >= minimumHeight,
    `${label}: 图片尺寸过小`,
  )
  assert(
    (metadata.width || 0) <= 7680 && (metadata.height || 0) <= 4320,
    `${label}: 图片尺寸过大`,
  )
}

function validateRelativeResource(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label}: 地址为空`)
  assert(!path.isAbsolute(value), `${label}: 不能使用绝对路径`)
  assert(!value.includes('..') && !value.includes('\\'), `${label}: 地址越过主题目录`)
  assert(!/^[a-z]+:/i.test(value) && !value.startsWith('//'), `${label}: 不能写死域名`)
}

async function main() {
  const definitions = JSON.parse(await readFile(path.join(resourceDir, 'themes.json'), 'utf8'))
  const catalog = JSON.parse(await readFile(path.join(outputDir, 'catalog.json'), 'utf8'))
  assert(catalog.schemaVersion === 1, 'catalog.json schemaVersion 必须为 1')
  assert(Array.isArray(catalog.themes) && catalog.themes.length === 10, 'catalog.json 必须包含十个主题')
  assert(catalog.themes.length === definitions.themes.length, '目录与主题定义数量不一致')

  const seenIds = new Set()
  for (const item of catalog.themes) {
    assert(!seenIds.has(item.id), `目录包含重复主题 ID：${item.id}`)
    seenIds.add(item.id)
    validateRelativeResource(item.package, `${item.id}/package`)
    validateRelativeResource(item.preview, `${item.id}/preview`)

    const packagePath = path.join(outputDir, item.package)
    const packageBuffer = await readFile(packagePath)
    const packageStats = await stat(packagePath)
    assert(packageStats.isFile() && packageBuffer.length === item.sizeBytes, `${item.id}: ZIP 大小不一致`)
    assert(packageBuffer.length <= 15 * 1024 * 1024, `${item.id}: ZIP 超过 15MB`)
    assert(sha256(packageBuffer) === item.sha256, `${item.id}: SHA-256 不一致`)

    const entries = await readZip(packageBuffer)
    assert(entries.size === requiredFiles.size, `${item.id}: ZIP 文件数量不正确`)
    for (const name of requiredFiles) {
      assert(entries.has(name), `${item.id}: ZIP 缺少 ${name}`)
    }
    const manifest = JSON.parse(entries.get('theme.json').toString('utf8'))
    assert(manifest.schemaVersion === 1, `${item.id}: manifest schemaVersion 不正确`)
    assert(manifest.id === item.id, `${item.id}: manifest ID 与目录不一致`)
    assert(manifest.version === item.version, `${item.id}: manifest 版本与目录不一致`)
    assert(
      manifest.runtime === item.runtime
        && ['wallpaper', 'qq-retro'].includes(manifest.runtime),
      `${item.id}: manifest runtime 与目录不一致`,
    )
    assert(
      JSON.stringify(manifest.platforms) === JSON.stringify(['windows', 'macos']),
      `${item.id}: 平台字段不正确`,
    )
    assert(manifest.background.file === 'background.webp', `${item.id}: 背景文件名不正确`)
    assert(manifest.preview === 'preview.webp', `${item.id}: 预览文件名不正确`)
    assert(entries.get('LICENSE.txt').toString('utf8').trim(), `${item.id}: LICENSE.txt 为空`)
    assert(entries.get('NOTICE.txt').toString('utf8').trim(), `${item.id}: NOTICE.txt 为空`)
    await validateWebp(entries.get('background.webp'), 1280, 720, 8 * 1024 * 1024, `${item.id}/background.webp`)
    await validateWebp(entries.get('preview.webp'), 640, 360, 2 * 1024 * 1024, `${item.id}/preview.webp`)

    const remotePreview = await readFile(path.join(outputDir, item.preview))
    await validateWebp(remotePreview, 640, 360, 2 * 1024 * 1024, `${item.id}/remote-preview`)
    assert(
      sha256(remotePreview) === sha256(entries.get('preview.webp')),
      `${item.id}: 目录预览与包内预览不一致`,
    )

    const definition = definitions.themes.find((candidate) => candidate.id === item.id)
    assert(definition, `${item.id}: 缺少源定义`)
    const original = await readFile(path.join(resourceDir, 'sources', definition.sourceFile))
    assert(
      /^[a-f0-9]{64}$/i.test(definition.source?.sha256 || '')
        && sha256(original) === String(definition.source.sha256).toLowerCase(),
      `${item.id}: 源图片 SHA-256 与主题定义不一致`,
    )
    assert(
      definition.runtime === manifest.runtime,
      `${item.id}: 源定义 runtime 与主题包不一致`,
    )
    if (definition.image.mode === 'copy') {
      assert(
        sha256(original) === sha256(entries.get('background.webp')),
        `${item.id}: 上游原图被重新编码或修改`,
      )
    }
  }
  process.stdout.write(`Verified ${catalog.themes.length} Codex theme packages.\n`)
}

await main()
