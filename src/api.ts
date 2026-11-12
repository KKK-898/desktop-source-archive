import { reportClientError } from './error-report'
import {
  getApiBaseUrl,
  getPayOrigin,
  getRuntimeApiCandidates,
  getSmsReceiverApiBaseUrl,
  getSoftwareAdminApiBaseUrl,
  type RuntimeApiServiceScope,
} from './domain-config'

export function getCurrentApiBaseUrl() {
  return getApiBaseUrl()
}

export function getCurrentSoftwareAdminApiBaseUrl() {
  return getSoftwareAdminApiBaseUrl()
}

export const DESKTOP_TUTORIAL_ENDPOINT = '/desktop/tutorial'
export const DESKTOP_TUTORIAL_API_PATH = '/api/v1/desktop/tutorial'
export const DESKTOP_AUTH_REFRESHED_EVENT = 'gaoge-desktop-auth-refreshed'
export const AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY = 'gaoge_desktop_token_expires_at'
export const API_CONNECTION_STATE_EVENT = 'gaoge-api-connection-state'
const AUTH_TOKEN_STORAGE_KEY = 'gaoge_desktop_auth_token'
const REFRESH_TOKEN_STORAGE_KEY = 'gaoge_desktop_refresh_token'
const AUTH_REFRESH_PATH = '/auth/refresh'
const AUTH_REFRESH_SKIP_PATHS = [
  '/auth/login',
  '/auth/login/2fa',
  '/auth/register',
  '/auth/refresh',
  '/auth/logout',
  '/auth/send-verify-code',
  '/auth/forgot-password',
  '/auth/reset-password',
]
const PAYMENT_PRIMARY_TIMEOUT_MS = 20_000
const PAYMENT_BACKUP_TIMEOUT_MS = 10_000

function emitApiConnectionState(connected: boolean, detail: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(API_CONNECTION_STATE_EVENT, {
    detail: {
      connected,
      at: Date.now(),
      ...detail,
    },
  }))
}

export interface ApiUser {
  id: number
  username?: string
  email: string
  balance: number
  concurrency?: number
  role?: 'admin' | 'user'
  status?: 'active' | 'disabled'
  allowed_groups?: number[] | null
}

export interface AuthResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  user: ApiUser
}

export interface TotpLoginResponse {
  requires_2fa: true
  temp_token?: string
  user_email_masked?: string
}

