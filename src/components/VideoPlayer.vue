<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";

const props = defineProps<{
  src: string;
  name: string;
  mimeType: string;
}>();

const videoRef = ref<HTMLVideoElement | null>(null);
const playing = ref(false);
const muted = ref(false);
const fullscreen = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const buffered = ref(0);

function toggle() {
  if (!videoRef.value) return;
  if (videoRef.value.paused) {
    videoRef.value.play();
  } else {
    videoRef.value.pause();
  }
}

function seek(e: MouseEvent) {
  if (!videoRef.value || !duration.value) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  videoRef.value.currentTime = ((e.clientX - rect.left) / rect.width) * duration.value;
}

function toggleMute() {
  if (!videoRef.value) return;
  videoRef.value.muted = !videoRef.value.muted;
}

function toggleFullscreen() {
  if (!videoRef.value) return;
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    videoRef.value.requestFullscreen();
  }
}

function fmt(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

onMounted(() => {
  const v = videoRef.value;
  if (!v) return;
  v.addEventListener("play", () => {
    playing.value = true;
  });
  v.addEventListener("pause", () => {
    playing.value = false;
  });
  v.addEventListener("timeupdate", () => {
    currentTime.value = v.currentTime;
  });
  v.addEventListener("durationchange", () => {
    duration.value = v.duration;
  });
  v.addEventListener("volumechange", () => {
    muted.value = v.muted;
  });
  v.addEventListener("progress", () => {
    if (v.buffered.length > 0) buffered.value = v.buffered.end(v.buffered.length - 1);
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreen.value = !!document.fullscreenElement;
  });
});

onBeforeUnmount(() => {
  videoRef.value?.pause();
});
</script>

<template>
  <div class="w-full bg-black rounded-xl overflow-hidden group">
    <div class="relative aspect-video" @click="toggle">
      <video
        ref="videoRef"
        :src="src"
        :type="mimeType"
        class="w-full h-full object-contain"
        preload="metadata"
      />

      <div
        v-if="!playing"
        class="absolute inset-0 flex items-center justify-center pointer-events-none"
      >
        <span class="i-lucide:play-circle w-16 h-16 text-white/80" />
      </div>
    </div>

    <div class="px-4 py-3 flex flex-col gap-2 bg-bg-elevated">
      <div
        class="h-1.5 bg-bg-muted rounded-full cursor-pointer relative"
        role="slider"
        :aria-valuenow="currentTime"
        :aria-valuemax="duration"
        @click="seek"
      >
        <div
          class="absolute inset-y-0 left-0 bg-fg-subtle/40 rounded-full"
          :style="`width: ${duration ? (buffered / duration) * 100 : 0}%`"
        />
        <div
          class="absolute inset-y-0 left-0 bg-accent rounded-full"
          :style="`width: ${duration ? (currentTime / duration) * 100 : 0}%`"
        />
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          class="text-fg-muted hover:text-fg transition-colors"
          :aria-label="playing ? 'pause' : 'play'"
          @click="toggle"
        >
          <span :class="playing ? 'i-lucide:pause' : 'i-lucide:play'" class="w-5 h-5" />
        </button>
        <button
          type="button"
          class="text-fg-muted hover:text-fg transition-colors"
          :aria-label="muted ? 'unmute' : 'mute'"
          @click="toggleMute"
        >
          <span :class="muted ? 'i-lucide:volume-x' : 'i-lucide:volume-2'" class="w-4 h-4" />
        </button>
        <span class="text-xs text-fg-subtle font-mono flex-1">
          {{ fmt(currentTime) }} / {{ fmt(duration) }}
        </span>
        <a
          :href="src"
          :download="name"
          class="text-fg-muted hover:text-fg transition-colors"
          aria-label="download"
        >
          <span class="i-lucide:download w-4 h-4" />
        </a>
        <button
          type="button"
          class="text-fg-muted hover:text-fg transition-colors"
          :aria-label="fullscreen ? 'exit fullscreen' : 'fullscreen'"
          @click="toggleFullscreen"
        >
          <span :class="fullscreen ? 'i-lucide:minimize' : 'i-lucide:maximize'" class="w-4 h-4" />
        </button>
      </div>
    </div>
  </div>
</template>
