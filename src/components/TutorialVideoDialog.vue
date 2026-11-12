<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Play, RefreshCcw, X } from 'lucide-vue-next'

interface TutorialVideo {
  title: string
  description: string
  src: string
}

const props = defineProps<{
  eyebrow: string
  video: TutorialVideo
  videos: TutorialVideo[]
}>()
const emit = defineEmits<{
  close: []
  select: [video: TutorialVideo]
}>()
const dialog = ref<HTMLDialogElement | null>(null)
const player = ref<HTMLVideoElement | null>(null)
const loadFailed = ref(false)

watch(() => props.video.src, () => { loadFailed.value = false })
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => {
  player.value?.pause()
  dialog.value?.close()
})

function closeOnBackdrop(event: MouseEvent) {
  const element = dialog.value
  if (!element || event.target !== element) return
  const bounds = element.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) emit('close')
}

function retryVideo() {
  loadFailed.value = false
  player.value?.load()
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="tutorial-video-dialog"
      aria-labelledby="tutorial-video-title"
      @cancel.prevent="emit('close')"
      @click="closeOnBackdrop"
      @keydown.esc.stop
    >
      <header class="tutorial-video-header">
        <div>
          <span>{{ eyebrow }}</span>
          <h2 id="tutorial-video-title">{{ video.title }}</h2>
        </div>
        <button class="tutorial-video-close" type="button" aria-label="关闭视频教程" autofocus @click="emit('close')">
          <X :size="20" />
        </button>
      </header>
      <nav v-if="videos.length > 1" class="tutorial-video-options" aria-label="选择教程视频">
        <button
          v-for="option in videos"
          :key="option.src"
          type="button"
          :aria-pressed="video.src === option.src"
          @click="emit('select', option)"
        >
          <Play :size="15" />
          {{ option.title }}
        </button>
      </nav>
      <video
        :key="video.src"
        ref="player"
        class="tutorial-video-player"
        :src="video.src"
        :aria-label="video.title"
        controls
        playsinline
        preload="metadata"
        @error="loadFailed = true"
      >你的浏览器暂不支持视频播放。</video>
      <div v-if="loadFailed" class="tutorial-video-error" role="alert">
        <span>视频暂时无法加载，请检查网络后重试。</span>
        <button type="button" @click="retryVideo"><RefreshCcw :size="15" />重新加载</button>
      </div>
      <p class="tutorial-video-description">{{ video.description }}</p>
    </dialog>
  </Teleport>
</template>

<style scoped>
.tutorial-video-dialog {
  box-sizing: border-box;
  width: min(900px, calc(100vw - 40px));
  max-height: calc(100dvh - 40px);
  margin: auto;
  padding: 22px;
  overflow: auto;
  border: 1px solid #334155;
  border-radius: 20px;
  background: #101a2b;
  color: #f1f5f9;
  box-shadow: 0 28px 90px #02061780;
}
.tutorial-video-dialog::backdrop { background: #020617bb; backdrop-filter: blur(8px); }
.tutorial-video-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.tutorial-video-header span { color: #93c5fd; font-size: 12px; }
.tutorial-video-header h2 { margin: 6px 0 0; font-size: 20px; line-height: 1.4; }
.tutorial-video-dialog button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid #334155; border-radius: 10px; background: #1e293b; color: inherit; font: inherit; cursor: pointer; }
.tutorial-video-dialog button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 3px; }
.tutorial-video-close { flex-shrink: 0; width: 36px; height: 36px; }
.tutorial-video-options { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.tutorial-video-options button { padding: 9px 12px; font-size: 13px; }
.tutorial-video-options button[aria-pressed="true"] { border-color: #60a5fa; background: #1e3a5f; color: #bfdbfe; }
.tutorial-video-player { display: block; width: 100%; max-height: 60dvh; aspect-ratio: 16 / 9; border-radius: 12px; background: #000; }
.tutorial-video-description { margin: 14px 0 0; color: #cbd5e1; font-size: 13px; line-height: 1.7; }
.tutorial-video-error { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-top: 12px; color: #fcd34d; font-size: 13px; }
.tutorial-video-error button { padding: 8px 12px; }
@media (max-width: 600px) {
  .tutorial-video-dialog { width: calc(100vw - 20px); max-height: calc(100dvh - 20px); padding: 16px; border-radius: 16px; }
  .tutorial-video-header h2 { font-size: 17px; }
}
</style>
