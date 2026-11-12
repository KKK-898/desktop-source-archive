<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertCircle, ArrowDownToLine, ArrowUpCircle, Check, ChevronDown, KeyRound, LoaderCircle, Package, Power, RefreshCcw, Search, Trash2, X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  restartBusy?: boolean
  restartNotice?: string
  restartError?: string
  restartWarning?: string
  restartRevision?: number
  confirmUninstall: (name: string) => Promise<boolean>
}>(), { restartBusy: false, restartNotice: '', restartError: '', restartWarning: '', restartRevision: 0 })
const emit = defineEmits<{ restart: [] }>()

type MarketFilter = 'all' | 'installable' | 'installed' | 'updates' | 'auth'
type MutationKind = 'install' | 'uninstall' | 'enable' | 'disable'
const source = ref<GaogeDesktopCodexPluginMarketSource>('public')
const filter = ref<MarketFilter>('all')
const query = ref('')
const catalog = ref<GaogeDesktopCodexPluginMarketListResponse | null>(null)
const loading = ref(true)
const error = ref('')
const notice = ref('')
const restartRequired = ref(false)
const restartFeedbackVisible = ref(true)
const actionId = ref('')
const actionKind = ref<MutationKind | ''>('')
const progressMessage = ref('')
const visibleCount = ref(24)
let disposed = false
let catalogGeneration = 0
let operationGeneration = 0
let pollingTimer: ReturnType<typeof setInterval> | undefined
let pollingInFlight = false

