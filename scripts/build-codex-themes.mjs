import { createHash } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import yazl from 'yazl'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourceDir = path.join(rootDir, 'theme-resources')
const sourceDir = path.join(resourceDir, 'sources')
const licenseDir = path.join(resourceDir, 'licenses')
const outputDir = path.join(rootDir, 'release', 'themes')
const packageDir = path.join(outputDir, 'packages')
const previewDir = path.join(outputDir, 'previews')
const requiredPackageFiles = [
  'theme.json',
  'background.webp',
  'preview.webp',
  'LICENSE.txt',
  'NOTICE.txt',
]
const fixedZipDate = new Date('2026-01-01T00:00:00.000Z')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function zipBuffers(entries) {
  const zipFile = new yazl.ZipFile()
  const chunks = []
  return new Promise((resolve, reject) => {
    zipFile.outputStream.on('data', (chunk) => chunks.push(chunk))
    zipFile.outputStream.on('error', reject)
    zipFile.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    for (const [name, data] of entries) {
      zipFile.addBuffer(data, name, {
        mtime: fixedZipDate,
        mode: 0o100644,
        compress: true,
      })
    }
    zipFile.end()
  })
}

async function buildBackground(theme) {
  const sourcePath = path.join(sourceDir, theme.sourceFile)
  const source = await readFile(sourcePath)
  assert(
    /^[a-f0-9]{64}$/i.test(theme.source?.sha256 || '')
      && sha256(source) === String(theme.source.sha256).toLowerCase(),
    `${theme.id}: 源图片 SHA-256 与主题定义不一致`,
  )
  const metadata = await sharp(source).metadata()
  assert(metadata.width && metadata.height, `${theme.id}: 无法读取源图片尺寸`)

  if (theme.image.mode === 'copy') {
    assert(metadata.format === 'webp', `${theme.id}: copy 模式只允许 WebP 原图`)
    assert(metadata.width >= 1280 && metadata.height >= 720, `${theme.id}: 原图低于 1280x720`)
    return source
  }

  let pipeline = sharp(source, { failOn: 'error' })
  if (theme.image.mode === 'extract') {
    pipeline = pipeline.extract({
      left: theme.image.left,
      top: theme.image.top,
      width: theme.image.width,
      height: theme.image.height,
    }).resize(2560, 1440, { fit: 'fill' })
  } else if (theme.image.mode === 'contain') {
    pipeline = pipeline.resize(2560, 1440, {
      fit: 'contain',
      background: theme.image.background || '#111827',
      withoutEnlargement: false,
    })
  } else {
    throw new Error(`${theme.id}: 未知图片处理模式 ${theme.image.mode}`)
  }
  return pipeline.webp({ quality: 92, effort: 5 }).toBuffer()
}

async function validateWebp(buffer, minimumWidth, minimumHeight, maxBytes, label) {
  assert(buffer.length > 0 && buffer.length <= maxBytes, `${label}: 文件大小超过限制`)
  const metadata = await sharp(buffer).metadata()
  assert(metadata.format === 'webp', `${label}: 必须为 WebP`)
  assert(
    (metadata.width || 0) >= minimumWidth && (metadata.height || 0) >= minimumHeight,
    `${label}: 图片尺寸低于 ${minimumWidth}x${minimumHeight}`,
  )
  assert(
    (metadata.width || 0) <= 7680 && (metadata.height || 0) <= 4320,
    `${label}: 图片尺寸超过 7680x4320`,
  )
}

async function themeLicense(theme) {
  if (theme.source.repository.includes('Codex-QQ-2007')) {
    return readFile(path.join(licenseDir, 'codex-qq-2007-LICENSE.txt'))
  }
  if (theme.source.repository.includes('Codex-QQ-Skin')) {
    return readFile(path.join(licenseDir, 'qq-LICENSE.txt'))
  }
  if (theme.source.repository.includes('heige-codex-skin-studio')) {
    return readFile(path.join(licenseDir, 'heige-LICENSE.txt'))
  }
  return Buffer.from(
    [
      'Copyright (c) 2026 Gaoge Studio',
      '',
      'This theme metadata and its Gaoge-provided visual asset may be used free of charge',
      'with Gaoge Free. Redistribution must retain this license and NOTICE.txt.',
      'No warranty is provided.',
      '',
    ].join('\n'),
    'utf8',
  )
}

