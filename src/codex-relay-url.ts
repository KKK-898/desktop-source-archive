/**
 * The desktop runtime has two first-party Codex relay endpoints.  Keep this
 * allowlist explicit: relay status must never be inferred from an arbitrary
 * configured URL or from a hostname that merely contains our brand name.
 */
export const GAOGE_CODEX_RELAY_BASE_ORIGINS = [
  'https://api.gaogeaii.com',
  'https://api.gaogeaii.cc',
] as const

const GAOGE_CODEX_RELAY_ORIGIN_SET = new Set<string>(GAOGE_CODEX_RELAY_BASE_ORIGINS)

/**
 * Normalize only the URL shapes supported by the first-party relay.
 *
 * Both `https://api.example` and `https://api.example/v1` are valid because
 * older Codex configs may omit the `/v1` suffix.  A trailing slash is also
 * harmless; every other path, query, fragment, credential, scheme, or host
 * is rejected instead of being treated as an active Gaoge relay.
 */
export function normalizeGaogeCodexRelayBaseUrl(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return ''
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    return ''
  }

  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname !== '' && pathname !== '/v1') return ''

  const origin = parsed.origin.toLowerCase()
  return GAOGE_CODEX_RELAY_ORIGIN_SET.has(origin) ? origin : ''
}

export function isGaogeCodexRelayBaseUrl(value: unknown): boolean {
  return GAOGE_CODEX_RELAY_ORIGIN_SET.has(normalizeGaogeCodexRelayBaseUrl(value))
}
