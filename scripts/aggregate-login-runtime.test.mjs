import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateGroupFailureReason,
  ensureAggregateApiKeyWithCache,
  isAggregateGroupReady,
  isAggregateModelResultReady,
  markAggregateKeyFailed,
  markAggregateKeyReady,
  refreshAggregateGroupRuntime,
} from '../src/aggregate-login-runtime.ts'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function createKeyState(initial) {
  let state = initial
  return {
    get value() {
      return state
    },
    onReady(stateKey) {
      state = markAggregateKeyReady(state, stateKey)
    },
    onError(stateKey, error) {
      state = markAggregateKeyFailed(state, stateKey, errorMessage(error))
    },
  }
}

test('cached aggregate key restores readiness before a successful model refresh', async () => {
  const cachedKey = { key: 'cached-key' }
  const cache = new Map([['user:provider:1', cachedKey]])
  const requests = new Map()
  const keyState = createKeyState({
    ready: { 'provider:1': false },
    errors: { 'provider:1': '旧的网络错误' },
  })
  let loadCount = 0
  let modelResult = null

  const outcome = await refreshAggregateGroupRuntime({
    ensureKey: () => ensureAggregateApiKeyWithCache({
      stateKey: 'provider:1',
      cacheKey: 'user:provider:1',
      cache,
      requests,
      load: async () => {
        loadCount += 1
        return { key: 'new-key' }
      },
      normalize: (value) => value,
      onReady: (stateKey) => keyState.onReady(stateKey),
      onError: (stateKey, error) => keyState.onError(stateKey, error),
    }),
    fetchModels: async (apiKey) => {
      assert.equal(apiKey, cachedKey)
      return { models: ['model-a'], baseUrl: 'https://relay.example/v1' }
    },
    normalizeModels: (models) => models,
    emptyBaseUrl: 'https://relay.example/v1',
    formatKeyError: errorMessage,
    formatModelError: errorMessage,
    onLoading: () => undefined,
    onResult: (result) => {
      modelResult = result
    },
  })

  assert.equal(outcome.kind, 'success')
  assert.equal(loadCount, 0)
  assert.equal(keyState.value.ready['provider:1'], true)
  assert.equal(keyState.value.errors['provider:1'], '')
  assert.deepEqual(modelResult?.models, ['model-a'])
  assert.equal(modelResult?.modelError, '')
})

test('model failure preserves a valid key, clears stale models, and recovers from cache', async () => {
  const cache = new Map([['user:provider:2', { key: 'cached-key' }]])
  const requests = new Map()
  const keyState = createKeyState({
    ready: { 'provider:2': true },
    errors: { 'provider:2': '' },
  })
  let loadCount = 0
  let modelResult = { models: ['stale-model'], baseUrl: 'https://relay.example/v1' }
  const loadingStates = []
  let shouldFail = true

  const refresh = () => refreshAggregateGroupRuntime({
    ensureKey: () => ensureAggregateApiKeyWithCache({
      stateKey: 'provider:2',
      cacheKey: 'user:provider:2',
      cache,
      requests,
      load: async () => {
        loadCount += 1
        return { key: 'new-key' }
      },
      normalize: (value) => value,
      onReady: (stateKey) => keyState.onReady(stateKey),
      onError: (stateKey, error) => keyState.onError(stateKey, error),
    }),
    fetchModels: async () => {
      if (shouldFail) throw new Error('模型目录请求超时')
      return { models: ['model-b'], baseUrl: 'https://relay.example/v1' }
    },
    normalizeModels: (models) => models,
    emptyBaseUrl: 'https://relay.example/v1',
    formatKeyError: errorMessage,
    formatModelError: errorMessage,
    onLoading: (loading) => loadingStates.push(loading),
    onResult: (result) => {
      modelResult = result
    },
  })

  const failed = await refresh()
  assert.equal(failed.kind, 'model-error')
  assert.equal(keyState.value.ready['provider:2'], true)
  assert.equal(keyState.value.errors['provider:2'], '')
  assert.deepEqual(modelResult.models, [])
  assert.equal(modelResult.modelError, '模型目录请求超时')
  assert.equal(isAggregateModelResultReady(modelResult), false)

  shouldFail = false
  const recovered = await refresh()
  assert.equal(recovered.kind, 'success')
  assert.equal(loadCount, 0)
  assert.deepEqual(modelResult.models, ['model-b'])
  assert.equal(modelResult.modelError, '')
  assert.equal(isAggregateModelResultReady(modelResult), true)
  assert.deepEqual(loadingStates, [true, false, true, false])
})

