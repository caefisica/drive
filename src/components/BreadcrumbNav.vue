<script setup lang="ts">
import { computed } from "vue";
import { Link } from "@void/vue";

const props = defineProps<{
  driveIdx: number;
  driveName: string;
  segments: string[];
}>();

const crumbs = computed(() => {
  const result = [{ label: props.driveName, href: `/${props.driveIdx}/` }];
  let path = `/${props.driveIdx}/`;
  for (const seg of props.segments) {
    path += `${encodeURIComponent(seg)}/`;
    result.push({ label: seg, href: path });
  }
  return result;
});
</script>

<template>
  <nav aria-label="breadcrumb" class="flex items-center gap-1 text-sm text-fg-muted flex-wrap">
    <template v-for="(crumb, i) in crumbs" :key="crumb.href">
      <span v-if="i > 0" class="text-fg-subtle" aria-hidden="true">/</span>
      <Link
        v-if="i < crumbs.length - 1"
        :href="crumb.href"
        class="hover:text-fg transition-colors truncate max-w-40"
        >{{ crumb.label }}</Link
      >
      <span v-else class="text-fg truncate max-w-40" aria-current="page">{{ crumb.label }}</span>
    </template>
  </nav>
</template>
