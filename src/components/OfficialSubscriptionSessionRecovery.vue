<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { AlertCircle, CheckCircle2, RefreshCcw } from 'lucide-vue-next'
import { getPaymentOrder, submitOfficialSubscriptionSession, type PaymentOrder } from '../api'
import { defaultOfficialSubscriptionPlans, normalizeOfficialSubscriptionPlan } from '../official-subscription'
import {
  isOfficialSubscriptionRecoveryOrder,
  normalizeOfficialSubscriptionRecoveryIdentity,
  recoverOfficialSubscriptionSession,
  type OfficialSubscriptionRecoveryIdentity,
} from '../official-subscription-recovery'

const props = defineProps<{ orders: PaymentOrder[]; token: string; ownerId: string }>()
const emit = defineEmits<{ recovered: [orderId: number] }>()
const selectedOrderId = ref<number | null>(null)
const sessionText = ref('')
const identity = ref<OfficialSubscriptionRecoveryIdentity | null>(null)
const identifying = ref(false)
const submitting = ref(false)
const error = ref('')
const notice = ref('')
let generation = 0
const orderId = (order: PaymentOrder) => Number(order.order_id || order.id)
const missingOrders = computed(() => props.orders.filter(isOfficialSubscriptionRecoveryOrder))
const selectedOrder = computed(() => missingOrders.value.find((order) => orderId(order) === selectedOrderId.value) || null)
const busy = computed(() => identifying.value || submitting.value)
const planName = (order: PaymentOrder) => defaultOfficialSubscriptionPlans.find(
  (plan) => plan.id === normalizeOfficialSubscriptionPlan(order.official_plan_id),
)?.name || '官方订阅'
const paymentTime = (order: PaymentOrder) => {
  const date = new Date(order.paid_at || order.created_at || '')
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '已付款'
}
const amountText = (order: PaymentOrder) => `¥${Number(order.pay_amount ?? order.amount).toFixed(2)}`
const message = (value: unknown) => value instanceof Error ? value.message : '暂时无法完成补交，请稍后重试。'

function clearInput() {
  generation++
  selectedOrderId.value = null
  sessionText.value = ''
  identity.value = null
  identifying.value = false
  submitting.value = false
  error.value = ''
}

watch(() => [props.ownerId, props.token], () => {
  clearInput()
  notice.value = ''
}, { flush: 'sync' })
watch(() => props.orders, () => {
  if (selectedOrderId.value !== null && !selectedOrder.value) clearInput()
}, { deep: true })
watch(sessionText, () => { identity.value = null }, { flush: 'sync' })
onUnmounted(clearInput)

function selectOrder(order: PaymentOrder) {
  if (busy.value) return
  clearInput()
  notice.value = ''
  selectedOrderId.value = orderId(order)
}

function cancel() {
  if (!busy.value) clearInput()
}