export interface Group {
  id: number
  name: string
  platform: 'anthropic' | 'openai' | 'gemini' | 'antigravity' | string
  description?: string
  rate_multiplier?: number
  status?: 'active' | 'inactive' | string
  enabled?: boolean
  is_active?: boolean
  is_enabled?: boolean
  subscription_type?: string
  daily_limit_usd?: number | string | null
  daily_remaining_usd?: number | string | null
  weekly_limit_usd?: number | string | null
  monthly_limit_usd?: number | string | null
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface UsageApiKey {
  id: number
  name?: string
  key?: string
  group_id?: number | null
  status?: string
}

export interface ApiKey {
  id: number
  user_id?: number
  key: string
  name: string
  group_id: number | null
  status: 'active' | 'inactive' | 'quota_exhausted' | 'expired' | string
  quota?: number
  quota_used?: number
  expires_at?: string | null
  created_at?: string
  updated_at?: string
  group?: Group
}

export interface UsageLog {
  id: number
  api_key_id: number
  model: string
  inbound_endpoint?: string | null
  upstream_endpoint?: string | null
  group_id?: number | null
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  cache_creation_5m_tokens?: number
  cache_creation_1h_tokens?: number
  input_cost?: number
  output_cost?: number
  cache_creation_cost?: number
  cache_read_cost?: number
  total_cost: number
  actual_cost: number
  rate_multiplier?: number
  service_tier?: string | null
  request_type?: string
  stream?: boolean
  duration_ms?: number | null
  first_token_ms?: number | null
  created_at: string
  api_key?: UsageApiKey
  group?: Group
}

export interface UsageLogQueryOptions {
  page?: number
  pageSize?: number
  apiKeyId?: number | string
  startDate?: string
  endDate?: string
  timezone?: string
}

export interface UsageStats {
  total_requests: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_tokens: number
  total_cache_creation_tokens: number
  total_cache_read_tokens: number
  total_tokens: number
  total_cost: number
  total_actual_cost: number
  average_duration_ms?: number
}

export interface PlatformDashboardStats {
  platform: string
  total_requests: number
  total_tokens: number
  total_actual_cost: number
  today_requests: number
  today_tokens: number
  today_actual_cost: number
}

export interface UserDashboardStats {
  total_api_keys: number
  active_api_keys: number
  total_requests: number
  total_tokens: number
  total_cost: number
  total_actual_cost: number
  today_requests: number
  today_tokens: number
  today_cost: number
  today_actual_cost: number
  by_platform?: PlatformDashboardStats[]
}

export interface DesktopTutorialSection {
  title?: string
  description?: string
  summary?: string
  content?: string
  body?: string
  items?: string[]
  images?: Array<{
    src?: string
    url?: string
    alt?: string
    caption?: string
  }>
}

export interface DesktopTutorialResponse {
  title?: string
  subtitle?: string
  description?: string
  content?: string
  markdown?: string
  updated_at?: string
  updatedAt?: string
  sections?: DesktopTutorialSection[]
}

export interface DesktopContactItem {
  id?: string
  title?: string
  content?: string
  description?: string
  icon?: string
  imageUrl?: string
  image_url?: string
  sort?: number
}

export interface DesktopContactResponse {
  items?: DesktopContactItem[]
  updated_at?: string
  updatedAt?: string
}

export interface DesktopAnnouncementItem {
  id?: string
  title?: string
  detail?: string
  content?: string
  time?: string
  updatedAt?: string
  level?: string
  position?: string
  version_scope?: string
  versionScope?: string
  priority?: number
}

export interface DesktopAnnouncementsResponse {
  items?: DesktopAnnouncementItem[]
  updated_at?: string
  updatedAt?: string
}

export interface SubmitDesktopFeedbackRequest {
  id?: string
  type: string
  content: string
  contact?: string
  page?: string
  user?: string
  userId?: string | number
  email?: string
  clientVersion?: string
  version?: string
  platform?: string
  os?: string
}

export interface SubmitDesktopFeedbackResponse {
  id: string
  status?: string
  submitted_at?: string
  submittedAt?: string
}

export type DesktopInvoiceApplicationStatus = 'waiting' | 'completed'

export interface DesktopInvoiceOrderItem {
  orderId: string
  orderNo: string
  orderAmount: number
  orderTime: string
  source?: string
  order_id?: string
  order_no?: string
  order_amount?: number
  order_time?: string | number
  time?: string | number
  paid_at?: string | number
  completed_at?: string | number
  created_at?: string | number
  updated_at?: string | number
}

export interface DesktopInvoiceApplication {
  id: string
  orderId?: string
  orderNo?: string
  orderAmount?: number
  orderTime?: string | number
  order_id?: string
  order_no?: string
  order_amount?: number
  order_time?: string | number
  orderIds?: string[]
  orderNos?: string[]
  orderCount?: number
  totalAmount?: number
  total_amount?: number
  orders?: DesktopInvoiceOrderItem[]
  titleId?: string
  titleName?: string
  taxNumber?: string
  invoiceType?: string
  invoiceKind?: string
  title_id?: string
  title_name?: string
  tax_number?: string
  invoice_type?: string
  invoice_kind?: string
  status: DesktopInvoiceApplicationStatus
  requestedAt?: string | number
  requested_at?: string | number
  submittedAt?: string | number
  submitted_at?: string | number
  createdAt?: string | number
  created_at?: string | number
  updatedAt?: string | number
  updated_at?: string | number
  pdfUrl?: string
  pdf_url?: string
  pdfDataUrl?: string
  pdf_data_url?: string
  pdfName?: string
  pdf_name?: string
}

export interface CreateDesktopInvoiceApplicationRequest {
  id?: string
  userId: string | number
  email?: string
  user?: string
  orderId: string
  orderNo: string
  orderAmount: number
  orderTime: string
  titleId: string
  titleName: string
  taxNumber: string
  invoiceType: string
  invoiceKind: string
}

export interface CreateDesktopInvoiceBatchApplicationRequest {
  userId: string | number
  email?: string
  user?: string
  orders: DesktopInvoiceOrderItem[]
  titleId: string
  titleName: string
  taxNumber: string
  invoiceType: string
  invoiceKind: string
}

export type DesktopProjectOutsourcingStatus = 'pending' | 'approved' | 'rejected'

export interface DesktopProjectOutsourcingRequest {
  id: string
  requirement: string
  content: string
  contact: string
  status: DesktopProjectOutsourcingStatus
  response?: string
  submittedAt: string
  updatedAt?: string
}

export interface CreateDesktopProjectOutsourcingRequest {
  id?: string
  userId: string | number
  email?: string
  user?: string
  requirement: string
  content: string
  contact: string
  clientVersion?: string
  version?: string
  platform?: string
  os?: string
}

export type DesktopTelemetryEvent = 'start' | 'heartbeat' | 'close'

export interface DesktopTelemetryPayload {
  sessionId: string
  deviceId: string
  userId?: number | string
  userEmail?: string
  username?: string
  appVersion?: string
  platform?: string
  arch?: string
  language?: string
  userAgent?: string
  page?: string
  region?: string
}

export interface DesktopTelemetryResponse {
  accepted: boolean
  event: DesktopTelemetryEvent
  session_id: string
  online_users: number
  today_users: number
  received_at: string
}

export interface RedeemResponse {
  message: string
  type: string
  value: number
  new_balance?: number
  new_concurrency?: number
}

export interface RedeemHistoryItem {
  id: number | string
  code: string
  type: string
  source?: string
  idempotency_key?: string
  value: number | string
  status: string
  used_at?: string | null
  created_at?: string | null
  notes?: string
  group_id?: number | string | null
  validity_days?: number | string | null
  group?: {
    id?: number | string
    name?: string
  } | null
}

export interface DesktopRedeemRegisterResponse extends Partial<AuthResponse> {
  email?: string
  password?: string
  account?: {
    email?: string
    password?: string
  }
  auth?: AuthResponse
  new_balance?: number
}

export interface SmsReceiverServiceItem {
  key: string
  name: string
  lubanServiceName?: string
  keyword?: string
  enabled: boolean
  sort?: number
  notes?: string
}

export interface SmsReceiverConfig {
  enabled: boolean
  pollIntervalSeconds: number
  services: SmsReceiverServiceItem[]
}

export interface SmsReceiverPricing {
  currency: string
  usdToCreditRate: number
  minimumChargeAmount: number
  roundingMode: string
}

export interface SmsReceiverOption {
  serviceKey: string
  serviceName: string
  serviceId: string
  lubanServiceName: string
  country: string
  countryNameZh: string
  countryNameEn: string
  provider: string
  costUsd: number
  chargeAmount: number
  pricing: SmsReceiverPricing
}

export interface SmsReceiverOrder {
  id: string
  user: string
  service: string
  serviceId?: string
  country: string
  number: string
  requestId: string
  status: string
  lubanCostUsd?: number
  chargedAmount: number
  canCancel?: boolean
  cancelAvailableAt?: string
  cancelRemainingSeconds?: number
  cancelled?: boolean
  lubanCancelStatus?: string
  lubanCancelMessage?: string
  smsCode?: string
  sms_code?: string
  verificationCode?: string
  verification_code?: string
  verifyCode?: string
  verify_code?: string
  code?: string | number
  otp?: string | number
  smsText?: string
  sms_text?: string
  text?: string
  content?: string
  body?: string
  msg?: string
  sms?: string | {
    code?: string | number
    text?: string
    content?: string
    body?: string
    message?: string
  }
  refundStatus?: string
  received?: boolean
  receivedAt?: number
  received_at?: string | number
  message?: string
  idempotent?: boolean
  createdAt: string
  updatedAt: string
  created_at?: string
  updated_at?: string
}

export interface SmsReceiverNumberRequest {
  userId: string
  service: string
  serviceKey?: string
  serviceName?: string
  service_name?: string
  lubanServiceName?: string
  luban_service_name?: string
  serviceId?: string
  service_id?: string
  country?: string
  countryNameZh?: string
  country_name_zh?: string
  countryNameEn?: string
  country_name_en?: string
  countryCode?: string
  country_code?: string
  costUsd?: number
  cost_usd?: number
  language?: string
  clientOrderId?: string
  client_order_id?: string
  provider?: string
  client?: string
}

export interface RegisterRequest {
  email: string
  password: string
  verify_code?: string
  turnstile_token?: string
  promo_code?: string
  invitation_code?: string
  aff_code?: string
  referral_token?: string
}

export interface PublicRegistrationSettings {
  registration_enabled?: boolean
  email_verify_enabled?: boolean
  turnstile_enabled?: boolean
  turnstile_site_key?: string
}

export interface AffiliateInviteInspection {
  valid: boolean
  inviter_locked: boolean
  expires_at: string
}

export interface AffiliateShareToken {
  token: string
  expires_at: string
}

export type AffiliateInviteeStatus = 'active' | 'invalid' | 'pending'

export interface AffiliateRebateTier {
  min_active_count: number
  max_active_count?: number
  rate_percent: number
}

export interface AffiliateInvitee {
  user_id: number
  email: string
  username?: string
  status: AffiliateInviteeStatus
  bound_at?: string
  qualified_at?: string
  last_login_at?: string
  last_used_at?: string
  latest_contribution_at?: string
  total_paid: number
  total_redeemed_quota: number
  total_rebate: number
}

export interface AffiliateDetail {
  user_id: number
  aff_code: string
  inviter_id?: number
  aff_count: number
  active_count: number
  invalid_count: number
  pending_count: number
  aff_quota: number
  aff_history_quota: number
  claimed_quota: number
  withdrawn_quota: number
  withdrawn_cash_amount?: number
  pending_withdrawal_quota: number
  pending_withdrawal_cash_amount?: number
  withdrawal_cash_rate?: number
  withdrawable_cash_amount?: number
  rebate_tiers: AffiliateRebateTier[]
  inactive_days: number
  effective_rebate_rate_percent: number
  invitees: AffiliateInvitee[]
}

export interface AffiliateTransferResult {
  transferred_quota: number
  balance: number
}

export interface AffiliateWithdrawal {
  id: number
  user_id: number
  quota_amount: number
  cash_rate: number
  cash_amount: number
  status: 'pending' | 'completed' | 'cancelled'
  requested_at: string
  processed_at?: string
  processed_by?: number
  notes?: string
}

export interface UpdateCurrentUserRequest {
  email?: string
  username?: string
}

export interface ChangePasswordRequest {
  old_password: string
  current_password?: string
  new_password: string
}

export interface SubmitAccountChangeRequest {
  email?: string
  username?: string
  old_password?: string
  current_password?: string
  new_password?: string
  login_password?: string
}

export interface SubmitAccountChangeResponse {
  requestId?: string
  user: ApiUser
  emailChanged?: boolean
  usernameChanged?: boolean
  passwordChanged?: boolean
  auth?: AuthResponse | null
  authRefreshError?: string
}

export interface PaymentOrder {
  id?: number
  order_id?: number
  amount: number
  pay_amount?: number
  fee_rate?: number
  payment_type?: string
  payment_mode?: string
  provider_key?: string
  order_type?: string
  plan_id?: number | null
  subscription_group_id?: number | null
  subscription_days?: number | null
  pay_url?: string
  qr_code?: string
  qr_code_img?: string
  out_trade_no?: string
  status?: string
  created_at?: string
  updated_at?: string
  expires_at?: string
  paid_at?: string | null
  completed_at?: string | null
  failed_reason?: string | null
  official_session_saved?: boolean
  official_plan_id?: string
  base_amount?: number
  discount_amount?: number
  coupon_face_amount?: number
  invitee_discount_amount?: number
  referral_mode?: string
  // Actual settled gift only; absent for legacy orders and before bonus settlement.
  bonus_amount?: number
  bonus_applied_at?: string | null
}

export interface CreatePaymentOrderOptions {
  orderType?: 'balance' | 'subscription' | 'official_sub' | 'platform_sub'
  onlinePaymentPlanId?: string
  planId?: number | null
  officialPlanId?: string | null
  subscriptionGroupId?: number | null
  subscriptionDays?: number | null
  officialSubscriptionSession?: OfficialSubscriptionSessionUploadRequest
  officialReferral?: { inviter_email: string; coupon_ids: number[] }
  idempotencyKey?: string
}

export interface PlatformSubscriptionPlanConfig {
  id: string
  name: string
  badge?: string
  price: string
  priceAmount: number
  dailyQuota: string
  dailyLimitUsd: number
  subscriptionDays: number
  description?: string
  enabled?: boolean
  sort?: number
  version?: number
}

export interface PlatformSubscriptionOrderRegisterRequest {
  sub2_order_id: string | number
  sub2_out_trade_no?: string
  sub2_order_type?: string
  sub2_recharge_amount?: number
  sub2_pay_amount?: number
  sub2_payment_status?: string
  subscription_action?: 'renew' | 'replace'
  current_subscription_id?: string | number
  current_plan_id?: string
  current_plan_name?: string
  current_group_id?: string | number
  target_plan_id?: string
  target_plan_name?: string
  target_group_id?: string | number
  balance_deduction?: PlatformSubscriptionBalanceDeductionRequest
  userId?: string | number
  user_id?: string | number
  email?: string
  planId?: string
  plan_id?: string
}

export interface PlatformSubscriptionPaymentSnapshot {
  sub2_order_id: string | number
  sub2_out_trade_no?: string
  sub2_order_type?: string
  sub2_recharge_amount?: number
  sub2_pay_amount?: number
  sub2_payment_status?: string
  paid_at?: string | null
  completed_at?: string | null
}

export interface OnlinePaymentPlan {
  id: string
  payAmount: number
  bonusAmount: number
  baseCreditAmount: number
  creditAmount: number
  sort: number
  enabled: boolean
  quota?: string
  price?: string
}

export interface OnlinePaymentSnapshot {
  planId: string
  payAmount: number
  baseCreditAmount: number
  bonusAmount: number
  totalCreditAmount: number
  multiplier?: number
  createdAt?: string
}

export interface OnlinePaymentConfig {
  enabled: boolean
  balanceRechargeMultiplier: number
  balance_recharge_multiplier?: number
  plans: OnlinePaymentPlan[]
  updatedAt?: string
}

export interface OnlinePaymentBonusResult {
  applied: boolean
  record?: {
    sub2OrderId?: string
    userId?: string
    planId?: string
    payAmount?: number
    baseCreditAmount?: number
    bonusAmount?: number
    totalCreditAmount?: number
    status?: string
  }
  message?: string
}

export interface OnlinePaymentSnapshotRegistrationResult {
  record?: OnlinePaymentBonusResult['record'] & {
    createdAt?: string
    updatedAt?: string
  }
}

export interface PlatformSubscriptionBalanceDeductionRequest {
  enabled: boolean
  amount: number
  source: 'sub2_balance_recharge'
  idempotency_key: string
  notes?: string
}

export interface PlatformSubscriptionActivationRequest {
  payment?: PlatformSubscriptionPaymentSnapshot
  subscription_action?: 'renew' | 'replace'
  current_subscription_id?: string | number
  current_plan_id?: string
  current_plan_name?: string
  current_group_id?: string | number
  target_plan_id?: string
  target_plan_name?: string
  target_group_id?: string | number
  balance_deduction?: PlatformSubscriptionBalanceDeductionRequest
}

export interface PlatformSubscriptionOrderRecord {
  id: string
  sub2_order_id: string
  user_id: string
  email?: string
  plan_id: string
  plan_name: string
  plan_version: number
  amount: number
  daily_limit_usd: number
  validity_days: number
  status: string
  error_message?: string
  created_at?: string
  updated_at?: string
}

export interface PlatformSubscriptionMySummaryItem {
  id: string
  group_name?: string
  plan_id?: string
  daily_used_usd?: number
  daily_limit_usd?: number
  daily_remaining_usd?: number
  expires_at?: string
  status?: string
  usage_error?: string
}

export interface PlatformSubscriptionMyResponse {
  subscription: (ActiveSubscription & {
    plan_id?: string
    plan_name?: string
    daily_remaining_usd?: number
  }) | null
  subscriptions: PlatformSubscriptionMySummaryItem[]
  today?: {
    used_usd: number
    limit_usd: number
    remaining_usd: number
    date: string
  }
}

export interface OfficialSubscriptionPricePlan {
  id: string
  planId?: string
  name: string
  planName: string
  officialPrice?: string
  amount: number
  currency?: string
  updatedAt?: string
}

export interface OfficialSubscriptionSessionUploadRequest {
  fill_missing_only?: boolean
  plan_id?: string
  plan_name?: string
  account_email?: string
  account_key?: string
  session_json: string
  session_source?: string
  session_url?: string
  order_no?: string
  paid_at?: string | null
}

export interface OfficialSubscriptionSoftwareAdminUploadRequest {
  userId?: string
  user?: string
  email?: string
  username?: string
  planName: string
  planId?: string
  source?: string
  subscriptionOrigin?: 'software' | 'web'
  orderId?: string
  orderNo?: string
  clientOrderId?: string
  paymentStatus?: string
  amount?: string | number
  currency?: string
  sessionText: string
  sessionSource?: string
  sessionUrl?: string
  clientVersion?: string
  platform?: string
  contact?: string
  note?: string
  paymentMethod?: string
  paymentInfo?: Record<string, unknown>
  paidAt?: string | null
  statusOnly?: boolean
  status?: string
  cardSecret?: string
}

export interface OfficialSubscriptionSoftwareAdminOrder {
  id?: string
  user?: string
  userId?: string
  email?: string
  username?: string
  planId?: string
  planName?: string
  orderId?: string
  orderNo?: string
  clientOrderId?: string
  source?: string
  paymentStatus?: string
  rechargeStatus?: string
  status?: string
  amount?: string | number
  currency?: string
  submittedAt?: string
  paidAt?: string
  requestId?: string
  hasSessionText?: boolean
}

export interface OfficialSubscriptionSoftwareAdminResponse {
  paid?: boolean
  orderCreated?: boolean
  paymentMethod?: string
  paymentStatus?: string
  amount?: string | number
  currency?: string
  request?: {
    id?: string
    status?: string
    hasSessionText?: boolean
  }
  order?: OfficialSubscriptionSoftwareAdminOrder
}

export interface ListPaymentOrdersOptions {
  page?: number
  pageSize?: number
  status?: string
  orderType?: string
  paymentType?: string
}

export interface ActiveSubscription {
  id?: number | string
  user_id?: number | string
  group_id?: number | string
  group?: Group | null
  status?: string
  created_at?: string | null
  starts_at?: string | null
  started_at?: string | null
  expires_at?: string | null
  end_at?: string | null
  valid_until?: string | null
  daily_limit_usd?: number | string | null
  daily_remaining_usd?: number | string | null
  weekly_limit_usd?: number | string | null
  monthly_limit_usd?: number | string | null
  daily_usage_usd?: number | string | null
  weekly_usage_usd?: number | string | null
  monthly_usage_usd?: number | string | null
}

export interface SubscriptionSummaryItem {
  id?: number | string
  group_id?: number | string
  group_name?: string
  status?: string
  daily_used_usd?: number | string | null
  daily_limit_usd?: number | string | null
  daily_remaining_usd?: number | string | null
  weekly_used_usd?: number | string | null
  weekly_limit_usd?: number | string | null
  monthly_used_usd?: number | string | null
  monthly_limit_usd?: number | string | null
  expires_at?: string | null
}

export interface SubscriptionSummary {
  active_count?: number
  total_used_usd?: number | string | null
  subscriptions?: SubscriptionSummaryItem[]
}

export interface ApiError extends Error {
  status?: number
  code?: unknown
  reason?: unknown
  metadata?: unknown
  transportKind?: string
  retryable?: boolean
}

export interface DesktopAuthRefreshResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
  token_type?: string
}

