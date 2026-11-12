<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'

interface TurnstileRenderOptions {
  sitekey: string
  callback: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: () => void
  theme?: 'light' | 'dark' | 'auto'
  size?: 'normal' | 'compact' | 'flexible'
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string
  reset: (widgetId?: string) => void
  remove: (widgetId?: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
    onGaogeTurnstileLoad?: () => void
  }
}

const props = withDefaults(defineProps<{
  siteKey: string
  theme?: 'light' | 'dark' | 'auto'
}>(), {
  theme: 'dark',
})

const emit = defineEmits<{
  verify: [token: string]
  expire: []
  error: []
}>()

const container = ref<HTMLElement | null>(null)
const widgetId = ref('')
let scriptReady = false

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const complete = () => {
      scriptReady = true
      resolve()
    }
    window.onGaogeTurnstileLoad = complete
    const existing = document.querySelector<HTMLScriptElement>('script[data-gaoge-turnstile]')
    if (existing) {
      existing.addEventListener('error', () => reject(new Error('Turnstile failed to load')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onGaogeTurnstileLoad&render=explicit'
    script.async = true
    script.defer = true
    script.dataset.gaogeTurnstile = 'true'
    script.addEventListener('error', () => reject(new Error('Turnstile failed to load')), { once: true })
    document.head.appendChild(script)
  })
}

function renderWidget() {
  if (!window.turnstile || !container.value || !props.siteKey) return
  if (widgetId.value) {
    window.turnstile.remove(widgetId.value)
    widgetId.value = ''
  }
  container.value.innerHTML = ''
  widgetId.value = window.turnstile.render(container.value, {
    sitekey: props.siteKey,
    callback: (token) => emit('verify', token),
    'expired-callback': () => emit('expire'),
    'error-callback': () => emit('error'),
    theme: props.theme,
    size: 'flexible',
  })
}

function reset() {
  if (window.turnstile && widgetId.value) window.turnstile.reset(widgetId.value)
}

defineExpose({ reset })

onMounted(async () => {
  if (!props.siteKey) return
  try {
    await loadScript()
    scriptReady = true
    renderWidget()
  } catch {
    emit('error')
  }
})

watch(() => props.siteKey, (siteKey) => {
  if (siteKey && scriptReady) renderWidget()
})

onUnmounted(() => {
  if (window.turnstile && widgetId.value) {
    window.turnstile.remove(widgetId.value)
  }
})
</script>

<template>
  <div ref="container" class="turnstile-container" />
</template>

<style scoped>
.turnstile-container {
  width: 100%;
  min-height: 65px;
}

.turnstile-container :deep(iframe) {
  width: 100% !important;
}
</style>
