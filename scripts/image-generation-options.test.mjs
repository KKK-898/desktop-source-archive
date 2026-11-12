import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import {
  IMAGE_GENERATION_MODELS,
  buildImageGenerationParameters,
  normalizeImageGenerationSelection,
  resolveImageGenerationModel,
} from '../src/image-generation.ts'

function options(overrides = {}) {
  return {
    model: 'gpt-image-2.6-flare', mode: 'text', size: '1024x1024', quality: 'medium',
    imageCount: 1, referenceImagePaths: [], outputFormat: 'png', complexity: 'high',
    frameCount: 9, frameDurationMs: 200, ...overrides,
  }
}

test('new installations select 2.6F while every valid saved model stays selected', () => {
  assert.equal(resolveImageGenerationModel(null), 'gpt-image-2.6-flare')
  assert.equal(resolveImageGenerationModel('missing-model'), 'gpt-image-2.6-flare')
  for (const { value } of IMAGE_GENERATION_MODELS) assert.equal(resolveImageGenerationModel(value), value)
})

test('GIF request strips stale edit inputs and uses one automatic-sized animation', () => {
  const request = buildImageGenerationParameters(options({
    model: 'gpt-image-2.6-sunburst', outputFormat: 'gif', mode: 'image', size: '3840x2160',
    imageCount: 4, referenceImagePaths: ['C:/private-reference.png'], quality: 'low', complexity: 'high',
  }))
  assert.deepEqual(request, {
    model: 'gpt-image-2.6-sunburst', mode: 'text', size: 'auto', quality: 'low', imageCount: 1,
    referenceImagePaths: [], outputFormat: 'gif', complexity: 'high', frameCount: 9, frameDurationMs: 200,
  })
})

test('2.6 static edits retain quality independently from complexity and omit animation parameters', () => {
  const request = buildImageGenerationParameters(options({
    mode: 'image', quality: 'high', complexity: 'low', imageCount: 3,
    referenceImagePaths: ['C:/reference.png'], frameCount: 16, frameDurationMs: 2000,
  }))
  assert.equal(request.mode, 'image')
  assert.equal(request.quality, 'high')
  assert.equal(request.complexity, 'low')
  assert.equal(request.imageCount, 3)
  assert.deepEqual(request.referenceImagePaths, ['C:/reference.png'])
  assert.ok(!('frameCount' in request))
  assert.ok(!('frameDurationMs' in request))
})

test('legacy models never send 2.6-only parameters and reject GIF requests', () => {
  for (const model of ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']) {
    const request = buildImageGenerationParameters(options({ model, mode: 'image', referenceImagePaths: ['C:/reference.png'] }))
    assert.equal(request.mode, 'image')
    assert.ok(!('complexity' in request))
    assert.ok(!('frameCount' in request))
    assert.ok(!('frameDurationMs' in request))
    assert.throws(() => buildImageGenerationParameters(options({ model, outputFormat: 'gif' })), /Image 2.6/)
  }
})

test('GIF validation accepts conservative boundaries and rejects malformed frame settings', () => {
  for (const [frameCount, frameDurationMs] of [[2, 20], [9, 200], [16, 2000]]) {
    const request = buildImageGenerationParameters(options({ outputFormat: 'gif', frameCount, frameDurationMs }))
    assert.equal(request.frameCount, frameCount)
    assert.equal(request.frameDurationMs, frameDurationMs)
  }
  for (const frameCount of [1, 17, 2.5, NaN, Infinity, '']) {
    assert.throws(() => buildImageGenerationParameters(options({ outputFormat: 'gif', frameCount })), /帧数/)
  }
  for (const frameDurationMs of [10, 2001, 205, 20.5, NaN, Infinity, '']) {
    assert.throws(() => buildImageGenerationParameters(options({ outputFormat: 'gif', frameDurationMs })), /每帧时长/)
  }
})

test('switching edit to GIF and back clears references, frame settings and incompatible size', () => {
  const gif = normalizeImageGenerationSelection(options({
    mode: 'image', outputFormat: 'gif', size: '3840x2160', imageCount: 4,
    referenceImagePaths: ['C:/reference.png'], frameCount: 16, frameDurationMs: 100,
  }), 'png')
  assert.equal(gif.mode, 'text')
  assert.equal(gif.size, 'auto')
  assert.equal(gif.imageCount, 1)
  assert.deepEqual(gif.referenceImagePaths, [])
  const png = normalizeImageGenerationSelection({ ...gif, outputFormat: 'png' }, 'gif')
  assert.equal(png.mode, 'text')
  assert.equal(png.size, '1024x1024')
  assert.equal(png.frameCount, 9)
  assert.equal(png.frameDurationMs, 200)
  assert.deepEqual(png.referenceImagePaths, [])
})

test('selecting an older model while GIF is active restores usable static defaults', () => {
  const next = normalizeImageGenerationSelection(options({
    model: 'gpt-image-2.5-sunburst', outputFormat: 'gif', mode: 'text', size: 'auto', complexity: 'low',
    frameCount: 12, frameDurationMs: 500,
  }), 'gif')
  assert.equal(next.outputFormat, 'png')
  assert.equal(next.size, '1024x1024')
  assert.equal(next.complexity, 'high')
  assert.equal(next.frameCount, 9)
  assert.equal(next.frameDurationMs, 200)
})

test('switching static models preserves a valid existing edit', () => {
  const original = options({ model: 'gpt-image-2.6-sunburst', mode: 'image', size: '2048x2048', imageCount: 4, referenceImagePaths: ['C:/reference.png'] })
  assert.deepEqual(normalizeImageGenerationSelection(original, 'png'), original)
})

test('conversation picker excludes 2.6 models, aliases, routed IDs and dated releases', () => {
  const vue = fs.readFileSync(new URL('../src/components/新版主题.vue', import.meta.url), 'utf8')
  const constants = vue.match(/const CODEX_IMAGE_GENERATION_MODEL_RELEASES = \[[\s\S]*?\]/)?.[0]
  const start = vue.indexOf('function canonicalCodexUpstreamModelName(')
  const end = vue.indexOf('function selectCodexConversationModel(', start)
  assert.ok(constants && start >= 0 && end > start)
  const source = ts.transpileModule(`${constants}\n${vue.slice(start, end)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const filter = new Function(`${source}\nreturn filterCodexConversationModels;`)()
  assert.deepEqual(filter([
    'gpt-6-astra', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'image-2.6-flare', 'image-2.6-sunburst',
    'gaoge/openai/3/gpt-image-2.6-flare', 'GPT_IMAGE_2.6_SUNBURST', 'gpt-image-2.6-flare-2026-11-04',
    'gpt-image-2.6-sunburst-20261104', 'gpt-image-2.6-flare-chat', 'gpt-image-2.5-flare',
  ]), ['gpt-6-astra', 'gpt-image-2.6-flare-chat'])
})