export interface DesktopAuthRefreshEventDetail {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  expiresIn?: number
  tokenType?: string
}

interface ApiRequestOptions {
  baseUrl?: string
  auth?: 'default' | 'none'
  serviceScope?: RuntimeApiServiceScope
  retryPolicy?: 'none' | 'safe-read' | 'idempotent-write'
  primaryTimeoutMs?: number
  backupTimeoutMs?: number
}

interface ApiRequestCandidate {
  serverId: string
  serverName: string
  baseUrl: string
  selected: boolean
}

interface DesktopTransportFailure {
  kind: string
  message: string
  retryable: boolean
  elapsedMs?: number
  host?: string
}

let authRefreshPromise: Promise<DesktopAuthRefreshResponse> | null = null

function readStorageValue(key: string) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStorageValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore unavailable storage in restricted browser contexts.
  }
}

function removeStorageValue(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore unavailable storage in restricted browser contexts.
  }
}

function getAuthToken(): string {
  return readStorageValue(AUTH_TOKEN_STORAGE_KEY)
}

function getRefreshToken(): string {
  return readStorageValue(REFRESH_TOKEN_STORAGE_KEY)
}

function toApiError(message: string, status?: number, payload?: Record<string, unknown>): ApiError {
  const nestedError = payload?.error && typeof payload.error === 'object'
    ? payload.error as Record<string, unknown>
    : undefined
  const error = new Error(message) as ApiError
  error.status = status
  error.code = payload?.code ?? nestedError?.code
  error.reason = payload?.reason ?? nestedError?.reason
  error.metadata = payload?.metadata ?? nestedError?.metadata
  return error
}

