const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('desktop invoice requests require a cumulative amount of at least 100 yuan', () => {
  const vue = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', '新版主题.vue'),
    'utf8',
  )
  const api = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.ts'), 'utf8')

  assert.match(vue, /const INVOICE_MINIMUM_APPLICATION_AMOUNT = 100/)
  assert.match(vue, /function showInvoiceMinimumAmountNotice\(amount: number\)/)
  assert.match(vue, /当前已选金额：\$\{formatCny\(currentAmount\)\}/)
  assert.match(vue, /未开票订单会继续保留/)
  assert.match(vue, /累计满 ¥100\.00 后一并提交申请/)
  assert.match(vue, /如有加急开票需求，请联系人工客服处理/)

  const openStart = vue.indexOf('function openInvoiceApplyDialog(')
  const openEnd = vue.indexOf('function closeInvoiceApplyDialog(', openStart)
  const openDialog = vue.slice(openStart, openEnd)
  assert.match(openDialog, /selectedAmount < INVOICE_MINIMUM_APPLICATION_AMOUNT/)
  assert.ok(
    openDialog.indexOf('selectedAmount < INVOICE_MINIMUM_APPLICATION_AMOUNT') <
      openDialog.indexOf('showInvoiceApplyDialog.value = true'),
    'minimum amount must be checked before opening the application dialog',
  )
  assert.doesNotMatch(
    openDialog.slice(
      openDialog.indexOf('selectedAmount < INVOICE_MINIMUM_APPLICATION_AMOUNT'),
      openDialog.indexOf('showInvoiceApplyDialog.value = true'),
    ),
    /clearInvoiceOrderSelection/,
  )

  const submitStart = vue.indexOf('async function submitInvoiceApplication(')
  const submitEnd = vue.indexOf('function getInvoiceDownloadFileName(', submitStart)
  const submit = vue.slice(submitStart, submitEnd)
  assert.match(submit, /orderAmount < INVOICE_MINIMUM_APPLICATION_AMOUNT/)
  assert.ok(
    submit.indexOf('orderAmount < INVOICE_MINIMUM_APPLICATION_AMOUNT') <
      submit.indexOf('createDesktopInvoiceBatchApplication'),
    'minimum amount must be checked again before the network request',
  )

  assert.match(api, /return apiRequest<DesktopInvoiceApplication>\('\/v2\/desktop\/invoices'/)
})

test('desktop invoices include completed recharge and subscription payment orders', () => {
  const vue = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'components', '新版主题.vue'),
    'utf8',
  )

  assert.match(vue, /const INVOICEABLE_PAYMENT_ORDER_TYPES = new Set\(\[\s*'balance',\s*'platform_sub',\s*'official_sub',\s*'subscription',\s*\]\)/)

  const normalizeStart = vue.indexOf('function normalizeInvoiceOrderFromPayment(')
  const normalizeEnd = vue.indexOf('function isApiNotFound(', normalizeStart)
  const normalizeOrder = vue.slice(normalizeStart, normalizeEnd)
  assert.match(normalizeOrder, /INVOICEABLE_PAYMENT_ORDER_TYPES\.has\(orderType\)/)
  assert.match(normalizeOrder, /amount <= 0/)
  assert.match(normalizeOrder, /isPaymentCompleted\(order\.status\)/)
  assert.match(normalizeOrder, /source: getInvoicePaymentOrderSource\(orderType\)/)

  const syncStart = vue.indexOf('async function syncInvoicePaymentOrders(')
  const syncEnd = vue.indexOf('async function syncInvoiceApplications(', syncStart)
  const syncOrders = vue.slice(syncStart, syncEnd)
  assert.match(syncOrders, /listAllPaymentOrders\(\)/)
  assert.doesNotMatch(syncOrders, /orderType:\s*'balance'/)

  assert.match(vue, /if \(orderType === 'platform_sub' \|\| orderType === 'subscription'\) return '平台订阅'/)
  assert.match(vue, /if \(orderType === 'official_sub'\) return '官方订阅'/)
  assert.match(vue, /<h1>申请在线支付订单发票<\/h1>/)
})