async function themeNotice(theme) {
  const lines = [
    `Theme: ${theme.name} (${theme.id})`,
    `Author: ${theme.author}`,
    `Source repository: ${theme.source.repository || 'Gaoge Free local source'}`,
    `Pinned commit: ${theme.source.commit || 'current Gaoge Free source'}`,
    `Original path: ${theme.source.originalPath}`,
    '',
    'This package is distributed free of charge. Community character, trademark and',
    'third-party visual rights remain with their respective owners. The software',
    'license does not automatically grant rights to third-party visual assets.',
    'Contact Gaoge Free to request prompt removal from the remote catalog.',
    '',
  ]
  if (theme.source.repository.includes('Codex-QQ-2007')) {
    lines.push(await readFile(path.join(licenseDir, 'codex-qq-2007-NOTICE.md'), 'utf8'))
    lines.push(
      await readFile(
        path.join(licenseDir, 'codex-qq-2007-ASSET-PROVENANCE.md'),
        'utf8',
      ),
    )
  }
  if (theme.source.repository.includes('Codex-QQ-Skin')) {
    lines.push(await readFile(path.join(licenseDir, 'qq-NOTICE.md'), 'utf8'))
  }
  if (theme.source.repository.includes('heige-codex-skin-studio')) {
    lines.push(await readFile(path.join(licenseDir, 'heige-NOTICE.md'), 'utf8'))
    lines.push(await readFile(path.join(licenseDir, 'heige-ASSET_PROVENANCE.md'), 'utf8'))
  }
  return Buffer.from(`${lines.join('\n').trim()}\n`, 'utf8')
}

function manifestFor(theme) {
  return {
    schemaVersion: 1,
    id: theme.id,
    name: theme.name,
    version: theme.version,
    author: theme.author,
    description: theme.description,
    platforms: ['windows', 'macos'],
    runtime: theme.runtime || 'wallpaper',
    appearance: theme.appearance,
    background: {
      file: 'background.webp',
      ...theme.background,
    },
    preview: 'preview.webp',
    colors: theme.colors,
    effects: theme.effects,
    source: theme.source,
  }
}

async function buildTheme(theme, index, minimumClientVersion) {
  const background = await buildBackground(theme)
  const preview = await sharp(background)
    .resize(640, 360, { fit: 'cover', position: 'centre' })
    .webp({ quality: 84, effort: 5 })
    .toBuffer()
  await validateWebp(background, 1280, 720, 8 * 1024 * 1024, `${theme.id}/background.webp`)
  await validateWebp(preview, 640, 360, 2 * 1024 * 1024, `${theme.id}/preview.webp`)

  const entries = new Map([
    ['theme.json', jsonBuffer(manifestFor(theme))],
    ['background.webp', background],
    ['preview.webp', preview],
    ['LICENSE.txt', await themeLicense(theme)],
    ['NOTICE.txt', await themeNotice(theme)],
  ])
  assert(
    requiredPackageFiles.every((name) => entries.has(name)) && entries.size === requiredPackageFiles.length,
    `${theme.id}: 主题包文件结构不完整`,
  )

  const zip = await zipBuffers(requiredPackageFiles.map((name) => [name, entries.get(name)]))
  assert(zip.length <= 15 * 1024 * 1024, `${theme.id}: ZIP 超过 15MB`)
  const packageName = `${theme.id}-${theme.version}.zip`
  const previewName = `${theme.id}.webp`
  await writeFile(path.join(packageDir, packageName), zip)
  await writeFile(path.join(previewDir, previewName), preview)

  return {
    id: theme.id,
    name: theme.name,
    version: theme.version,
    author: theme.author,
    description: theme.description,
    style: theme.style,
    platforms: ['windows', 'macos'],
    runtime: theme.runtime || 'wallpaper',
    appearance: theme.appearance,
    package: `packages/${packageName}`,
    preview: `previews/${previewName}`,
    sha256: sha256(zip),
    sizeBytes: zip.length,
    enabled: true,
    sort: index + 1,
    minimumClientVersion,
    sourceLabel: theme.sourceLabel,
    source: theme.source,
  }
}

async function main() {
  const definition = JSON.parse(await readFile(path.join(resourceDir, 'themes.json'), 'utf8'))
  assert(definition.schemaVersion === 1, 'themes.json schemaVersion 必须为 1')
  assert(Array.isArray(definition.themes) && definition.themes.length === 10, '必须正好配置十个内置主题')
  const ids = new Set(definition.themes.map((theme) => theme.id))
  assert(ids.size === definition.themes.length, '主题 ID 不能重复')

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(packageDir, { recursive: true })
  await mkdir(previewDir, { recursive: true })

  const themes = []
  for (const [index, theme] of definition.themes.entries()) {
    themes.push(await buildTheme(theme, index, definition.minimumClientVersion))
  }
  const generatedAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString()
  const catalog = {
    schemaVersion: 1,
    generatedAt,
    minimumClientVersion: definition.minimumClientVersion,
    themes,
  }
  await writeFile(path.join(outputDir, 'catalog.json'), jsonBuffer(catalog))
  process.stdout.write(`Built ${themes.length} Codex themes in ${outputDir}\n`)
}

await main()
