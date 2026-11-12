import { createApp, type Component } from 'vue'
import './new-theme-global.css'
import './desktop-api'
import { startDesktopTelemetry } from './desktop-telemetry'
import { installGlobalErrorReporter, reportFeatureError } from './error-report'
import { initializeDomainConfig } from './domain-config'

function mountRootComponent(RootComponent: Component) {
  const app = createApp(RootComponent)

  app.config.errorHandler = (error, instance, info) => {
    reportFeatureError('renderer', 'vue-error', error, {
      source: 'renderer-global',
      severity: 'fatal',
      metadata: {
        info,
        component: instance?.$options?.name || '',
      },
    })
  }

  app.mount('#app')
}

function shouldShowInvitationDownloadPage() {
  if (typeof window === 'undefined') return false
  const isDesktopRuntime = Boolean(window.gaogeDesktop)
    || '__TAURI_INTERNALS__' in window
    || '__TAURI__' in window
  if (isDesktopRuntime) return false

  const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/'
  const params = new URLSearchParams(window.location.search)
  return normalizedPath === '/invite' || params.has('aff') || params.has('aff_code')
}

async function bootstrap() {
  const config = await initializeDomainConfig()
  if (config.source !== 'remote') {
    console.warn('[Gaoge] Runtime config fallback:', config.source, config.warning || '')
  }

  installGlobalErrorReporter()
  startDesktopTelemetry()

  if (shouldShowInvitationDownloadPage()) {
    const { default: InvitationDownloadPage } = await import('./components/InvitationDownloadPage.vue')
    mountRootComponent(InvitationDownloadPage)
    return
  }

  const { default: NewTheme } = await import('./components/新版主题.vue')
  mountRootComponent(NewTheme)
}

void bootstrap()
