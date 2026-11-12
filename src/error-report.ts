import { getApiBaseUrl } from './domain-config'

type ErrorReportSource =
  | 'renderer'
  | 'renderer-global'
  | 'api'
  | 'tauri'

export interface ErrorReportContext {
  source?: ErrorReportSource | string
  feature?: string
  action?: string
  page?: string
  apiPath?: string
  ipcChannel?: string
  status?: number
  severity?: 'error' | 'warning' | 'fatal'
  metadata?: Record<string, unknown>
  reportable?: boolean
}

interface SerializedError {
  name: string
  message: string
  stack: string
  status?: number
  code?: unknown
  reason?: unknown
}

const ERROR_REPORT_ENDPOINT = '/desktop/error-reports'
const ERROR_REPORT_DEDUPE_MS = 30_000
const ERROR_REPORT_RATE_WINDOW_MS = 60_000
const ERROR_REPORT_RATE_LIMIT = 8
const MAX_MESSAGE_LENGTH = 1000
const MAX_STACK_LENGTH = 5000
const MAX_METADATA_LENGTH = 6000

const reportableStatusCodes = new Set([0, 408, 423, 424, 425, 429])
const ignoredStatusCodes = new Set([400, 401, 403, 404, 409, 422])

const businessErrorPatterns = [
  /密码错误/i,
  /账号.*密码/i,
  /invalid.*password/i,
  /invalid.*credential/i,
  /incorrect.*password/i,
  /验证码/i,
  /二次验证|2fa/i,
  /卡密/i,
  /兑换码/i,
  /redeem/i,
  /已被使用|already.*used/i,
  /已过期|expired/i,
  /请输入/,
  /请先登录/,
  /登录状态已失效/,
  /未找到可取消的订单/,
  /已取消/,
  /用户取消|cancelled by user/i,
  /当前不是桌面环境/,
]

const sensitivePatterns = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /(sk-[A-Za-z0-9_-]{12,})/g,
  /("?(?:password|passwd|pwd|apiKey|api_key|key|token|access_token|refresh_token|session|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
  /([?&](?:token|key|api_key|access_token|refresh_token|password)=)[^&\s]+/gi,
]

const lastReportBySignature = new Map<string, number>()
let rateWindowStartedAt = 0
let rateWindowCount = 0
let globalReporterInstalled = false

function trimText(value: unknown, maxLength: number) {
  const text = String(value || '')
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function redactSensitiveText(value: unknown, maxLength = MAX_MESSAGE_LENGTH) {
  let text = trimText(value, maxLength)
  for (const pattern of sensitivePatterns) {
    text = text.replace(pattern, (match, prefix) => {
      if (typeof prefix === 'string' && prefix.length < match.length) return `${prefix}[REDACTED]`
      return '[REDACTED]'
    })
  }
  return text
}

function safeJson(value: unknown, maxLength = MAX_METADATA_LENGTH) {
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value ?? {}), maxLength))
  } catch {
    return redactSensitiveText(value, maxLength)
  }
}

function getOrCreateDeviceId() {
  const key = 'gaoge_desktop_error_device_id'
  let id = localStorage.getItem(key)
  if (!id) {
    id = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    localStorage.setItem(key, id)
  }
  return id
}

function maskEmail(email: unknown) {
  const value = typeof email === 'string' ? email.trim() : ''
  const atIndex = value.indexOf('@')
  if (atIndex <= 1) return value ? '[REDACTED_EMAIL]' : ''
  return `${value.slice(0, 2)}***${value.slice(atIndex)}`
}

function currentUserForReport() {
  try {
    const user = JSON.parse(localStorage.getItem('gaoge_desktop_user') || 'null') as Record<string, unknown> | null
    if (!user) return null
    return {
      id: user.id,
      emailMasked: maskEmail(user.email),
      role: user.role,
    }
  } catch {
    return null
  }
}

function serializeError(error: unknown): SerializedError {
  const record = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>
  const fallbackMessage = typeof error === 'string' ? error : '未知错误'
  const message = redactSensitiveText(record.message || fallbackMessage, MAX_MESSAGE_LENGTH)
  return {
    name: redactSensitiveText(record.name || 'Error', 120),
    message,
    stack: redactSensitiveText(record.stack || '', MAX_STACK_LENGTH),
    status: typeof record.status === 'number' ? record.status : undefined,
    code: safeJson(record.code, 500),
    reason: safeJson(record.reason, 1000),
  }
}