function parseRequestBody(body: BodyInit | null | undefined) {
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function shouldSkipAuthRefresh(path: string) {
  return AUTH_REFRESH_SKIP_PATHS.some((skipPath) => path === skipPath || path.startsWith(`${skipPath}?`))
}

function shouldAttemptAuthRefresh(error: unknown, path: string, token: string) {
  const apiError = error as ApiError
  return apiError?.status === 401 && Boolean(token) && Boolean(getRefreshToken()) && !shouldSkipAuthRefresh(path)
}

function persistRefreshedAuth(response: DesktopAuthRefreshResponse) {
  const accessToken = response.access_token?.trim()
  if (!accessToken) {
    throw toApiError('Token refresh response missing access token', 401)
  }

  const nextRefreshToken = response.refresh_token.trim()
  if (!nextRefreshToken) {
    throw toApiError('Token refresh response missing refresh token', 401)
  }

  writeStorageValue(AUTH_TOKEN_STORAGE_KEY, accessToken)
  writeStorageValue(REFRESH_TOKEN_STORAGE_KEY, nextRefreshToken)

  const expiresIn = Number(response.expires_in || 0)
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? Date.now() + expiresIn * 1000
    : undefined
  if (expiresAt) {
    writeStorageValue(AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY, String(expiresAt))
  } else {
    removeStorageValue(AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY)
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<DesktopAuthRefreshEventDetail>(DESKTOP_AUTH_REFRESHED_EVENT, {
      detail: {
        accessToken,
        refreshToken: nextRefreshToken,
        expiresAt,
        expiresIn: response.expires_in,
        tokenType: response.token_type,
      },
    }))
  }
}

async function refreshDesktopAuthTokenOnce() {
  const currentRefreshToken = getRefreshToken()
  if (!currentRefreshToken) {
    throw toApiError('No refresh token available', 401)
  }

  try {
    const response = await sendApiRequest<DesktopAuthRefreshResponse>(AUTH_REFRESH_PATH, {
      method: 'POST',
      body: JSON.stringify({ refresh_token: currentRefreshToken }),
    }, '', { baseUrl: getApiBaseUrl() })
    persistRefreshedAuth(response)
    return response
  } catch (error) {
    const status = (error as ApiError)?.status
    if (status === 400 || status === 401 || status === 403) {
      removeStorageValue(REFRESH_TOKEN_STORAGE_KEY)
      removeStorageValue(AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY)
    }
    throw error
  }
}

export async function refreshDesktopAuthToken() {
  if (!authRefreshPromise) {
    authRefreshPromise = refreshDesktopAuthTokenOnce().finally(() => {
      authRefreshPromise = null
    })
  }
  return authRefreshPromise
}

async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  token = getAuthToken(),
  requestOptions: ApiRequestOptions = {},
): Promise<T> {
  const requestToken = requestOptions.auth === 'none' ? '' : token || getAuthToken()
  try {
    return await sendApiRequest<T>(path, options, requestToken, requestOptions)
  } catch (error) {
    if (!shouldAttemptAuthRefresh(error, path, requestToken)) {
      throw error
    }
    const refreshed = await refreshDesktopAuthToken()
    return sendApiRequest<T>(path, options, refreshed.access_token, requestOptions)
  }
}

async function sendApiRequest<T>(
  path: string,
  options: RequestInit = {},
  token = getAuthToken(),
  requestOptions: ApiRequestOptions = {},
): Promise<T> {
  const baseUrl = requestOptions.baseUrl || getApiBaseUrl()
  const headers = new Headers(options.headers)
  headers.set('Accept', 'application/json')
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  if (window.gaogeDesktop?.apiRequest) {
    const method = options.method || 'GET'
    const requestId = createApiRequestId()
    headers.set('X-Request-ID', requestId)
    const candidates = apiRequestCandidates(requestOptions)
    const attempts: Array<Record<string, unknown>> = []
    const isResilientRequest = Boolean(requestOptions.retryPolicy && requestOptions.retryPolicy !== 'none')

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const hasBackup = index + 1 < candidates.length
      const timeoutMs = !isResilientRequest
        ? undefined
        : index === 0
          ? requestOptions.primaryTimeoutMs ?? PAYMENT_PRIMARY_TIMEOUT_MS
          : requestOptions.backupTimeoutMs ?? PAYMENT_BACKUP_TIMEOUT_MS
      let desktopResponse: GaogeDesktopApiResponse
      try {
        desktopResponse = await window.gaogeDesktop.apiRequest({
          path,
          method,
          token,
          baseUrl: candidate.baseUrl,
          body: parseRequestBody(options.body),
          headers: desktopForwardHeaders(headers),
          timeoutMs,
        })
      } catch (cause) {
        const failure = normalizeDesktopTransportFailure(cause)
        attempts.push({
          serverId: candidate.serverId,
          host: failure.host,
          kind: failure.kind,
          elapsedMs: failure.elapsedMs,
        })
        if (hasBackup && failure.retryable && requestOptions.retryPolicy !== 'none') {
          emitApiConnectionState(false, {
            path,
            method,
            retrying: true,
            message: '当前线路连接失败，正在尝试备用线路。',
            selectedServerId: candidate.serverId,
            nextServerId: candidates[index + 1].serverId,
            requestId,
          })
          continue
        }

        const userMessage = isResilientRequest
          ? paymentTransportErrorMessage(failure, attempts.length)
          : '无法连接到 GaogeAI 服务器，请检查网络或 API 地址。'
        const error = toApiError(userMessage, 0, {
          reason: failure.message,
          metadata: {
            transport: 'desktop',
            transportKind: failure.kind,
            retryable: failure.retryable,
            requestId,
            attempts,
          },
        })
        error.transportKind = failure.kind
        error.retryable = failure.retryable
        emitApiConnectionState(false, {
          path,
          method,
          message: error.message,
          requestId,
          attempts,
        })
        void reportClientError(error, {
          source: 'api',
          feature: 'backend-api',
          action: 'desktop-api-request',
          apiPath: path,
          status: 0,
          metadata: { method, transport: 'desktop', requestId, attempts },
        })
        throw error
      }

      try {
        const result = unwrapPayload<T>(desktopResponse.payload, desktopResponse.ok, desktopResponse.status)
        emitApiConnectionState(true, {
          path,
          method,
          status: desktopResponse.status,
          requestId,
          selectedServerId: candidates[0]?.serverId,
          respondingServerId: candidate.serverId,
          failoverUsed: index > 0,
        })
        return result
      } catch (error) {
        attempts.push({ serverId: candidate.serverId, status: desktopResponse.status })
        if (hasBackup && requestOptions.retryPolicy !== 'none' && isRetryableGatewayError(error)) {
          emitApiConnectionState(false, {
            path,
            method,
            retrying: true,
            message: '当前线路连接失败，正在尝试备用线路。',
            selectedServerId: candidate.serverId,
            nextServerId: candidates[index + 1].serverId,
            requestId,
          })
          continue
        }
        emitApiConnectionState(true, {
          path,
          method,
          status: desktopResponse.status,
          requestId,
          respondingServerId: candidate.serverId,
        })
        void reportClientError(error, {
          source: 'api',
          feature: 'backend-api',
          action: 'desktop-api-response',
          apiPath: path,
          status: desktopResponse.status,
          metadata: { method, requestId, attempts },
        })
        throw error
      }
    }

    throw toApiError('当前主线路和备用线路均暂时无法连接，请稍后重试。', 0)
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
      credentials: 'omit',
    })
  } catch (cause) {
    const transportMessage = (cause instanceof Error ? cause.message : String(cause || '')).slice(0, 500)
    const error = toApiError('无法连接到 GaogeAI 服务器，请检查网络或 API 地址。桌面版会通过内置请求通道访问线上接口。', 0, {
      reason: transportMessage,
      metadata: { transport: 'browser', transportMessage },
    })
    emitApiConnectionState(false, {
      path,
      method: options.method || 'GET',
      message: transportMessage || error.message,
    })
    void reportClientError(error, {
      source: 'api',
      feature: 'backend-api',
      action: 'browser-api-request',
      apiPath: path,
      status: 0,
      metadata: { method: options.method || 'GET', transport: 'browser', transportMessage },
    })
    throw error
  }
  emitApiConnectionState(true, {
    path,
    method: options.method || 'GET',
    status: response.status,
  })

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  try {
    return unwrapPayload<T>(payload, response.ok, response.status)
  } catch (error) {
    void reportClientError(error, {
      source: 'api',
      feature: 'backend-api',
      action: 'browser-api-response',
      apiPath: path,
      status: response.status,
      metadata: { method: options.method || 'GET' },
    })
    throw error
  }
}

