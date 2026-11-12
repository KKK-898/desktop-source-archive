<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ArrowRight, Check, ChevronDown, LoaderCircle, Plus, Settings2, Trash2, X } from 'lucide-vue-next'

type Group = { providerId: string; providerName: string; groupId: string; groupName: string; models: string[] }
const props = defineProps<{ groups: Group[] }>()
const emit = defineEmits<{ saved: [snapshot: GaogeAggregateSettings] }>()
const dialogOpen = ref(false)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const snapshot = ref<GaogeAggregateSettings | null>(null)
const draftGroups = ref<GaogeAggregateGroupSettings[]>([])
const providers = ref<GaogeAggregateExternalProvider[]>([])
type AggregateSource = 'builtin' | 'custom'
const selectedSource = ref<AggregateSource>('builtin')
const selectedTarget = ref('')
const targetBySource = ref<Record<AggregateSource, string>>({ builtin: '', custom: '' })
const modelByTarget = ref<Record<string, string>>({})
const pendingModelByTarget = ref<Record<string, string>>({})
const selectedPreset = ref('')
const pendingDelete = ref('')
const manualModel = computed({
  get: () => pendingModelByTarget.value[selectedTarget.value] || '',
  set: value => { pendingModelByTarget.value[selectedTarget.value] = value },
})
const dialog = ref<HTMLElement | null>(null)
const launcher = ref<HTMLButtonElement | null>(null)
const protocols: { value: GaogeAggregateProtocol; label: string }[] = [
  { value: 'responses', label: 'OpenAI Responses' },
  { value: 'chatCompletions', label: 'OpenAI Chat Completions' },
  { value: 'anthropicMessages', label: 'Anthropic Messages' },
]
const groupKey = (group: Pick<Group, 'providerId' | 'groupId'>) => `group:${JSON.stringify([group.providerId, group.groupId])}`
const providerKey = (id: string) => `provider:${id}`
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const presets = computed(() => snapshot.value?.presets || [])
const modelCatalog = computed(() => snapshot.value?.modelCatalog || [])
const selectedGroup = computed(() => props.groups.find(group => groupKey(group) === selectedTarget.value))
const selectedProvider = computed(() => providers.value.find(provider => providerKey(provider.id) === selectedTarget.value))
const activeSettings = computed(() => selectedProvider.value || draftGroups.value.find(group => groupKey(group) === selectedTarget.value))
const activeModels = computed(() => selectedProvider.value?.models || selectedGroup.value?.models || [])
const selectedModel = computed({
  get: () => activeModels.value.includes(modelByTarget.value[selectedTarget.value] || '') ? modelByTarget.value[selectedTarget.value]! : activeModels.value[0] || '',
  set: value => { modelByTarget.value[selectedTarget.value] = value },
})
const enabledProviders = computed(() => providers.value.filter(provider => provider.enabled !== false))
const builtinModelCount = computed(() => props.groups.reduce((count, group) => count + group.models.length, 0))
const customModelCount = computed(() => enabledProviders.value.reduce((count, provider) => count + provider.models.length, 0))
const activeModelConfig = computed(() => activeSettings.value?.modelSettings[selectedModel.value] || {})
const activeMetadata = computed(() => findMetadata(selectedModel.value))
const activeTitle = computed(() => selectedProvider.value?.name || selectedGroup.value?.groupName || '选择一个接口')
const busy = computed(() => loading.value || saving.value)
const keyMustChange = computed(() => {
  const provider = selectedProvider.value
  return Boolean(provider?.keyConfigured && routeChanged(provider))
})
const fastDescription = computed(() => {
  if (activeSettings.value?.protocol === 'anthropicMessages') return '该协议不支持映射原生 Fast。'
  if (activeModelConfig.value.fast === 'supported') return '手动声明此模型支持原生 Fast。'
  if (activeModelConfig.value.fast === 'unsupported') return '此模型关闭 Fast。'
  const metadata = activeMetadata.value?.metadata
  const speeds: unknown[] = ['service_tiers', 'supported_service_tiers', 'additional_speed_tiers'].flatMap(key => Array.isArray(metadata?.[key]) ? metadata[key] as unknown[] : [])
  const hasFast = speeds.some(value => {
    const id = typeof value === 'string' ? value : value && typeof value === 'object' && 'id' in value ? value.id : undefined
    return id === 'priority' || id === 'fast'
  })
  return hasFast ? '内置资料声明支持 Fast；原生模型资料优先。' : '跟随原生模型资料；没有声明时不启用 Fast。'
})
const effectiveWindow = computed(() => activeModelConfig.value.contextWindow || activeMetadata.value?.contextWindow)
const compactPreview = computed(() => {
  const percent = activeModelConfig.value.autoCompactPercent
  if (!percent) return '留空跟随模型设置'
  if (!effectiveWindow.value) return '设置窗口后可计算压缩阈值'
  return `${formatTokens(Math.floor(effectiveWindow.value * percent / 100))} tokens 时压缩`
})
function formatTokens(value: number) { return value.toLocaleString('en-US') }
function canonical(model: string) {
  const name = model.trim().toLowerCase().replaceAll('_', '-')
  return ({ k3: 'kimi-k3', 'gpt-5.6': 'gpt-5.6-sol', 'gpt-6': 'gpt-6-sol', 'grok-4.5-latest': 'grok-4.5', 'grok-build-latest': 'grok-4.5' } as Record<string, string>)[name] || name
}
function findMetadata(model: string) {
  const exact = model.trim().toLowerCase()
  const normalized = canonical(model)
  return modelCatalog.value.find(item => item.slug.toLowerCase() === exact)
    || modelCatalog.value.find(item => item.slug.toLowerCase() === normalized)
    || modelCatalog.value.find(item => normalized.startsWith(`${item.slug.toLowerCase()}-`) && /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(normalized.slice(item.slug.length + 1)))
}
function mergeGroups() {
  for (const group of props.groups) {
    if (!draftGroups.value.some(item => groupKey(item) === groupKey(group))) {
      draftGroups.value.push({ providerId: group.providerId, groupId: group.groupId, protocol: 'responses', modelSettings: {} })
    }
  }
  ensureSelection()
}
function ensureSelection() {
  const keys = selectedSource.value === 'builtin' ? props.groups.map(groupKey) : providers.value.map(provider => providerKey(provider.id))
  if (!keys.includes(selectedTarget.value)) selectedTarget.value = keys.includes(targetBySource.value[selectedSource.value]) ? targetBySource.value[selectedSource.value] : keys[0] || ''
  targetBySource.value[selectedSource.value] = selectedTarget.value
}
function selectSource(source: AggregateSource) {
  if (saving.value || selectedSource.value === source) return
  targetBySource.value[selectedSource.value] = selectedTarget.value
  selectedSource.value = source
  selectedTarget.value = targetBySource.value[source]
  pendingDelete.value = ''
  ensureSelection()
}
function sourceKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const source = event.key === 'Home' ? 'builtin' : event.key === 'End' ? 'custom' : selectedSource.value === 'builtin' ? 'custom' : 'builtin'
  selectSource(source)
  nextTick(() => dialog.value?.querySelector<HTMLButtonElement>(`#aggregate-source-${source}`)?.focus())
}
function toggleProvider() {
  if (!selectedProvider.value || saving.value) return
  selectedProvider.value.enabled = selectedProvider.value.enabled === false
  notice.value = selectedProvider.value.enabled ? '接口已启用，保存后重新写入聚合生效。' : '接口已停用，配置与密钥保留；保存后重新写入聚合生效。'
}
function applySnapshot(value: GaogeAggregateSettings) {
  const initialLoad = !snapshot.value
  snapshot.value = copy(value)
  draftGroups.value = copy(value.groups || [])
  providers.value = copy(value.providers || []).map(provider => ({ ...provider, source: 'custom', enabled: provider.enabled !== false, apiKey: '', modelSettings: provider.modelSettings || {} }))
  if (initialLoad && !props.groups.length) selectedSource.value = 'custom'
  mergeGroups()
}
function errorMessage(cause: unknown) {
  return typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '设置读取或保存失败，请重试。'
}
async function loadSettings() {
  loading.value = true
  error.value = ''
  try {
    if (!window.gaogeDesktop?.getAggregateModelSettings) throw new Error('请在桌面客户端中配置聚合模型。')
    const value = await window.gaogeDesktop.getAggregateModelSettings()
    applySnapshot(value)
    emit('saved', value)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
}
async function openDialog() {
  dialogOpen.value = true
  notice.value = ''
  mergeGroups()
  await nextTick()
  dialog.value?.focus()
}
function closeDialog() {
  if (saving.value) return
  dialogOpen.value = false
  if (snapshot.value) applySnapshot(snapshot.value)
  pendingModelByTarget.value = {}
  selectedPreset.value = ''
  pendingDelete.value = ''
  error.value = ''
  nextTick(() => launcher.value?.focus())
}
function trapFocus(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return }
  if (event.key !== 'Tab' || !dialog.value) return
  const elements = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length)
  const first = elements[0], last = elements.at(-1)
  if (!first || !last) return
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function ensureModelConfig() {
  const settings = activeSettings.value
  if (!settings || !selectedModel.value) return
  return settings.modelSettings[selectedModel.value] ||= {}
}
function setNumber(field: 'contextWindow' | 'autoCompactPercent', event: Event) {
  const config = ensureModelConfig()
  if (!config) return
  const value = (event.target as HTMLInputElement).value
  if (!value.trim()) delete config[field]
  else config[field] = Number(value)
  notice.value = ''
}
function setFast(event: Event) {
  const config = ensureModelConfig()
  if (!config) return
  const value = (event.target as HTMLSelectElement).value as GaogeAggregateModelConfig['fast']
  if (value === 'inherit') delete config.fast
  else config.fast = value
}
function resetModel() {
  if (activeSettings.value && selectedModel.value) delete activeSettings.value.modelSettings[selectedModel.value]
}
function protocolChanged() {
  const settings = activeSettings.value
  if (settings?.protocol !== 'anthropicMessages') return
  let changed = false
  for (const config of Object.values(settings.modelSettings)) {
    if (config.fast === 'supported') { config.fast = 'unsupported'; changed = true }
  }
  if (changed) notice.value = 'Anthropic 协议不支持原生 Fast，已关闭这些模型的 Fast。'
}
function routeChanged(provider: GaogeAggregateExternalProvider) {
  const original = snapshot.value?.providers.find(item => item.id === provider.id)
  const normalize = (value: string) => value.trim().replace(/\/+$/, '')
  return Boolean(original && (normalize(original.baseUrl) !== normalize(provider.baseUrl) || original.protocol !== provider.protocol))
}
function addProvider() {
  if (providers.value.length >= 50) { error.value = '最多可添加 50 个接口。'; return }
  const preset = presets.value.find(item => item.id === selectedPreset.value)
  const id = `external-${crypto.randomUUID().slice(0, 12)}`
  const models = [...new Set([preset?.model, ...(preset?.modelList || [])].filter((model): model is string => Boolean(model?.trim())))].map(model => model.trim())
  providers.value.push({ id, enabled: true, source: 'custom', vendor: preset?.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'custom', name: preset?.name || '自定义接口', baseUrl: preset?.baseUrl || '', protocol: preset?.protocol || 'responses', apiKey: '', keyConfigured: false, models, modelSettings: {} })
  selectedSource.value = 'custom'
  selectedTarget.value = providerKey(id)
  targetBySource.value.custom = selectedTarget.value
  selectedPreset.value = ''
  error.value = ''
  notice.value = ''
}
function removeProvider() {
  const provider = selectedProvider.value
  if (!provider || pendingDelete.value !== provider.id || saving.value) return
  providers.value = providers.value.filter(item => item.id !== provider.id)
  delete pendingModelByTarget.value[providerKey(provider.id)]
  delete modelByTarget.value[providerKey(provider.id)]
  pendingDelete.value = ''
  ensureSelection()
  notice.value = '接口已从草稿中移除，保存后生效。'
}
function addModel() {
  const provider = selectedProvider.value
  const model = manualModel.value.trim()
  if (!provider || !model) return
  if (model.length > 160 || /[\x00-\x1f\x7f]/.test(model)) { error.value = '模型 ID 无效，请检查名称。'; return }
  if (!provider.models.includes(model)) {
    if (provider.models.length >= 200) { error.value = '每个接口最多添加 200 个模型。'; return }
    provider.models.push(model)
  }
  selectedModel.value = model
  manualModel.value = ''
  error.value = ''
}
function removeModel() {
  const provider = selectedProvider.value
  if (!provider || !selectedModel.value) return
  const model = selectedModel.value
  provider.models = provider.models.filter(item => item !== model)
  delete provider.modelSettings[model]
}
function validateConfigs(settings: { protocol: GaogeAggregateProtocol; modelSettings: Record<string, GaogeAggregateModelConfig> }, label: string) {
  for (const [model, config] of Object.entries(settings.modelSettings)) {
    const window = config.contextWindow
    if (window != null && (!Number.isInteger(window) || window < 1024 || window > 100_000_000)) throw new Error(`${label} / ${model}：窗口须为 1,024 到 100,000,000 的整数。`)
    const percent = config.autoCompactPercent
    if (percent != null && (!Number.isInteger(percent) || percent < 10 || percent > 100)) throw new Error(`${label} / ${model}：自动压缩须为 10 到 100 的整数。`)
    if (settings.protocol === 'anthropicMessages' && config.fast === 'supported') throw new Error(`${label}：Anthropic 协议不支持原生 Fast。`)
  }
}
function savePayload(): Pick<GaogeAggregateSettings, 'groups' | 'providers'> {
  const groups = copy(draftGroups.value)
  groups.forEach(group => validateConfigs(group, props.groups.find(item => groupKey(item) === groupKey(group))?.groupName || group.groupId))
  const external = providers.value.map(provider => {
    const name = provider.name.trim()
    if (!name || name.length > 80) throw new Error('供应商名称须为 1 到 80 个字符。')
    let url: URL
    try { url = new URL(provider.baseUrl.trim()) } catch { throw new Error(`${name}：请输入完整的 API 地址。`) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name}：API 地址须为 HTTP/HTTPS 地址，且不能包含账号、查询参数或片段。`)
    if (!provider.apiKey.trim() && (!provider.keyConfigured || routeChanged(provider))) throw new Error(`${name}：${routeChanged(provider) ? '地址或协议已更改，请重新输入 API Key。' : '请输入 API Key。'}`)
    if (!provider.models.length) throw new Error(`${name}：至少添加一个模型。`)
    validateConfigs(provider, name)
    return { ...copy(provider), enabled: provider.enabled !== false, source: 'custom' as const, name, baseUrl: provider.baseUrl.trim(), apiKey: provider.apiKey.trim() }
  })
  return { groups, providers: external }
}
async function saveSettings() {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  try {
    const payload = savePayload()
    if (!window.gaogeDesktop?.saveAggregateModelSettings) throw new Error('当前客户端不支持保存聚合模型设置。')
    saving.value = true
    const value = await window.gaogeDesktop.saveAggregateModelSettings(payload)
    applySnapshot(value)
    emit('saved', value)
    notice.value = '已保存。点击开始／重新写入聚合后生效。'
  } catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}
watch(() => props.groups, mergeGroups, { deep: true })
watch(selectedTarget, () => { notice.value = ''; pendingDelete.value = ''; targetBySource.value[selectedSource.value] = selectedTarget.value })
onMounted(loadSettings)
</script>

<template>
  <section class="aggregate-settings-card" aria-label="聚合模型设置">
    <span class="aggregate-settings-icon"><Settings2 :size="20" /></span>
    <div class="aggregate-settings-summary"><h3>聚合模型</h3><p>内置聚合与自有聚合，按模型配置上下文与 Fast。</p></div>
    <span v-if="snapshot" class="aggregate-settings-count">{{ enabledProviders.length }} 个自有接口已启用</span>
    <button ref="launcher" class="aggregate-settings-open" type="button" :disabled="loading || !snapshot" @click="openDialog"><LoaderCircle v-if="loading" :size="15" class="is-spinning" /><span>模型设置</span><ArrowRight :size="15" /></button>
    <p v-if="error && !dialogOpen" class="aggregate-settings-inline-error">{{ error }} <button type="button" @click="loadSettings">重试</button></p>
  </section>
  <Teleport to="body">
    <div v-if="dialogOpen" class="aggregate-settings-overlay" @click.self="closeDialog">
      <section ref="dialog" class="aggregate-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="aggregate-settings-title" tabindex="-1" @keydown="trapFocus">
        <header class="aggregate-settings-head"><div><p class="aggregate-settings-eyebrow">AGGREGATE</p><h2 id="aggregate-settings-title">聚合模型</h2></div><button class="aggregate-icon-button" type="button" aria-label="关闭模型设置" :disabled="saving" @click="closeDialog"><X :size="20" /></button></header>
        <div class="aggregate-source-bar">
          <div class="aggregate-source-tabs" role="tablist" aria-label="聚合来源" @keydown="sourceKeydown">
            <button id="aggregate-source-builtin" type="button" role="tab" :aria-selected="selectedSource === 'builtin'" aria-controls="aggregate-source-panel" :tabindex="selectedSource === 'builtin' ? 0 : -1" :disabled="saving" @click="selectSource('builtin')">内置聚合<span>{{ groups.length }}</span></button>
            <button id="aggregate-source-custom" type="button" role="tab" :aria-selected="selectedSource === 'custom'" aria-controls="aggregate-source-panel" :tabindex="selectedSource === 'custom' ? 0 : -1" :disabled="saving" @click="selectSource('custom')">自有聚合<span>{{ providers.length }}</span></button>
          </div>
          <p>{{ selectedSource === 'builtin' ? `中转站已同步 · ${builtinModelCount} 个模型` : `自行添加接口 · ${customModelCount} 个模型已启用` }}</p>
        </div>
        <div id="aggregate-source-panel" class="aggregate-settings-body" role="tabpanel" :aria-labelledby="`aggregate-source-${selectedSource}`">
          <aside class="aggregate-settings-nav" aria-label="接口列表">
            <div v-if="selectedSource === 'builtin' && groups.length" class="aggregate-nav-section"><p>中转站分组</p><button v-for="group in groups" :key="groupKey(group)" type="button" :class="{ active: selectedTarget === groupKey(group) }" :disabled="saving" @click="selectedTarget = groupKey(group)"><strong>{{ group.groupName }}</strong><span>{{ group.providerName }} · {{ group.models.length }} 个模型</span></button></div>
            <div v-if="selectedSource === 'custom' && providers.length" class="aggregate-nav-section"><p>自有接口</p><button v-for="provider in providers" :key="provider.id" type="button" :class="{ active: selectedTarget === providerKey(provider.id), 'is-disabled': provider.enabled === false }" :disabled="saving" @click="selectedTarget = providerKey(provider.id)"><strong>{{ provider.name || '未命名接口' }}<i v-if="provider.enabled === false">已停用</i></strong><span>{{ provider.models.length }} 个模型</span></button></div>
            <div v-if="selectedSource === 'custom'" class="aggregate-add-provider"><label for="aggregate-provider-preset">添加接口</label><select id="aggregate-provider-preset" v-model="selectedPreset" :disabled="saving"><option value="">自定义供应商</option><option v-for="preset in presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option></select><button class="aggregate-subtle-button" type="button" :disabled="busy" @click="addProvider"><Plus :size="15" />添加接口</button></div>
          </aside>
          <main class="aggregate-settings-main">
            <div v-if="activeSettings" class="aggregate-settings-editor">
              <div class="aggregate-editor-heading"><div><h3>{{ activeTitle }}</h3><p>{{ selectedGroup ? `${selectedGroup.providerName} · 内置聚合` : '自有聚合 · 使用你自己的接口与模型' }}</p></div><div v-if="selectedProvider" class="aggregate-provider-actions"><button class="aggregate-provider-switch" type="button" role="switch" aria-label="接口启用状态" :aria-checked="selectedProvider.enabled !== false" :disabled="saving" @click="toggleProvider"><span class="aggregate-switch-track" aria-hidden="true"><span /></span>{{ selectedProvider.enabled === false ? '已停用' : '已启用' }}</button><button class="aggregate-icon-button danger" type="button" aria-label="移除此接口" :disabled="saving" @click="pendingDelete = selectedProvider.id"><Trash2 :size="17" /></button></div></div>
              <div v-if="selectedProvider && pendingDelete === selectedProvider.id" class="aggregate-delete-confirm" role="group" aria-label="确认移除接口"><p>移除「{{ selectedProvider.name || '未命名接口' }}」及其模型？保存后生效。</p><div><button class="aggregate-subtle-button" type="button" :disabled="saving" @click="pendingDelete = ''">保留接口</button><button class="aggregate-subtle-button danger" type="button" :disabled="saving" @click="removeProvider">确认移除</button></div></div>
              <div v-if="selectedProvider?.enabled === false" class="aggregate-disabled-note">已停用；配置与密钥仍保留，重新启用后可继续使用。</div>
              <div class="aggregate-connection-fields">
                <label v-if="selectedProvider" class="aggregate-field"><span>名称</span><input v-model="selectedProvider.name" aria-label="接口名称" maxlength="80" :disabled="saving" /></label>
                <label class="aggregate-field"><span>接口协议</span><select v-model="activeSettings.protocol" aria-label="接口协议" :disabled="saving" @change="protocolChanged"><option v-for="protocol in protocols" :key="protocol.value" :value="protocol.value">{{ protocol.label }}</option></select></label>
                <label v-if="selectedProvider" class="aggregate-field full"><span>API 地址</span><input v-model="selectedProvider.baseUrl" aria-label="API 地址" type="url" placeholder="https://api.example.com/v1" spellcheck="false" :disabled="saving" /></label>
                <label v-if="selectedProvider" class="aggregate-field full"><span>API Key <small v-if="selectedProvider.keyConfigured">已保存</small></span><input v-model="selectedProvider.apiKey" aria-label="API Key" type="password" autocomplete="new-password" :placeholder="keyMustChange ? '地址或协议已更改，请重新输入' : selectedProvider.keyConfigured ? '留空保留已保存的密钥' : '输入此接口的 API Key'" :disabled="saving" /><small v-if="keyMustChange" class="aggregate-key-warning">地址或协议已更改，需要重新输入密钥。</small></label>
              </div>
              <div class="aggregate-model-section">
                <div class="aggregate-model-select-row"><label class="aggregate-field"><span>模型 <small>{{ activeModels.length }} 个</small></span><select v-model="selectedModel" aria-label="模型" :disabled="saving || !activeModels.length"><option v-if="!activeModels.length" value="">尚未添加模型</option><option v-for="model in activeModels" :key="model" :value="model">{{ model }}</option></select></label><button v-if="selectedProvider && selectedModel" class="aggregate-icon-button danger aggregate-remove-model" type="button" aria-label="移除此模型" :disabled="saving" @click="removeModel"><Trash2 :size="16" /></button></div>
                <div v-if="selectedProvider" class="aggregate-add-model"><input v-model="manualModel" aria-label="新模型 ID" placeholder="输入模型 ID" list="aggregate-model-suggestions" spellcheck="false" :disabled="saving" @keydown.enter.prevent="addModel" /><button class="aggregate-subtle-button" type="button" :disabled="saving || !manualModel.trim()" @click="addModel"><Plus :size="15" />添加</button><datalist id="aggregate-model-suggestions"><option v-for="item in modelCatalog" :key="item.slug" :value="item.slug" /></datalist></div>
                <template v-if="selectedModel">
                  <div class="aggregate-model-source"><span :class="['aggregate-source-dot', { pending: !activeMetadata?.contextWindow }]" /><div><strong>{{ activeMetadata?.contextWindow ? `自动资料 · ${formatTokens(activeMetadata.contextWindow)} tokens` : '自动资料 · 待配置' }}</strong><span>{{ activeMetadata ? `来源：${activeMetadata.source} · CodexPlusPlus` : '没有已知窗口，填写后将单独应用于此模型。' }}</span></div><span v-if="activeModelConfig.contextWindow" class="aggregate-manual-badge">已手动设置</span></div>
                  <div class="aggregate-model-fields">
                    <label class="aggregate-field"><span>上下文窗口 <small>tokens</small></span><input :value="activeModelConfig.contextWindow ?? ''" aria-label="上下文窗口" type="number" min="1024" max="100000000" step="1" :placeholder="activeMetadata?.contextWindow ? String(activeMetadata.contextWindow) : '待配置'" :disabled="saving" @input="setNumber('contextWindow', $event)" /><small>{{ activeModelConfig.contextWindow ? '使用手动窗口' : activeMetadata?.contextWindow ? '留空跟随自动资料' : '填写供应商支持的窗口大小' }}</small></label>
                    <label class="aggregate-field"><span>自动压缩 <small>%</small></span><input :value="activeModelConfig.autoCompactPercent ?? ''" aria-label="自动压缩比例" type="number" min="10" max="100" step="1" placeholder="自动" :disabled="saving" @input="setNumber('autoCompactPercent', $event)" /><small>{{ compactPreview }}</small></label>
                    <label class="aggregate-field full"><span>原生 Fast</span><select :value="activeModelConfig.fast || 'inherit'" aria-label="原生 Fast" :disabled="saving" @change="setFast"><option value="inherit">自动识别</option><option value="supported" :disabled="activeSettings.protocol === 'anthropicMessages'">支持</option><option value="unsupported">不支持</option></select><small>{{ fastDescription }}</small></label>
                  </div>
                  <button class="aggregate-reset-button" type="button" :disabled="saving" @click="resetModel">恢复此模型的自动设置</button>
                </template>
              </div>
            </div>
            <div v-else class="aggregate-settings-empty"><Settings2 :size="28" /><h3>{{ selectedSource === 'builtin' ? '还没有内置聚合模型' : '添加你的第一个接口' }}</h3><p>{{ selectedSource === 'builtin' ? '登录中转站并同步账号分组后，在这里配置模型。' : '选择供应商预设，或填写任意兼容的 API 和模型 ID。' }}</p><button v-if="selectedSource === 'builtin'" class="aggregate-subtle-button" type="button" @click="selectSource('custom')">前往自有聚合<ArrowRight :size="15" /></button><ChevronDown v-else :size="18" /></div>
          </main>
        </div>
        <div v-if="error || notice" :class="['aggregate-settings-feedback', { error: Boolean(error) }]" :role="error ? 'alert' : 'status'"><Check v-if="!error" :size="15" />{{ error || notice }}</div>
        <footer class="aggregate-settings-footer"><p>点击开始／重新写入聚合后生效</p><div><button class="aggregate-subtle-button" type="button" :disabled="saving" @click="closeDialog">关闭</button><button class="aggregate-save-button" type="button" :disabled="busy || !snapshot" @click="saveSettings"><LoaderCircle v-if="saving" :size="15" class="is-spinning" />{{ saving ? '保存中' : '保存设置' }}</button></div></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.aggregate-settings-card { display: flex; align-items: center; gap: 15px; flex-wrap: wrap; padding: 21px 24px; border: 1px solid #e7ebef; border-radius: 18px; background: #fff; color: #17212f; }
.aggregate-settings-icon { width: 42px; height: 42px; display: grid; place-items: center; border: 1px solid #e6edf1; border-radius: 12px; color: #4e6a7c; background: #f8fafb; }
.aggregate-settings-summary { flex: 1; min-width: 200px; }
.aggregate-settings-summary h3 { margin: 0 0 5px; font-size: 15px; font-weight: 650; }
.aggregate-settings-summary p { margin: 0; color: #788493; font-size: 12px; line-height: 1.6; }
.aggregate-settings-count { color: #8993a0; font-size: 12px; }
.aggregate-settings-open, .aggregate-subtle-button, .aggregate-save-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 8px 13px; border-radius: 9px; border: 1px solid #e2e7ed; color: #334155; background: white; font: inherit; font-size: 12px; cursor: pointer; transition: background .15s, border-color .15s; }
.aggregate-settings-open:hover, .aggregate-subtle-button:hover { background: #f7f9fb; border-color: #cad4df; }
.aggregate-settings-inline-error { flex-basis: 100%; margin: 0; color: #b64646; font-size: 12px; }
.aggregate-settings-inline-error button { border: 0; color: inherit; background: transparent; cursor: pointer; text-decoration: underline; }
.aggregate-settings-overlay { position: fixed; inset: 0; z-index: 2500; padding: 28px; display: flex; align-items: center; justify-content: center; background: rgba(24,35,48,.35); backdrop-filter: blur(7px); font-family: inherit; color: #17212f; }
.aggregate-settings-dialog { display: flex; flex-direction: column; width: min(940px,100%); height: min(810px,calc(100dvh - 56px)); background: white; border: 1px solid rgba(255,255,255,.8); border-radius: 22px; box-shadow: 0 28px 90px #0f172a30; overflow: hidden; outline: 0; }
.aggregate-settings-dialog *, .aggregate-settings-card * { box-sizing: border-box; }
.aggregate-settings-head { display: flex; align-items: center; justify-content: space-between; padding: 22px 26px 20px; border-bottom: 1px solid #edf0f3; }
.aggregate-settings-head h2 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -.5px; }
.aggregate-settings-eyebrow { margin: 0 0 5px; color: #8d9aaa; font-size: 9px; letter-spacing: 2px; font-weight: 650; }
.aggregate-icon-button { display: inline-grid; place-items: center; flex: 0 0 auto; width: 32px; height: 32px; border: 0; border-radius: 8px; color: #8090a0; background: transparent; cursor: pointer; }
.aggregate-icon-button:hover { background: #f1f5f9; color: #334155; }
.aggregate-icon-button.danger:hover { color: #bd3f47; background: #fff0f1; }
.aggregate-source-bar { display: flex; align-items: center; gap: 18px; padding: 14px 25px; border-bottom: 1px solid #edf0f3; }
.aggregate-source-bar > p { margin: 0; color: #8b96a3; font-size: 11px; }
.aggregate-source-tabs { display: flex; gap: 4px; padding: 4px; background: #f1f4f7; border-radius: 11px; flex: 0 0 auto; }
.aggregate-source-tabs button { display: inline-flex; align-items: center; gap: 9px; padding: 8px 14px; color: #768393; background: transparent; border: 1px solid transparent; border-radius: 8px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.aggregate-source-tabs button[aria-selected="true"] { color: #253e51; background: white; border-color: #e4e9ee; box-shadow: 0 1px 3px #253e510a; }
.aggregate-source-tabs button > span { min-width: 16px; font-size: 10px; color: #91a0ad; font-weight: 400; }
.aggregate-provider-actions { display: flex; align-items: center; gap: 9px; flex-shrink: 0; }
.aggregate-provider-switch { display: inline-flex; align-items: center; gap: 7px; padding: 7px 0; border: 0; background: none; color: #7e8d9a; font: inherit; font-size: 11px; cursor: pointer; }
.aggregate-switch-track { display: inline-flex; align-items: center; width: 28px; height: 17px; padding: 2px; border-radius: 20px; background: #c6cfd8; }
.aggregate-switch-track > span { width: 13px; height: 13px; border-radius: 50%; background: white; box-shadow: 0 1px 3px #152c4529; }
.aggregate-provider-switch[aria-checked="true"] { color: #476b5d; }
.aggregate-provider-switch[aria-checked="true"] .aggregate-switch-track { background: #608a79; justify-content: flex-end; }
.aggregate-disabled-note { margin: -8px 0 19px; padding: 10px 12px; border: 1px solid #e8edf1; border-radius: 8px; background: #fafbfc; color: #84909f; font-size: 11px; line-height: 1.6; }
.aggregate-delete-confirm { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 12px; margin-bottom: 18px; border: 1px solid #f0dadb; border-radius: 9px; background: #fff9f9; }
.aggregate-delete-confirm p { margin: 0; font-size: 11px; line-height: 1.6; color: #95515b; }
.aggregate-delete-confirm > div { display: flex; gap: 7px; margin-left: auto; }
.aggregate-delete-confirm .danger { color: #b74650; border-color: #edcdd0; }
.aggregate-settings-body { display: grid; grid-template-columns: 225px minmax(0,1fr); flex: 1; min-height: 0; }
.aggregate-settings-nav { padding: 20px 15px; background: #f8fafb; border-right: 1px solid #edf0f3; overflow: auto; }
.aggregate-nav-section { margin-bottom: 22px; }
.aggregate-nav-section > p, .aggregate-add-provider > label { display: block; margin: 0 9px 9px; color: #8b96a4; font-size: 11px; }
.aggregate-nav-section > button { display: block; width: 100%; text-align: left; padding: 11px 12px; margin-bottom: 4px; border: 1px solid transparent; border-radius: 9px; color: #5b697a; background: transparent; cursor: pointer; }
.aggregate-nav-section > button.active { background: #fff; color: #152b3f; border-color: #e1e8ee; box-shadow: 0 2px 4px #182b3d04; }
.aggregate-nav-section > button:hover { background: #fff; }
.aggregate-nav-section > button.is-disabled { color: #98a3af; }
.aggregate-nav-section i { margin-left: 6px; font-style: normal; font-size: 9px; font-weight: 400; color: #9ca6b2; }
.aggregate-nav-section strong { display: block; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aggregate-nav-section span { display: block; color: #8c97a4; font-size: 10px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aggregate-add-provider { display: grid; gap: 8px; padding-top: 2px; }
.aggregate-add-provider > label { margin-bottom: 0; }
.aggregate-add-provider > select { width: 100%; min-width: 0; height: 36px; padding: 7px; border: 1px solid #e0e6ed; border-radius: 8px; color: #526273; background: white; font: inherit; font-size: 11px; }
.aggregate-settings-main { padding: 25px 30px 24px; overflow: auto; min-width: 0; }
.aggregate-editor-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 23px; }
.aggregate-editor-heading h3 { margin: 0 0 6px; font-size: 17px; font-weight: 650; overflow-wrap: anywhere; }
.aggregate-editor-heading p { margin: 0; color: #8b96a3; font-size: 11px; }
.aggregate-connection-fields, .aggregate-model-fields { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 16px; }
.aggregate-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.aggregate-field.full { grid-column: 1/-1; }
.aggregate-field > span { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 500; color: #405064; }
.aggregate-field small { color: #96a0ad; font-size: 10px; font-weight: 400; line-height: 1.6; }
.aggregate-field input, .aggregate-field select, .aggregate-add-model input { width: 100%; min-width: 0; height: 38px; padding: 9px 11px; border: 1px solid #dfe5eb; border-radius: 8px; outline: 0; color: #26384a; background: white; font: inherit; font-size: 12px; transition: border-color .15s, box-shadow .15s; }
.aggregate-field input::placeholder, .aggregate-add-model input::placeholder { color: #a8b1be; }
.aggregate-field input:focus, .aggregate-field select:focus, .aggregate-add-model input:focus, .aggregate-add-provider select:focus { border-color: #8eaebe; box-shadow: 0 0 0 3px #8eaebe16; outline: none; }
.aggregate-field .aggregate-key-warning { color: #b47732; }
.aggregate-model-section { margin-top: 26px; padding-top: 23px; border-top: 1px solid #edf0f3; }
.aggregate-model-select-row { display: flex; align-items: flex-end; gap: 8px; }
.aggregate-model-select-row > label { flex: 1; }
.aggregate-remove-model { margin-bottom: 3px; }
.aggregate-add-model { display: flex; gap: 8px; margin-top: 10px; }
.aggregate-add-model > button { white-space: nowrap; }
.aggregate-model-source { display: flex; align-items: center; gap: 10px; padding: 14px 12px; margin: 16px 0 20px; border-radius: 9px; background: #f6f9fa; }
.aggregate-source-dot { width: 6px; height: 6px; border-radius: 50%; background: #4f9e8d; flex: 0 0 auto; }
.aggregate-source-dot.pending { background: #b6bec9; }
.aggregate-model-source > div { flex: 1; min-width: 0; }
.aggregate-model-source strong { display: block; color: #506474; font-size: 11px; font-weight: 550; }
.aggregate-model-source div > span { display: block; margin-top: 4px; color: #929eaa; font-size: 10px; line-height: 1.5; }
.aggregate-manual-badge { color: #587e91; font-size: 9px; white-space: nowrap; }
.aggregate-reset-button { display: inline-block; margin-top: 16px; padding: 0; border: 0; color: #8798a8; background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.aggregate-reset-button:hover { color: #3e7288; }
.aggregate-settings-empty { display: flex; height: 100%; min-height: 210px; align-items: center; justify-content: center; flex-direction: column; color: #9aa8b5; text-align: center; }
.aggregate-settings-empty h3 { font-size: 15px; font-weight: 550; color: #617485; margin: 16px 0 7px; }
.aggregate-settings-empty p { font-size: 11px; margin: 0 0 15px; }
.aggregate-settings-feedback { display: flex; gap: 8px; align-items: center; margin: 0 24px 14px; padding: 11px 13px; border-radius: 9px; color: #477d6c; background: #f0f8f4; font-size: 11px; line-height: 1.6; }
.aggregate-settings-feedback.error { color: #b34148; background: #fff3f4; }
.aggregate-settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 17px 24px; border-top: 1px solid #edf0f3; }
.aggregate-settings-footer > p { margin: 0; color: #96a0ad; font-size: 10px; }
.aggregate-settings-footer > div { display: flex; gap: 9px; flex: 0 0 auto; }
.aggregate-save-button { color: white; background: #253e51; border-color: #253e51; min-width: 88px; }
.aggregate-save-button:hover { background: #34566d; }
.aggregate-settings-dialog button:disabled, .aggregate-settings-card button:disabled { opacity: .5; cursor: default; }
.aggregate-settings-dialog input:disabled, .aggregate-settings-dialog select:disabled { opacity: .65; }
.aggregate-settings-dialog button:focus-visible, .aggregate-settings-card button:focus-visible { outline: 2px solid #688fa6; outline-offset: 3px; }
.is-spinning { animation: aggregate-spin 1s linear infinite; }
@keyframes aggregate-spin { to { transform: rotate(360deg); } }
@media(max-width:700px) {
  .aggregate-settings-count { display: none; }
  .aggregate-settings-card { padding: 17px; gap: 11px; }
  .aggregate-settings-summary { min-width: 170px; }
  .aggregate-settings-overlay { padding: 12px; }
  .aggregate-settings-dialog { height: calc(100dvh - 24px); border-radius: 17px; }
  .aggregate-settings-head { padding: 18px 20px; }
  .aggregate-source-bar { padding: 11px 16px; flex-wrap: wrap; gap: 8px; }
  .aggregate-source-bar > p { flex-basis: 100%; padding-left: 4px; font-size: 10px; }
  .aggregate-editor-heading { flex-wrap: wrap; }
  .aggregate-settings-body { grid-template-columns: 1fr; grid-template-rows: auto minmax(0,1fr); }
  .aggregate-settings-nav { display: flex; gap: 12px; max-height: 180px; padding: 12px; border-right: 0; border-bottom: 1px solid #edf0f3; }
  .aggregate-nav-section { min-width: 150px; max-width: 190px; margin-bottom: 0; }
  .aggregate-add-provider { min-width: 155px; align-self: start; }
  .aggregate-settings-main { padding: 20px; }
  .aggregate-settings-footer { padding: 14px 17px; flex-wrap: wrap; }
  .aggregate-settings-footer > div { margin-left: auto; }
  .aggregate-settings-feedback { margin: 0 16px 12px; }
  .aggregate-model-fields { gap: 12px; }
}
@media(prefers-reduced-motion:reduce) { .is-spinning { animation: none; } }
</style>
