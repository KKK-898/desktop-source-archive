<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import * as QRCode from 'qrcode'
import { isConfiguredAccountRelay, readFrontendDeploymentValue } from '../frontend-deployment'
import {
  ArrowUpRight, Check, ChevronDown, Copy, Download, Eye, EyeOff, Globe2, KeyRound,
  Laptop, LoaderCircle, LockKeyhole, MessageSquareText, Power, QrCode,
  RefreshCcw, ShieldCheck, Smartphone, Sparkles, Trash2, Wifi,
} from 'lucide-vue-next'
import {
  hasMobileDesktopRuntime, mobileComponent, mobileConnection, unavailableMobileComponent, unavailableMobileConnection,
  type MobileComponentStatus, type MobileConnectionStatus, type SaveMobileConnectionRequest,
} from '../mobile-connection'

const props = withDefaults(defineProps<{ accountToken?: string }>(), { accountToken: '' })
const desktop = hasMobileDesktopRuntime()
const status = ref<MobileConnectionStatus>(unavailableMobileConnection())
const component = ref<MobileComponentStatus>(unavailableMobileComponent())
const componentLoading = ref(true)
const componentRequest = ref<'check' | 'install' | ''>('')
const componentError = ref('')
const componentAwaitingCompletion = ref(false)
const username = ref('')
const password = ref('')
const relayUrl = ref('')
const enrollmentToken = ref('')
const showPassword = ref(false)
const advancedOpen = ref(false)
const loading = ref(true)
const action = ref('')
const error = ref('')
const notice = ref('')
const qrImage = ref('')
const now = ref(Date.now())
const copied = ref(false)
let initialized = false
let mounted = true
let polling = false
let revision = 0
let qrRevision = 0
let pollTimer: ReturnType<typeof setInterval> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
let copiedTimer: ReturnType<typeof setTimeout> | undefined
let componentTimer: ReturnType<typeof setInterval> | undefined
let componentPolling = false
let componentRevision = 0
let lastComponentPoll = 0
let autoPairPending = false

const componentInstalling = computed(() => componentRequest.value === 'install'
  || (componentAwaitingCompletion.value && component.value.state === 'checking')
  || ['downloading', 'verifying', 'installing'].includes(component.value.state))
const componentChecking = computed(() => componentRequest.value === 'check' || component.value.state === 'checking')
const componentInstalled = computed(() => Boolean(component.value.installedVersion) && component.value.compatible)
const componentReady = computed(() => componentInstalled.value && status.value.runtimeAvailable)
const busy = computed(() => loading.value || Boolean(action.value) || componentInstalling.value)
const running = computed(() => status.value.state === 'running')
const active = computed(() => ['starting', 'running', 'reconnecting'].includes(status.value.state))
const stateLabel = computed(() => {
  if (loading.value) return '正在检查'
  if (!desktop) return '请在桌面端打开'
  if (componentInstalling.value) return '正在安装组件'
  if (!componentReady.value) return componentLoading.value ? '正在检查组件' : '等待安装组件'
  if (!status.value.relayConfigured) return '等待配置'
  return { stopped: '未开启', starting: '正在连接', running: '已开启', reconnecting: '正在重连', error: '连接异常' }[status.value.state]
})
const passwordValid = computed(() => password.value.length >= 12 || (!password.value && status.value.hasPassword))
const loginValid = computed(() => Boolean(username.value.trim()) && username.value.trim().length <= 200 && passwordValid.value)
const relayChanged = computed(() => relayUrl.value.trim().replace(/\/$/, '') !== status.value.relayUrl.replace(/\/$/, ''))
const automaticEnrollment = computed(() => {
  if (!props.accountToken) return false
  try {
    return isConfiguredAccountRelay(relayUrl.value, readFrontendDeploymentValue('VITE_GAOGE_MOBILE_RELAY_URL'))
  } catch {
    return false
  }
})
const serverValid = computed(() => Boolean(relayUrl.value.trim())
  && Boolean(enrollmentToken.value.trim() || (!relayChanged.value && status.value.hasEnrollmentToken) || automaticEnrollment.value))
const canStart = computed(() => desktop && componentReady.value && loginValid.value && serverValid.value && !busy.value)
const secondsLeft = computed(() => Math.max(0, Math.ceil(((status.value.pairing?.expiresAt || 0) - now.value) / 1000)))
const pairingValid = computed(() => running.value && Boolean(status.value.pairing?.url) && secondsLeft.value > 0)
const expiryLabel = computed(() => `${Math.floor(secondsLeft.value / 60)}:${String(secondsLeft.value % 60).padStart(2, '0')}`)
const blocker = computed(() => {
  if (!desktop) return '此处为网页预览。请在 Gaoge Free 桌面软件中开启连接。'
  if (!componentInstalled.value) return ''
  if (!status.value.runtimeAvailable) return '手机连接组件暂时无法启动，请稍后重试。'
  if (!serverValid.value) return '首次使用，请在下方配置手机连接服务。使用默认服务时，软件已登录账号会自动完成接入。'
  if (!status.value.hasPassword) return '设置手机登录的用户名和密码后，即可开启连接。'
  return ''
})
const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err || '操作失败，请重试。')
const connectionError = computed(() => error.value || (componentInstalled.value ? status.value.error : null))
const componentNeedsInstall = computed(() => !componentInstalled.value || component.value.updateAvailable)
const componentCanInstall = computed(() => desktop && !componentLoading.value && !componentInstalling.value
  && !componentChecking.value && !loading.value && !active.value && !action.value && componentNeedsInstall.value)
