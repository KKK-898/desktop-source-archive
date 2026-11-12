<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Download,
  KeyRound,
  Layers3,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Monitor,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
} from 'lucide-vue-next'
import gaogeLogo from '../assets/new-theme-gaoge-logo.png'
import {
  getPublicRegistrationSettings,
  inspectAffiliateInviteToken,
  registerWithPassword,
  sendRegistrationVerifyCode,
  type PublicRegistrationSettings,
} from '../api'
import { getDownloadBaseUrl } from '../domain-config'
import TurnstileWidget from './TurnstileWidget.vue'

type PageState = 'checking' | 'ready' | 'submitting' | 'success' | 'invalid'
type PlatformId = 'windows' | 'macos' | 'linux'

interface DownloadPackage {
  id: PlatformId
  eyebrow: string
  title: string
  detail: string
  url: string
  icon: typeof Monitor
}

interface RegistrationMarker {
  email?: string
  createdAt?: number
}

const DEFAULT_DOWNLOAD_BASE_URL = ''
const SUCCESS_MARKER_TTL = 30 * 24 * 60 * 60 * 1000

const previewParams = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search)
const invitationPreviewMode = import.meta.env.DEV && previewParams?.get('preview') === 'invitation-register'
const previewStage = previewParams?.get('stage') || ''
const referralToken = readReferralToken()
const pageState = ref<PageState>('checking')
const settings = ref<PublicRegistrationSettings>({})
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const verifyCode = ref('')
const turnstileToken = ref('')
const formError = ref('')
const verificationError = ref('')
const verificationCountdown = ref(0)
const isSendingCode = ref(false)
const registeredEmail = ref('')
const turnstile = ref<InstanceType<typeof TurnstileWidget> | null>(null)
const preferredPlatform = detectPlatform()
let countdownTimer: number | null = null

const downloadBaseUrl = computed(() => (
  String(getDownloadBaseUrl() || DEFAULT_DOWNLOAD_BASE_URL).replace(/\/+$/, '')
))
const emailVerificationEnabled = computed(() => Boolean(settings.value.email_verify_enabled))
const turnstileEnabled = computed(() => Boolean(
  settings.value.turnstile_enabled && settings.value.turnstile_site_key,
))
const registrationDisabled = computed(() => settings.value.registration_enabled === false)
const canSubmit = computed(() => (
  pageState.value === 'ready'
  && !registrationDisabled.value
  && email.value.trim().length > 0
  && password.value.length >= 6
  && confirmPassword.value.length >= 6
  && (!emailVerificationEnabled.value || verifyCode.value.trim().length > 0)
  && (!turnstileEnabled.value || turnstileToken.value.length > 0)
))
const maskedRegisteredEmail = computed(() => maskEmail(registeredEmail.value))

const downloadPackages = computed<DownloadPackage[]>(() => [
  {
    id: 'windows',
    eyebrow: 'Windows 10 / 11',
    title: 'Windows 安装包',
    detail: '适合大多数电脑，下载后按提示完成安装。',
    url: downloadBaseUrl.value ? `${downloadBaseUrl.value}/win/Gaoge-Free-latest-windows-x64-setup.exe` : '',
    icon: Monitor,
  },
  {
    id: 'macos',
    eyebrow: 'Apple 芯片与 Intel',
    title: 'macOS 安装包',
    detail: '通用 DMG 安装包，下载后拖入“应用程序”。',
    url: downloadBaseUrl.value ? `${downloadBaseUrl.value}/mac/Gaoge-Free-latest-macos-universal.dmg` : '',
    icon: Laptop,
  },
  {
    id: 'linux',
    eyebrow: 'Linux 桌面系统',
    title: 'Linux 安装包',
    detail: 'AppImage 版本，赋予执行权限后即可运行。',
    url: downloadBaseUrl.value ? `${downloadBaseUrl.value}/linux/Gaoge-Free-latest-linux-x86_64.AppImage` : '',
    icon: Terminal,
  },
])

function readReferralToken() {
  if (typeof window === 'undefined') return ''
  const value = new URLSearchParams(window.location.search).get('t')
  if (typeof value === 'string' && value.trim()) return value.trim()
  return invitationPreviewMode ? 'local-preview-signed-invitation-token' : ''
}

