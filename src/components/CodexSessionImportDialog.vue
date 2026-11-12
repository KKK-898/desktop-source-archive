<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { FolderOpen, Upload, X } from 'lucide-vue-next'

defineProps<{ dark?: boolean }>()
const emit = defineEmits<{
  close: []
  imported: [result: GaogeDesktopCodexSessionsImportResponse]
}>()
const dialog = ref<HTMLElement | null>(null)
const busy = ref(false)
const importing = ref(false)
const preview = ref<GaogeDesktopCodexSessionsImportPreview | null>(null)
const result = ref<GaogeDesktopCodexSessionsImportResponse | null>(null)
const error = ref('')
const selected = ref<string[]>([])
const mappings = ref<Record<string, string>>({})
const shownCount = ref(100)
const previousFocus = document.activeElement as HTMLElement | null
const sessions = computed(() => preview.value?.sessions || [])
const ready = computed(() => sessions.value.filter(row => row.status === 'ready'))
const chosen = computed(() => ready.value.filter(row => selected.value.includes(row.id)))
const projects = computed(() => Array.from(new Set(chosen.value.map(row => row.cwd))))
const missingPaths = computed(() => projects.value.some(cwd => !mappings.value[cwd]))
const canImport = computed(() => chosen.value.length > 0 && !missingPaths.value && !busy.value && !result.value)
const allSelected = computed(() => ready.value.length > 0 && selected.value.length === ready.value.length)
const labels: Record<GaogeDesktopCodexSessionImportItem['status'], string> = {
  ready: '可导入', duplicate: '已存在', metadataOnly: '无聊天记录', invalid: '无法恢复', deleted: '本机已删除',
}
const errorText = (value: unknown) => value instanceof Error ? value.message : String(value)