const componentPlatform = computed(() => {
  const platform = component.value.platform.toLowerCase()
  if (platform.includes('windows')) return '已自动适配 Windows'
  if (platform.includes('macos') || platform.includes('darwin')) return '已自动适配 Mac'
  if (platform.includes('linux')) return '已自动适配 Linux'
  return '自动适配当前电脑'
})
const componentStage = computed(() => {
  if (componentLoading.value) return '正在检查本机组件'
  if (componentRequest.value === 'install' && !['downloading', 'verifying', 'installing'].includes(component.value.state)) return '正在准备下载'
  if (componentChecking.value) return '正在检查可用版本'
  return {
    not_installed: '尚未安装', installed: component.value.updateAvailable ? '有新版本可用' : '组件已就绪',
    checking: '正在检查可用版本', downloading: '正在下载组件', verifying: '正在校验下载文件',
    installing: '正在安装组件', error: componentInstalled.value ? '组件可用，检查或更新未完成' : '组件尚未就绪',
  }[component.value.state]
})
const componentInstallLabel = computed(() => {
  const retry = Boolean(componentError.value || component.value.error)
  if (component.value.installedVersion) return retry ? '重试更新组件' : '更新组件'
  return retry ? '重试下载并安装' : '下载并安装组件'
})
const componentPercent = computed(() => component.value.totalBytes && component.value.totalBytes > 0
  ? Math.min(100, Math.max(0, Math.floor(component.value.downloadBytes / component.value.totalBytes * 100))) : null)
const componentDescription = computed(() => {
  if (componentInstalled.value) return '组件已保存在这台电脑，软件升级后会继续复用。账号、密码和手机授权保持不变。'
  if (component.value.installedVersion) return '当前组件需要更新后才能连接手机。点击更新即可完成，原有连接设置会保留。'
  return '首次使用时下载一次，就能扫码连接本机 Codex。不使用手机连接时，无需下载。'
})

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function acceptComponentStatus(next: MobileComponentStatus) {
  if (!mounted) return
  component.value = next
  if (['downloading', 'verifying', 'installing'].includes(next.state)) componentAwaitingCompletion.value = true
  if (componentAwaitingCompletion.value && next.state === 'installed' && next.installedVersion && next.compatible) {
    componentAwaitingCompletion.value = false
    notice.value = '手机连接组件已准备好，可以开启连接。'
    void refresh()
  } else if (next.state === 'error') {
    componentAwaitingCompletion.value = false
  }
}

async function refreshComponent() {
  if (componentPolling || !mounted) return
  componentPolling = true
  lastComponentPoll = Date.now()
  const requestRevision = componentRevision
  try {
    const next = await mobileComponent.status()
    if (requestRevision === componentRevision) {
      acceptComponentStatus(next)
      if (componentError.value.startsWith('组件状态更新失败')) componentError.value = ''
    }
  } catch (err) {
    if (mounted && requestRevision === componentRevision) componentError.value = `组件状态更新失败：${errorMessage(err)}`
  } finally {
    componentPolling = false
    if (mounted) componentLoading.value = false
  }
}

async function checkComponent() {
  if (!desktop || componentInstalling.value || componentChecking.value || !mounted) return
  componentRevision += 1
  componentRequest.value = 'check'
  componentError.value = ''
  try {
    acceptComponentStatus(await mobileComponent.check())
  } catch (err) {
    if (mounted) componentError.value = `检查更新失败：${errorMessage(err)}`
  } finally {
    if (mounted) componentRequest.value = ''
  }
}

async function installComponent() {
  if (!componentCanInstall.value) return
  componentRevision += 1
  componentRequest.value = 'install'
  componentAwaitingCompletion.value = true
  componentError.value = ''
  notice.value = ''
  try {
    acceptComponentStatus(await mobileComponent.install())
  } catch (err) {
    componentAwaitingCompletion.value = false
    if (mounted) componentError.value = `组件安装未完成：${errorMessage(err)}`
  } finally {
    if (mounted) componentRequest.value = ''
  }
}

function acceptStatus(next: MobileConnectionStatus, syncForm = false) {
  if (!mounted) return
  status.value = next
  if (!initialized || syncForm) {
    username.value = next.username
    relayUrl.value = next.relayUrl
    initialized = true
  }
}

async function refresh() {
  if (polling || action.value || !mounted) return
  polling = true
  const requestRevision = revision
  try {
    const next = await mobileConnection.status()
    if (requestRevision === revision) {
      acceptStatus(next)
      if (!error.value || error.value.startsWith('状态更新失败')) error.value = ''
      if (autoPairPending && next.state === 'running' && !loading.value) {
        autoPairPending = false
        await createPairing()
      }
    }
  } catch (err) {
    if (mounted && requestRevision === revision) error.value = `状态更新失败：${errorMessage(err)}`
  } finally {
    polling = false
    if (mounted) loading.value = false
  }
}

async function perform(name: string, work: () => Promise<void>) {
  if (busy.value) return
  revision += 1
  action.value = name
  error.value = ''
  notice.value = ''
  try {
    await work()
  } catch (err) {
    if (mounted) error.value = errorMessage(err)
  } finally {
    if (mounted) action.value = ''
  }
}

function saveRequest(): SaveMobileConnectionRequest {
  const request: SaveMobileConnectionRequest = { username: username.value.trim(), relayUrl: relayUrl.value.trim() }
  if (password.value) request.password = password.value
  if (enrollmentToken.value.trim()) request.enrollmentToken = enrollmentToken.value.trim()
  if (automaticEnrollment.value && (!status.value.hasEnrollmentToken || relayChanged.value)) request.accountToken = props.accountToken
  return request
}

