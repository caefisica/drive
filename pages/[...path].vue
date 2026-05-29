<script setup lang="ts">
import { Link } from "@void/vue";
import type { Props } from "./[...path].server";
import FileGrid from "../src/components/FileGrid.vue";
import BreadcrumbNav from "../src/components/BreadcrumbNav.vue";
import VideoPlayer from "../src/components/VideoPlayer.vue";
import AudioPlayer from "../src/components/AudioPlayer.vue";
import CodeViewer from "../src/components/CodeViewer.vue";
import PdfViewer from "../src/components/PdfViewer.vue";
import MarkdownViewer from "../src/components/MarkdownViewer.vue";
import PasswordGate from "../src/components/PasswordGate.vue";

const props = defineProps<Props>();
</script>

<template>
  <PasswordGate
    v-if="props.type === 'locked'"
    :drive-idx="props.driveIdx"
    :folder-id="props.folderId"
    :return-path="props.path"
  />

  <template v-else-if="props.type === 'directory'">
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
        <FileGrid
          :items="props.items"
          :base-path="`/${props.driveIdx}/${props.segments.map(encodeURIComponent).join('/')}/`"
        />
      </div>
    </div>
  </template>

  <template v-else-if="props.type === 'file'">
    <div class="flex flex-col gap-6">
      <div class="flex items-start gap-4 flex-wrap">
        <BreadcrumbNav
          :drive-idx="props.driveIdx"
          :drive-name="props.drive.name"
          :segments="[...props.segments, props.file.name]"
        />
        <div class="ml-auto flex items-center gap-2 shrink-0">
          <a v-if="props.exportUrl" :href="props.exportUrl" class="btn">
            <span class="i-lucide:download w-3.5 h-3.5" aria-hidden="true" />
            export{{ props.exportExt }}
          </a>
          <a v-else :href="props.streamUrl" :download="props.file.name" class="btn">
            <span class="i-lucide:download w-3.5 h-3.5" aria-hidden="true" />
            download
          </a>
        </div>
      </div>

      <VideoPlayer
        v-if="props.file.kind === 'video'"
        :src="props.streamUrl"
        :name="props.file.name"
        :mime-type="props.file.mimeType"
      />

      <AudioPlayer
        v-else-if="props.file.kind === 'audio'"
        :src="props.streamUrl"
        :name="props.file.name"
      />

      <div v-else-if="props.file.kind === 'image'" class="flex justify-center">
        <img
          :src="props.streamUrl"
          :alt="props.file.name"
          class="max-w-full max-h-screen rounded-xl border border-border"
        />
      </div>

      <PdfViewer
        v-else-if="props.file.kind === 'pdf'"
        :src="props.streamUrl"
        :name="props.file.name"
      />

      <CodeViewer
        v-else-if="props.file.kind === 'code' && props.renderedHtml"
        :html="props.renderedHtml"
        :name="props.file.name"
        :download-url="props.streamUrl"
      />

      <MarkdownViewer
        v-else-if="props.file.kind === 'markdown' && props.renderedHtml"
        :html="props.renderedHtml"
        :name="props.file.name"
        :download-url="props.streamUrl"
      />

      <div v-else class="flex flex-col items-center gap-4 py-16 text-center">
        <span class="i-lucide:file w-16 h-16 text-fg-subtle" aria-hidden="true" />
        <p class="font-mono text-fg">{{ props.file.name }}</p>
        <a :href="props.streamUrl" :download="props.file.name" class="btn-accent">
          <span class="i-lucide:download w-4 h-4" aria-hidden="true" />
          download
        </a>
      </div>
    </div>
  </template>
</template>
