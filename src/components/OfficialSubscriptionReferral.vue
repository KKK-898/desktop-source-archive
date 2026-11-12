<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { Copy, Gift, RefreshCcw, Users } from 'lucide-vue-next'
import {
  getOfficialSubscriptionReferralSummary,
  prepareOfficialSubscriptionReferral,
  type OfficialReferralPrepareResult,
  type OfficialReferralSummary,
} from '../api'
import { defaultOfficialSubscriptionPlans, normalizeOfficialSubscriptionPlan, quoteOfficialReferral, type OfficialReferralSelection } from '../official-subscription'

const props = withDefaults(defineProps<{
  mode?: 'checkout' | 'summary'
  accountEmail?: string
  sessionJson?: string
  planId?: string
  amount?: number
  token?: string
  disabled?: boolean
}>(), { mode: 'checkout', accountEmail: '', sessionJson: '', planId: '', amount: 0, token: '', disabled: false })
const emit = defineEmits<{ change: [selection: OfficialReferralSelection] }>()
const inviterEmail = ref('')
const preparedInviter = ref('')
const lookupEmail = ref(props.accountEmail)
const resultEmail = ref('')
const data = ref<OfficialReferralPrepareResult | null>(null)
const summary = ref<OfficialReferralSummary | null>(null)
const couponIDs = ref<number[]>([])
const loading = ref(false)
const error = ref('')
const notice = ref('')
const inviteStep = ref(false)
const verified = ref(false)
let generation = 0
const normalizedInviter = computed(() => inviterEmail.value.trim().toLowerCase())
const ready = computed(() => Boolean(data.value && verified.value && !inviteStep.value && !loading.value && preparedInviter.value === normalizedInviter.value))
const checkoutStep = computed(() => loading.value ? 'loading' : inviteStep.value ? 'inviter' : 'coupons')
const quote = computed(() => quoteOfficialReferral(props.amount, ready.value ? data.value : null, couponIDs.value))
const coupons = computed(() => (data.value?.coupons || []).filter((coupon) => coupon.status === 'available' && normalizeOfficialSubscriptionPlan(coupon.plan_id) === normalizeOfficialSubscriptionPlan(props.planId)))
const bound = computed(() => ['qualified', 'skipped'].includes(data.value?.relation?.status || ''))
const money = (amount: number) => Number(amount || 0).toFixed(2)
const planName = (id: string) => defaultOfficialSubscriptionPlans.find((plan) => plan.id === normalizeOfficialSubscriptionPlan(id))?.name || id
const errorMessage = (err: unknown) => err instanceof Error ? err.message : String((err as { message?: string })?.message || '暂时无法查询，请稍后重试。')

watch([ready, checkoutStep, normalizedInviter, couponIDs, quote], () => {
  emit('change', {
    ready: ready.value,
    step: checkoutStep.value,
    inviterEmail: data.value?.config.enabled ? normalizedInviter.value : '',
    couponIDs: ready.value && data.value?.config.enabled ? coupons.value.filter((coupon) => couponIDs.value.includes(coupon.id)).map((coupon) => coupon.id) : [],
    ...quote.value,
  })
}, { immediate: true, deep: true })

async function prepare(detectExisting = false) {
  if (props.mode !== 'checkout' || !props.sessionJson || !props.accountEmail || props.disabled) return
  const request = ++generation
  const inviter = normalizedInviter.value
  loading.value = true
  verified.value = false
  error.value = ''
  couponIDs.value = []
  try {
    const result = await prepareOfficialSubscriptionReferral({
      account_email: props.accountEmail,
      session_json: props.sessionJson,
      plan_id: props.planId,
      inviter_email: inviter,
    }, props.token)
    if (request !== generation || inviter !== normalizedInviter.value) return
    data.value = result
    preparedInviter.value = inviter
    verified.value = true
    // Match the website: existing qualified/skipped relations bypass input.
    inviteStep.value = detectExisting && result.config.enabled && !['qualified', 'skipped'].includes(result.relation?.status || '')
  } catch (err) {
    if (request === generation) error.value = errorMessage(err)
  } finally {
    if (request === generation) loading.value = false
  }
}

watch(() => [props.accountEmail, props.sessionJson, props.planId, props.token, props.mode], () => {
  generation++
  data.value = null
  summary.value = null
  error.value = ''
  notice.value = ''
  couponIDs.value = []
  inviterEmail.value = ''
  preparedInviter.value = ''
  lookupEmail.value = props.accountEmail
  resultEmail.value = ''
  loading.value = false
  inviteStep.value = false
  verified.value = false
  if (props.mode === 'checkout') void prepare(true)
}, { immediate: true })

async function lookup() {
  const email = lookupEmail.value.trim().toLowerCase()
  if (!email || loading.value) return
  const request = ++generation
  loading.value = true
  error.value = ''
  notice.value = ''
  summary.value = null
  resultEmail.value = ''
  try {
    const result = await getOfficialSubscriptionReferralSummary(email, props.token)
    if (request !== generation) return
    summary.value = result
    resultEmail.value = email
  } catch (err) {
    if (request === generation) error.value = errorMessage(err)
  } finally {
    if (request === generation) loading.value = false
  }
}