async function openSessionPage() {
  const url = 'https://chatgpt.com/api/auth/session'
  try {
    if (window.gaogeDesktop?.openPaymentWindow) {
      await window.gaogeDesktop.openPaymentWindow({ payUrl: url })
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    error.value = '无法打开 Session 页面，请在浏览器中访问 https://chatgpt.com/api/auth/session。'
  }
}

async function identifySession() {
  if (busy.value || !selectedOrder.value) return
  error.value = ''
  identity.value = null
  const text = sessionText.value.trim()
  if (!text) {
    error.value = '请粘贴需要订阅的 ChatGPT 账号的完整 Session 文本。'
    return
  }
  if (new Blob([text]).size > 2 * 1024 * 1024) {
    error.value = 'Session 文本超过大小限制，请只复制 Session 页面中的完整 JSON 文本。'
    return
  }
  if (!props.token || !props.ownerId) {
    error.value = '请先登录付款时使用的软件账号。'
    return
  }
  if (!window.gaogeDesktop?.identifyOfficialChatgptSessionText) {
    error.value = '当前客户端暂不支持 Session 识别，请更新软件后再试。'
    return
  }
  const request = ++generation
  const token = props.token
  const ownerId = props.ownerId
  const selectedId = selectedOrderId.value
  identifying.value = true
  try {
    const result = await window.gaogeDesktop.identifyOfficialChatgptSessionText({ sessionJson: text })
    if (request !== generation || token !== props.token || ownerId !== props.ownerId || selectedId !== selectedOrderId.value) return
    identity.value = normalizeOfficialSubscriptionRecoveryIdentity(result)
  } catch (err) {
    if (request === generation) error.value = message(err)
  } finally {
    if (request === generation) identifying.value = false
  }
}

async function submit() {
  if (busy.value || !selectedOrder.value || !identity.value || !props.token || !props.ownerId) return
  error.value = ''
  const selectedId = orderId(selectedOrder.value)
  const session = identity.value
  const token = props.token
  const ownerId = props.ownerId
  const request = ++generation
  const isCurrent = () => request === generation && token === props.token
    && ownerId === props.ownerId && selectedId === selectedOrderId.value
  submitting.value = true
  try {
    const recovered = await recoverOfficialSubscriptionSession(selectedId, session, {
      readOrder: (id) => getPaymentOrder(id, token),
      submit: (id, payload) => submitOfficialSubscriptionSession(id, payload, token),
      isCurrent,
    })
    if (!recovered || !isCurrent()) return
    clearInput()
    notice.value = '服务器已确认保存资料，原订单将继续处理，无需再次付款。'
    emit('recovered', selectedId)
  } catch (err) {
    if (isCurrent()) error.value = message(err)
  } finally {
    if (request === generation) submitting.value = false
  }
}
</script>

<template>
  <section v-if="missingOrders.length || notice" class="official-session-recovery" aria-label="已付款订单补交资料">
    <div v-if="missingOrders.length" class="recovery-heading">
      <AlertCircle :size="19" aria-hidden="true" />
      <div>
        <h3>已付款，待补交订阅资料</h3>
        <p>以下订单尚未收到完整 Session。请为原订单补交最新文本，无需重新下单或付款。</p>
      </div>
    </div>
    <div class="recovery-orders">
      <article v-for="order in missingOrders" :key="orderId(order)" class="recovery-order">
        <div class="recovery-order-heading">
          <div>
            <strong>{{ planName(order) }} · {{ amountText(order) }}</strong>
            <p>订单 {{ order.out_trade_no || orderId(order) }} · {{ paymentTime(order) }}</p>
          </div>
          <button v-if="selectedOrderId !== orderId(order)" type="button" :disabled="busy" @click="selectOrder(order)">补交 Session</button>
        </div>
        <form v-if="selectedOrderId === orderId(order)" class="recovery-form" @submit.prevent="identity ? submit() : identifySession()">
          <p>请在浏览器登录需要订阅的 ChatGPT 账号，再打开 Session 页面并复制全部文本。</p>
          <a href="https://chatgpt.com/api/auth/session" target="_blank" rel="noopener noreferrer" @click.prevent="openSessionPage">打开 Session 页面</a>
          <label>
            <span>完整 Session 文本</span>
            <textarea v-model="sessionText" rows="5" autocomplete="off" autocorrect="off" spellcheck="false" :disabled="busy" placeholder="请粘贴完整 Session JSON" />
          </label>
          <div v-if="identity" class="recovery-confirmation" role="status">
            <strong>已识别订阅账号：{{ identity.email }}</strong>
            <p>请确认这是此订单需要订阅的账号。提交后会保存到上方已付款订单。</p>
          </div>
          <p v-if="error" class="recovery-error" role="alert">{{ error }}</p>
          <div class="recovery-actions">
            <button type="submit" :disabled="busy || !sessionText.trim()">
              <RefreshCcw v-if="busy" :size="15" aria-hidden="true" />
              {{ submitting ? '正在确认保存…' : identifying ? '正在识别…' : identity ? '确认补交到原订单' : '识别并确认账号' }}
            </button>
            <button type="button" :disabled="busy" @click="cancel">取消</button>
          </div>
          <p class="recovery-hint">上传失败时可在当前窗口重试。关闭窗口后请重新粘贴，不会将本次补交文本写入浏览器本地存储。</p>
        </form>
      </article>
    </div>
    <p v-if="notice" class="recovery-success" role="status"><CheckCircle2 :size="16" aria-hidden="true" />{{ notice }}</p>
  </section>
</template>

<style scoped>
.official-session-recovery { padding: 1rem; margin-bottom: 1rem; border: 1px solid #d99b484d; border-radius: 1rem; background: #d99b480a; color: inherit; }
.recovery-heading, .recovery-order-heading, .recovery-actions { display: flex; align-items: flex-start; gap: .7rem; }
.recovery-heading > svg { color: #d99b48; flex-shrink: 0; margin-top: .1rem; }
.recovery-order-heading { justify-content: space-between; align-items: center; flex-wrap: wrap; }
.recovery-orders { display: grid; gap: .7rem; margin-top: .75rem; }
.recovery-order { padding: .8rem; border: 1px solid #8294b333; border-radius: .7rem; min-width: 0; }
h3 { margin: 0; font-size: .95rem; }
p, label { font-size: .78rem; line-height: 1.65; margin: .4rem 0; overflow-wrap: anywhere; }
strong { font-size: .82rem; overflow-wrap: anywhere; }
.recovery-order-heading > div { min-width: 0; }
.recovery-form { display: grid; gap: .55rem; margin-top: .65rem; }
.recovery-form label { display: grid; gap: .4rem; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 7rem; padding: .65rem; border: 1px solid #8294b366; border-radius: .55rem; background: #8294b308; color: inherit; font-family: monospace; font-size: .78rem; }
button { display: inline-flex; gap: .4rem; align-items: center; justify-content: center; border: 1px solid #8294b355; border-radius: .55rem; padding: .6rem .8rem; background: #7c3aed18; color: inherit; font-size: .78rem; font-weight: 700; cursor: pointer; }
button:disabled, textarea:disabled { opacity: .5; cursor: default; }
a { color: #8c9fff; font-size: .78rem; width: fit-content; }
.recovery-confirmation { padding: .7rem; border-radius: .6rem; background: #14b8a612; }
.recovery-error { color: #ef6a70; }
.recovery-success { display: flex; align-items: center; gap: .45rem; color: #14b8a6; }
.recovery-hint, .recovery-order-heading p { opacity: .75; }
@media (max-width: 520px) { .recovery-order-heading > button { width: 100%; } .recovery-actions { flex-wrap: wrap; } }
</style>
