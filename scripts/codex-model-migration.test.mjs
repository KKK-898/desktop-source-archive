import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateCodexDefaultModelStorage,
  resolveCodexBackendModelAfterDefaultMigration,
} from '../src/codex-model-migration.ts'

const keys = {
  modelKey: 'model',
  lockedModelKey: 'locked',
  selectionModeKey: 'mode',
  legacyDefaultedKey: 'defaulted',
  selectionOriginKey: 'origin',
  migrationKey: 'migrated-v4',
}

function fixture(initial = {}) {
  const values = new Map(Object.entries(initial))
  const writes = []
  const storage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null
    },
    setItem(key, value) {
      values.set(key, value)
      writes.push([key, value])
    },
  }
  migrateCodexDefaultModelStorage(storage, {
    ...keys,
    currentDefaultModel: 'gpt-5.6-sol',
    legacyDefaultModel: 'gpt-5.5',
    isConversationModel: model => /^gpt-/.test(model) && !model.startsWith('gpt-image-'),
  })
  return { values, writes, storage }
}

test('missing or invalid saved model receives the new automatic default', () => {
  const { values } = fixture({ model: 'gpt-image-2.5-flare' })
  assert.equal(values.get('model'), 'gpt-5.6-sol')
  assert.equal(values.get('locked'), 'gpt-5.6-sol')
  assert.equal(values.get('origin'), 'automatic')
  assert.equal(values.get('migrated-v4'), '1')
})

test('legacy confirmed automatic 5.5 default migrates to 5.6-sol', () => {
  const { values } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'upstream',
    defaulted: '1',
  })
  assert.equal(values.get('model'), 'gpt-5.6-sol')
  assert.equal(values.get('locked'), 'gpt-5.6-sol')
  assert.equal(values.get('origin'), 'automatic')
})

test('explicit locked 5.5 is never overwritten', () => {
  const { values } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'locked',
    defaulted: '1',
  })
  assert.equal(values.get('model'), 'gpt-5.5')
  assert.equal(values.get('locked'), 'gpt-5.5')
  assert.equal(values.get('origin'), 'user')
})

test('valid explicit locked model repairs a missing general model without rewriting the lock', () => {
  const { values, writes } = fixture({
    locked: 'gpt-5.5',
    mode: 'locked',
    defaulted: '1',
  })
  assert.equal(values.get('model'), 'gpt-5.5')
  assert.equal(values.get('locked'), 'gpt-5.5')
  assert.equal(values.get('origin'), 'user')
  assert.equal(writes.some(([key]) => key === 'locked'), false)
})

test('valid explicit locked model replaces an invalid general model without migrating the lock', () => {
  const { values, writes } = fixture({
    model: 'gpt-image-2.5-flare',
    locked: 'gpt-5.5',
    mode: 'locked',
    defaulted: '1',
    origin: 'automatic',
  })
  assert.equal(values.get('model'), 'gpt-5.5')
  assert.equal(values.get('locked'), 'gpt-5.5')
  assert.equal(values.get('origin'), 'user')
  assert.equal(writes.some(([key]) => key === 'locked'), false)
})

test('explicit user origin preserves 5.5 even in upstream mode', () => {
  const { values } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'upstream',
    defaulted: '1',
    origin: 'user',
  })
  assert.equal(values.get('model'), 'gpt-5.5')
  assert.equal(values.get('locked'), 'gpt-5.5')
  assert.equal(values.get('origin'), 'user')
})

test('automatic origin migrates the legacy default without relying on legacy flags', () => {
  const { values } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'upstream',
    origin: 'automatic',
  })
  assert.equal(values.get('model'), 'gpt-5.6-sol')
  assert.equal(values.get('locked'), 'gpt-5.6-sol')
  assert.equal(values.get('origin'), 'automatic')
})

test('unknown valid non-default model is conservatively marked as user-selected', () => {
  const { values } = fixture({
    model: 'gpt-6-astra',
    locked: 'gpt-6-astra',
    mode: 'upstream',
  })
  assert.equal(values.get('model'), 'gpt-6-astra')
  assert.equal(values.get('locked'), 'gpt-6-astra')
  assert.equal(values.get('origin'), 'user')
})

test('migration marker makes subsequent runs idempotent', () => {
  const { storage, writes } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'upstream',
    defaulted: '1',
  })
  const firstWriteCount = writes.length
  migrateCodexDefaultModelStorage(storage, {
    ...keys,
    currentDefaultModel: 'gpt-5.6-sol',
    legacyDefaultModel: 'gpt-5.5',
    isConversationModel: model => /^gpt-/.test(model) && !model.startsWith('gpt-image-'),
  })
  assert.equal(writes.length, firstWriteCount)
})

test('legacy backend automatic default cannot overwrite the migrated frontend default', () => {
  const { storage } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'upstream',
    defaulted: '1',
  })
  assert.equal(resolveCodexBackendModelAfterDefaultMigration(storage, {
    ...keys,
    currentDefaultModel: 'gpt-5.6-sol',
    legacyDefaultModel: 'gpt-5.5',
    isConversationModel: model => /^gpt-/.test(model) && !model.startsWith('gpt-image-'),
  }, 'gpt-5.5'), 'gpt-5.6-sol')
})

test('backend user origin preserves an explicit 5.5 even after local automatic migration', () => {
  const { storage } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'upstream',
    defaulted: '1',
  })
  assert.equal(resolveCodexBackendModelAfterDefaultMigration(storage, {
    ...keys,
    currentDefaultModel: 'gpt-5.6-sol',
    legacyDefaultModel: 'gpt-5.5',
    isConversationModel: model => /^gpt-/.test(model) && !model.startsWith('gpt-image-'),
  }, 'gpt-5.5', 'user'), 'gpt-5.5')
})

test('local user origin preserves a legacy backend 5.5 without an origin marker', () => {
  const { storage } = fixture({
    model: 'gpt-5.5',
    locked: 'gpt-5.5',
    mode: 'upstream',
    defaulted: '1',
    origin: 'user',
  })
  assert.equal(resolveCodexBackendModelAfterDefaultMigration(storage, {
    ...keys,
    currentDefaultModel: 'gpt-5.6-sol',
    legacyDefaultModel: 'gpt-5.5',
    isConversationModel: model => /^gpt-/.test(model) && !model.startsWith('gpt-image-'),
  }, 'gpt-5.5'), 'gpt-5.5')
})