function statusFrom(error: unknown, context: ErrorReportContext) {
  const record = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>
  return typeof context.status === 'number'
    ? context.status
    : typeof record.status === 'number'
      ? record.status
      : undefined
}

export function shouldReportSoftwareError(error: unknown, context: ErrorReportContext = {}) {
  if (context.reportable === false) return false
  if (context.reportable === true) return true

  const serialized = serializeError(error)
  const message = serialized.message
  if (!message) return false
  if (businessErrorPatterns.some((pattern) => pattern.test(message))) return false

  const status = statusFrom(error, context)
  if (typeof status === 'number') {
    if (status >= 500 || reportableStatusCodes.has(status)) return true
    if (ignoredStatusCodes.has(status)) return false
  }

  if (serialized.stack) return true
  if (context.source === 'renderer-global') return true
  return false
}

function withinRateLimit(signature: string) {
  const now = Date.now()
  const lastReportedAt = lastReportBySignature.get(signature) || 0
  if (now - lastReportedAt < ERROR_REPORT_DEDUPE_MS) return false
  lastReportBySignature.set(signature, now)

  if (now - rateWindowStartedAt > ERROR_REPORT_RATE_WINDOW_MS) {
    rateWindowStartedAt = now
    rateWindowCount = 0
  }
  rateWindowCount += 1
  return rateWindowCount <= ERROR_REPORT_RATE_LIMIT
}

function buildReportPayload(error: unknown, context: ErrorReportContext) {
  const serialized = serializeError(error)
  const signature = [
    serialized.name,
    serialized.message,
    statusFrom(error, context) ?? serialized.status ?? '',
  ].join('|')

  return {
    signature,
    payload: {
      app: 'gaoge-free',
      appVersion: import.meta.env.VITE_APP_VERSION || '',
      endpointVersion: 1,
      createdAt: new Date().toISOString(),
      source: context.source || 'renderer',
      feature: context.feature || 'unknown',
      action: context.action || '',
      page: context.page || '',
      severity: context.severity || 'error',
      apiPath: context.apiPath || '',
      ipcChannel: context.ipcChannel || '',
      status: statusFrom(error, context) ?? serialized.status ?? null,
      error: serialized,
      metadata: safeJson(context.metadata || {}),
      user: currentUserForReport(),
      device: {
        deviceId: getOrCreateDeviceId(),
        userAgent: redactSensitiveText(navigator.userAgent, 500),
        platform: navigator.platform || '',
        language: navigator.language || '',
      },
    },
  }
}

export async function reportClientError(error: unknown, context: ErrorReportContext = {}) {
  if (!shouldReportSoftwareError(error, context)) return false

  const { signature, payload } = buildReportPayload(error, context)
  if (!withinRateLimit(signature)) return false

  try {
    if (window.gaogeDesktop?.reportError) {
      try {
        await window.gaogeDesktop.reportError({
          ...payload,
          baseUrl: getApiBaseUrl(),
        })
        return true
      } catch {
        // 桌面桥接不可用时继续尝试浏览器直连上报。
      }
    }

    await fetch(`${getApiBaseUrl()}${ERROR_REPORT_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      keepalive: true,
    })
    return true
  } catch {
    return false
  }
}

export function reportFeatureError(feature: string, action: string, error: unknown, context: ErrorReportContext = {}) {
  void reportClientError(error, {
    ...context,
    source: context.source || 'renderer',
    feature,
    action,
  })
}

export function installGlobalErrorReporter() {
  if (globalReporterInstalled || typeof window === 'undefined') return
  globalReporterInstalled = true

  window.addEventListener('error', (event) => {
    void reportClientError(event.error || event.message, {
      source: 'renderer-global',
      feature: 'renderer',
      action: 'window-error',
      severity: 'fatal',
      metadata: {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    void reportClientError(event.reason, {
      source: 'renderer-global',
      feature: 'renderer',
      action: 'unhandled-rejection',
      severity: 'fatal',
    })
  })
}
