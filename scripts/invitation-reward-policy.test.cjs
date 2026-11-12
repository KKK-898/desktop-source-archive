const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const vue = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'components', '新版主题.vue'),
  'utf8',
)

test('invitation rewards display quota separately from withdrawable cash', () => {
  assert.match(vue, /const invitationRewardPoolText = computed\(\(\) => `\$\{formatRechargeAmount\(invitationRewardPoolAmount\.value\)\}刀`\)/)
  assert.match(vue, /const invitationCurrentRebateRateText = computed/)
  assert.match(vue, /invitationRewardPoolAmount\.value \* invitationWithdrawalCashRate\.value/)
  assert.match(vue, /当前奖励比例：<b>\{\{ invitationCurrentRebateRateText \}\}<\/b>/)
  assert.match(vue, /可提现金额：<b>\{\{ invitationWithdrawableAmountText \}\}<\/b>/)
})

test('gift quota is excluded from the invitation reward example', () => {
  assert.match(vue, /基础到账 60刀并额外赠送 5刀时，赠送额度不参与返利/)
  assert.match(vue, /const exampleReward = 60 \* currentRate \/ 100/)
})

test('claim transfers quota to balance while withdraw opens customer service', () => {
  const claimStart = vue.indexOf('async function confirmClaimInvitationReward(')
  const claimEnd = vue.indexOf('async function openInvitationWithdrawDialog(', claimStart)
  const claimFlow = vue.slice(claimStart, claimEnd)
  assert.match(claimFlow, /claimAffiliateReward\(authToken\.value\)/)
  assert.match(claimFlow, /balance: result\.balance/)
  assert.match(claimFlow, /result\.transferred_quota\)\}刀到账户余额/)

  const withdrawStart = claimEnd
  const withdrawEnd = vue.indexOf('function formatUsageDate(', withdrawStart)
  const withdrawFlow = vue.slice(withdrawStart, withdrawEnd)
  assert.match(withdrawFlow, /openContactPanel\(\)/)
  assert.match(withdrawFlow, /1刀奖励额度/)
  assert.doesNotMatch(withdrawFlow, /requestAffiliateWithdrawal/)
})

test('zero reward buttons remain clickable and show empty notices', () => {
  assert.match(vue, /notify\('暂无可领取的奖励额度。', 'warning', '我的邀请'\)/)
  assert.match(vue, /notify\('暂无可提现的奖励额度。', 'warning', '我的邀请'\)/)

  const actionsStart = vue.indexOf('<div class="new-theme-invitation-reward-actions">')
  const actionsEnd = vue.indexOf('</div>', actionsStart)
  const actions = vue.slice(actionsStart, actionsEnd)
  assert.match(actions, /:disabled="isInvitationActionLoading" @click="confirmClaimInvitationReward"/)
  assert.match(actions, /:disabled="isInvitationActionLoading" @click="openInvitationWithdrawDialog"/)
  assert.doesNotMatch(actions, /invitationRewardPoolAmount <= 0/)
})