async function copyInvitation() {
  const email = resultEmail.value
  if (!email || props.disabled) return
  try {
    await navigator.clipboard.writeText(`邀请你使用 Gaoge 官方 GPT 订阅。你可以在 Gaoge Free 软件或官方订阅网页选择套餐，在在线支付前的“邀请好友”中填写我的 ChatGPT 邮箱：${email}。符合条件的首次受邀订阅可享对应套餐优惠，订阅成功后邀请人获得同套餐优惠券；具体金额以结账显示为准。`)
    notice.value = '邀请信息已复制，发送给好友即可。'
  } catch {
    error.value = '复制失败，请手动复制上方邮箱发给好友。'
  }
}

onUnmounted(() => { generation++ })
</script>

<template>
  <section class="official-referral" :class="{ 'is-summary': mode === 'summary' }" :aria-busy="loading">
    <header class="referral-heading">
      <Gift :size="20" />
      <div>
        <h3>{{ mode === 'summary' ? '邀请好友 · 订阅权益' : inviteStep ? '填写邀请人，你和邀请人同时获得优惠' : '邀请好友与优惠券' }}</h3>
        <p>{{ mode === 'summary' ? '网页与软件共用邀请关系和同套餐优惠券。' : inviteStep ? '如果没有邀请人，可以留空并直接点击下一步。' : '优惠仅用于在线支付，卡密支付不参与抵扣。' }}</p>
      </div>
    </header>

    <template v-if="mode === 'summary'">
      <form class="referral-form" @submit.prevent="lookup">
        <label>
          <span>你的 ChatGPT 订阅邮箱</span>
          <input v-model="lookupEmail" type="email" autocomplete="email" required placeholder="填写已开通过官方订阅的邮箱" :disabled="loading || disabled" />
        </label>
        <button type="submit" :disabled="loading || disabled || !lookupEmail.trim()"><Users :size="15" />{{ loading ? '查询中…' : '查询邀请权益' }}</button>
      </form>
      <template v-if="summary">
        <p class="referral-account">{{ resultEmail }}</p>
        <div class="referral-stats">
          <div><strong>{{ summary.qualified_invites }}</strong><span>成功邀请</span></div>
          <div><strong>{{ summary.available_coupons }}</strong><span>可用优惠券</span></div>
          <div><strong>¥{{ money(summary.available_amount) }}</strong><span>可用优惠总额</span></div>
        </div>
        <div v-if="summary.coupons_by_plan?.length" class="referral-plan-balances">
          <span v-for="item in summary.coupons_by_plan" :key="item.plan_id">{{ planName(item.plan_id) }} · {{ item.available_coupons }} 张 · ¥{{ money(item.available_amount) }}</span>
        </div>
        <button type="button" class="referral-copy" :disabled="disabled" @click="copyInvitation"><Copy :size="15" />复制邀请信息</button>
      </template>
      <p class="referral-hint">邀请人须有官方订阅成功记录。好友首次在线订阅时填写邀请邮箱，订阅成功后发放奖励；优惠券仅抵扣对应套餐，可叠加，超出部分不找零。</p>
    </template>

    <template v-else>
      <p v-if="loading" class="referral-hint" role="status">正在查询邀请关系与优惠券…</p>
      <p v-if="inviteStep && data" class="referral-benefit">{{ planName(planId) }}：你获得 ¥{{ money(data.reward_preview.invitee_amount) }} 优惠，邀请人获得 ¥{{ money(data.reward_preview.inviter_amount) }} 同套餐优惠券。</p>
      <form v-if="inviteStep && data && !bound" class="referral-form" @submit.prevent="prepare()">
        <label>
          <span>邀请人 ChatGPT 邮箱（选填）</span>
          <input v-model="inviterEmail" type="email" autocomplete="email" placeholder="如果没有邀请人，直接点击下一步" :disabled="loading || disabled" />
        </label>
        <button type="submit" :disabled="loading || disabled">{{ loading ? '查询中…' : '下一步' }}</button>
      </form>
      <button v-if="!loading && !ready && !inviteStep" type="button" :disabled="disabled" @click="prepare(true)"><RefreshCcw :size="15" />重新查询邀请关系</button>
      <p v-if="inviteStep" class="referral-hint">邀请人必须有官方订阅成功记录；邀请关系只能绑定一次，优惠用于网页或软件内对应套餐的在线支付。</p>
      <p v-if="data?.relation?.inviter_email" class="referral-hint">{{ data.relation.status === 'preview' ? '本次邀请人' : '已绑定邀请人' }}：{{ data.relation.inviter_email }}</p>
      <p v-if="data?.relation?.status === 'skipped'" class="referral-hint">此账号已完成首次订阅，不能再绑定邀请人，仍可使用可用优惠券。</p>
      <template v-if="ready">
        <div class="referral-step-actions">
          <button v-if="!bound && data?.config.enabled" type="button" :disabled="disabled" @click="inviteStep = true">修改邀请人</button>
          <button type="button" :disabled="disabled" @click="prepare()"><RefreshCcw :size="15" />刷新优惠券</button>
        </div>
        <p v-if="data?.config.enabled && !bound" class="referral-benefit">符合条件的首邀可减 ¥{{ money(data.reward_preview.invitee_amount) }}；订阅成功后，邀请人获得 ¥{{ money(data.reward_preview.inviter_amount) }} 同套餐优惠券。</p>
        <p v-else-if="data && !data.config.enabled" class="referral-hint">当前邀请优惠活动已关闭，可按原价订阅。</p>
        <div v-if="coupons.length" class="referral-coupons" role="group" aria-label="同套餐可用优惠券">
          <label v-for="coupon in coupons" :key="coupon.id" class="referral-coupon">
            <input v-model="couponIDs" type="checkbox" :value="coupon.id" :disabled="disabled" />
            <strong>¥{{ money(coupon.face_amount) }}</strong><span>{{ planName(coupon.plan_id) }} · {{ coupon.beneficiary === 'inviter' ? '邀请奖励' : '订阅优惠' }}</span>
          </label>
        </div>
        <p v-else class="referral-hint">暂无其他可用优惠券。</p>
        <div class="referral-quote">
          <span>套餐原价 <b>¥{{ money(quote.baseAmount) }}</b></span>
          <span v-if="quote.inviteeDiscount > 0">首邀优惠 <b>−¥{{ money(quote.inviteeDiscount) }}</b></span>
          <span v-if="quote.couponDiscount > 0">优惠券抵扣 <b>−¥{{ money(quote.couponDiscount) }}</b></span>
          <span class="referral-payable">预计应付 <b>¥{{ money(quote.payableAmount) }}</b></span>
        </div>
        <p v-if="quote.couponFaceAmount > quote.couponDiscount" class="referral-warning">所选优惠券超出 ¥{{ money(quote.couponFaceAmount - quote.couponDiscount) }}，超出部分不找零。</p>
        <p v-if="!bound && data?.config.enabled" class="referral-hint">首次成功订阅后邀请关系固定；留空完成首次订阅后将不能再绑定邀请人。订阅未成功不发放奖励。</p>
      </template>
    </template>
    <p v-if="error" class="referral-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="referral-benefit" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.official-referral { padding: 1rem; border: 1px solid #8294b333; border-radius: 1rem; background: #6480b008; color: inherit; }