function unwrapPayload<T>(payload: unknown, ok: boolean, status: number): T {
  const objectPayload =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null

  if (!ok) {
    const errorPayload = objectPayload?.error && typeof objectPayload.error === 'object'
      ? objectPayload.error as Record<string, unknown>
      : null
    if (objectPayload && errorPayload?.message && !objectPayload.message) {
      objectPayload.message = errorPayload.message
    }
    throw toApiError(
      String(objectPayload?.message || objectPayload?.detail || `请求失败：${status}`),
      status,
      objectPayload || undefined,
    )
  }

  if (objectPayload && 'success' in objectPayload) {
    if (objectPayload.success === false) {
      const errorPayload = objectPayload.error && typeof objectPayload.error === 'object'
        ? objectPayload.error as Record<string, unknown>
        : null
      throw toApiError(
        String(errorPayload?.message || objectPayload.message || objectPayload.detail || '请求失败'),
        status,
        objectPayload,
      )
    }
    if ('data' in objectPayload) {
      return objectPayload.data as T
    }
  }

  if (objectPayload && 'code' in objectPayload && ('data' in objectPayload || !looksLikeDirectResourcePayload(objectPayload))) {
    if (objectPayload.code !== 0) {
      throw toApiError(
        String(objectPayload.message || '请求失败'),
        status,
        objectPayload,
      )
    }
    return objectPayload.data as T
  }

  return payload as T
}

function looksLikeDirectResourcePayload(payload: Record<string, unknown>) {
  return [
    'id',
    'number',
    'requestId',
    'request_id',
    'status',
    'smsCode',
    'sms_code',
    'smsText',
    'sms_text',
    'verificationCode',
    'verification_code',
  ].some((key) => key in payload)
}

export function isTotpRequired(response: AuthResponse | TotpLoginResponse): response is TotpLoginResponse {
  return 'requires_2fa' in response && response.requires_2fa === true
}

export async function loginWithPassword(email: string, password: string) {
  return apiRequest<AuthResponse | TotpLoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  }, '')
}

export async function registerWithPassword(request: RegisterRequest) {
  return apiRequest<AuthResponse | TotpLoginResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(request),
  }, '', { auth: 'none' })
}

function normalizeApiBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function createApiRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

function desktopForwardHeaders(headers: Headers) {
  const allowed = ['Idempotency-Key', 'Accept-Language', 'X-Request-ID']
  return Object.fromEntries(allowed
    .map((name) => [name, headers.get(name)?.trim() || ''] as const)
    .filter(([, value]) => Boolean(value)))
}

function apiRequestCandidates(requestOptions: ApiRequestOptions): ApiRequestCandidate[] {
  const primaryBaseUrl = normalizeApiBaseUrl(requestOptions.baseUrl || getApiBaseUrl())
  if (requestOptions.retryPolicy === 'none' || !requestOptions.retryPolicy || !requestOptions.serviceScope) {
    return [{ serverId: 'current', serverName: '当前线路', baseUrl: primaryBaseUrl, selected: true }]
  }

  const runtimeCandidates = getRuntimeApiCandidates(requestOptions.serviceScope)
  const matchingPrimary = runtimeCandidates.find((candidate) => (
    normalizeApiBaseUrl(candidate.baseUrl) === primaryBaseUrl
  ))
  const primary = matchingPrimary || {
    serverId: 'current',
    serverName: '当前线路',
    baseUrl: primaryBaseUrl,
    selected: true,
  }
  return [
    primary,
    ...runtimeCandidates.filter((candidate) => candidate.serverId !== primary.serverId),
  ].slice(0, 2)
}

function normalizeDesktopTransportFailure(cause: unknown): DesktopTransportFailure {
  let value: unknown = cause
  if (cause instanceof Error) value = cause.message
  if (typeof value === 'string') {
    const text = value
    try {
      value = JSON.parse(text)
    } catch {
      return {
        kind: /timed?\s*out|timeout/i.test(text) ? 'timeout' : 'connect',
        message: text.slice(0, 500),
        retryable: true,
      }
    }
  }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    kind: String(record.kind || 'connect').trim().toLowerCase(),
    message: String(record.message || 'desktop transport request failed').slice(0, 500),
    retryable: typeof record.retryable === 'boolean' ? record.retryable : true,
    elapsedMs: Number.isFinite(Number(record.elapsedMs)) ? Number(record.elapsedMs) : undefined,
    host: String(record.host || '').trim() || undefined,
  }
}

function isRetryableGatewayError(error: unknown) {
  const apiError = error as ApiError
  if (![502, 503, 504].includes(Number(apiError?.status || 0))) return false
  return !String(apiError?.code || apiError?.reason || '').trim()
}

function paymentTransportErrorMessage(failure: DesktopTransportFailure, attemptedCount: number) {
  if (failure.kind === 'timeout') return '支付服务器响应较慢，请稍后重试。'
  if (attemptedCount > 1) return '当前主线路和备用线路均暂时无法连接，请稍后重试。'
  return '当前线路暂时无法连接支付服务器，请稍后重试。'
}

export async function getPublicRegistrationSettings() {
  return apiRequest<PublicRegistrationSettings>('/settings/public', {
    method: 'GET',
  }, '', { auth: 'none' })
}

export async function inspectAffiliateInviteToken(token: string) {
  return apiRequest<AffiliateInviteInspection>('/auth/affiliate-invite/inspect', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }, '', { auth: 'none' })
}

export async function sendRegistrationVerifyCode(email: string, turnstileToken = '') {
  return apiRequest<{ message?: string; countdown?: number }>('/auth/send-verify-code', {
    method: 'POST',
    body: JSON.stringify({
      email,
      turnstile_token: turnstileToken,
    }),
  }, '', { auth: 'none' })
}

export async function redeemAndRegister(code: string, password?: string) {
  return apiRequest<DesktopRedeemRegisterResponse>('/desktop/redeem-register', {
    method: 'POST',
    body: JSON.stringify({
      code,
      ...(password ? { password, initial_password: password } : {}),
    }),
  }, '')
}

export async function getCurrentUser(token?: string) {
  return apiRequest<ApiUser>('/auth/me', { method: 'GET' }, token)
}

export async function getAffiliateDetail(token?: string) {
  return apiRequest<AffiliateDetail>('/user/aff', { method: 'GET' }, token)
}

export async function createAffiliateShareToken(token?: string) {
  return apiRequest<AffiliateShareToken>('/user/aff/share-token', {
    method: 'POST',
    body: JSON.stringify({}),
  }, token)
}

export async function bindAffiliateInviter(inviter: string, token?: string) {
  return apiRequest<AffiliateDetail>('/user/aff/bind', {
    method: 'POST',
    body: JSON.stringify({ inviter }),
  }, token)
}

export async function claimAffiliateReward(token?: string) {
  return apiRequest<AffiliateTransferResult>('/user/aff/transfer', {
    method: 'POST',
    body: JSON.stringify({}),
  }, token)
}

export async function requestAffiliateWithdrawal(token?: string) {
  return apiRequest<AffiliateWithdrawal>('/user/aff/withdrawals', {
    method: 'POST',
    body: JSON.stringify({}),
  }, token)
}

export async function updateCurrentUser(request: UpdateCurrentUserRequest, token?: string) {
  try {
    return await apiRequest<ApiUser>('/user', {
      method: 'PUT',
      body: JSON.stringify(request),
    }, token)
  } catch (error) {
    const status = (error as ApiError)?.status
    if (status !== 404 && status !== 405) throw error
    throw toApiError('账号资料保存接口暂不可用，请稍后重试或联系售后。', status)
  }
}

