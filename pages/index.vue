<script setup lang="ts">
import { Link } from "@void/vue";
import type { Props } from "./index.server";
import FileGrid from "../src/components/FileGrid.vue";
import BreadcrumbNav from "../src/components/BreadcrumbNav.vue";

const props = defineProps<Props>();
</script>

<template>
  <div
    v-if="props.type === 'no-config'"
    class="flex flex-col items-center justify-center py-24 gap-4 text-center"
  >
    <span class="i-lucide:settings w-12 h-12 text-fg-subtle" aria-hidden="true" />
    <h1 class="text-xl font-mono text-fg">not configured</h1>
    <p class="text-sm text-fg-muted max-w-sm">
      set the <code class="font-mono text-accent">DRIVES</code> environment variable to a JSON array
      of drive configs.
    </p>
  </div>

  <template v-else>
    <nav v-if="props.drives.length > 1" class="flex items-center gap-1 mb-6" aria-label="drives">
      <Link
        v-for="d in props.drives"
        :key="d.idx"
        :href="`/${d.idx}/`"
        :class="[
          'drive-tab',
          d.idx === props.driveIdx
            ? 'bg-accent/10 text-fg border-accent/30'
            : 'text-fg-muted hover:text-fg hover:bg-bg-subtle border-transparent',
        ]"
      >
        {{ d.name }}
      </Link>
    </nav>

    <div class="flex flex-col gap-4">
      <div class="flex-split">
        <BreadcrumbNav
          :drive-idx="props.driveIdx"
          :drive-name="props.drive.name"
          :segments="props.segments"
        />
        <span class="text-xs text-fg-subtle font-mono">{{ props.items.length }} items</span>
      </div>

      <div class="table-shell">
        <div class="table-head-row">
          <span class="w-4 shrink-0" />
          <span>name</span>
          <span class="hidden sm:block text-right shrink-0">size</span>
          <span class="hidden md:block text-right shrink-0">modified</span>
        </div>
        <FileGrid :items="props.items" :base-path="`/${props.driveIdx}/`" />
      </div>
    </div>
  </template>
</template>