const desktopAvailable = computed(() => Boolean(window.gaogeDesktop?.listCodexPlugins))
const busy = computed(() => loading.value || Boolean(actionId.value) || props.restartBusy)
const plugins = computed(() => catalog.value?.plugins || [])
const counts = computed(() => ({
  all: plugins.value.length,
  installable: plugins.value.filter(plugin => plugin.installable && !plugin.installed).length,
  installed: plugins.value.filter(plugin => plugin.installed).length,
  updates: plugins.value.filter(plugin => plugin.updateAvailable).length,
  auth: plugins.value.filter(plugin => plugin.requiresAuth).length,
}))
const tabs = computed(() => [
  { id: 'all' as const, label: '全部插件', count: counts.value.all },
  { id: 'installable' as const, label: '可安装', count: counts.value.installable },
  { id: 'installed' as const, label: '已安装', count: counts.value.installed },
  { id: 'updates' as const, label: '有更新', count: counts.value.updates },
  { id: 'auth' as const, label: '需服务授权', count: counts.value.auth },
])
const filteredPlugins = computed(() => {
  const terms = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return plugins.value.filter(plugin => {
    if (filter.value === 'installable' && (!plugin.installable || plugin.installed)) return false
    if (filter.value === 'installed' && !plugin.installed) return false
    if (filter.value === 'updates' && !plugin.updateAvailable) return false
    if (filter.value === 'auth' && !plugin.requiresAuth) return false
    if (!terms.length) return true
    const haystack = [plugin.displayName, plugin.name, plugin.description, plugin.author, ...(plugin.tags || [])].join(' ').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
})
const visiblePlugins = computed(() => filteredPlugins.value.slice(0, visibleCount.value))
const emptyLabel = computed(() => {
  if (query.value.trim()) return '没有找到匹配的插件'
  if (filter.value === 'installed') return '这个市场中还没有已安装的插件'
  if (filter.value === 'updates') return '已安装的插件暂无更新'
  if (filter.value === 'auth') return '这个市场中没有需要服务授权的插件'
  if (filter.value === 'installable') return '暂时没有可安装的插件'
  return '暂时没有可显示的插件'
})
const marketWarnings = computed(() => (catalog.value?.warnings || []).filter(Boolean))

function errorText(cause: unknown, fallback: string) {
  if (typeof cause === 'string' && cause.trim()) return cause
  if (cause instanceof Error && cause.message) return cause.message
  return fallback
}
function displayName(plugin: GaogeDesktopCodexMarketPlugin) { return plugin.displayName || plugin.name }
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
function actionLabel(plugin: GaogeDesktopCodexMarketPlugin) {
  if (actionId.value !== plugin.id) return plugin.updateAvailable ? '更新' : '安装'
  if (actionKind.value === 'uninstall') return '正在卸载'
  if (actionKind.value === 'enable') return '正在启用'
  if (actionKind.value === 'disable') return '正在停用'
  return plugin.installed ? '正在更新' : '正在安装'
}
function stopInstallPolling() {
  if (pollingTimer) clearInterval(pollingTimer)
  pollingTimer = undefined
}
function startInstallPolling(id: string, requestedSource: GaogeDesktopCodexPluginMarketSource, generation: number) {
  stopInstallPolling()
  const poll = async () => {
    if (disposed || pollingInFlight || operationGeneration !== generation || actionId.value !== id) return
    if (!window.gaogeDesktop?.getCodexPluginInstallStatus) return
    pollingInFlight = true
    try {
      const status = await window.gaogeDesktop.getCodexPluginInstallStatus({ source: requestedSource, id })
      if (disposed || operationGeneration !== generation || actionId.value !== id) return
      const stageLabels: Record<string, string> = {
        downloading: '正在下载插件', verifying: '正在校验插件', extracting: '正在展开插件',
        installing: '正在安装插件', registering: '正在写入插件配置', complete: '安装完成',
      }
      progressMessage.value = status.message || stageLabels[status.stage || ''] || '正在安装插件，请稍候…'
    } catch {
      // The install request owns the final result; a status refresh must not turn it into a failure.
    } finally {
      pollingInFlight = false
    }
  }
  pollingTimer = setInterval(() => { void poll() }, 900)
}
async function loadCatalog(refresh = false) {
  const generation = ++catalogGeneration
  const requestedSource = source.value
  loading.value = true
  error.value = ''
  try {
    if (!window.gaogeDesktop?.listCodexPlugins) throw new Error('请在 Gaoge Free 桌面版中打开插件市场。')
    const result = await window.gaogeDesktop.listCodexPlugins({ source: requestedSource, refresh })
    if (disposed || generation !== catalogGeneration || requestedSource !== source.value) return
    catalog.value = result
  } catch (cause) {
    if (!disposed && generation === catalogGeneration) error.value = errorText(cause, '插件列表加载失败，请稍后重试。')
  } finally {
    if (!disposed && generation === catalogGeneration) loading.value = false
  }
}
async function mutate(plugin: GaogeDesktopCodexMarketPlugin, kind: MutationKind) {
  if (busy.value || disposed) return
  if (kind === 'install' && (!plugin.installable || (plugin.installed && !plugin.managed))) return
  if (kind !== 'install' && (!plugin.installed || !plugin.managed)) return
  const requestedSource = source.value
  const generation = ++operationGeneration
  actionId.value = plugin.id
  actionKind.value = kind
  progressMessage.value = kind === 'install' ? '正在准备插件…' : ''
  restartFeedbackVisible.value = false
  error.value = ''
  notice.value = ''
  try {
    if (kind === 'uninstall' && !(await props.confirmUninstall(displayName(plugin)))) return
    if (disposed || generation !== operationGeneration || requestedSource !== source.value) return
    const desktop = window.gaogeDesktop
    if (!desktop) throw new Error('请在 Gaoge Free 桌面版中管理插件。')
    let result: GaogeDesktopCodexPluginMutationResponse
    if (kind === 'install') {
      startInstallPolling(plugin.id, requestedSource, generation)
      if (!desktop.installCodexPlugin) throw new Error('当前桌面版本不支持安装插件，请更新软件。')
      result = await desktop.installCodexPlugin({ source: requestedSource, id: plugin.id })
    } else if (kind === 'uninstall') {
      if (!desktop.uninstallCodexPlugin) throw new Error('当前桌面版本不支持卸载插件，请更新软件。')
      result = await desktop.uninstallCodexPlugin({ source: requestedSource, id: plugin.id })
    } else {
      if (!desktop.setCodexPluginEnabled) throw new Error('当前桌面版本不支持管理插件，请更新软件。')
      result = await desktop.setCodexPluginEnabled({ source: requestedSource, id: plugin.id, enabled: kind === 'enable' })
    }
    if (disposed || generation !== operationGeneration) return
    if (result.status === 'error' || result.status === 'failed') throw new Error(result.message || '插件操作未完成，请重试。')
    restartRequired.value = restartRequired.value || Boolean(result.restartRequired)
    const verb = kind === 'install' ? (plugin.installed ? '更新' : '安装') : kind === 'uninstall' ? '卸载' : kind === 'enable' ? '启用' : '停用'
    notice.value = result.message || `${displayName(plugin)} 已${verb}。`
    stopInstallPolling()
    await loadCatalog(false)
  } catch (cause) {
    if (!disposed && generation === operationGeneration) error.value = errorText(cause, '插件操作失败，请稍后重试。')
  } finally {
    if (generation === operationGeneration) {
      stopInstallPolling()
      actionId.value = ''
      actionKind.value = ''
      progressMessage.value = ''
    }
  }
}
function requestRestart() {
  if (busy.value) return
  restartFeedbackVisible.value = true
  notice.value = ''
  error.value = ''
  emit('restart')
}
function clearFilters() {
  query.value = ''
  filter.value = 'all'
}
watch(() => props.restartRevision, () => { restartRequired.value = false })
watch([query, filter], () => { visibleCount.value = 24 })
watch(source, () => {
  catalog.value = null
  visibleCount.value = 24
  error.value = ''
  notice.value = ''
  void loadCatalog(false)
})
onMounted(() => { void loadCatalog(false) })
onBeforeUnmount(() => {
  disposed = true
  catalogGeneration += 1
  operationGeneration += 1
  stopInstallPolling()
})
</script>

<template>
  <section class="codex-plugin-market" aria-label="安装插件" :aria-busy="loading">
    <header class="plugin-page-heading">
      <div><span class="plugin-eyebrow">CHATGPT · PLUGINS</span><h1>安装插件</h1><p>发现技能与工具，让 ChatGPT 帮你完成更多工作。</p></div>
      <button class="plugin-button primary" type="button" :disabled="busy || !desktopAvailable" @click="requestRestart"><RefreshCcw :size="15" :class="{ spinning: restartBusy }" />{{ restartBusy ? '正在重启' : '重启 ChatGPT' }}</button>
    </header>

    <div v-if="restartRequired" class="plugin-feedback restart-hint" role="status"><RefreshCcw :size="16" /><span>插件配置已更新。重启 ChatGPT 后，在新聊天中使用。</span><button type="button" :disabled="busy" @click="requestRestart">立即重启</button></div>
    <div v-if="error || (restartFeedbackVisible && restartError)" class="plugin-feedback error" role="alert"><AlertCircle :size="17" /><span>{{ error || (restartFeedbackVisible ? restartError : '') }}</span><button v-if="error && desktopAvailable" type="button" :disabled="busy" @click="loadCatalog(true)">重试</button></div>
    <div v-if="restartFeedbackVisible && restartWarning" class="plugin-feedback warning" role="status"><AlertCircle :size="16" /><span>{{ restartWarning }}</span></div>
    <div v-if="notice || (restartFeedbackVisible && restartNotice)" class="plugin-feedback success" role="status"><Check :size="16" /><span>{{ notice || (restartFeedbackVisible ? restartNotice : '') }}</span></div>

    <div class="plugin-toolbar">
      <label class="plugin-search"><Search :size="17" /><input v-model="query" type="search" placeholder="搜索名称、作者、描述或标签" aria-label="搜索插件" /><button v-if="query" class="plugin-clear" type="button" aria-label="清空搜索" @click="query = ''"><X :size="14" /></button></label>
      <div class="plugin-source"><select v-model="source" aria-label="插件市场来源" :disabled="busy"><option value="public">公开精选</option><option value="full">全部插件</option></select><ChevronDown :size="14" /></div>
      <button class="plugin-icon-button" type="button" :disabled="busy || !desktopAvailable" aria-label="刷新插件市场" title="刷新插件市场" @click="loadCatalog(true)"><RefreshCcw :size="17" :class="{ spinning: loading }" /></button>
    </div>

    <div class="plugin-filters-row">
      <div class="plugin-filters" role="group" aria-label="筛选插件"><button v-for="tab in tabs" :key="tab.id" type="button" :class="{ active: filter === tab.id }" :aria-pressed="filter === tab.id" @click="filter = tab.id">{{ tab.label }}<span>{{ tab.count }}</span></button></div>
      <span v-if="catalog" class="plugin-cache-label">{{ catalog.cached ? '本地缓存' : '已同步' }}</span>
    </div>
    <div v-if="marketWarnings.length" class="plugin-catalog-warning" role="status"><AlertCircle :size="14" /><span>{{ marketWarnings.join('；') }}</span></div>

    <div v-if="loading && !catalog" class="plugin-state"><LoaderCircle class="spinning" :size="29" /><h2>正在加载插件市场</h2><p>首次加载可能需要一点时间，请稍候。</p></div>
    <div v-else-if="!desktopAvailable" class="plugin-state"><Package :size="34" /><h2>请在桌面版中安装插件</h2><p>插件将安装到这台电脑上的 ChatGPT 配置目录。</p></div>
    <div v-else-if="!catalog && error" class="plugin-state"><AlertCircle :size="31" /><h2>暂时无法加载插件市场</h2><p>检查网络连接后，再刷新列表。</p><button class="plugin-button secondary" type="button" :disabled="busy" @click="loadCatalog(true)"><RefreshCcw :size="14" />重新加载</button></div>
    <div v-else-if="!filteredPlugins.length" class="plugin-state"><Package :size="34" /><h2>{{ emptyLabel }}</h2><p>{{ query.trim() ? '换个关键词，或试试按作者和标签搜索。' : '可以切换筛选或市场来源，继续发现其他插件。' }}</p><button v-if="query || filter !== 'all'" class="plugin-button secondary" type="button" @click="clearFilters">查看全部插件</button></div>
    <div v-else class="plugin-grid">
      <article v-for="plugin in visiblePlugins" :key="plugin.id" class="plugin-card" :class="{ 'is-working': actionId === plugin.id }">
        <div class="plugin-card-heading"><span class="plugin-package-icon"><Package :size="18" /></span><h2 :title="displayName(plugin)">{{ displayName(plugin) }}</h2><span v-if="plugin.requiresAuth" class="plugin-auth-badge" title="首次使用时需要连接外部服务" aria-label="需要服务授权"><KeyRound :size="13" /></span><span v-if="plugin.installed" class="plugin-installed-badge" :class="{ disabled: !plugin.enabled }">{{ plugin.enabled ? '已启用' : '已停用' }}</span></div>
        <p class="plugin-description" :title="plugin.description">{{ plugin.description || '这个插件暂未提供描述。' }}</p>
        <div class="plugin-card-details"><span v-if="plugin.author" :title="plugin.author">{{ plugin.author }}</span><span v-if="plugin.skills">{{ plugin.skills }} 个技能</span><span v-if="plugin.tags?.length" class="plugin-tag" :title="plugin.tags.join(' · ')">{{ plugin.tags[0] }}</span></div>
        <div class="plugin-card-footer"><div class="plugin-version"><span :title="plugin.installedVersion && plugin.installedVersion !== plugin.version ? `已安装 v${plugin.installedVersion}` : ''">v{{ plugin.version || plugin.installedVersion || '—' }}</span><span v-if="formatBytes(plugin.bytes)">{{ formatBytes(plugin.bytes) }}</span><span v-if="plugin.installed && plugin.updateAvailable" class="plugin-update-label">有更新</span></div><div class="plugin-card-actions"><template v-if="plugin.installed && plugin.managed"><button class="plugin-icon-button" type="button" :disabled="busy" :aria-label="`${plugin.enabled ? '停用' : '启用'} ${displayName(plugin)}`" :title="plugin.enabled ? '停用插件' : '启用插件'" @click="mutate(plugin, plugin.enabled ? 'disable' : 'enable')"><Power :size="15" /></button><button class="plugin-icon-button remove" type="button" :disabled="busy" :aria-label="`卸载 ${displayName(plugin)}`" title="卸载插件" @click="mutate(plugin, 'uninstall')"><Trash2 :size="15" /></button></template><button v-if="plugin.installable && (!plugin.installed || (plugin.updateAvailable && plugin.managed))" class="plugin-button install" type="button" :disabled="busy" @click="mutate(plugin, 'install')"><LoaderCircle v-if="actionId === plugin.id" :size="14" class="spinning" /><ArrowUpCircle v-else-if="plugin.updateAvailable" :size="14" /><ArrowDownToLine v-else :size="14" />{{ actionLabel(plugin) }}</button><span v-else-if="plugin.installed && !plugin.managed" class="plugin-external-install" title="此插件由其他来源安装，请在原安装入口中管理。">其他来源安装</span><span v-else-if="!plugin.installed" class="plugin-external-install">暂不可安装</span></div></div>
        <div v-if="actionId === plugin.id" class="plugin-progress" role="status"><LoaderCircle :size="13" class="spinning" /><span>{{ progressMessage || actionLabel(plugin) }}</span></div>
      </article>
    </div>

    <div v-if="filteredPlugins.length > visibleCount" class="plugin-load-more"><span>已显示 {{ visiblePlugins.length }} / {{ filteredPlugins.length }} 个插件</span><button class="plugin-button secondary" type="button" @click="visibleCount += 24">加载更多<ChevronDown :size="14" /></button></div>
    <footer class="plugin-footer"><KeyRound :size="14" /><span>带钥匙标记的插件需要连接外部服务，请在 ChatGPT 首次使用时完成授权。</span><details v-if="catalog?.codexHome"><summary>安装位置</summary><code>{{ catalog.codexHome }}</code><p>插件安装到当前配置目录，使用独立目录的其他实例需单独安装。</p></details></footer>
  </section>
</template>

<style scoped>
.codex-plugin-market { --pm-bg: #fff; --pm-card: #f7f8fa; --pm-border: #e5e8ee; --pm-text: #18202c; --pm-muted: #798394; --pm-accent: #6150ca; --pm-accent-bg: #f0edff; display: grid; align-content: start; gap: 18px; width: 100%; min-width: 0; padding: 5px 3px 24px; color: var(--pm-text); }
:global(.mode-dark .codex-plugin-market) { --pm-bg: #171c24; --pm-card: #1c222c; --pm-border: #303744; --pm-text: #eef1f7; --pm-muted: #99a4b6; --pm-accent: #b0a2ff; --pm-accent-bg: #2b2544; }
.codex-plugin-market * { box-sizing: border-box; }
.codex-plugin-market button, .codex-plugin-market input, .codex-plugin-market select { font: inherit; }
.codex-plugin-market button { cursor: pointer; }
.codex-plugin-market button:disabled, .codex-plugin-market select:disabled { opacity: .45; cursor: not-allowed; }
.codex-plugin-market button:focus-visible, .codex-plugin-market input:focus-visible, .codex-plugin-market select:focus-visible, .codex-plugin-market summary:focus-visible { outline: 2px solid var(--pm-accent); outline-offset: 3px; }
.plugin-page-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 4px; }
.plugin-eyebrow { color: var(--pm-muted); font-size: 9px; font-weight: 650; letter-spacing: 1.7px; }
.plugin-page-heading h1 { margin: 6px 0; font-size: 23px; font-weight: 700; letter-spacing: -.5px; }
.plugin-page-heading p { margin: 0; color: var(--pm-muted); font-size: 12px; line-height: 1.7; }
.plugin-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 33px; padding: 0 12px; border: 1px solid var(--pm-border); border-radius: 8px; background: var(--pm-bg); color: var(--pm-text); font-size: 11px !important; white-space: nowrap; }
.plugin-button.primary { min-height: 35px; border-color: transparent; background: var(--pm-text); color: var(--pm-bg); }
.plugin-button:hover:not(:disabled) { border-color: var(--pm-accent); }
.plugin-button.install { min-height: 30px; font-size: 11px !important; }
.plugin-toolbar { display: flex; align-items: center; gap: 10px; }
.plugin-search { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; height: 39px; border: 1px solid var(--pm-border); border-radius: 10px; background: var(--pm-card); padding: 0 12px; color: var(--pm-muted); }
.plugin-search:focus-within { border-color: var(--pm-accent); }
.plugin-search input { width: 100%; min-width: 0; border: 0; outline: none !important; color: var(--pm-text); background: transparent; font-size: 12px; }
.plugin-search input::-webkit-search-cancel-button { display: none; }
.plugin-search input::placeholder { color: var(--pm-muted); }
.plugin-clear { display: grid; place-items: center; border: 0; padding: 2px; background: transparent; color: var(--pm-muted); }
.plugin-source { position: relative; min-width: 128px; }
.plugin-source select { appearance: none; width: 100%; height: 39px; border: 1px solid var(--pm-border); border-radius: 10px; background: var(--pm-bg); color: var(--pm-text); font-size: 12px; padding: 0 29px 0 12px; cursor: pointer; }
.plugin-source > svg { position: absolute; right: 10px; top: 13px; pointer-events: none; color: var(--pm-muted); }
.plugin-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid transparent; border-radius: 7px; color: var(--pm-muted); background: transparent; }
.plugin-icon-button:hover:not(:disabled) { background: var(--pm-bg); color: var(--pm-text); border-color: var(--pm-border); }
.plugin-icon-button.remove:hover:not(:disabled) { color: #d36a5e; }
.plugin-filters-row { display: flex; align-items: center; gap: 12px; margin-top: -5px; }
.plugin-filters { display: flex; flex-wrap: wrap; gap: 7px; }
.plugin-filters button { display: inline-flex; align-items: center; gap: 6px; min-height: 29px; padding: 0 11px; border: 1px solid var(--pm-border); border-radius: 16px; color: var(--pm-text); background: var(--pm-bg); font-size: 11px; }
.plugin-filters button.active { background: var(--pm-accent-bg); border-color: color-mix(in srgb, var(--pm-accent) 23%, var(--pm-border)); color: var(--pm-accent); }
.plugin-filters button span { font-size: 10px; color: var(--pm-muted); font-variant-numeric: tabular-nums; }
.plugin-filters button.active span { color: var(--pm-accent); }
.plugin-cache-label { margin-left: auto; color: var(--pm-muted); font-size: 10px; white-space: nowrap; }
.plugin-feedback { display: flex; align-items: flex-start; gap: 9px; padding: 11px 13px; border: 1px solid var(--pm-border); border-radius: 9px; font-size: 12px; line-height: 1.6; }
.plugin-feedback > svg { flex-shrink: 0; margin-top: 2px; }
.plugin-feedback span { overflow-wrap: anywhere; }
.plugin-feedback button { margin-left: auto; flex-shrink: 0; background: transparent; border: 0; color: inherit; padding: 0; font-size: 11px; text-decoration: underline; text-underline-offset: 3px; }
.plugin-feedback.error { color: #c76553; border-color: #d8796033; background: #d879600b; }
.plugin-feedback.warning { color: #af8545; border-color: #b9904b33; background: #b9904b0b; }
.plugin-feedback.success { color: #299b76; border-color: #279b762b; background: #279b7608; }
.plugin-feedback.restart-hint { color: var(--pm-accent); border-color: color-mix(in srgb, var(--pm-accent) 20%, var(--pm-border)); background: var(--pm-accent-bg); }
.plugin-catalog-warning { display: flex; align-items: flex-start; gap: 7px; color: var(--pm-muted); font-size: 11px; line-height: 1.6; }
.plugin-catalog-warning > svg { flex-shrink: 0; margin-top: 1px; }
.plugin-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; }
.plugin-card { display: flex; flex-direction: column; min-width: 0; min-height: 173px; padding: 17px 17px 13px; border: 1px solid transparent; border-radius: 12px; background: var(--pm-card); transition: border-color .15s ease; }
.plugin-card:hover { border-color: var(--pm-border); }
.plugin-card.is-working { border-color: color-mix(in srgb, var(--pm-accent) 45%, var(--pm-border)); }
.plugin-card-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.plugin-package-icon { display: inline-flex; color: var(--pm-muted); flex-shrink: 0; }
.plugin-card-heading h2 { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 1.4; font-weight: 650; }
.plugin-auth-badge { display: inline-flex; padding: 3px; color: var(--pm-muted); border-radius: 5px; background: color-mix(in srgb, var(--pm-muted) 9%, transparent); }
.plugin-installed-badge { margin-left: auto; color: #299b76; background: #299b7610; border-radius: 4px; padding: 3px 6px; font-size: 9px; white-space: nowrap; }
.plugin-installed-badge.disabled { color: var(--pm-muted); background: color-mix(in srgb, var(--pm-muted) 9%, transparent); }
.plugin-description { margin: 10px 0 9px; color: var(--pm-muted); font-size: 11px; line-height: 1.8; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; min-height: 39px; overflow-wrap: anywhere; }
.plugin-card-details { display: flex; align-items: center; gap: 9px; min-width: 0; min-height: 18px; margin-bottom: 8px; color: var(--pm-muted); font-size: 9px; }
.plugin-card-details > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plugin-card-details > span:first-child { max-width: 45%; }
.plugin-tag { padding: 2px 6px; border: 1px solid var(--pm-border); border-radius: 4px; }
.plugin-card-footer { display: flex; align-items: center; gap: 6px; margin-top: auto; min-height: 31px; }
.plugin-version { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; min-width: 0; font-size: 10px; color: var(--pm-muted); font-variant-numeric: tabular-nums; }
.plugin-version > span { overflow-wrap: anywhere; }
.plugin-version .plugin-update-label { color: var(--pm-accent); }
.plugin-card-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; flex-shrink: 0; }
.plugin-external-install { font-size: 10px; color: var(--pm-muted); }
.plugin-progress { display: flex; align-items: center; gap: 6px; padding-top: 10px; margin-top: 8px; border-top: 1px solid var(--pm-border); color: var(--pm-accent); font-size: 10px; line-height: 1.6; }
.plugin-progress > svg { flex-shrink: 0; }
.plugin-state { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 300px; gap: 10px; padding: 40px 20px; text-align: center; color: var(--pm-muted); }
.plugin-state h2 { margin: 5px 0 0; font-size: 14px; color: var(--pm-text); font-weight: 600; }
.plugin-state p { margin: 0 0 7px; font-size: 12px; line-height: 1.7; }
.plugin-load-more { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 7px 0; }
.plugin-load-more > span { font-size: 11px; color: var(--pm-muted); }
.plugin-footer { display: flex; align-items: flex-start; gap: 7px; padding: 2px 1px; color: var(--pm-muted); font-size: 10px; line-height: 1.7; }
.plugin-footer > svg { flex-shrink: 0; margin-top: 2px; }
.plugin-footer details { margin-left: auto; min-width: 0; text-align: right; }
.plugin-footer summary { cursor: pointer; white-space: nowrap; }
.plugin-footer code { display: block; max-width: 420px; font-size: 10px; overflow-wrap: anywhere; margin-top: 8px; }
.plugin-footer details p { margin: 4px 0 0; max-width: 420px; }
.spinning { animation: plugin-spin 1s linear infinite; }
@keyframes plugin-spin { to { transform: rotate(360deg); } }
@media (max-width: 1050px) { .plugin-card { padding: 14px; } .plugin-card-details { gap: 6px; } .plugin-card-footer { flex-wrap: wrap; } }
@media (max-width: 760px) { .plugin-grid { grid-template-columns: minmax(0, 1fr); } .plugin-page-heading { align-items: flex-start; } .plugin-toolbar { flex-wrap: wrap; } .plugin-search { flex-basis: calc(100% - 40px); } .plugin-source { flex: 1; } .plugin-filters-row { align-items: flex-start; } .plugin-cache-label { padding-top: 8px; } .plugin-footer { flex-wrap: wrap; } .plugin-footer details { flex-basis: 100%; margin-left: 21px; text-align: left; } }
@media (prefers-reduced-motion: reduce) { .spinning { animation-duration: 2s; } .plugin-card { transition: none; } }
</style>