export async function changePassword(request: ChangePasswordRequest, token?: string) {
  return apiRequest<{ message?: string } | null>('/user/password', {
    method: 'PUT',
    body: JSON.stringify(request),
  }, token)
}

export async function submitAccountChange(
  request: SubmitAccountChangeRequest,
  token?: string,
) {
  return apiRequest<SubmitAccountChangeResponse>(
    '/v1/desktop/account-change',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl() },
  )
}

export async function redeemCode(code: string, token?: string) {
  return apiRequest<RedeemResponse>('/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  }, token)
}

export async function listRedeemHistory(token?: string, options: { includeBalanceBonus?: boolean } = {}) {
  const path = options.includeBalanceBonus ? '/redeem/history?include_balance_bonus=true' : '/redeem/history'
  return apiRequest<RedeemHistoryItem[]>(path, { method: 'GET' }, token)
}

export async function createPaymentOrder(paymentAmount: number, token?: string, options: CreatePaymentOrderOptions = {}) {
  const orderType = options.orderType || 'balance'
  const idempotencyKey = options.idempotencyKey || `desktop-payment:${createApiRequestId()}`
  return apiRequest<PaymentOrder>('/payment/orders', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      amount: paymentAmount,
      payment_type: 'alipay',
      order_type: orderType,
      is_mobile: false,
      payment_mode: 'qrcode',
      pay_origin: getPayOrigin(),
      ...(orderType === 'balance' && options.onlinePaymentPlanId ? {
        online_payment_plan_id: options.onlinePaymentPlanId,
      } : {}),
      ...(orderType === 'official_sub' && options.officialPlanId ? {
        official_plan_id: options.officialPlanId,
      } : {}),
      ...(orderType === 'official_sub' && options.officialSubscriptionSession ? {
        official_subscription_session: options.officialSubscriptionSession,
      } : {}),
      ...(orderType === 'official_sub' && options.officialReferral ? {
        official_referral: options.officialReferral,
      } : {}),
      ...(orderType === 'subscription' ? {
        ...(options.planId ? { plan_id: options.planId } : {}),
        ...(options.subscriptionGroupId ? { subscription_group_id: options.subscriptionGroupId } : {}),
        ...(options.subscriptionDays ? { subscription_days: options.subscriptionDays } : {}),
      } : {}),
    }),
  }, token, {
    serviceScope: 'core',
    retryPolicy: 'idempotent-write',
  })
}

export async function getOfficialSubscriptionPrices(token?: string) {
  return apiRequest<OfficialSubscriptionPricePlan[]>(
    '/v1/desktop/subscription-prices',
    { method: 'GET' },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'safe-read' },
  )
}

export interface OfficialReferralPrepareResult {
  config: { enabled: boolean; online_payment_only: boolean; allow_stacking: boolean; excess_not_refundable: boolean }
  account_email: string
  plan_id: string
  relation?: { status: string; inviter_email?: string }
  coupons: { id: number; plan_id: string; face_amount: number; status: string; beneficiary: string }[]
  reward_preview: { plan_id: string; invitee_amount: number; inviter_amount: number }
}

export interface OfficialReferralSummary {
  bound_invites: number
  qualified_invites: number
  available_coupons: number
  available_amount: number
  coupons_by_plan: { plan_id: string; available_coupons: number; available_amount: number }[]
}

export async function prepareOfficialSubscriptionReferral(
  payload: { account_email: string; session_json: string; plan_id: string; inviter_email: string },
  token?: string,
) {
  return apiRequest<OfficialReferralPrepareResult>('/v1/desktop/subscriptions/referrals/prepare', {
    method: 'POST', body: JSON.stringify(payload),
  }, token, { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'safe-read' })
}

export async function getOfficialSubscriptionReferralSummary(accountEmail: string, token?: string) {
  return apiRequest<OfficialReferralSummary>('/v1/desktop/subscriptions/referrals/summary', {
    method: 'POST', body: JSON.stringify({ account_email: accountEmail }),
  }, token, { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'safe-read' })
}

export async function getPlatformSubscriptionPlansFromSoftwareAdmin(token?: string) {
  return apiRequest<PlatformSubscriptionPlanConfig[]>(
    '/v1/desktop/platform-subscription/plans',
    { method: 'GET' },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'safe-read' },
  )
}

export async function getOnlinePaymentConfigFromSoftwareAdmin(token?: string) {
  return apiRequest<OnlinePaymentConfig>(
    '/v1/desktop/online-payment/config',
    { method: 'GET' },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'safe-read' },
  )
}

export async function registerOnlinePaymentOrderSnapshot(
  payload: {
    sub2OrderId: number | string
    snapshot: OnlinePaymentSnapshot
    userId?: string | number
    email?: string
    username?: string
  },
  token?: string,
) {
  return apiRequest<OnlinePaymentSnapshotRegistrationResult>(
    '/v1/desktop/online-payment/order-snapshot',
    {
      method: 'POST',
      body: JSON.stringify({
        sub2OrderId: payload.sub2OrderId,
        planId: payload.snapshot.planId,
        snapshot: payload.snapshot,
        ...(typeof payload.userId !== 'undefined' && payload.userId !== null ? { userId: String(payload.userId) } : {}),
        ...(payload.email ? { email: payload.email } : {}),
        ...(payload.username ? { username: payload.username } : {}),
      }),
    },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'idempotent-write' },
  )
}

export async function applyOnlinePaymentBonus(
  payload: {
    sub2OrderId: number | string
    planId?: string
    snapshot?: OnlinePaymentSnapshot | null
    userId?: string | number
    email?: string
    username?: string
  },
  token?: string,
) {
  return apiRequest<OnlinePaymentBonusResult>(
    '/v1/desktop/online-payment/bonus',
    {
      method: 'POST',
      body: JSON.stringify({
        sub2OrderId: payload.sub2OrderId,
        planId: payload.planId,
        ...(payload.snapshot ? { snapshot: payload.snapshot } : {}),
        ...(typeof payload.userId !== 'undefined' && payload.userId !== null ? { userId: String(payload.userId) } : {}),
        ...(payload.email ? { email: payload.email } : {}),
        ...(payload.username ? { username: payload.username } : {}),
      }),
    },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'idempotent-write' },
  )
}

export async function registerPlatformSubscriptionOrder(
  payload: PlatformSubscriptionOrderRegisterRequest,
  token?: string,
) {
  return apiRequest<PlatformSubscriptionOrderRecord>(
    '/v1/desktop/platform-subscription/orders/register',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'idempotent-write' },
  )
}

export async function activatePlatformSubscriptionOrder(
  orderId: string,
  token?: string,
  payload?: PlatformSubscriptionActivationRequest,
) {
  return apiRequest<{
    order?: PlatformSubscriptionOrderRecord
    subscription?: ActiveSubscription | null
    grant?: Record<string, unknown>
    replayed?: boolean
  }>(
    `/v1/desktop/platform-subscription/orders/${encodeURIComponent(orderId)}/activate`,
    {
      method: 'POST',
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'idempotent-write' },
  )
}

export async function getMyPlatformSubscriptionFromSoftwareAdmin(
  params: { userId?: string | number; email?: string },
  token?: string,
) {
  const searchParams = new URLSearchParams()
  if (typeof params.userId !== 'undefined' && params.userId !== null && String(params.userId).trim()) {
    searchParams.set('userId', String(params.userId))
  }
  if (params.email?.trim()) searchParams.set('email', params.email.trim())
  return apiRequest<PlatformSubscriptionMyResponse>(
    `/v1/desktop/platform-subscription/my?${searchParams.toString()}`,
    { method: 'GET' },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl(), serviceScope: 'software-admin', retryPolicy: 'safe-read' },
  )
}

export async function submitOfficialSubscriptionSession(
  orderId: number,
  payload: OfficialSubscriptionSessionUploadRequest,
  token?: string,
) {
  return apiRequest<{ submitted?: boolean; saved?: boolean }>(`/payment/orders/${orderId}/official-subscription-session`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token, {
    serviceScope: 'core',
    retryPolicy: 'idempotent-write',
  })
}

export async function submitOfficialSubscriptionToSoftwareAdmin(
  payload: OfficialSubscriptionSoftwareAdminUploadRequest,
  token?: string,
) {
  return apiRequest<OfficialSubscriptionSoftwareAdminResponse>(
    '/desktop/subscriptions',
    {
      method: 'POST',
      body: JSON.stringify({ ...payload, subscriptionOrigin: 'software' }),
    },
    token,
    { serviceScope: 'core', retryPolicy: 'idempotent-write' },
  )
}

