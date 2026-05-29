<script setup lang="ts">
defineProps<{
  src: string;
  name: string;
}>();
</script>

<template>
  <div class="w-full flex flex-col gap-3">
    <div class="flex-split">
      <span class="text-sm text-fg-muted font-mono">{{ name }}</span>
      <a :href="src" :download="name" class="btn">
        <span class="i-lucide:download w-3.5 h-3.5" aria-hidden="true" />
        download
      </a>
    </div>
    <iframe
      :src="src"
      :title="name"
      class="w-full rounded-xl border border-border bg-white"
      style="height: 80vh"
    />
  </div>
</template>