async function saveSettings(startAfterSave: boolean) {
  await perform(startAfterSave ? 'start' : 'save', async () => {
    autoPairPending = false
    if (!loginValid.value) throw new Error('请输入用户名，并设置至少 12 位的登录密码。')
    if (startAfterSave && !serverValid.value) throw new Error('请先配置手机连接服务。')
    const next = await mobileConnection.save(saveRequest())
    acceptStatus(next, true)
    password.value = ''
    enrollmentToken.value = ''
    showPassword.value = false
    if (next.error) throw new Error(next.error)
    if (startAfterSave) {
      const started = await mobileConnection.start()
      acceptStatus(started)
      if (started.error) throw new Error(started.error)
      if (started.state === 'running') {
        acceptStatus(await mobileConnection.pair())
        notice.value = '连接已开启，使用手机相机扫描二维码即可登录。'
      } else {
        autoPairPending = ['starting', 'reconnecting'].includes(started.state)
        notice.value = '正在连接手机服务，连接成功后可生成二维码。'
      }
    } else {
      notice.value = '设置已保存。'
    }
  })
}

async function stop() {
  await perform('stop', async () => {
    autoPairPending = false
    acceptStatus(await mobileConnection.stop())
    notice.value = '连接已关闭。'
  })
}

async function createPairing() {
  await perform('pair', async () => {
    autoPairPending = false
    const next = await mobileConnection.pair()
    acceptStatus(next)
    if (next.error) throw new Error(next.error)
    if (!next.pairing) throw new Error('二维码暂时无法生成，请稍后重试。')
    notice.value = '已生成新的二维码，之前的二维码已失效。'
  })
}

async function revoke(deviceId: string) {
  await perform(`revoke:${deviceId}`, async () => {
    const next = await mobileConnection.revokeDevice(deviceId)
    acceptStatus(next)
    if (next.error) throw new Error(next.error)
    notice.value = '已移除该手机的登录授权。'
  })
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_'
  const result: string[] = []
  const bytes = new Uint8Array(32)
  const limit = Math.floor(256 / alphabet.length) * alphabet.length
  while (result.length < 20) {
    crypto.getRandomValues(bytes)
    for (const value of bytes) {
      if (value < limit && result.length < 20) result.push(alphabet[value % alphabet.length]!)
    }
  }
  password.value = result.join('')
  showPassword.value = true
  notice.value = '已生成随机密码，请保存设置后使用。'
}

async function copyUrl() {
  if (!status.value.publicUrl) return
  try {
    await navigator.clipboard.writeText(status.value.publicUrl)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 2200)
  } catch {
    error.value = '复制失败，请选中连接网址手动复制。'
  }
}

function lastSeen(timestamp: number) {
  if (!timestamp) return '已授权'
  return `最近使用 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)}`
}