export async function submitOfficialSubscriptionCardSecretToSoftwareAdmin(
  payload: OfficialSubscriptionSoftwareAdminUploadRequest,
  token?: string,
) {
  return apiRequest<OfficialSubscriptionSoftwareAdminResponse>(
    '/desktop/subscriptions/card-secret',
    {
      method: 'POST',
      body: JSON.stringify({ ...payload, subscriptionOrigin: 'software' }),
    },
    token,
    { serviceScope: 'core', retryPolicy: 'idempotent-write' },
  )
}

export async function listOfficialSubscriptionsFromSoftwareAdmin(
  params: { userId?: string; email?: string; username?: string; user?: string },
  token?: string,
) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (typeof value !== 'undefined' && value !== null && String(value).trim() !== '') {
      searchParams.set(key, String(value))
    }
  })
  const query = searchParams.toString()
  return apiRequest<OfficialSubscriptionSoftwareAdminOrder[]>(
    `/desktop/subscriptions${query ? `?${query}` : ''}`,
    { method: 'GET' },
    token,
    { serviceScope: 'core', retryPolicy: 'safe-read' },
  )
}

export async function getPaymentOrder(orderId: number, token?: string) {
  return apiRequest<PaymentOrder>(`/payment/orders/${orderId}`, { method: 'GET' }, token, {
    serviceScope: 'core',
    retryPolicy: 'safe-read',
  })
}

export async function verifyPaymentOrderByOutTradeNo(outTradeNo: string, token?: string) {
  return apiRequest<PaymentOrder>('/payment/orders/verify', {
    method: 'POST',
    body: JSON.stringify({ out_trade_no: outTradeNo }),
  }, token, {
    serviceScope: 'core',
    retryPolicy: 'idempotent-write',
  })
}

export async function listPaymentOrders(token?: string, options: ListPaymentOrdersOptions = {}) {
  const params = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 100),
  })
  if (options.status) params.set('status', options.status)
  if (options.orderType) params.set('order_type', options.orderType)
  if (options.paymentType) params.set('payment_type', options.paymentType)
  return apiRequest<PaginatedResponse<PaymentOrder>>(`/payment/orders/my?${params.toString()}`, { method: 'GET' }, token)
}

export async function cancelPaymentOrder(orderId: number, token?: string) {
  return apiRequest<Partial<PaymentOrder> | null>(`/payment/orders/${orderId}/cancel`, {
    method: 'POST',
  }, token)
}

export async function getActiveSubscription(token?: string) {
  return apiRequest<ActiveSubscription | ActiveSubscription[] | null>('/subscriptions/active', { method: 'GET' }, token)
}

export async function getSubscriptionSummary(token?: string) {
  return apiRequest<SubscriptionSummary>('/subscriptions/summary', { method: 'GET' }, token)
}

export async function getAvailableGroups(token?: string) {
  return apiRequest<Group[]>('/groups/available', { method: 'GET' }, token)
}

export async function getApiKeys(
  token?: string,
  options: {
    page?: number
    pageSize?: number
    search?: string
    groupId?: number
    status?: string
  } = {},
) {
  const params = new URLSearchParams({
    page: String(options.page ?? 1),
    page_size: String(options.pageSize ?? 100),
  })
  if (options.search) params.set('search', options.search)
  if (options.groupId) params.set('group_id', String(options.groupId))
  if (options.status) params.set('status', options.status)
  return apiRequest<PaginatedResponse<ApiKey>>(`/keys?${params.toString()}`, { method: 'GET' }, token)
}

export async function createApiKey(name: string, groupId: number | null, token?: string) {
  return apiRequest<ApiKey>('/keys', {
    method: 'POST',
    body: JSON.stringify({ name, group_id: groupId }),
  }, token)
}

export async function deleteApiKey(id: number, token?: string) {
  return apiRequest<{ deleted?: boolean } | null>(`/keys/${id}`, {
    method: 'DELETE',
  }, token)
}