function close() { if (!busy.value) emit('close') }
function toggleAll() { selected.value = allSelected.value ? [] : ready.value.map(row => row.id) }
async function chooseFile() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  result.value = null
  preview.value = null
  selected.value = []
  mappings.value = {}
  shownCount.value = 100
  try {
    if (!window.gaogeDesktop?.previewCodexSessionsImport) throw new Error('当前桌面版本不支持会话导入，请更新后重试。')
    const response = await window.gaogeDesktop.previewCodexSessionsImport()
    if (response.cancelled) return
    preview.value = response
    for (const row of response.sessions || []) {
      if (row.status !== 'ready') continue
      selected.value.push(row.id)
      mappings.value[row.cwd] = row.suggestedProjectPath
    }
  } catch (failure) { error.value = errorText(failure) }
  finally { busy.value = false }
}
async function chooseProject(cwd: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!window.gaogeDesktop?.selectCodexSessionProjectDir) throw new Error('当前版本不支持选择项目文件夹。')
    const response = await window.gaogeDesktop.selectCodexSessionProjectDir()
    if (!response.cancelled) mappings.value[cwd] = response.path
  } catch (failure) { error.value = errorText(failure) }
  finally { busy.value = false }
}
async function startImport() {
  if (!canImport.value || !preview.value?.filePath || !preview.value.archiveHash) return
  busy.value = true
  importing.value = true
  error.value = ''
  try {
    if (!window.gaogeDesktop?.importCodexSessions) throw new Error('当前版本不支持会话导入。')
    const response = await window.gaogeDesktop.importCodexSessions({
      filePath: preview.value.filePath,
      archiveHash: preview.value.archiveHash,
      sessionIds: [...selected.value],
      projectMappings: { ...mappings.value },
    })
    result.value = response
    emit('imported', response)
  } catch (failure) { error.value = errorText(failure) }
  finally { busy.value = false; importing.value = false }
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || !dialog.value) return
  const elements = Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
  const first = elements[0], last = elements[elements.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(async () => { await nextTick(); dialog.value?.focus(); await chooseFile() })
onUnmounted(() => previousFocus?.focus())
</script>

<template>
  <div :class="['session-import-backdrop', { 'is-dark': dark }]" @click.self="close">
    <section ref="dialog" class="session-import-dialog" role="dialog" aria-modal="true" aria-labelledby="session-import-title" :aria-busy="busy" tabindex="-1" @keydown="onKeydown">
      <header>
        <div><h2 id="session-import-title">导入会话</h2><p>选择本软件导出的 ZIP，在这台电脑恢复聊天记录。</p></div>
        <button type="button" :disabled="busy" aria-label="关闭导入会话" @click="close"><X :size="20" /></button>
      </header>
      <main>
        <div class="file-picker"><button type="button" :disabled="busy" @click="chooseFile"><Upload :size="16" /> {{ preview ? '重新选择文件' : '选择会话 ZIP' }}</button><span v-if="preview" class="file-path" :title="preview.filePath">{{ preview.filePath }}</span></div>
        <p v-if="busy" role="status">{{ importing ? '正在恢复会话，请稍候…' : '正在读取，请稍候…' }}</p>
        <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
        <template v-if="preview && !result">
          <div class="summary"><strong>{{ ready.length }} 个可导入</strong><span>{{ sessions.filter(row => row.status === 'duplicate').length }} 个已存在</span><span>{{ sessions.filter(row => !['ready', 'duplicate'].includes(row.status)).length }} 个不可导入</span></div>
          <p class="hint">已有会话会跳过；仅有标题、缺少正文或分支历史的条目无法恢复。项目代码和外部附件需另行复制。</p>
          <div class="session-table" tabindex="0" aria-label="导入会话预览">
            <table>
              <thead><tr><th><input type="checkbox" aria-label="选择全部可导入会话" :checked="allSelected" :disabled="busy || !ready.length" @change="toggleAll" /></th><th>会话</th><th>状态</th></tr></thead>
              <tbody><tr v-for="row in sessions.slice(0, shownCount)" :key="row.id"><td><input v-model="selected" type="checkbox" :value="row.id" :aria-label="'导入 ' + row.title" :disabled="busy || row.status !== 'ready'" /></td><td><strong>{{ row.title }}</strong><small v-if="row.archived">已归档</small><span v-if="row.message" class="row-message">{{ row.message }}</span></td><td><span :class="['status', row.status]">{{ labels[row.status] }}</span></td></tr></tbody>
            </table>
            <button v-if="sessions.length > shownCount" type="button" :disabled="busy" @click="shownCount += 100">显示更多</button>
          </div>
          <section v-if="projects.length" class="projects" aria-label="本机项目文件夹">
            <h3>本机项目文件夹</h3>
            <p class="hint">原电脑的路径不同或不存在时，请选择已复制到本机的项目文件夹。</p>
            <div v-for="cwd in projects" :key="cwd" class="project-row">
              <div><small>原目录：{{ cwd || '未指定项目' }}</small><span :class="{ 'missing-path': !mappings[cwd] }">{{ mappings[cwd] || '请选择本机文件夹' }}</span></div>
              <button type="button" :disabled="busy" :aria-label="'选择本机文件夹：' + (cwd || '未指定项目')" @click="chooseProject(cwd)"><FolderOpen :size="16" /> 选择文件夹</button>
            </div>
          </section>
          <p class="hint">导入位置：{{ preview.codexHome }}</p>
          <p class="notice">请先退出 Codex，再点击开始导入；完成后重新打开 Codex。手动导入不需要开启“同步会话”。</p>
        </template>
        <div v-if="result" class="result" role="status">
          <h3>导入结果</h3>
          <p>成功 {{ result.importedCount }} 个 · 跳过 {{ result.skippedCount }} 个 · 失败 {{ result.failedCount }} 个</p>
          <p v-if="result.importedCount">重新打开 Codex 后查看；已归档会话保留在归档中。</p>
          <ul v-if="result.skipped.length || result.failures.length"><li v-for="item in [...result.skipped, ...result.failures]" :key="item.sessionId"><strong>{{ sessions.find(row => row.id === item.sessionId)?.title || item.sessionId }}</strong>：{{ item.message }}</li></ul>
        </div>
      </main>
      <footer><span v-if="preview && !result">已选择 {{ selected.length }} 个<span v-if="missingPaths"> · 请补全本机项目目录</span></span><button type="button" :disabled="busy" @click="close">{{ result ? '完成' : '取消' }}</button><button v-if="!result" class="primary" type="button" :disabled="!canImport" @click="startImport">{{ importing ? '导入中…' : '开始导入' }}</button></footer>
    </section>
  </div>
</template>

<style scoped>
.session-import-backdrop{position:fixed;inset:0;z-index:3500;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.48);font-family:inherit;color:#1e293b;--surface:#fff;--muted:#64748b;--border:#e2e8f0;--soft:#f8fafc;--accent:#2563eb}
.session-import-backdrop.is-dark{color:#e2e8f0;--surface:#1b2230;--muted:#a8b4c6;--border:#374151;--soft:#232e3e;--accent:#60a5fa}
.session-import-dialog{width:min(880px,100%);max-height:90vh;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:0 24px 90px #0003;overflow:hidden;outline:none}
header,footer{display:flex;gap:14px;align-items:center;padding:20px 24px}header{border-bottom:1px solid var(--border);justify-content:space-between}footer{border-top:1px solid var(--border);justify-content:flex-end}footer>span{margin-right:auto;font-size:13px;color:var(--muted)}
main{overflow:auto;padding:20px 24px}h2{font-size:20px;margin:0}h3{font-size:15px;margin:0 0 10px}p{line-height:1.65;font-size:13px;margin:8px 0}header p,.hint{color:var(--muted)}
button{display:inline-flex;align-items:center;justify-content:center;gap:7px;flex-shrink:0;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:inherit;padding:9px 12px;font:inherit;font-size:13px;cursor:pointer}button:hover:not(:disabled){background:var(--soft)}button:disabled{opacity:.45;cursor:default}button.primary{background:#2563eb;color:#fff;border-color:#2563eb}button.primary:hover:not(:disabled){background:#1d4ed8}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.file-picker,.summary{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.file-path{color:var(--muted);font-size:12px;overflow-wrap:anywhere;flex:1;min-width:160px}.summary{margin:22px 0 8px;font-size:13px}.summary strong{color:var(--accent)}
.session-table{max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:10px;margin-top:14px}table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}th{background:var(--soft);position:sticky;top:0}th,td{padding:11px 12px;border-bottom:1px solid var(--border);vertical-align:top}th:first-child,td:first-child{width:24px}td strong{display:block;overflow-wrap:anywhere}td small,.row-message{display:block;color:var(--muted);font-size:12px;margin-top:4px}.status{white-space:nowrap;color:var(--muted)}.status.ready{color:var(--accent)}input{accent-color:#2563eb}
.projects{margin-top:22px}.project-row{display:flex;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--border)}.project-row>div{min-width:0;flex:1}.project-row small{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere;margin-bottom:6px}.project-row span{display:block;font-size:13px;overflow-wrap:anywhere}.missing-path{color:#d97706}.notice,.feedback{padding:10px 14px;border-radius:8px;background:var(--soft)}.error{color:#dc2626}.result{padding:20px 0}.result ul{font-size:13px;line-height:1.7;padding-left:20px}
@media(max-width:600px){.session-import-backdrop{padding:10px}header,footer,main{padding:14px}.project-row{align-items:flex-start;flex-direction:column}.summary{gap:9px}footer{flex-wrap:wrap}footer>span{width:100%}.session-import-dialog{max-height:95vh}}
</style>