watch(() => status.value.pairing?.url, async (url) => {
  const generation = ++qrRevision
  qrImage.value = ''
  if (!url) return
  try {
    const dataUrl = await QRCode.toDataURL(url, { width: 440, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111827', light: '#ffffff' } })
    if (mounted && generation === qrRevision) qrImage.value = dataUrl
  } catch {
    if (mounted && generation === qrRevision) error.value = '二维码生成失败，请刷新二维码。'
  }
})

onMounted(() => {
  void refresh()
  void refreshComponent().then(() => {
    if (mounted && desktop && !componentInstalling.value) void checkComponent()
  })
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
  componentTimer = setInterval(() => {
    if (desktop && (componentInstalling.value || (document.visibilityState === 'visible' && Date.now() - lastComponentPoll >= 5000))) void refreshComponent()
  }, 1000)
})
onUnmounted(() => {
  mounted = false
  revision += 1
  qrRevision += 1
  componentRevision += 1
  clearInterval(pollTimer)
  clearInterval(clockTimer)
  clearTimeout(copiedTimer)
  clearInterval(componentTimer)
})
</script>

<template>
  <section class="mobile-connection" aria-label="连接手机">
    <header class="mobile-heading">
      <div>
        <span class="mobile-eyebrow">连接手机</span>
        <h1>让手机，接上电脑里的 Codex</h1>
        <p>查看项目与对话、新建聊天、继续发送消息。手机浏览器就能用。</p>
      </div>
      <div class="mobile-header-actions">
        <span class="mobile-status" :class="{ online: running, warning: status.state === 'error' }" role="status"><i />{{ stateLabel }}</span>
        <button v-if="active" class="mobile-button secondary" :disabled="busy" @click="stop"><Power :size="15" />{{ action === 'stop' ? '正在关闭' : '关闭连接' }}</button>
        <button v-else class="mobile-button primary" :disabled="!canStart" @click="saveSettings(true)"><LoaderCircle v-if="action === 'start'" :size="15" class="spin" /><Power v-else :size="15" />{{ action === 'start' ? '正在开启' : '开启连接' }}</button>
      </div>
    </header>

    <div class="mobile-intro">
      <div class="mobile-intro-icon"><Laptop :size="24" /><span><Smartphone :size="15" /></span></div>
      <div class="mobile-intro-copy"><strong>电脑上的工作，随时在手机继续</strong><p>沿用本机 Codex 的登录与模型设置，无需在手机上另外登录 ChatGPT。</p></div>
      <div class="mobile-features"><span><Globe2 :size="14" />Wi-Fi / 手机流量</span><span><MessageSquareText :size="14" />项目与聊天同步</span></div>
    </div>

    <article class="mobile-card mobile-component" :class="{ 'needs-install': !componentInstalled }" aria-label="手机连接组件">
      <div class="mobile-component-top">
        <span class="mobile-component-icon"><ShieldCheck v-if="componentInstalled" :size="23" /><Download v-else :size="23" /></span>
        <div class="mobile-component-copy">
          <div class="mobile-component-title"><h2>手机连接组件</h2><span v-if="component.installedVersion" class="mobile-component-version">v{{ component.installedVersion }}</span></div>
          <p>{{ componentDescription }}</p>
          <div class="mobile-component-meta"><span><Laptop :size="12" />{{ componentPlatform }}</span><span v-if="component.updateAvailable && component.latestVersion">可更新至 v{{ component.latestVersion }}</span><span v-if="componentNeedsInstall && component.totalBytes !== null && component.totalBytes > 0">下载大小 {{ formatBytes(component.totalBytes) }}</span><span v-else-if="!componentInstalled && componentChecking">正在获取下载大小</span></div>
        </div>
        <div class="mobile-component-actions">
          <button v-if="componentNeedsInstall && !componentInstalling" class="mobile-button primary" :disabled="!componentCanInstall" @click="installComponent"><Download :size="14" />{{ componentInstallLabel }}</button>
          <button v-if="!componentInstalling" class="mobile-text-button" :disabled="!desktop || componentLoading || componentChecking" @click="checkComponent"><RefreshCcw :size="13" :class="{ spin: componentChecking }" />{{ componentChecking ? '正在检查' : componentError || component.error ? '重新检查' : '检查更新' }}</button>
          <span v-if="componentInstalling" class="mobile-component-stage"><LoaderCircle :size="15" class="spin" />{{ componentStage }}</span>
          <span v-else-if="componentInstalled && !componentError && !component.error" class="mobile-component-ready"><Check :size="13" />{{ componentChecking ? '已安装，可继续使用' : componentStage }}</span>
        </div>
      </div>
      <div v-if="componentInstalling" class="mobile-component-progress" role="status" aria-live="polite">
        <div class="mobile-component-progress-label"><span>{{ componentStage }}</span><span v-if="component.state === 'downloading'">{{ formatBytes(component.downloadBytes) }}<template v-if="component.totalBytes !== null && component.totalBytes > 0"> / {{ formatBytes(component.totalBytes) }} · {{ componentPercent }}%</template></span><span v-else-if="component.state === 'verifying'">下载完成，正在确认文件完整</span><span v-else-if="component.state === 'installing'">即将完成，请稍候</span></div>
        <progress v-if="component.state === 'downloading'" :value="componentPercent === null ? undefined : componentPercent" max="100" aria-label="手机连接组件下载进度" />
        <p>安装会在后台继续，完成后即可设置手机连接。</p>
      </div>
      <div v-if="componentError || component.error" class="mobile-component-error" role="alert"><span>{{ componentError || component.error }}</span><small v-if="componentInstalled">已安装的组件仍可继续使用。</small></div>
      <p v-if="active && componentNeedsInstall && !componentInstalling" class="mobile-component-hint">请先关闭右上角的手机连接，再更新组件。</p>
      <p v-else-if="!desktop" class="mobile-component-hint">请在 Gaoge Free 桌面软件中下载并安装组件。</p>
    </article>

    <div v-if="connectionError" class="mobile-feedback danger" role="alert">{{ connectionError }}</div>
    <div v-else-if="notice" class="mobile-feedback success" role="status"><Check :size="15" />{{ notice }}</div>
    <div v-else-if="!loading && blocker" class="mobile-feedback info"><ShieldCheck :size="16" /><span>{{ blocker }}</span><button v-if="desktop && !serverValid" @click="advancedOpen = true">配置服务<ArrowUpRight :size="13" /></button></div>

    <div v-if="componentInstalled || active" class="mobile-main-grid">
      <article class="mobile-card login-card">
        <div class="mobile-card-heading"><span class="mobile-step">01</span><div><h2>设置手机登录</h2><p>使用连接网址时，凭此账号密码登录。</p></div><LockKeyhole class="mobile-card-icon" :size="20" /></div>
        <form class="mobile-form" @submit.prevent="saveSettings(false)">
          <label for="mobile-username">用户名</label>
          <div class="mobile-input-wrap"><Smartphone :size="16" /><input id="mobile-username" v-model="username" name="mobile-username" autocomplete="username" maxlength="200" placeholder="设置一个方便记住的用户名" :disabled="busy || !desktop" /></div>
          <div class="mobile-field-label"><label for="mobile-password">登录密码</label><span v-if="status.hasPassword" class="mobile-saved"><ShieldCheck :size="12" />已设置</span></div>
          <div class="mobile-input-wrap"><KeyRound :size="16" /><input id="mobile-password" v-model="password" :type="showPassword ? 'text' : 'password'" name="mobile-password" autocomplete="new-password" minlength="12" maxlength="1000" :placeholder="status.hasPassword ? '留空保留当前密码' : '至少 12 位，建议混合字母与数字'" :disabled="busy || !desktop" /><button type="button" class="mobile-icon-button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" :aria-pressed="showPassword" @click="showPassword = !showPassword"><EyeOff v-if="showPassword" :size="16" /><Eye v-else :size="16" /></button></div>
          <div class="mobile-password-help"><small :class="{ invalid: password.length > 0 && password.length < 12 }">{{ password.length > 0 && password.length < 12 ? `还需 ${12 - password.length} 位字符` : '仅用于手机连接，不是 ChatGPT 账号密码。' }}</small><button type="button" class="mobile-text-button" :disabled="busy || !desktop" @click="generatePassword"><Sparkles :size="13" />随机生成</button></div>
          <div class="mobile-form-actions"><button type="submit" class="mobile-button secondary" :disabled="busy || !desktop || !loginValid"><LoaderCircle v-if="action === 'save'" :size="14" class="spin" />{{ action === 'save' ? '正在保存' : '保存设置' }}</button><button v-if="!active" type="button" class="mobile-button primary" :disabled="!canStart" @click="saveSettings(true)"><Power :size="14" />保存并开启连接</button></div>
        </form>
        <div class="mobile-login-note"><ShieldCheck :size="16" /><p>修改登录信息后，需要重新授权手机。二维码只用于一次登录，请勿公开分享。</p></div>
      </article>

      <article class="mobile-card qr-card">
        <div class="mobile-card-heading"><span class="mobile-step">02</span><div><h2>拿起手机，扫码连接</h2><p>扫码直接登录，也可以复制网址手动登录。</p></div><QrCode class="mobile-card-icon" :size="20" /></div>
        <div class="mobile-qr-layout">
          <div class="mobile-qr-frame" :class="{ ready: pairingValid && qrImage }">
            <img v-if="pairingValid && qrImage" :src="qrImage" alt="手机连接登录二维码" width="184" height="184" />
            <div v-else class="mobile-qr-placeholder"><QrCode :size="58" :stroke-width="1.1" /><strong>{{ !running ? '开启连接后显示二维码' : secondsLeft === 0 && status.pairing ? '二维码已过期' : '生成手机登录二维码' }}</strong><span>{{ !running ? '完成左侧设置，即可开始' : '点击下方按钮获取新的二维码' }}</span></div>
          </div>
          <div class="mobile-qr-instructions"><span class="mobile-device-tag"><Smartphone :size="13" />手机浏览器</span><h3>扫一扫，继续聊</h3><p>打开手机相机扫码，<br />在浏览器中继续操作 Codex。</p><span v-if="pairingValid" class="mobile-expiry"><i />二维码有效期 {{ expiryLabel }}</span><span v-else class="mobile-expiry muted">二维码短时有效，仅可使用一次</span><button class="mobile-text-button" :disabled="busy || !running" @click="createPairing"><RefreshCcw :size="13" :class="{ spin: action === 'pair' }" />{{ action === 'pair' ? '正在生成' : pairingValid ? '刷新二维码' : '生成二维码' }}</button></div>
        </div>
        <div class="mobile-link-area"><label for="mobile-public-url">连接网址 <span>可收藏，下次使用账号密码登录</span></label><div class="mobile-link-row"><input id="mobile-public-url" :value="status.publicUrl || ''" readonly :placeholder="running ? '正在获取连接网址' : '连接开启后生成专属网址'" aria-label="手机连接网址" /><button class="mobile-button secondary" :disabled="!status.publicUrl" @click="copyUrl"><Check v-if="copied" :size="14" /><Copy v-else :size="14" />{{ copied ? '已复制' : '复制网址' }}</button></div></div>
      </article>
    </div>

    <article v-if="componentInstalled || active" class="mobile-card mobile-devices">
      <div class="mobile-devices-heading"><div><Smartphone :size="18" /><h2>已授权的手机</h2><span class="mobile-count">{{ status.devices.length }}</span></div><button class="mobile-text-button" :disabled="busy || !desktop" @click="refresh"><RefreshCcw :size="13" />刷新</button></div>
      <div v-if="!status.devices.length" class="mobile-empty-devices"><div><Smartphone :size="21" /></div><p><strong>还没有手机连接</strong><span>首次扫码或登录后，会在这里显示。你可以随时移除手机的访问权限。</span></p></div>
      <ul v-else class="mobile-device-list"><li v-for="device in status.devices" :key="device.id"><span class="mobile-device-icon"><Smartphone :size="18" /></span><div><strong>{{ device.name || '手机浏览器' }}</strong><span>{{ lastSeen(device.lastSeen) }}</span></div><button class="mobile-text-button remove" :disabled="busy" :aria-label="`移除 ${device.name || '手机浏览器'} 的授权`" @click="revoke(device.id)"><LoaderCircle v-if="action === `revoke:${device.id}`" :size="14" class="spin" /><Trash2 v-else :size="14" />移除</button></li></ul>
    </article>

    <article v-if="componentInstalled || active" class="mobile-card mobile-service" :class="{ expanded: advancedOpen }">
      <button class="mobile-service-toggle" :aria-expanded="advancedOpen" aria-controls="mobile-service-settings" @click="advancedOpen = !advancedOpen"><Globe2 :size="18" /><strong>手机连接服务</strong><span>{{ status.relayConfigured ? '已配置' : '首次使用时配置' }}</span><ChevronDown :size="16" /></button>
      <div v-show="advancedOpen" id="mobile-service-settings" class="mobile-service-body"><p>默认服务使用软件已登录账号自动接入。手机使用流量或其他 Wi-Fi，也能连接这台电脑。</p><div class="mobile-service-fields"><label for="mobile-relay-url">服务地址<input id="mobile-relay-url" v-model="relayUrl" type="url" autocomplete="off" spellcheck="false" placeholder="以 https:// 开头的手机连接服务地址" :disabled="busy || !desktop" /></label><label for="mobile-enrollment-token">设备接入码（可选） <span v-if="status.hasEnrollmentToken && !relayChanged">已保存</span><input id="mobile-enrollment-token" v-model="enrollmentToken" type="password" autocomplete="off" :placeholder="status.hasEnrollmentToken && !relayChanged ? '留空保留已保存的接入信息' : '管理员备用，已登录账号自动接入'" :disabled="busy || !desktop" /></label></div><div class="mobile-service-footer"><small>使用自定义服务时，由管理员提供对应接入码。</small><button class="mobile-button secondary" :disabled="busy || !desktop || !loginValid" @click="saveSettings(false)">保存配置</button></div></div>
    </article>
    <footer class="mobile-footer"><Wifi :size="14" /><span>连接期间，请保持电脑联网，并保持 Gaoge Free 与 Codex 运行。电脑休眠后，手机会暂时无法连接。</span><span class="mobile-codex-only">当前支持 Codex</span></footer>
  </section>
</template>

<style scoped>
.mobile-connection { --m-bg: #fff; --m-subtle: #f8fafc; --m-line: #e5e9f0; --m-text: #162134; --m-muted: #768296; --m-accent: #6756d9; --m-accent-soft: #f1eeff; display: grid; align-content: start; width: 100%; min-width: 0; max-width: 100%; gap: 16px; padding: 4px 2px 20px; color: var(--m-text); }
:global(.mode-dark .mobile-connection) { --m-bg: #1c2129; --m-subtle: #181d25; --m-line: #303744; --m-text: #edf0f7; --m-muted: #94a0b3; --m-accent: #aa9bff; --m-accent-soft: #29243e; }
.mobile-connection * { box-sizing: border-box; }
.mobile-connection button, .mobile-connection input { font: inherit; }
.mobile-connection button { cursor: pointer; }
.mobile-connection button:disabled { opacity: .43; cursor: not-allowed; }
.mobile-connection button:focus-visible, .mobile-connection input:focus-visible { outline: 2px solid var(--m-accent); outline-offset: 3px; }
.mobile-heading { display: flex; gap: 22px; justify-content: space-between; align-items: center; padding: 8px 2px 5px; }
.mobile-eyebrow { font-size: 11px; font-weight: 700; color: var(--m-accent); letter-spacing: .08em; }
.mobile-heading h1 { font-size: 23px; letter-spacing: -.04em; margin: 8px 0; font-weight: 780; }
.mobile-heading p, .mobile-intro p { margin: 0; color: var(--m-muted); font-size: 12px; line-height: 1.65; }
.mobile-header-actions { display: flex; gap: 13px; align-items: center; flex-shrink: 0; }
.mobile-status { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--m-muted); white-space: nowrap; }
.mobile-status i, .mobile-expiry i { width: 6px; height: 6px; background: currentColor; border-radius: 100%; }
.mobile-status.online { color: #22aa81; }
.mobile-status.warning { color: #e59363; }
.mobile-button { min-height: 35px; padding: 0 13px; border: 1px solid transparent; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px !important; font-weight: 650 !important; white-space: nowrap; transition: background .15s; }
.mobile-button.primary { background: #7961e8; color: white; box-shadow: 0 3px 10px #7961e820; }
.mobile-button.primary:hover:not(:disabled) { background: #8974ee; }
.mobile-button.secondary { background: var(--m-bg); border-color: var(--m-line); color: var(--m-text); }
.mobile-button.secondary:hover:not(:disabled) { background: var(--m-subtle); }
.mobile-intro { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border: 1px solid var(--m-line); border-radius: 12px; background: linear-gradient(110deg, var(--m-accent-soft), var(--m-bg) 75%); }
.mobile-intro-icon { position: relative; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--m-bg); color: var(--m-accent); flex-shrink: 0; }
.mobile-intro-icon span { position: absolute; right: -4px; bottom: -3px; background: var(--m-accent-soft); padding: 3px; border: 2px solid var(--m-bg); border-radius: 6px; line-height: 0; }
.mobile-intro-copy strong { display: block; font-size: 13px; margin-bottom: 4px; }
.mobile-features { display: grid; gap: 9px; margin-left: auto; font-size: 11px; color: var(--m-muted); flex-shrink: 0; }
.mobile-features span { display: flex; gap: 6px; align-items: center; }
.mobile-feedback { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 9px; font-size: 12px; line-height: 1.6; border: 1px solid var(--m-line); }
.mobile-feedback > svg { flex-shrink: 0; }
.mobile-feedback.info { background: var(--m-subtle); color: var(--m-muted); }
.mobile-feedback.danger { color: #db725f; background: #d8625010; border-color: #d862502d; }
.mobile-feedback.success { color: #249879; background: #22aa8110; border-color: #22aa812d; }
.mobile-feedback button { display: inline-flex; align-items: center; gap: 3px; margin-left: auto; color: var(--m-accent); background: none; border: 0; white-space: nowrap; }
.mobile-main-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.16fr); gap: 16px; }
.mobile-card { border: 1px solid var(--m-line); border-radius: 12px; background: var(--m-bg); overflow: hidden; }
.mobile-component { padding: 18px 20px; }
.mobile-component.needs-install { border-color: color-mix(in srgb, var(--m-accent) 30%, var(--m-line)); }
.mobile-component-top { display: flex; align-items: center; gap: 14px; }
.mobile-component-icon { width: 42px; height: 42px; border-radius: 11px; display: grid; place-items: center; color: var(--m-accent); background: var(--m-accent-soft); flex-shrink: 0; }
.mobile-component-copy { min-width: 0; flex: 1; }
.mobile-component-title { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.mobile-component-version { font-size: 10px; color: var(--m-muted); border: 1px solid var(--m-line); padding: 2px 6px; border-radius: 5px; overflow-wrap: anywhere; }
.mobile-component-copy p { font-size: 11px; color: var(--m-muted); line-height: 1.7; margin: 7px 0; }
.mobile-component-meta { display: flex; flex-wrap: wrap; gap: 7px 14px; color: var(--m-muted); font-size: 10px; line-height: 1.6; }
.mobile-component-meta > span { display: inline-flex; align-items: center; gap: 4px; }
.mobile-component-actions { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 9px; flex-shrink: 0; }
.mobile-component-stage, .mobile-component-ready { display: inline-flex; align-items: center; gap: 5px; color: var(--m-accent); font-size: 11px; }
.mobile-component-ready { color: #22aa81; }
.mobile-component-progress { display: grid; gap: 9px; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--m-line); }
.mobile-component-progress-label { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 7px; font-size: 11px; }
.mobile-component-progress-label > span:last-child { color: var(--m-muted); }
.mobile-component-progress progress { display: block; appearance: none; width: 100%; height: 7px; border: 0; border-radius: 10px; background: var(--m-accent-soft); overflow: hidden; accent-color: #7961e8; }
.mobile-component-progress progress::-webkit-progress-bar { background: var(--m-accent-soft); }
.mobile-component-progress progress::-webkit-progress-value { background: #7961e8; border-radius: 10px; }
.mobile-component-progress progress::-moz-progress-bar { background: #7961e8; border-radius: 10px; }
.mobile-component-progress p, .mobile-component-hint { margin: 0; color: var(--m-muted); font-size: 10px; line-height: 1.7; }
.mobile-component-hint { margin-top: 12px; }
.mobile-component-error { display: grid; gap: 4px; padding: 10px 12px; margin-top: 14px; border-radius: 8px; background: #d8625010; color: #db725f; font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.mobile-component-error small { color: var(--m-muted); font-size: 10px; }
.login-card, .qr-card { padding: 21px; }
.mobile-card-heading { display: flex; align-items: center; gap: 11px; margin-bottom: 24px; }
.mobile-step { width: 29px; height: 29px; display: grid; place-items: center; border-radius: 8px; background: var(--m-accent-soft); color: var(--m-accent); font: 700 11px ui-monospace, monospace; }
.mobile-card h2 { margin: 0; font-size: 14px; font-weight: 730; }
.mobile-card-heading p { margin: 5px 0 0; font-size: 11px; color: var(--m-muted); }
.mobile-card-icon { margin-left: auto; color: var(--m-muted); opacity: .7; }
.mobile-form { display: grid; gap: 8px; }
.mobile-form label { font-size: 12px; font-weight: 600; }
.mobile-input-wrap { display: flex; align-items: center; gap: 9px; min-height: 41px; padding: 0 11px; background: var(--m-subtle); border: 1px solid var(--m-line); border-radius: 8px; color: var(--m-muted); }
.mobile-input-wrap:focus-within { border-color: var(--m-accent); }
.mobile-input-wrap > svg { flex-shrink: 0; }
.mobile-input-wrap input { width: 100%; min-width: 0; border: 0; outline: none !important; background: none; font-size: 12px; color: var(--m-text); padding: 10px 0; }
.mobile-connection input::placeholder { color: var(--m-muted); opacity: .8; }
.mobile-field-label { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.mobile-saved { display: flex; align-items: center; gap: 4px; color: #22aa81; font-size: 10px; }
.mobile-icon-button { display: grid; place-items: center; border: 0; padding: 3px; background: none; color: var(--m-muted); }
.mobile-password-help { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.mobile-password-help small { color: var(--m-muted); font-size: 10px; line-height: 1.5; }
.mobile-password-help small.invalid { color: #dc8c61; }
.mobile-text-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; padding: 3px 0; border: 0; background: none; color: var(--m-accent); font-size: 11px !important; white-space: nowrap; }
.mobile-form-actions { margin-top: 19px; display: flex; gap: 9px; }
.mobile-form-actions .primary { flex: 1; }
.mobile-login-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 25px; padding-top: 15px; border-top: 1px solid var(--m-line); color: var(--m-muted); }
.mobile-login-note svg { flex-shrink: 0; margin-top: 2px; }
.mobile-login-note p { font-size: 10px; line-height: 1.7; margin: 0; }
.mobile-qr-layout { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.mobile-qr-frame { width: 184px; height: 184px; flex-shrink: 0; border: 1px dashed var(--m-line); background: var(--m-subtle); border-radius: 10px; display: grid; place-items: center; overflow: hidden; }
.mobile-qr-frame.ready { border: 1px solid var(--m-line); background: white; }
.mobile-qr-frame img { width: 100%; height: 100%; object-fit: contain; }
.mobile-qr-placeholder { display: grid; justify-items: center; gap: 11px; text-align: center; color: var(--m-muted); }
.mobile-qr-placeholder > svg { opacity: .28; }
.mobile-qr-placeholder strong { font-size: 11px; font-weight: 500; }
.mobile-qr-placeholder span { font-size: 9px; opacity: .75; }
.mobile-qr-instructions { display: flex; flex-direction: column; align-items: flex-start; gap: 9px; min-width: 0; }
.mobile-device-tag { display: flex; align-items: center; gap: 5px; background: var(--m-accent-soft); color: var(--m-accent); border-radius: 5px; padding: 4px 7px; font-size: 9px; }
.mobile-qr-instructions h3 { font-size: 17px; margin: 3px 0 0; letter-spacing: -.03em; }
.mobile-qr-instructions p { font-size: 11px; line-height: 1.8; color: var(--m-muted); margin: 0; }
.mobile-expiry { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #22aa81; margin-top: 2px; }
.mobile-expiry.muted { color: var(--m-muted); font-size: 9px; }
.mobile-link-area { margin-top: 20px; padding-top: 17px; border-top: 1px solid var(--m-line); }
.mobile-link-area > label { display: flex; align-items: center; gap: 10px; font-size: 11px; font-weight: 600; margin-bottom: 9px; }
.mobile-link-area label span { font-size: 9px; color: var(--m-muted); font-weight: 400; }
.mobile-link-row { display: flex; gap: 7px; }
.mobile-link-row input { min-width: 0; width: 100%; background: var(--m-subtle); border: 1px solid var(--m-line); border-radius: 7px; color: var(--m-text); padding: 0 10px; font-size: 11px; text-overflow: ellipsis; }
.mobile-devices { padding: 17px 20px; }
.mobile-devices-heading, .mobile-devices-heading > div { display: flex; align-items: center; gap: 8px; }
.mobile-devices-heading > .mobile-text-button { margin-left: auto; color: var(--m-muted); }
.mobile-devices-heading > div > svg { color: var(--m-muted); }
.mobile-devices h2 { font-size: 12px; }
.mobile-count { border-radius: 5px; padding: 1px 6px; font-size: 10px; color: var(--m-muted); background: var(--m-subtle); border: 1px solid var(--m-line); }
.mobile-empty-devices { display: flex; align-items: center; gap: 12px; margin-top: 17px; padding: 12px 14px; border-radius: 8px; background: var(--m-subtle); color: var(--m-muted); }
.mobile-empty-devices > div { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--m-line); border-radius: 9px; flex-shrink: 0; }
.mobile-empty-devices p { display: grid; gap: 5px; margin: 0; }
.mobile-empty-devices strong { font-size: 11px; font-weight: 500; color: var(--m-text); }
.mobile-empty-devices span { font-size: 10px; }
.mobile-device-list { list-style: none; padding: 0; margin: 9px 0 0; }
.mobile-device-list li { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-top: 1px solid var(--m-line); }
.mobile-device-list li:first-child { border-top: none; }
.mobile-device-icon { display: grid; place-items: center; height: 34px; width: 34px; border-radius: 8px; background: var(--m-accent-soft); color: var(--m-accent); }
.mobile-device-list li > div { display: grid; gap: 5px; }
.mobile-device-list strong { font-size: 11px; font-weight: 600; }
.mobile-device-list li > div > span { color: var(--m-muted); font-size: 10px; }
.mobile-device-list .remove { margin-left: auto; color: var(--m-muted); }
.mobile-device-list .remove:hover { color: #e28b80; }
.mobile-service-toggle { display: flex; width: 100%; align-items: center; gap: 10px; background: none; border: 0; padding: 17px 20px; text-align: left; color: var(--m-muted); }
.mobile-service-toggle strong { color: var(--m-text); font-size: 12px; font-weight: 600; }
.mobile-service-toggle span { font-size: 10px; margin-left: auto; }
.mobile-service-toggle > svg:last-child { transition: transform .2s; }
.mobile-service.expanded .mobile-service-toggle > svg:last-child { transform: rotate(180deg); }
.mobile-service-body { border-top: 1px solid var(--m-line); padding: 17px 20px; }
.mobile-service-body p { font-size: 11px; color: var(--m-muted); margin: 0 0 16px; line-height: 1.6; }
.mobile-service-fields { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; }
.mobile-service-fields label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; }
.mobile-service-fields label span { color: #22aa81; font-size: 10px; }
.mobile-service-fields input { display: block; width: 100%; height: 38px; padding: 0 10px; border: 1px solid var(--m-line); border-radius: 7px; background: var(--m-subtle); color: var(--m-text); font-size: 11px; }
.mobile-service-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.mobile-service-footer small { font-size: 10px; color: var(--m-muted); line-height: 1.6; }
.mobile-footer { display: flex; align-items: flex-start; gap: 7px; padding: 0 3px; color: var(--m-muted); font-size: 10px; line-height: 1.7; }
.mobile-footer > svg { flex-shrink: 0; margin-top: 2px; }
.mobile-codex-only { margin-left: auto; white-space: nowrap; color: var(--m-accent); }
.spin { animation: mobile-spin 1s linear infinite; }
@keyframes mobile-spin { to { transform: rotate(360deg); } }
@media (max-width: 1120px) { .mobile-main-grid { grid-template-columns: 1fr 1.15fr; } .login-card, .qr-card { padding: 17px; } .mobile-qr-layout { gap: 14px; } .mobile-qr-frame { width: 160px; height: 160px; } .mobile-heading h1 { font-size: 21px; } }
@media (max-width: 850px) { .mobile-main-grid { grid-template-columns: 1fr; } .mobile-heading { align-items: flex-start; flex-direction: column; gap: 12px; } .mobile-header-actions { width: 100%; justify-content: space-between; } .mobile-features { display: none; } .mobile-component-top { align-items: flex-start; flex-wrap: wrap; } .mobile-component-copy { flex-basis: calc(100% - 56px); } .mobile-component-actions { width: 100%; flex-direction: row; justify-content: flex-start; flex-wrap: wrap; padding-left: 56px; } .mobile-qr-layout { justify-content: flex-start; gap: 30px; } .mobile-qr-frame { width: 184px; height: 184px; } .mobile-service-fields { grid-template-columns: 1fr; } .mobile-codex-only { display: none; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } .mobile-connection * { transition: none !important; } }
</style>