export async function updateApiKey(id: number, updates: { group_id?: number | null }, token?: string) {
  return apiRequest<ApiKey>(`/keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  }, token)
}

export type DefaultApiKeyPurpose = 'codex' | 'claude' | 'image2'

function getDefaultApiKeyName(purpose: DefaultApiKeyPurpose = 'codex') {
  if (purpose === 'claude') return '默认-claude'
  if (purpose === 'image2') return '默认-image-2'
  return '默认-codex'
}

export async function ensureDefaultApiKey(
  groupId: number,
  token?: string,
  purpose: DefaultApiKeyPurpose = 'codex',
  options: { preferredId?: number; syncGroup?: boolean } = {},
) {
  const keyName = getDefaultApiKeyName(purpose)
  const shouldSyncGroup = options.syncGroup !== false
  const keys = await getApiKeys(token, {
    page: 1,
    pageSize: 100,
    search: keyName,
    ...(purpose === 'image2' ? { groupId } : {}),
  })

  const candidates = keys.items.filter((item) => (
    item.name === keyName &&
    (purpose === 'image2' ? Number(item.group_id) === Number(groupId) : true) &&
    item.status === 'active' &&
    item.key
  ))
  const existing = (
    candidates.find((item) => Number(item.id) === Number(options.preferredId)) ||
    candidates[0]
  )

  if (!existing) return createApiKey(keyName, groupId, token)
  if (purpose === 'image2' || !shouldSyncGroup || Number(existing.group_id) === Number(groupId)) {
    return existing
  }

  const updated = await updateApiKey(existing.id, { group_id: groupId }, token)
  return {
    ...existing,
    ...updated,
    key: updated.key || existing.key,
  }
}

export async function ensureNamedApiKey(name: string, groupId: number, token?: string) {
  const keyName = name.trim()
  const keys = await getApiKeys(token, {
    page: 1,
    pageSize: 100,
    search: keyName,
    groupId,
  })

  const existing = keys.items.find((item) => (
    item.name === keyName &&
    Number(item.group_id) === Number(groupId) &&
    item.status === 'active' &&
    item.key
  ))

  return existing || createApiKey(keyName, groupId, token)
}

export async function getUsageLogs(token?: string, options: UsageLogQueryOptions = {}) {
  const page = options.page ?? 1
  const pageSize = options.pageSize ?? 50
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    sort_by: 'created_at',
    sort_order: 'desc',
  })
  if (options.apiKeyId && options.apiKeyId !== 'all') params.set('api_key_id', String(options.apiKeyId))
  if (options.startDate) params.set('start_date', options.startDate)
  if (options.endDate) params.set('end_date', options.endDate)
  if (options.timezone) params.set('timezone', options.timezone)
  return apiRequest<PaginatedResponse<UsageLog>>(`/usage?${params.toString()}`, { method: 'GET' }, token)
}

export async function getUsageStats(token?: string, options: UsageLogQueryOptions = {}) {
  const params = new URLSearchParams()
  if (options.apiKeyId && options.apiKeyId !== 'all') params.set('api_key_id', String(options.apiKeyId))
  if (options.startDate) params.set('start_date', options.startDate)
  if (options.endDate) params.set('end_date', options.endDate)
  if (options.timezone) params.set('timezone', options.timezone)
  return apiRequest<UsageStats>(`/usage/stats?${params.toString()}`, { method: 'GET' }, token)
}

export async function getUsageDashboardStats(token?: string) {
  return apiRequest<UserDashboardStats>('/usage/dashboard/stats', { method: 'GET' }, token)
}

export async function getDesktopTutorial(token?: string) {
  return apiRequest<DesktopTutorialResponse>(DESKTOP_TUTORIAL_ENDPOINT, { method: 'GET' }, token)
}

export async function getDesktopContact(token?: string) {
  return apiRequest<DesktopContactResponse>('/desktop/contact', { method: 'GET' }, token)
}

export async function getDesktopAnnouncements(token?: string) {
  return apiRequest<DesktopAnnouncementsResponse>('/desktop/announcements', { method: 'GET' }, token)
}

export async function submitDesktopFeedback(
  payload: SubmitDesktopFeedbackRequest,
  token?: string,
) {
  return apiRequest<SubmitDesktopFeedbackResponse>('/desktop/feedback', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token)
}

export async function listDesktopInvoices(
  params: { userId?: string | number; email?: string },
  token?: string,
) {
  const searchParams = new URLSearchParams()
  if (params.userId) searchParams.set('userId', String(params.userId))
  if (params.email) searchParams.set('email', params.email)
  const query = searchParams.toString()
  return apiRequest<DesktopInvoiceApplication[]>(
    `/v1/desktop/invoices${query ? `?${query}` : ''}`,
    { method: 'GET' },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl() },
  )
}

export async function createDesktopInvoiceApplication(
  payload: CreateDesktopInvoiceApplicationRequest,
  token?: string,
) {
  return apiRequest<DesktopInvoiceApplication>('/v1/desktop/invoices', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token, { baseUrl: getSoftwareAdminApiBaseUrl() })
}

export async function listDesktopInvoiceBatchApplications(
  params: { userId?: string | number; email?: string },
  token?: string,
) {
  const searchParams = new URLSearchParams()
  if (params.userId) searchParams.set('userId', String(params.userId))
  if (params.email) searchParams.set('email', params.email)
  const query = searchParams.toString()
  return apiRequest<DesktopInvoiceApplication[]>(
    `/v2/desktop/invoices${query ? `?${query}` : ''}`,
    { method: 'GET' },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl() },
  )
}

export async function createDesktopInvoiceBatchApplication(
  payload: CreateDesktopInvoiceBatchApplicationRequest,
  token?: string,
) {
  return apiRequest<DesktopInvoiceApplication>('/v2/desktop/invoices', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token, { baseUrl: getSoftwareAdminApiBaseUrl() })
}

export async function listDesktopProjectOutsourcingRequests(
  params: { userId?: string | number; email?: string },
  token?: string,
) {
  const searchParams = new URLSearchParams()
  if (params.userId) searchParams.set('userId', String(params.userId))
  if (params.email) searchParams.set('email', params.email)
  const query = searchParams.toString()
  return apiRequest<DesktopProjectOutsourcingRequest[]>(
    `/v1/desktop/project-outsourcing${query ? `?${query}` : ''}`,
    { method: 'GET' },
    token,
    { baseUrl: getSoftwareAdminApiBaseUrl() },
  )
}

export async function createDesktopProjectOutsourcingRequest(
  payload: CreateDesktopProjectOutsourcingRequest,
  token?: string,
) {
  return apiRequest<DesktopProjectOutsourcingRequest>('/v1/desktop/project-outsourcing', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, token, { baseUrl: getSoftwareAdminApiBaseUrl() })
}

export async function reportDesktopTelemetry(
  event: DesktopTelemetryEvent,
  payload: DesktopTelemetryPayload,
  options: { keepalive?: boolean } = {},
) {
  return apiRequest<DesktopTelemetryResponse>(`/desktop/telemetry/${event}`, {
    method: 'POST',
    body: JSON.stringify(payload),
    keepalive: options.keepalive,
  }, '')
}

function pathSegment(value: string) {
  return encodeURIComponent(value)
}

function smsReceiverApiRequest<T>(path: string, options: RequestInit = {}, token?: string) {
  return apiRequest<T>(path, options, token, { baseUrl: getSmsReceiverApiBaseUrl() })
}

function readSmsReceiverString(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

function readSmsReceiverNestedPayload(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function extractSmsReceiverCode(text: string) {
  const normalized = String(text || '').trim()
  if (!normalized) return ''
  const preferred = normalized.match(/(?:\u9a8c\u8bc1\u7801|\u9a8c\u8bc1\u4ee3\u7801|\u6821\u9a8c\u7801|\u52a8\u6001\u7801|verification\s*code|verify\s*code|code|otp)[^\d]{0,24}(\d{4,8})/i)
  if (preferred?.[1]) return preferred[1]
  const fallback = normalized.match(/\b\d{4,8}\b/)
  return fallback?.[0] || ''
}

function normalizeSmsReceiverCode(value: string) {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  if (/^\d{4,8}$/.test(normalized)) return normalized
  return extractSmsReceiverCode(normalized)
}

function normalizeSmsReceiverOrder(order: SmsReceiverOrder) {
  const payload = order as SmsReceiverOrder & Record<string, unknown>
  const smsPayload = readSmsReceiverNestedPayload(payload, 'sms')
  const nestedCode = smsPayload
    ? normalizeSmsReceiverCode(readSmsReceiverString(smsPayload, ['code', 'smsCode', 'sms_code', 'verificationCode', 'verification_code', 'otp']))
    : ''
  const nestedText = smsPayload
    ? readSmsReceiverString(smsPayload, ['text', 'smsText', 'sms_text', 'content', 'body', 'message', 'msg'])
    : ''
  const explicitSmsText = readSmsReceiverString(payload, ['smsText', 'sms_text', 'text', 'content', 'body', 'sms']) || nestedText
  const genericMessage = readSmsReceiverString(payload, ['message', 'msg'])
  const directCode = normalizeSmsReceiverCode(readSmsReceiverString(payload, [
    'smsCode',
    'sms_code',
    'verificationCode',
    'verification_code',
    'verifyCode',
    'verify_code',
    'otp',
    'code',
  ]))
  const smsCode = directCode || nestedCode || extractSmsReceiverCode(explicitSmsText) || extractSmsReceiverCode(genericMessage)
  const smsText = explicitSmsText || (extractSmsReceiverCode(genericMessage) ? genericMessage : '')

  if (!smsCode && !smsText) return order

  return {
    ...order,
    smsCode: smsCode || order.smsCode,
    smsText: smsText || order.smsText,
  }
}

export async function getSmsReceiverConfig(token?: string) {
  return smsReceiverApiRequest<SmsReceiverConfig>('/sms-receiver/config', { method: 'GET' }, token)
}

export async function listSmsReceiverServices(token?: string) {
  return smsReceiverApiRequest<SmsReceiverServiceItem[]>('/sms-receiver/services', { method: 'GET' }, token)
}

export async function listSmsReceiverOptions(
  token?: string,
  params: {
    service?: string
    country?: string
    page?: number
    pages?: number
    language?: string
    minAmount?: number | string
    maxAmount?: number | string
    sort?: string
  } = {},
) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (typeof value !== 'undefined' && value !== null && String(value).trim() !== '') {
      searchParams.set(key, String(value))
    }
  })
  const query = searchParams.toString()
  return smsReceiverApiRequest<SmsReceiverOption[]>(
    `/sms-receiver/options${query ? `?${query}` : ''}`,
    { method: 'GET' },
    token,
  )
}

export async function listSmsReceiverOrders(token?: string) {
  const orders = await smsReceiverApiRequest<SmsReceiverOrder[]>('/sms-receiver/orders', { method: 'GET' }, token)
  return Array.isArray(orders) ? orders.map(normalizeSmsReceiverOrder) : orders
}

export async function requestSmsReceiverNumber(payload: SmsReceiverNumberRequest, token?: string) {
  const normalizedPayload: SmsReceiverNumberRequest = {
    ...payload,
    service_id: payload.service_id || payload.serviceId,
    service_name: payload.service_name || payload.serviceName,
    luban_service_name: payload.luban_service_name || payload.lubanServiceName,
    country_name_zh: payload.country_name_zh || payload.countryNameZh,
    country_name_en: payload.country_name_en || payload.countryNameEn,
    country_code: payload.country_code || payload.countryCode,
    cost_usd: payload.cost_usd ?? payload.costUsd,
    client_order_id: payload.client_order_id || payload.clientOrderId,
  }
  const query = normalizedPayload.service_id
    ? `?service_id=${encodeURIComponent(normalizedPayload.service_id)}`
    : ''
  const order = await smsReceiverApiRequest<SmsReceiverOrder>(`/sms-receiver/numbers${query}`, {
    method: 'POST',
    body: JSON.stringify(normalizedPayload),
  }, token)
  return normalizeSmsReceiverOrder(order)
}

export async function pollSmsReceiverCode(orderId: string, token?: string) {
  const order = await smsReceiverApiRequest<SmsReceiverOrder>(`/sms-receiver/numbers/${pathSegment(orderId)}/sms`, { method: 'GET' }, token)
  return normalizeSmsReceiverOrder(order)
}

export async function cancelSmsReceiverNumber(orderId: string, token?: string, reason = 'desktop_sms_cancel') {
  const order = await smsReceiverApiRequest<SmsReceiverOrder>(`/sms-receiver/numbers/${pathSegment(orderId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }, token)
  return normalizeSmsReceiverOrder(order)
}
