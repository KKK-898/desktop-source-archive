export interface AggregateKeyPreparationState {
  ready: Record<string, boolean>
  errors: Record<string, string>
}

export interface AggregateModelResult {
  models: string[]
  baseUrl: string
  fallback?: boolean
  builtinCatalog?: boolean
  message?: string
  cached?: boolean
  modelError?: string
}

export interface AggregateGroupReadiness {
  keyReady: boolean
  keyError: string
  modelReady: boolean
  modelError: string
}

interface EnsureAggregateApiKeyOptions<TKey> {
  stateKey: string
  cacheKey: string
  cache: Map<string, TKey>
  requests: Map<string, Promise<TKey>>
  load: () => Promise<TKey>
  normalize: (value: TKey) => TKey
  onReady: (stateKey: string) => void
  onError: (stateKey: string, error: unknown) => void
}

interface RefreshAggregateGroupOptions<TKey, TResult extends AggregateModelResult> {
  ensureKey: () => Promise<TKey>
  fetchModels: (key: TKey) => Promise<TResult>
  normalizeModels: (models: string[]) => string[]
  emptyBaseUrl: string
  formatKeyError: (error: unknown) => string
  formatModelError: (error: unknown) => string
  onLoading: (loading: boolean) => void
  onResult: (result: AggregateModelResult) => void
  onFailure?: (phase: 'key' | 'model', error: unknown, message: string) => void
}

export type AggregateGroupRefreshOutcome =
  | { kind: 'success'; result: AggregateModelResult }
  | { kind: 'key-error'; message: string }
  | { kind: 'model-error'; message: string }

function normalizedErrorMessage(message: string, fallback: string) {
  return message.trim() || fallback
}

export function markAggregateKeyReady(
  state: AggregateKeyPreparationState,
  stateKey: string,
): AggregateKeyPreparationState {
  return {
    ready: { ...state.ready, [stateKey]: true },
    errors: { ...state.errors, [stateKey]: '' },
  }
}

export function markAggregateKeyFailed(
  state: AggregateKeyPreparationState,
  stateKey: string,
  message: string,
): AggregateKeyPreparationState {
  return {
    ready: { ...state.ready, [stateKey]: false },
    errors: {
      ...state.errors,
      [stateKey]: normalizedErrorMessage(message, '独立 Key 准备失败。'),
    },
  }
}

export async function ensureAggregateApiKeyWithCache<TKey>(
  options: EnsureAggregateApiKeyOptions<TKey>,
): Promise<TKey> {
  const cached = options.cache.get(options.cacheKey)
  if (cached) {
    options.onReady(options.stateKey)
    return cached
  }

  const pending = options.requests.get(options.cacheKey)
  if (pending) {
    const value = await pending
    options.onReady(options.stateKey)
    return value
  }

  const request = Promise.resolve()
    .then(options.load)
    .then(options.normalize)
    .then((value) => {
      options.cache.set(options.cacheKey, value)
      options.onReady(options.stateKey)
      return value
    })
    .catch((error) => {
      options.cache.delete(options.cacheKey)
      options.onError(options.stateKey, error)
      throw error
    })
    .finally(() => {
      options.requests.delete(options.cacheKey)
    })

  options.requests.set(options.cacheKey, request)
  return request
}

export function isAggregateModelResultReady(result?: AggregateModelResult | null) {
  return Boolean(result && result.models.length > 0 && !result.modelError)
}

export function isAggregateGroupReady(group: AggregateGroupReadiness) {
  return group.keyReady && !group.keyError && group.modelReady && !group.modelError
}

export function aggregateGroupFailureReason(group: AggregateGroupReadiness) {
  if (group.keyError) return group.keyError
  if (!group.keyReady) return '独立 Key 尚未准备完成。'
  if (group.modelError) return group.modelError
  if (!group.modelReady) return '模型目录尚未准备完成。'
  return ''
}

export async function refreshAggregateGroupRuntime<TKey, TResult extends AggregateModelResult>(
  options: RefreshAggregateGroupOptions<TKey, TResult>,
): Promise<AggregateGroupRefreshOutcome> {
  options.onLoading(true)
  try {
    let apiKey: TKey
    try {
      apiKey = await options.ensureKey()
    } catch (error) {
      const message = normalizedErrorMessage(options.formatKeyError(error), '独立 Key 准备失败。')
      options.onResult({
        models: [],
        baseUrl: options.emptyBaseUrl,
        fallback: false,
        builtinCatalog: false,
        message: '',
        modelError: '',
      })
      options.onFailure?.('key', error, message)
      return { kind: 'key-error', message }
    }

    try {
      const result = await options.fetchModels(apiKey)
      const models = options.normalizeModels(result.models).filter(Boolean)
      if (models.length === 0) throw new Error('模型目录没有返回可用模型。')
      const completed: AggregateModelResult = {
        ...result,
        models,
        modelError: '',
      }
      options.onResult(completed)
      return { kind: 'success', result: completed }
    } catch (error) {
      const message = normalizedErrorMessage(options.formatModelError(error), '模型目录读取失败。')
      options.onResult({
        models: [],
        baseUrl: options.emptyBaseUrl,
        fallback: false,
        builtinCatalog: false,
        message,
        modelError: message,
      })
      options.onFailure?.('model', error, message)
      return { kind: 'model-error', message }
    }
  } finally {
    options.onLoading(false)
  }
}
