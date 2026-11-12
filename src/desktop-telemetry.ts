import {
  reportDesktopTelemetry,
  type ApiUser,
  type DesktopTelemetryEvent,
  type DesktopTelemetryPayload,
} from './api'
import { getApiBaseUrl } from './domain-config'

const DEVICE_ID_STORAGE_KEY = 'gaoge_desktop_device_id'
const HEARTBEAT_INTERVAL_MS = 60_000
let telemetryStarted = false
let heartbeatTimer: number | undefined
let currentSessionId = ''

function randomId(prefix: string) {
  const randomValues = new Uint8Array(8)
  window.crypto?.getRandomValues?.(randomValues)
  const randomPart = Array.from(randomValues, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${prefix}-${Date.now().toString(36)}-${randomPart || Math.random().toString(36).slice(2, 12)}`
}

function readStorageValue(key: string) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStorageValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 忽略隐私模式或本地存储不可用时的写入失败。
  }
}

function getOrCreateDeviceId() {
  const existing = readStorageValue(DEVICE_ID_STORAGE_KEY)
  if (existing) return existing

  const nextDeviceId = randomId('dev')
  writeStorageValue(DEVICE_ID_STORAGE_KEY, nextDeviceId)
  return nextDeviceId
}

function getOrCreateSessionId() {
  if (!currentSessionId) {
    currentSessionId = randomId('session')
  }
  return currentSessionId
}

function readCurrentUser(): Partial<ApiUser> | null {
  try {
    const user = JSON.parse(localStorage.getItem('gaoge_desktop_user') || 'null') as Partial<ApiUser> | null
    return user && typeof user === 'object' ? user : null
  } catch {
    return null
  }
}

function currentPageLabel() {
  const title = document.title.trim()
  const hash = window.location.hash.replace(/^#\/?/, '')
  return title || hash || 'desktop'
}

function buildTelemetryPayload(): DesktopTelemetryPayload {
  const user = readCurrentUser()

  return {
    sessionId: getOrCreateSessionId(),
    deviceId: getOrCreateDeviceId(),
    userId: user?.id,
    userEmail: user?.email,
    username: user?.username,
    appVersion: import.meta.env.VITE_APP_VERSION || '',
    platform: navigator.platform || '',
    arch: '',
    language: navigator.language || '',
    userAgent: navigator.userAgent || '',
    page: currentPageLabel(),
  }
}

async function sendTelemetry(event: DesktopTelemetryEvent, options: { keepalive?: boolean } = {}) {
  try {
    await reportDesktopTelemetry(event, buildTelemetryPayload(), options)
  } catch {
    // 在线人数统计不能影响主流程。
  }
}

function sendCloseTelemetry() {
  const payload = buildTelemetryPayload()
  const body = JSON.stringify(payload)
  const url = `${getApiBaseUrl()}/desktop/telemetry/close`

  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: 'application/json' })
    if (navigator.sendBeacon(url, blob)) return
  }

  void fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
    keepalive: true,
  }).catch(() => undefined)
}

export function startDesktopTelemetry() {
  if (telemetryStarted || typeof window === 'undefined') return
  telemetryStarted = true

  void sendTelemetry('start')
  heartbeatTimer = window.setInterval(() => {
    void sendTelemetry('heartbeat')
  }, HEARTBEAT_INTERVAL_MS)

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void sendTelemetry('heartbeat')
    }
  })
  window.addEventListener('pagehide', sendCloseTelemetry)
  window.addEventListener('beforeunload', sendCloseTelemetry)
}

export function stopDesktopTelemetry() {
  if (heartbeatTimer) {
    window.clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
  sendCloseTelemetry()
}
