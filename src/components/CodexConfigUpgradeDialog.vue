<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { CircleAlert, RefreshCcw } from 'lucide-vue-next'
import { getApiBaseUrl, getOpenAIBaseUrl } from '../domain-config'

const props = defineProps<{
  enabled: boolean
  busy: boolean
  version: string
}>()
const emit = defineEmits<{
  'busy-change': [busy: boolean]
}>()
type Stage = '' | 'prompt' | 'progress' | 'result'
const stage = ref<Stage>('')
const dialog = ref<HTMLDialogElement | null>(null)
const working = ref(false)
const progress = ref('正在重启 Codex')
const resultTitle = ref('')
const resultMessage = ref('')
const error = ref('')
const noticeVersionKey = 'gaoge_desktop_codex_update_notice_version'
let seenVersion = ''
let disposed = false
let removeProgress: (() => void) | undefined
let previousFocus: HTMLElement | null = null
const title = computed(() => ({ prompt: '软件更新使用提醒', progress: '正在重启 Codex', result: resultTitle.value, '': '' })[stage.value])

function maybePrompt() {
  const version = props.version.trim()
  if (!props.enabled || props.busy || working.value || stage.value || !version || seenVersion === version) return
  // This is a once-per-version notice, not a Codex configuration inspection.
  // Reading or dismissing it must never call a native configuration command.
  try {
    if (localStorage.getItem(noticeVersionKey) === version) {
      seenVersion = version
      return
    }
    localStorage.setItem(noticeVersionKey, version)
  } catch {
    // Restricted local storage must not block the user's actions. Remember
    // the notice for this mounted session even if persistence is unavailable.
  }
  seenVersion = version
  error.value = ''
  stage.value = 'prompt'
}

watch(() => [props.enabled, props.busy, props.version], () => {
  if (!props.enabled && !working.value) stage.value = ''
  maybePrompt()
}, { immediate: true })

watch(stage, async (value) => {
  await nextTick()
  if (disposed || !dialog.value) return
  if (value && !dialog.value.open) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.value.showModal()
  } else if (!value && dialog.value.open) {
    dialog.value.close()
    previousFocus?.focus()
  }
}, { immediate: true })

function dismiss() {
  if (!working.value) stage.value = ''
}

async function restartCodex() {
  const api = window.gaogeDesktop
  if (working.value) return
  working.value = true
  emit('busy-change', true)
  stage.value = 'progress'
  progress.value = '正在重启 Codex'
  error.value = ''
  try {
    if (!api?.restartCodex) throw new Error('当前环境无法自动重启 Codex，请手动重新打开 Codex。')
    removeProgress = api.onCodexLoginProgress?.((event) => { progress.value = event.message || '正在重启 Codex' })
    // The native restart refreshes only the software-managed model catalog.
    // Do not run a general configuration migration or add a second confirmation.
    const result = await api.restartCodex({
      modelPolicyApiBaseUrl: getApiBaseUrl(),
      relayBaseUrl: getOpenAIBaseUrl(),
    })
    resultTitle.value = result.codexLaunched
      ? 'Codex 已重启'
      : result.codexLaunchQueued ? 'Codex 正在启动' : 'Codex 未能自动打开'
    resultMessage.value = result.codexLaunched
      ? 'Codex 已重新打开。'
      : result.codexLaunchQueued
        ? '已提交启动请求，请稍候。'
        : '请手动打开 Codex，或稍后再次点击“重启 Codex”。'
    if (result.warnings?.length) resultMessage.value += ` ${result.warnings.join(' ')}`
  } catch (cause) {
    resultTitle.value = 'Codex 重启未完成'
    resultMessage.value = '请稍后重试，或手动重新打开 Codex。'
    error.value = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '请稍后重试。'
  } finally {
    removeProgress?.()
    removeProgress = undefined
    working.value = false
    emit('busy-change', false)
    if (!disposed) stage.value = 'result'
  }
}

onUnmounted(() => {
  disposed = true
  removeProgress?.()
  dialog.value?.close()
  if (working.value) emit('busy-change', false)
})
</script>

<template>
  <dialog ref="dialog" class="codex-config-upgrade" aria-labelledby="codex-config-upgrade-title" aria-describedby="codex-config-upgrade-message" @cancel.prevent="dismiss">
    <header>
      <RefreshCcw v-if="stage === 'progress'" class="upgrade-spin" :size="24" />
      <CircleAlert v-else :size="24" />
      <h2 id="codex-config-upgrade-title">{{ title }}</h2>
    </header>
    <p v-if="stage === 'prompt'" id="codex-config-upgrade-message">当前软件版本为 {{ version }}。如需应用新版本中转配置，请前往「已有账号加油」，先点击「关闭加油」，再点击「开始加油」；使用「无账号登录」的用户，先点击「关闭登录」，再点击「开始登录」。使用官方登录的用户无需重新配置。<br><br>「重启 Codex」会同步当前由本软件管理的模型支持配置，再重新打开 Codex；不会改动官方登录状态或其他个人配置。本提醒每个版本只显示一次，也可以稍后手动处理。</p>
    <p v-else-if="stage === 'progress'" id="codex-config-upgrade-message" role="status" aria-live="polite">{{ progress }}，请稍候…</p>
    <p v-else id="codex-config-upgrade-message">{{ resultMessage }}</p>
    <p v-if="error" class="upgrade-error" role="alert">{{ error }}</p>
    <footer v-if="stage === 'prompt'">
      <button type="button" autofocus @click="dismiss">知道了，稍后处理</button>
      <button type="button" class="primary" @click="restartCodex">重启 Codex</button>
    </footer>
    <footer v-else-if="stage !== 'progress'">
      <button type="button" class="primary" @click="dismiss">知道了</button>
    </footer>
  </dialog>
</template>

<style scoped>
.codex-config-upgrade { width: min(520px, calc(100vw - 32px)); box-sizing: border-box; padding: 28px; border: 1px solid #344257; border-radius: 18px; background: #151d29; color: #edf2fa; box-shadow: 0 24px 80px #0008; font-family: inherit; }
.codex-config-upgrade::backdrop { background: #020617b8; backdrop-filter: blur(4px); }
header { display: flex; align-items: center; gap: 12px; color: #60a5fa; }
h2 { margin: 0; color: #edf2fa; font-size: 19px; line-height: 1.5; }
p { margin: 20px 0 0; color: #c5cedd; font-size: 14px; line-height: 1.9; overflow-wrap: anywhere; white-space: pre-line; }
.upgrade-error { color: #fca5a5; }
footer { display: flex; justify-content: flex-end; gap: 12px; margin-top: 26px; flex-wrap: wrap; }
button { padding: 11px 18px; border: 1px solid #475569; border-radius: 9px; background: #233044; color: #edf2fa; font: inherit; font-size: 14px; cursor: pointer; }
button.primary { background: linear-gradient(110deg, #0891b2, #2563eb); border-color: transparent; }
button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 3px; }
.upgrade-spin { animation: upgrade-spin 1.1s linear infinite; }
@keyframes upgrade-spin { to { transform: rotate(360deg); } }
:global([data-theme="light"]) .codex-config-upgrade { background: #fff; color: #0f172a; border-color: #cbd5e1; }
:global([data-theme="light"]) h2 { color: #0f172a; }
:global([data-theme="light"]) p { color: #475569; }
@media (prefers-reduced-motion: reduce) { .upgrade-spin { animation: none; } }
</style>