.is-summary { margin-top: 1rem; }
.referral-heading { display: flex; align-items: flex-start; gap: .65rem; }
.referral-heading > svg { color: #a78bfa; flex-shrink: 0; margin-top: .15rem; }
h3 { margin: 0; font-size: .95rem; }
p { font-size: .78rem; line-height: 1.65; margin: .4rem 0; }
.referral-heading p, .referral-hint { opacity: .78; }
.referral-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: .6rem; margin-top: .8rem; }
.referral-step-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .65rem; }
.referral-form label { display: grid; gap: .4rem; flex: 1 1 16rem; min-width: 0; font-size: .78rem; }
.referral-form input { padding: .6rem .75rem; min-width: 0; border: 1px solid #8294b366; border-radius: .55rem; background: transparent; color: inherit; font: inherit; }
button { display: inline-flex; gap: .4rem; align-items: center; justify-content: center; border: 1px solid #8294b355; border-radius: .55rem; padding: .65rem .8rem; background: #7c3aed18; color: inherit; font-size: .78rem; font-weight: 700; cursor: pointer; }
button:disabled { cursor: default; opacity: .5; }
.referral-account { overflow-wrap: anywhere; font-weight: 700; }
.referral-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .6rem; margin: .8rem 0; }
.referral-stats > div { display: grid; gap: .3rem; padding: .75rem; border-radius: .65rem; background: #8294b311; }
.referral-stats strong { font-size: 1.1rem; overflow-wrap: anywhere; }
.referral-stats span, .referral-plan-balances, .referral-coupons { font-size: .78rem; }
.referral-plan-balances { display: flex; flex-wrap: wrap; gap: .65rem; margin-bottom: .8rem; }
.referral-coupons { display: grid; gap: .5rem; margin: .8rem 0; }
.referral-coupon { display: flex; align-items: center; gap: .6rem; padding: .65rem; border: 1px solid #8294b333; border-radius: .6rem; cursor: pointer; }
.referral-quote { display: grid; gap: .45rem; margin: .8rem 0; font-size: .8rem; }
.referral-quote > span { display: flex; justify-content: space-between; gap: .8rem; }
.referral-payable { border-top: 1px solid #8294b333; padding-top: .65rem; font-size: .95rem; }
.referral-benefit { color: #14b8a6; }
.referral-error, .referral-warning { color: #ef6a70; }
@media (max-width: 520px) { .referral-stats { grid-template-columns: 1fr; } .referral-form button { width: 100%; } }
</style>
