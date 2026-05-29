<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";

const props = defineProps<{
  src: string;
  name: string;
}>();

const audioRef = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const currentTime = ref(0);
const duration = ref(0);

function toggle() {
  if (!audioRef.value) return;
  if (audioRef.value.paused) {
    audioRef.value.play();
  } else {
    audioRef.value.pause();
  }
}

function seek(e: MouseEvent) {
  if (!audioRef.value || !duration.value) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  audioRef.value.currentTime = ((e.clientX - rect.left) / rect.width) * duration.value;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

onMounted(() => {
  const a = audioRef.value;
  if (!a) return;
  a.addEventListener("play", () => {
    playing.value = true;
  });
  a.addEventListener("pause", () => {
    playing.value = false;
  });
  a.addEventListener("timeupdate", () => {
    currentTime.value = a.currentTime;
  });
  a.addEventListener("durationchange", () => {
    duration.value = a.duration;
  });
});

onBeforeUnmount(() => {
  audioRef.value?.pause();
});
</script>

<template>
  <div
    class="w-full rounded-xl border border-border bg-bg-elevated px-5 py-4 flex items-center gap-4"
  >
    <audio ref="audioRef" :src="src" preload="metadata" class="hidden" />

    <button
      type="button"
      class="w-10 h-10 rounded-full flex items-center justify-center bg-accent/10 border border-accent/30 text-accent hover:bg-accent/20 transition-colors shrink-0"
      :aria-label="playing ? 'pause' : 'play'"
      @click="toggle"
    >
      <span :class="playing ? 'i-lucide:pause' : 'i-lucide:play'" class="w-5 h-5" />
    </button>

    <div class="flex-1 flex flex-col gap-1.5 min-w-0">
      <span class="text-sm text-fg truncate font-mono">{{ name }}</span>
      <div
        class="h-1.5 bg-bg-muted rounded-full cursor-pointer"
        role="slider"
        :aria-valuenow="currentTime"
        :aria-valuemax="duration"
        @click="seek"
      >
        <div
          class="h-full bg-accent rounded-full transition-all"
          :style="`width: ${duration ? (currentTime / duration) * 100 : 0}%`"
        />
      </div>
      <div class="flex justify-between text-xs text-fg-subtle font-mono">
        <span>{{ fmt(currentTime) }}</span>
        <span>{{ fmt(duration) }}</span>
      </div>
    </div>

    <a
      :href="src"
      :download="name"
      class="text-fg-muted hover:text-fg transition-colors shrink-0"
      aria-label="download"
    >
      <span class="i-lucide:download w-4 h-4" />
    </a>
  </div>
</template>
