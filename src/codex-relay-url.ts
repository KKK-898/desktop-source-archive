import { parseTrustedRelayOrigins, readFrontendDeploymentValue } from './frontend-deployment.ts'

/** Explicit operator-controlled allowlist; empty builds do not trust any relay. */
export const GAOGE_CODEX_RELAY_BASE_ORIGINS: readonly string[] = parseTrustedRelayOrigins(
  readFrontendDeploymentValue('VITE_GAOGE_CODEX_RELAY_ORIGINS'),
)

/** Accept only configured HTTPS origins, optionally followed by /v1. */
export function normalizeGaogeCodexRelayBaseUrl(
  value: unknown,
  trustedOrigins: readonly string[] = GAOGE_CODEX_RELAY_BASE_ORIGINS,
): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  let parsed: URL
  try { parsed = new URL(raw) } catch { return '' }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return ''
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname !== '' && pathname !== '/v1') return ''
  const origin = parsed.origin.toLowerCase()
  return trustedOrigins.includes(origin) ? origin : ''
}

export function isGaogeCodexRelayBaseUrl(
  value: unknown,
  trustedOrigins: readonly string[] = GAOGE_CODEX_RELAY_BASE_ORIGINS,
): boolean {
  return Boolean(normalizeGaogeCodexRelayBaseUrl(value, trustedOrigins))
}