test('real key preparation failure is the only path that marks the key unavailable', async () => {
  const keyState = createKeyState({
    ready: { 'provider:3': true },
    errors: { 'provider:3': '' },
  })
  let modelResult = { models: ['stale-model'], baseUrl: 'https://relay.example/v1' }
  let fetchCount = 0

  const outcome = await refreshAggregateGroupRuntime({
    ensureKey: () => ensureAggregateApiKeyWithCache({
      stateKey: 'provider:3',
      cacheKey: 'user:provider:3',
      cache: new Map(),
      requests: new Map(),
      load: async () => {
        throw new Error('Key 接口不可用')
      },
      normalize: (value) => value,
      onReady: (stateKey) => keyState.onReady(stateKey),
      onError: (stateKey, error) => keyState.onError(stateKey, error),
    }),
    fetchModels: async () => {
      fetchCount += 1
      return { models: ['should-not-run'], baseUrl: 'https://relay.example/v1' }
    },
    normalizeModels: (models) => models,
    emptyBaseUrl: 'https://relay.example/v1',
    formatKeyError: errorMessage,
    formatModelError: errorMessage,
    onLoading: () => undefined,
    onResult: (result) => {
      modelResult = result
    },
  })

  assert.equal(outcome.kind, 'key-error')
  assert.equal(fetchCount, 0)
  assert.equal(keyState.value.ready['provider:3'], false)
  assert.equal(keyState.value.errors['provider:3'], 'Key 接口不可用')
  assert.deepEqual(modelResult.models, [])
  assert.equal(modelResult.modelError, '')
})

test('concurrent key preparation shares one request and restores all waiters', async () => {
  const cache = new Map()
  const requests = new Map()
  const keyState = createKeyState({ ready: {}, errors: {} })
  let loadCount = 0
  let release
  const deferred = new Promise((resolve) => {
    release = resolve
  })
  const options = {
    stateKey: 'provider:4',
    cacheKey: 'user:provider:4',
    cache,
    requests,
    load: async () => {
      loadCount += 1
      return deferred
    },
    normalize: (value) => value,
    onReady: (stateKey) => keyState.onReady(stateKey),
    onError: (stateKey, error) => keyState.onError(stateKey, error),
  }

  const first = ensureAggregateApiKeyWithCache(options)
  const second = ensureAggregateApiKeyWithCache(options)
  release({ key: 'shared-key' })

  const [firstKey, secondKey] = await Promise.all([first, second])
  assert.equal(loadCount, 1)
  assert.equal(firstKey, secondKey)
  assert.equal(firstKey.key, 'shared-key')
  assert.equal(keyState.value.ready['provider:4'], true)
  assert.equal(keyState.value.errors['provider:4'], '')
  assert.equal(requests.size, 0)
})

test('aggregate readiness reports key and model failures independently', () => {
  assert.equal(isAggregateGroupReady({
    keyReady: true,
    keyError: '',
    modelReady: true,
    modelError: '',
  }), true)
  assert.equal(aggregateGroupFailureReason({
    keyReady: true,
    keyError: '',
    modelReady: false,
    modelError: '模型服务暂时不可用',
  }), '模型服务暂时不可用')
  assert.equal(aggregateGroupFailureReason({
    keyReady: false,
    keyError: '',
    modelReady: false,
    modelError: '',
  }), '独立 Key 尚未准备完成。')
})