function markerKey() {
  let hash = 2166136261
  for (let index = 0; index < referralToken.length; index += 1) {
    hash ^= referralToken.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `gaoge_invite_registration_success_v1:${(hash >>> 0).toString(36)}`
}

function readRegistrationMarker(): RegistrationMarker | null {
  if (!referralToken) return null
  try {
    const raw = window.localStorage.getItem(markerKey())
    if (!raw) return null
    const marker = JSON.parse(raw) as RegistrationMarker
    if (!marker.createdAt || Date.now() - marker.createdAt > SUCCESS_MARKER_TTL) {
      window.localStorage.removeItem(markerKey())
      return null
    }
    return marker
  } catch {
    return null
  }
}

function saveRegistrationMarker() {
  try {
    window.localStorage.setItem(markerKey(), JSON.stringify({
      email: email.value.trim().toLowerCase(),
      createdAt: Date.now(),
    }))
  } catch {
    // Storage restrictions must not turn a successful registration into an error.
  }
}

function maskEmail(value: string) {
  const [name, domain] = value.split('@')
  if (!name || !domain) return value
  if (name.length <= 2) return `${name.slice(0, 1)}***@${domain}`
  return `${name.slice(0, 2)}***${name.slice(-1)}@${domain}`
}

function detectPlatform(): PlatformId | null {
  if (typeof navigator === 'undefined') return 'windows'
  const source = `${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase()
  if (/android|iphone|ipad|ipod/.test(source)) return null
  if (source.includes('mac')) return 'macos'
  if (source.includes('linux')) return 'linux'
  return 'windows'
}

function errorMessage(error: unknown, fallback: string) {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : ''
  if (/EMAIL_EXISTS/i.test(message) || /email already exists/i.test(message)) return '这个邮箱已经注册过，请直接下载软件并登录。'
  if (/INVITE_TOKEN|invitation link|affiliate invitation/i.test(message)) return '邀请链接无效或已过期，请让邀请人重新分享。'
  if (/verification/i.test(message)) return '邮箱验证码不正确或已过期，请重新获取。'
  if (/registration.*disabled/i.test(message)) return '当前暂未开放注册，请稍后再试。'
  return message || fallback
}

async function initializePage() {
  document.title = '官方邀请注册 | Gaoge Free'
  if (invitationPreviewMode) {
    settings.value = {
      registration_enabled: true,
      email_verify_enabled: false,
      turnstile_enabled: false,
    }
    if (previewStage === 'download') {
      registeredEmail.value = 'preview@example.com'
      pageState.value = 'success'
    } else {
      pageState.value = 'ready'
    }
    return
  }
  if (!referralToken || referralToken.length > 8192) {
    formError.value = '邀请链接缺少有效凭证，请让邀请人重新分享。'
    pageState.value = 'invalid'
    return
  }

  const marker = readRegistrationMarker()
  if (marker) {
    registeredEmail.value = String(marker.email || '')
    pageState.value = 'success'
    return
  }

  try {
    const [inviteResult, publicSettings] = await Promise.all([
      inspectAffiliateInviteToken(referralToken),
      getPublicRegistrationSettings(),
    ])
    if (!inviteResult.valid || !inviteResult.inviter_locked) throw new Error('Invalid invitation link')
    settings.value = publicSettings || {}
    if (registrationDisabled.value) {
      formError.value = '当前暂未开放注册，请稍后再试。'
    }
    pageState.value = 'ready'
  } catch (error) {
    formError.value = errorMessage(error, '邀请链接暂时无法验证，请稍后重试。')
    pageState.value = 'invalid'
  }
}

function validateForm() {
  formError.value = ''
  const normalizedEmail = email.value.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    formError.value = '请输入正确的邮箱地址。'
    return false
  }
  if (password.value.length < 6) {
    formError.value = '密码至少需要 6 位。'
    return false
  }
  if (password.value !== confirmPassword.value) {
    formError.value = '两次输入的密码不一致。'
    return false
  }
  if (emailVerificationEnabled.value && !verifyCode.value.trim()) {
    formError.value = '请输入邮箱验证码。'
    return false
  }
  if (turnstileEnabled.value && !turnstileToken.value) {
    formError.value = '请先完成安全验证。'
    return false
  }
  return true
}

async function submitRegistration() {
  if (!validateForm()) return
  pageState.value = 'submitting'
  try {
    if (!invitationPreviewMode) {
      await registerWithPassword({
        email: email.value.trim().toLowerCase(),
        password: password.value,
        verify_code: emailVerificationEnabled.value ? verifyCode.value.trim() : undefined,
        turnstile_token: turnstileEnabled.value ? turnstileToken.value : undefined,
        referral_token: referralToken,
      })
    }
    registeredEmail.value = email.value.trim().toLowerCase()
    saveRegistrationMarker()
    password.value = ''
    confirmPassword.value = ''
    verifyCode.value = ''
    pageState.value = 'success'
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (error) {
    formError.value = errorMessage(error, '注册失败，请稍后再试。')
    turnstileToken.value = ''
    turnstile.value?.reset()
    pageState.value = 'ready'
  }
}

function startCountdown(seconds: number) {
  verificationCountdown.value = Math.max(1, seconds)
  if (countdownTimer !== null) window.clearInterval(countdownTimer)
  countdownTimer = window.setInterval(() => {
    verificationCountdown.value -= 1
    if (verificationCountdown.value <= 0 && countdownTimer !== null) {
      window.clearInterval(countdownTimer)
      countdownTimer = null
    }
  }, 1000)
}

async function sendVerifyCode() {
  verificationError.value = ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) {
    verificationError.value = '请先输入正确的邮箱。'
    return
  }
  if (turnstileEnabled.value && !turnstileToken.value) {
    verificationError.value = '请先完成安全验证。'
    return
  }
  isSendingCode.value = true
  try {
    const result = await sendRegistrationVerifyCode(email.value.trim(), turnstileToken.value)
    startCountdown(Number(result.countdown) || 60)
  } catch (error) {
    verificationError.value = errorMessage(error, '验证码发送失败，请稍后再试。')
  } finally {
    isSendingCode.value = false
  }
}

onMounted(() => {
  void initializePage()
})

onUnmounted(() => {
  if (countdownTimer !== null) window.clearInterval(countdownTimer)
})
</script>

<template>
  <div class="invite-page">
    <div class="invite-backdrop" aria-hidden="true">
      <span class="glow glow-one" />
      <span class="glow glow-two" />
      <span class="grid-mask" />
    </div>

    <header class="invite-nav">
      <div class="brand" aria-label="Gaoge Free 官方邀请注册">
        <img :src="gaogeLogo" alt="" />
        <span>
          <strong>Gaoge Free</strong>
          <small>官方邀请注册</small>
        </span>
      </div>
      <div class="official-channel">
        <span />
        OFFICIAL INVITATION
      </div>
    </header>

    <main class="invite-main">
      <section v-if="pageState !== 'success'" class="invite-hero">
        <div class="hero-copy">
          <div class="brand-eyebrow">
            <Sparkles :size="15" />
            GAOGE INTELLIGENCE
          </div>
          <h1 class="hero-title" aria-label="让智能，融入每一次创造">
            <span class="title-lead">
              <span class="title-word">让智能</span>
              <i>，</i>
              <span class="title-word title-word-delay">融入</span>
            </span>
            <em class="title-creation" data-text="每一次创造">每一次创造</em>
          </h1>
          <div class="title-energy" aria-hidden="true">
            <span />
            <i />
          </div>
          <p class="hero-description">
            统一连接模型、工具与工作流，以稳定流畅的智能服务，
            为创作、协作与效率带来全新的可能。
          </p>

          <div class="intelligence-stage" aria-hidden="true">
            <span class="stage-grid" />
            <span class="stage-scan" />
            <span class="ambient-orb ambient-one" />
            <span class="ambient-orb ambient-two" />
            <span class="orbit orbit-outer">
              <i class="orbit-node node-a" />
              <i class="orbit-node node-b" />
            </span>
            <span class="orbit orbit-inner">
              <i class="orbit-node node-c" />
            </span>
            <span class="data-line line-one" />
            <span class="data-line line-two" />
            <span class="data-line line-three" />

            <div class="intelligence-core">
              <span class="core-halo" />
              <span class="core-logo">
                <img :src="gaogeLogo" alt="" />
              </span>
              <span class="core-copy">
                <strong>GAOGE</strong>
                <small>INTELLIGENCE CORE</small>
              </span>
            </div>

            <div class="signal-card signal-model">
              <span class="signal-icon"><Layers3 :size="15" /></span>
              <span><strong>多模型协同</strong><small>MULTI-MODEL</small></span>
            </div>
            <div class="signal-card signal-flow">
              <span class="signal-icon"><Workflow :size="15" /></span>
              <span><strong>智能工作流</strong><small>SMART FLOW</small></span>
            </div>
            <div class="signal-card signal-secure">
              <span class="signal-icon"><ShieldCheck :size="15" /></span>
              <span><strong>安全连接</strong><small>SECURE LINK</small></span>
            </div>
          </div>

          <div class="capability-strip">
            <span><i />统一账户体系</span>
            <span><i />全平台客户端</span>
            <span><i />持续稳定服务</span>
          </div>
        </div>

        <aside class="register-card">
          <div v-if="pageState === 'checking'" class="state-panel">
            <LoaderCircle class="spin" :size="32" />
            <strong>正在验证专属邀请资格</strong>
            <span>系统正在确认邀请凭证，请稍候。</span>
          </div>

          <div v-else-if="pageState === 'invalid'" class="state-panel is-error">
            <LockKeyhole :size="34" />
            <strong>邀请凭证验证失败</strong>
            <span>{{ formError }}</span>
            <button type="button" @click="initializePage">
              <RefreshCcw :size="16" />
              重新验证
            </button>
          </div>

          <form v-else class="register-form" @submit.prevent="submitRegistration">
            <div class="card-heading">
              <span><BadgeCheck :size="22" /></span>
              <div>
                <small>官方邀请资格已确认</small>
                <strong>创建 Gaoge Free 账户</strong>
              </div>
            </div>

            <div class="locked-inviter">
              <LockKeyhole :size="15" />
              <span>邀请关系已由系统安全确认，账户创建后自动生效</span>
            </div>

            <label>
              <span>登录邮箱</span>
              <div class="input-shell">
                <Mail :size="17" />
                <input v-model.trim="email" type="email" autocomplete="email" placeholder="请输入常用邮箱地址" required />
              </div>
            </label>

            <label>
              <span>设置登录密码</span>
              <div class="input-shell">
                <KeyRound :size="17" />
                <input v-model="password" type="password" autocomplete="new-password" minlength="6" placeholder="请设置至少 6 位密码" required />
              </div>
            </label>

            <label>
              <span>确认登录密码</span>
              <div class="input-shell">
                <KeyRound :size="17" />
                <input v-model="confirmPassword" type="password" autocomplete="new-password" minlength="6" placeholder="请再次输入登录密码" required />
              </div>
            </label>

            <label v-if="emailVerificationEnabled">
              <span>邮箱验证码</span>
              <div class="verify-row">
                <div class="input-shell">
                  <ShieldCheck :size="17" />
                  <input v-model.trim="verifyCode" inputmode="numeric" autocomplete="one-time-code" placeholder="输入验证码" required />
                </div>
                <button
                  type="button"
                  :disabled="isSendingCode || verificationCountdown > 0"
                  @click="sendVerifyCode"
                >
                  {{ verificationCountdown > 0 ? `${verificationCountdown}s` : isSendingCode ? '发送中' : '获取验证码' }}
                </button>
              </div>
              <small v-if="verificationError" class="field-error">{{ verificationError }}</small>
            </label>

            <TurnstileWidget
              v-if="turnstileEnabled"
              ref="turnstile"
              :site-key="settings.turnstile_site_key || ''"
              @verify="turnstileToken = $event"
              @expire="turnstileToken = ''"
              @error="formError = '安全验证加载失败，请刷新页面重试。'"
            />

            <p v-if="formError" class="form-error">{{ formError }}</p>

            <button class="submit-button" type="submit" :disabled="!canSubmit">
              <LoaderCircle v-if="pageState === 'submitting'" class="spin" :size="18" />
              <span>{{ pageState === 'submitting' ? '正在创建账户…' : '完成账户注册' }}</span>
              <ArrowRight v-if="pageState !== 'submitting'" :size="18" />
            </button>

            <p class="privacy-note">
              账户用于 Gaoge Free 客户端登录，请妥善保管登录凭证。
            </p>
          </form>
        </aside>
      </section>

      <section v-else class="success-section">
        <div class="success-hero">
          <span class="success-icon"><CheckCircle2 :size="35" /></span>
          <div>
            <small>账户创建完成 · 邀请关系已生效</small>
            <h1>下载 Gaoge Free 客户端</h1>
            <p>
              账户 <strong>{{ maskedRegisteredEmail }}</strong> 已创建。
              安装完成后，请使用该账户登录客户端。
            </p>
          </div>
        </div>

        <div class="download-grid">
          <article
            v-for="item in downloadPackages"
            :key="item.id"
            :class="['download-card', { 'is-recommended': item.id === preferredPlatform }]"
          >
            <span v-if="item.id === preferredPlatform" class="recommended-badge">当前设备推荐</span>
            <span :class="['platform-icon', `platform-${item.id}`]">
              <component :is="item.icon" :size="29" />
            </span>
            <small>{{ item.eyebrow }}</small>
            <h2>{{ item.title }}</h2>
            <p>{{ item.detail }}</p>
            <a v-if="item.url" :href="item.url">
              <Download :size="18" />
              下载最新版
            </a>
            <span v-else>暂未配置下载地址</span>
          </article>
        </div>

        <div class="login-reminder">
          <LockKeyhole :size="18" />
          <span>首次打开客户端后，请使用刚创建的邮箱账户与密码登录。</span>
        </div>
      </section>
    </main>

    <footer class="invite-footer">
      <span>© {{ new Date().getFullYear() }} Gaoge Free</span>
      <span>智能连接 · 安全可靠 · 持续进化</span>
    </footer>
  </div>
</template>

<style scoped>
.invite-page {
  position: relative;
  z-index: 0;
  width: 100%;
  min-height: 100vh;
  min-height: 100dvh;
  overflow-x: hidden;
  color: #eef4ff;
  background:
    radial-gradient(circle at 12% 12%, rgba(29, 78, 216, 0.2), transparent 32rem),
    radial-gradient(circle at 84% 46%, rgba(8, 145, 178, 0.1), transparent 30rem),
    linear-gradient(145deg, #07101d 0%, #091321 48%, #060c15 100%);
}

.invite-page::before {
  position: fixed;
  z-index: -1;
  inset: 0;
  opacity: 0.34;
  background:
    linear-gradient(115deg, transparent 24%, rgba(56, 189, 248, 0.035) 42%, transparent 58%),
    radial-gradient(ellipse at 50% -18%, rgba(96, 165, 250, 0.1), transparent 58%);
  content: "";
  pointer-events: none;
  animation: page-ambient 12s ease-in-out infinite alternate;
}

.invite-backdrop {
  position: fixed;
  z-index: -1;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.glow {
  position: absolute;
  display: block;
  border-radius: 999px;
  filter: blur(12px);
}

.glow-one {
  top: -7rem;
  left: -8rem;
  width: 34rem;
  height: 34rem;
  background: radial-gradient(circle, rgba(37, 99, 235, 0.25), transparent 70%);
  animation: ambient-drift 14s ease-in-out infinite alternate;
}

.glow-two {
  top: 18rem;
  right: -12rem;
  width: 38rem;
  height: 38rem;
  background: radial-gradient(circle, rgba(8, 145, 178, 0.18), transparent 70%);
  animation: ambient-drift 17s ease-in-out 1.5s infinite alternate-reverse;
}

.grid-mask {
  position: absolute;
  inset: 0;
  opacity: 0.08;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.22) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.22) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: linear-gradient(to bottom, black, transparent 76%);
}

.invite-nav,
.invite-main,
.invite-footer {
  width: min(1160px, calc(100% - 48px));
  margin-inline: auto;
}

.invite-nav {
  display: flex;
  min-height: 80px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(148, 163, 184, 0.14);
}

.brand {
  display: inline-flex;
  align-items: center;
  color: inherit;
}

.brand img {
  width: 42px;
  height: 42px;
  margin-right: 12px;
  border: 1px solid rgba(245, 158, 11, 0.26);
  border-radius: 13px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
}

.brand span {
  display: grid;
}

.brand strong {
  font-size: 15px;
}

.brand small {
  color: #8292aa;
  font-size: 11px;
  letter-spacing: 0.08em;
}

.official-channel {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: #657894;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.18em;
}

.official-channel span {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #22d3ee;
  box-shadow: 0 0 0 4px rgba(34, 211, 238, 0.08), 0 0 18px rgba(34, 211, 238, 0.82);
  animation: status-pulse 2.2s ease-in-out infinite;
}

.invite-main {
  display: grid;
  min-height: calc(100vh - 152px);
  min-height: calc(100dvh - 152px);
  align-items: center;
  padding: 42px 0 54px;
}

.invite-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(385px, 0.7fr);
  gap: clamp(42px, 5.5vw, 74px);
  align-items: center;
}

.hero-copy {
  position: relative;
  min-width: 0;
}

.brand-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 7px 12px;
  border: 1px solid rgba(125, 211, 252, 0.19);
  border-radius: 999px;
  color: #9edff1;
  background: linear-gradient(90deg, rgba(8, 145, 178, 0.1), rgba(37, 99, 235, 0.07));
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.03);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.15em;
}

.hero-title {
  position: relative;
  z-index: 2;
  margin: 21px 0 0;
  font-family: "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif;
  font-size: clamp(48px, 5.15vw, 68px);
  line-height: 0.98;
  isolation: isolate;
}

.title-lead {
  display: flex;
  align-items: baseline;
  color: #edf4ff;
  font-size: 0.7em;
  font-weight: 560;
  letter-spacing: 0.025em;
  line-height: 1.2;
  text-shadow: 0 10px 34px rgba(30, 64, 175, 0.2);
  animation: title-lead-in 0.82s cubic-bezier(0.2, 0.82, 0.25, 1) both;
}

.title-lead i {
  margin-inline: -0.06em 0.02em;
  color: #7f98b9;
  font-style: normal;
  font-weight: 360;
}

.title-word {
  display: inline-block;
  animation: title-word-breathe 7s ease-in-out 1.3s infinite;
}

.title-word-delay {
  animation-delay: 2.1s;
}

.title-creation {
  position: relative;
  display: block;
  width: fit-content;
  margin-top: 5px;
  color: transparent;
  background:
    linear-gradient(
      105deg,
      #d8e7ff 0%,
      #91baff 18%,
      #55d9f5 42%,
      #7d9cff 67%,
      #c19bff 83%,
      #d8e7ff 100%
    );
  background-clip: text;
  background-size: 230% 100%;
  filter: drop-shadow(0 12px 30px rgba(34, 211, 238, 0.12));
  font-size: 1em;
  font-style: normal;
  font-weight: 720;
  letter-spacing: -0.045em;
  line-height: 1.08;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation:
    title-creation-in 1.05s cubic-bezier(0.16, 0.88, 0.2, 1) 0.08s both,
    title-gradient-flow 7.5s ease-in-out 1.2s infinite;
}

.title-creation::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  color: transparent;
  content: attr(data-text);
  opacity: 0.28;
  transform: translate(3px, 7px);
  -webkit-text-stroke: 1px rgba(92, 155, 255, 0.36);
  -webkit-text-fill-color: transparent;
  filter: blur(0.4px);
}

.title-creation::after {
  position: absolute;
  inset: 0;
  color: transparent;
  background: linear-gradient(
    100deg,
    transparent 0%,
    transparent 38%,
    rgba(255, 255, 255, 0.95) 49%,
    rgba(165, 243, 252, 0.88) 53%,
    transparent 64%,
    transparent 100%
  );
  background-clip: text;
  background-size: 260% 100%;
  content: attr(data-text);
  opacity: 0.62;
  pointer-events: none;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: title-shine 6.8s ease-in-out 1.8s infinite;
}

.title-energy {
  position: relative;
  width: min(82%, 465px);
  height: 13px;
  margin: 10px 0 8px;
  overflow: hidden;
  opacity: 0;
  animation: energy-line-in 0.8s ease-out 0.6s forwards;
}

.title-energy::before {
  position: absolute;
  top: 6px;
  right: 0;
  left: 0;
  height: 1px;
  background: linear-gradient(
    90deg,
    rgba(96, 165, 250, 0.64),
    rgba(34, 211, 238, 0.24) 42%,
    rgba(167, 139, 250, 0.15) 72%,
    transparent
  );
  content: "";
}

.title-energy span {
  position: absolute;
  z-index: 1;
  top: 5px;
  left: 0;
  width: 26%;
  height: 3px;
  border-radius: 999px;
  background: linear-gradient(90deg, transparent, #67e8f9, #93c5fd, transparent);
  filter: blur(0.2px);
  box-shadow: 0 0 12px rgba(34, 211, 238, 0.72);
  animation: energy-sweep 4.8s cubic-bezier(0.4, 0, 0.2, 1) 1.15s infinite;
}

.title-energy i {
  position: absolute;
  z-index: 2;
  top: 3px;
  left: 0;
  width: 7px;
  height: 7px;
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 50%;
  background: #67e8f9;
  box-shadow: 0 0 14px rgba(103, 232, 249, 0.9);
  animation: energy-dot 4.8s cubic-bezier(0.4, 0, 0.2, 1) 1.15s infinite;
}

.hero-description {
  max-width: 620px;
  margin: 0;
  color: #91a2b9;
  font-size: clamp(14px, 1.25vw, 16px);
  line-height: 1.78;
  letter-spacing: 0.012em;
}

.intelligence-stage {
  position: relative;
  height: 246px;
  margin-top: 25px;
  overflow: hidden;
  border: 1px solid rgba(96, 165, 250, 0.18);
  border-radius: 24px;
  background:
    linear-gradient(135deg, rgba(30, 64, 175, 0.08), transparent 44%),
    radial-gradient(circle at 52% 48%, rgba(8, 145, 178, 0.09), transparent 34%),
    rgba(8, 17, 30, 0.68);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.035),
    inset 0 -40px 80px rgba(2, 6, 23, 0.23),
    0 30px 90px rgba(0, 0, 0, 0.2);
  isolation: isolate;
}

.intelligence-stage::before {
  position: absolute;
  z-index: 5;
  top: 0;
  right: 17%;
  left: 17%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.75), transparent);
  box-shadow: 0 0 24px rgba(34, 211, 238, 0.5);
  content: "";
}

.stage-grid {
  position: absolute;
  inset: 0;
  opacity: 0.18;
  background-image:
    linear-gradient(rgba(96, 165, 250, 0.17) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96, 165, 250, 0.17) 1px, transparent 1px);
  background-position: center;
  background-size: 31px 31px;
  mask-image: radial-gradient(ellipse at center, black 12%, transparent 74%);
  transform: perspective(380px) rotateX(58deg) scale(1.28) translateY(32%);
}

.stage-scan {
  position: absolute;
  z-index: 1;
  right: 0;
  left: 0;
  height: 58px;
  background: linear-gradient(180deg, transparent, rgba(34, 211, 238, 0.06), rgba(96, 165, 250, 0.16), transparent);
  filter: blur(1px);
  animation: stage-scan 5.2s ease-in-out infinite;
}

.ambient-orb {
  position: absolute;
  border-radius: 999px;
  filter: blur(14px);
}

.ambient-one {
  top: 36px;
  left: 36%;
  width: 120px;
  height: 120px;
  background: rgba(37, 99, 235, 0.12);
  animation: orb-breathe 5s ease-in-out infinite;
}

.ambient-two {
  right: 28%;
  bottom: 24px;
  width: 90px;
  height: 90px;
  background: rgba(168, 85, 247, 0.1);
  animation: orb-breathe 6s ease-in-out 1s infinite reverse;
}

.orbit {
  position: absolute;
  z-index: 2;
  top: 50%;
  left: 50%;
  border: 1px solid rgba(103, 232, 249, 0.2);
  border-radius: 50%;
  transform: translate(-50%, -50%);
}

.orbit::before,
.orbit::after {
  position: absolute;
  border-radius: inherit;
  content: "";
}

.orbit-outer {
  width: 202px;
  height: 202px;
  border-top-color: rgba(103, 232, 249, 0.55);
  border-bottom-color: rgba(167, 139, 250, 0.36);
  box-shadow: 0 0 42px rgba(8, 145, 178, 0.06);
  animation: orbit-spin 18s linear infinite;
}

.orbit-outer::before {
  inset: 11px;
  border: 1px dashed rgba(96, 165, 250, 0.12);
}

.orbit-inner {
  width: 138px;
  height: 138px;
  border-right-color: rgba(167, 139, 250, 0.58);
  border-left-color: rgba(56, 189, 248, 0.48);
  animation: orbit-spin-reverse 11s linear infinite;
}

.orbit-node {
  position: absolute;
  display: block;
  width: 7px;
  height: 7px;
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 50%;
  background: #67e8f9;
  box-shadow: 0 0 13px rgba(103, 232, 249, 0.95);
}

.node-a {
  top: 12px;
  left: 38px;
}

.node-b {
  right: 11px;
  bottom: 45px;
  background: #a78bfa;
  box-shadow: 0 0 13px rgba(167, 139, 250, 0.95);
}

.node-c {
  top: 65px;
  right: -4px;
}

.data-line {
  position: absolute;
  z-index: 1;
  height: 1px;
  overflow: hidden;
  background: linear-gradient(90deg, transparent, rgba(96, 165, 250, 0.16), transparent);
}

.data-line::after {
  position: absolute;
  width: 28%;
  height: 100%;
  background: linear-gradient(90deg, transparent, #67e8f9, transparent);
  content: "";
  animation: data-flow 3.4s linear infinite;
}

.line-one {
  top: 61px;
  right: 7%;
  left: 8%;
}

.line-two {
  right: 3%;
  bottom: 55px;
  left: 13%;
}

.line-two::after {
  animation-delay: 1.1s;
}

.line-three {
  top: 50%;
  right: 18%;
  left: 17%;
  opacity: 0.55;
}

.line-three::after {
  animation-delay: 2s;
}

.intelligence-core {
  position: absolute;
  z-index: 4;
  top: 50%;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 11px;
  transform: translate(-50%, -50%);
  animation: core-float 4s ease-in-out infinite;
}

.core-halo {
  position: absolute;
  inset: -34px;
  border-radius: 999px;
  background: radial-gradient(circle, rgba(34, 211, 238, 0.14), transparent 65%);
  animation: core-pulse 3.2s ease-in-out infinite;
}

.core-logo {
  position: relative;
  display: grid;
  width: 63px;
  height: 63px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(125, 211, 252, 0.3);
  border-radius: 18px;
  background: linear-gradient(145deg, rgba(14, 116, 144, 0.18), rgba(30, 64, 175, 0.22));
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.08),
    0 0 34px rgba(37, 99, 235, 0.2);
}

.core-logo img {
  width: 47px;
  height: 47px;
  border-radius: 13px;
}

.core-copy {
  position: relative;
  display: grid;
  min-width: 116px;
  text-shadow: 0 8px 22px rgba(0, 0, 0, 0.52);
}

.core-copy strong {
  font-size: 17px;
  font-weight: 850;
  letter-spacing: 0.18em;
}

.core-copy small {
  margin-top: 2px;
  color: #69cde2;
  font-size: 7px;
  font-weight: 800;
  letter-spacing: 0.13em;
}

.signal-card {
  position: absolute;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 128px;
  padding: 8px 10px;
  border: 1px solid rgba(125, 211, 252, 0.14);
  border-radius: 11px;
  background: rgba(8, 18, 33, 0.78);
  box-shadow: 0 13px 30px rgba(0, 0, 0, 0.2), inset 0 1px rgba(255, 255, 255, 0.035);
  backdrop-filter: blur(9px);
}

.signal-icon {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: #67e8f9;
  background: rgba(8, 145, 178, 0.12);
}

.signal-card > span:last-child {
  display: grid;
}

.signal-card strong {
  color: #dcecff;
  font-size: 10px;
}

.signal-card small {
  margin-top: 1px;
  color: #536882;
  font-size: 6px;
  font-weight: 800;
  letter-spacing: 0.12em;
}

.signal-model {
  top: 34px;
  left: 22px;
  animation: signal-float 4.8s ease-in-out infinite;
}

.signal-flow {
  top: 43px;
  right: 21px;
  animation: signal-float 5.3s ease-in-out 0.8s infinite reverse;
}

.signal-secure {
  bottom: 27px;
  left: 48px;
  animation: signal-float 4.4s ease-in-out 1.4s infinite;
}

.capability-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 14px;
}

.capability-strip span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid rgba(100, 116, 139, 0.16);
  border-radius: 999px;
  color: #7387a2;
  background: rgba(15, 23, 42, 0.31);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

.capability-strip i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #22d3ee;
  box-shadow: 0 0 8px rgba(34, 211, 238, 0.7);
}

.register-card {
  position: relative;
  overflow: hidden;
  padding: 24px;
  border: 1px solid rgba(100, 116, 139, 0.27);
  border-radius: 22px;
  background:
    linear-gradient(145deg, rgba(30, 64, 175, 0.055), transparent 38%),
    rgba(12, 22, 37, 0.91);
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.4), inset 0 1px rgba(255, 255, 255, 0.025);
  backdrop-filter: blur(18px);
}

.register-card::before {
  position: absolute;
  top: 0;
  right: 18%;
  left: 18%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(103, 232, 249, 0.65), transparent);
  content: "";
}

.state-panel {
  display: grid;
  min-height: 360px;
  place-content: center;
  justify-items: center;
  gap: 13px;
  color: #7dd3fc;
  text-align: center;
}

.state-panel strong {
  color: #eff6ff;
  font-size: 20px;
}

.state-panel span {
  max-width: 290px;
  color: #8da0ba;
  font-size: 13px;
  line-height: 1.7;
}

.state-panel.is-error {
  color: #fca5a5;
}

.state-panel button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  padding: 10px 15px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 10px;
  color: #dce9fb;
  background: rgba(30, 41, 59, 0.76);
  cursor: pointer;
}

.card-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.card-heading > span {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 13px;
  color: #67e8f9;
  background: rgba(8, 145, 178, 0.15);
}

.card-heading > div {
  display: grid;
}

.card-heading small {
  color: #7b8ca6;
  font-size: 11px;
}

.card-heading strong {
  font-size: 20px;
}

.locked-inviter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  padding: 10px 11px;
  border: 1px solid rgba(34, 211, 238, 0.15);
  border-radius: 10px;
  color: #96ddea;
  background: rgba(8, 145, 178, 0.07);
  font-size: 11px;
}

.register-form > label {
  display: grid;
  gap: 7px;
  margin-top: 13px;
  color: #bac7d9;
  font-size: 12px;
  font-weight: 650;
}

.input-shell {
  display: flex;
  min-width: 0;
  height: 44px;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  border: 1px solid rgba(100, 116, 139, 0.3);
  border-radius: 10px;
  color: #6f829e;
  background: rgba(7, 13, 23, 0.74);
  transition: 150ms ease;
}

.input-shell:focus-within {
  border-color: rgba(56, 189, 248, 0.55);
  box-shadow: 0 0 0 3px rgba(14, 165, 233, 0.08);
}

.input-shell input {
  min-width: 0;
  width: 100%;
  border: 0;
  outline: 0;
  color: #edf6ff;
  background: transparent;
  font: inherit;
}

.input-shell input::placeholder {
  color: #4d5f78;
}

.verify-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 104px;
  gap: 8px;
}

.verify-row > button {
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 10px;
  color: #8de5f6;
  background: rgba(8, 145, 178, 0.1);
  cursor: pointer;
}

.verify-row > button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.field-error,
.form-error {
  color: #fca5a5;
  font-size: 11px;
  line-height: 1.55;
}

.form-error {
  margin: 12px 0 0;
  padding: 9px 10px;
  border: 1px solid rgba(248, 113, 113, 0.18);
  border-radius: 9px;
  background: rgba(127, 29, 29, 0.12);
}

.submit-button {
  display: flex;
  width: 100%;
  height: 47px;
  align-items: center;
  justify-content: center;
  gap: 9px;
  margin-top: 18px;
  border: 0;
  border-radius: 11px;
  color: white;
  background: linear-gradient(110deg, #2563eb, #0891b2);
  box-shadow: 0 13px 28px rgba(37, 99, 235, 0.22);
  font-size: 14px;
  font-weight: 750;
  cursor: pointer;
}

.submit-button:disabled {
  cursor: not-allowed;
  filter: saturate(0.5);
  opacity: 0.52;
}

.privacy-note {
  margin: 12px 0 0;
  color: #657791;
  font-size: 10px;
  line-height: 1.55;
  text-align: center;
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes title-lead-in {
  0% {
    opacity: 0;
    filter: blur(7px);
    transform: translateY(18px);
  }
  100% {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0);
  }
}

@keyframes title-creation-in {
  0% {
    opacity: 0;
    clip-path: inset(0 100% 0 0);
    filter: blur(9px) drop-shadow(0 12px 30px rgba(34, 211, 238, 0));
    transform: translateY(24px);
  }
  100% {
    opacity: 1;
    clip-path: inset(0 -8% 0 0);
    filter: blur(0) drop-shadow(0 12px 30px rgba(34, 211, 238, 0.12));
    transform: translateY(0);
  }
}

@keyframes title-word-breathe {
  0%, 100% {
    color: #edf4ff;
    text-shadow: 0 10px 34px rgba(30, 64, 175, 0.2);
  }
  50% {
    color: #f7fbff;
    text-shadow: 0 10px 38px rgba(96, 165, 250, 0.34);
  }
}

@keyframes title-gradient-flow {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}

@keyframes title-shine {
  0%, 22% {
    opacity: 0;
    background-position: 145% 50%;
  }
  34% { opacity: 0.72; }
  52% {
    opacity: 0.18;
    background-position: -115% 50%;
  }
  53%, 100% {
    opacity: 0;
    background-position: -115% 50%;
  }
}

@keyframes energy-line-in {
  0% {
    width: 0;
    opacity: 0;
  }
  100% {
    width: min(82%, 465px);
    opacity: 1;
  }
}

@keyframes energy-sweep {
  0%, 12% {
    left: -28%;
    opacity: 0;
  }
  24% { opacity: 1; }
  76% { opacity: 0.9; }
  88%, 100% {
    left: 102%;
    opacity: 0;
  }
}

@keyframes energy-dot {
  0%, 12% {
    left: -2%;
    opacity: 0;
  }
  24% { opacity: 1; }
  76% { opacity: 1; }
  88%, 100% {
    left: 98%;
    opacity: 0;
  }
}

@keyframes page-ambient {
  0% { transform: translate3d(-1.5%, -1%, 0) scale(1); }
  100% { transform: translate3d(1.5%, 1%, 0) scale(1.04); }
}

@keyframes ambient-drift {
  0% { transform: translate3d(0, 0, 0) scale(1); }
  100% { transform: translate3d(38px, 24px, 0) scale(1.08); }
}

@keyframes status-pulse {
  0%, 100% { opacity: 0.52; transform: scale(0.88); }
  50% { opacity: 1; transform: scale(1); }
}

@keyframes stage-scan {
  0% { top: -72px; opacity: 0; }
  18% { opacity: 1; }
  82% { opacity: 0.78; }
  100% { top: calc(100% + 20px); opacity: 0; }
}

@keyframes orb-breathe {
  0%, 100% { opacity: 0.42; transform: scale(0.82); }
  50% { opacity: 0.86; transform: scale(1.18); }
}

@keyframes orbit-spin {
  from { transform: translate(-50%, -50%) rotate(0deg); }
  to { transform: translate(-50%, -50%) rotate(360deg); }
}

@keyframes orbit-spin-reverse {
  from { transform: translate(-50%, -50%) rotate(360deg); }
  to { transform: translate(-50%, -50%) rotate(0deg); }
}

@keyframes data-flow {
  from { transform: translateX(-130%); }
  to { transform: translateX(470%); }
}

@keyframes core-float {
  0%, 100% { transform: translate(-50%, -50%) translateY(-2px); }
  50% { transform: translate(-50%, -50%) translateY(4px); }
}

@keyframes core-pulse {
  0%, 100% { opacity: 0.54; transform: scale(0.88); }
  50% { opacity: 1; transform: scale(1.18); }
}

@keyframes signal-float {
  0%, 100% { transform: translateY(-3px); }
  50% { transform: translateY(4px); }
}

.success-section {
  width: 100%;
}

.success-hero {
  display: flex;
  align-items: center;
  gap: 19px;
  margin-bottom: 38px;
}

.success-icon {
  display: grid;
  width: 68px;
  height: 68px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgba(52, 211, 153, 0.26);
  border-radius: 20px;
  color: #6ee7b7;
  background: rgba(5, 150, 105, 0.12);
}

.success-hero small {
  color: #6ee7b7;
  font-weight: 750;
}

.success-hero h1 {
  margin: 4px 0 5px;
  font-size: clamp(30px, 4vw, 44px);
}

.success-hero p {
  margin: 0;
  color: #8fa0b8;
}

.success-hero p strong {
  color: #cfe5ff;
}

.download-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.download-card {
  position: relative;
  padding: 24px;
  border: 1px solid rgba(100, 116, 139, 0.27);
  border-radius: 18px;
  background: rgba(13, 23, 38, 0.84);
}

.download-card.is-recommended {
  border-color: rgba(56, 189, 248, 0.48);
  box-shadow: 0 22px 65px rgba(8, 145, 178, 0.1);
}

.recommended-badge {
  position: absolute;
  top: 16px;
  right: 16px;
  padding: 5px 8px;
  border-radius: 999px;
  color: #93e8f6;
  background: rgba(8, 145, 178, 0.15);
  font-size: 10px;
  font-weight: 750;
}

.platform-icon {
  display: grid;
  width: 52px;
  height: 52px;
  margin-bottom: 19px;
  place-items: center;
  border-radius: 15px;
}

.platform-windows {
  color: #60a5fa;
  background: rgba(37, 99, 235, 0.13);
}

.platform-macos {
  color: #c4b5fd;
  background: rgba(124, 58, 237, 0.13);
}

.platform-linux {
  color: #5eead4;
  background: rgba(13, 148, 136, 0.13);
}

.download-card > small {
  color: #72849e;
  font-size: 11px;
}

.download-card h2 {
  margin: 5px 0 9px;
  font-size: 20px;
}

.download-card p {
  min-height: 45px;
  margin: 0 0 20px;
  color: #899ab2;
  font-size: 12px;
  line-height: 1.7;
}

.download-card a {
  display: flex;
  height: 42px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid rgba(56, 189, 248, 0.26);
  border-radius: 10px;
  color: #dff8ff;
  background: rgba(8, 145, 178, 0.12);
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
}

.login-reminder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  margin-top: 20px;
  padding: 13px;
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 12px;
  color: #91a3bc;
  background: rgba(15, 23, 42, 0.44);
  font-size: 12px;
}

.invite-footer {
  display: flex;
  min-height: 72px;
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid rgba(148, 163, 184, 0.12);
  color: #566981;
  font-size: 11px;
}

@media (max-width: 900px) {
  .invite-main {
    padding-top: 38px;
  }

  .invite-hero {
    grid-template-columns: 1fr;
    gap: 36px;
  }

  .hero-copy {
    width: min(100%, 700px);
    margin-inline: auto;
    text-align: center;
  }

  .brand-eyebrow {
    margin-inline: auto;
  }

  .title-lead {
    justify-content: center;
  }

  .title-creation {
    margin-inline: auto;
  }

  .title-energy {
    margin-inline: auto;
  }

  .hero-description {
    margin-inline: auto;
  }

  .capability-strip {
    justify-content: center;
  }

  .download-grid {
    grid-template-columns: 1fr;
  }

  .download-card p {
    min-height: 0;
  }
}

@media (max-width: 620px) {
  .invite-nav,
  .invite-main,
  .invite-footer {
    width: min(100% - 28px, 1160px);
  }

  .invite-nav {
    min-height: 68px;
  }

  .official-channel {
    font-size: 8px;
    letter-spacing: 0.12em;
  }

  .hero-title {
    font-size: 44px;
  }

  .title-lead {
    font-size: 0.68em;
  }

  .title-energy {
    width: min(88%, 340px);
  }

  .intelligence-stage {
    height: 285px;
    border-radius: 19px;
  }

  .signal-model {
    top: 19px;
    left: 13px;
  }

  .signal-flow {
    top: auto;
    right: 13px;
    bottom: 18px;
  }

  .signal-secure {
    display: none;
  }

  .orbit-outer {
    width: 186px;
    height: 186px;
  }

  .orbit-inner {
    width: 126px;
    height: 126px;
  }

  .core-copy {
    min-width: 102px;
  }

  .core-copy strong {
    font-size: 15px;
  }

  .register-card {
    padding: 18px;
    border-radius: 17px;
  }

  .success-hero {
    align-items: flex-start;
  }

  .success-icon {
    width: 54px;
    height: 54px;
    border-radius: 15px;
  }

  .invite-footer {
    flex-direction: column;
    justify-content: center;
    gap: 5px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .invite-page::before,
  .glow,
  .official-channel span,
  .stage-scan,
  .ambient-orb,
  .orbit,
  .data-line::after,
  .intelligence-core,
  .core-halo,
  .signal-card {
    animation: none !important;
  }

  .title-lead,
  .title-word,
  .title-creation,
  .title-creation::after,
  .title-energy,
  .title-energy span,
  .title-energy i {
    animation: none !important;
  }

  .title-energy {
    opacity: 1;
  }
}
</style>
