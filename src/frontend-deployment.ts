/** Public source has no operator endpoints or contact details by default.
 * Explicit keys let Vite substitute only this allowlist into production bundles.
 */
const FRONTEND_DEPLOYMENT_VALUES: Record<string, string | undefined> = {
  VITE_GAOGE_CODEX_RELAY_ORIGINS: import.meta.env?.VITE_GAOGE_CODEX_RELAY_ORIGINS,
  VITE_GAOGE_MOBILE_RELAY_URL: import.meta.env?.VITE_GAOGE_MOBILE_RELAY_URL,
  VITE_GAOGE_CONTACT_ITEMS: import.meta.env?.VITE_GAOGE_CONTACT_ITEMS,
  VITE_GAOGE_DESKTOP_EMAIL_DOMAIN: import.meta.env?.VITE_GAOGE_DESKTOP_EMAIL_DOMAIN,
  VITE_GAOGE_SUPPORT_GROUP: import.meta.env?.VITE_GAOGE_SUPPORT_GROUP,
  VITE_GAOGE_SUPPORT_QR_URL: import.meta.env?.VITE_GAOGE_SUPPORT_QR_URL,
}

export function readFrontendDeploymentValue(key: string): string {
  if (!Object.hasOwn(FRONTEND_DEPLOYMENT_VALUES, key)) return ''
  return String(FRONTEND_DEPLOYMENT_VALUES[key] || '').trim()
}

export function normalizeTrustedHttpsUrl(value: unknown): string {
  try {
    const parsed = new URL(String(value || '').trim())
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function parseTrustedRelayOrigins(value: unknown): string[] {
  const candidates = String(value || '').split(/[\n,]/)
  return [...new Set(candidates.map(normalizeTrustedHttpsUrl).filter((value) => {
    if (!value) return false
    return new URL(value).pathname === '/'
  }))]
}

/** Never send an account token merely because a user entered a relay URL. */
export function isConfiguredAccountRelay(value: unknown, configuredValue: unknown): boolean {
  const configured = normalizeTrustedHttpsUrl(configuredValue)
  return Boolean(configured && normalizeTrustedHttpsUrl(value) === configured)
}

export interface DeploymentContactItem {
  id?: string
  title?: string
  content?: string
  description?: string
  icon?: string
  imageUrl?: string
}

export function parseDeploymentContactItems(value: unknown): DeploymentContactItem[] {
  try {
    const items: unknown = JSON.parse(String(value || '[]'))
    if (!Array.isArray(items)) return []
    return items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
      .map((item) => Object.fromEntries(['id', 'title', 'content', 'description', 'icon', 'imageUrl']
        .filter((key) => typeof item[key] === 'string')
        .map((key) => [key, String(item[key]).trim()])))
  } catch {
    return []
  }
}

export function desktopRegistrationEmailDomain(value: unknown): string {
  const domain = String(value || '').trim().toLowerCase()
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
    ? domain
    : 'desktop.example.invalid'
}
