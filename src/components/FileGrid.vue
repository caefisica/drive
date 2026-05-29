<script setup lang="ts">
import { Link } from "@void/vue";
import type { DriveFile, FileKind } from "../integrations/google-drive";

defineProps<{
  items: Array<DriveFile & { kind: FileKind }>;
  basePath: string;
}>();

const ICONS: Record<FileKind | "default", string> = {
  folder: "i-lucide:folder",
  video: "i-lucide:video",
  audio: "i-lucide:music",
  image: "i-lucide:image",
  pdf: "i-lucide:file-text",
  code: "i-lucide:code",
  markdown: "i-lucide:file-text",
  document: "i-lucide:file-spreadsheet",
  archive: "i-lucide:archive",
  other: "i-lucide:file",
  default: "i-lucide:file",
};

function iconFor(kind: FileKind): string {
  return ICONS[kind] ?? ICONS.default;
}

function hrefFor(item: DriveFile & { kind: FileKind }, basePath: string): string {
  const encoded = encodeURIComponent(item.name);
  if (item.kind === "folder") return `${basePath}${encoded}/`;
  return `${basePath}${encoded}`;
}

function formatSize(bytes?: number | string): string {
  const n = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
  if (!n) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <Link
      v-for="item in items"
      :key="item.id"
      :href="hrefFor(item, basePath)"
      class="table-body-row"
    >
      <span
        :class="[iconFor(item.kind), item.kind === 'folder' ? 'text-accent' : 'text-fg-subtle']"
        class="w-4 h-4 shrink-0"
        aria-hidden="true"
      />
      <span class="flex-1 truncate text-sm text-fg group-hover:text-fg">{{ item.name }}</span>
      <span class="hidden sm:block text-xs text-fg-subtle tabular-nums text-right shrink-0">
        {{ item.kind === "folder" ? "" : formatSize(item.size) }}
      </span>
      <span class="hidden md:block text-xs text-fg-subtle tabular-nums text-right shrink-0">
        {{ formatDate(item.modifiedTime) }}
      </span>
    </Link>

    <p v-if="items.length === 0" class="text-sm text-fg-subtle py-8 text-center">empty folder</p>
  </div>
</template>
