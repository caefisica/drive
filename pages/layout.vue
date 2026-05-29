<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import "virtual:uno.css";
import "../src/styles/app.css";
import { Link } from "@void/vue";

const theme = ref<"dark" | "light">("dark");
const searchQuery = ref("");

function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme.value;
}

function onKeydown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  const isEditable =
    target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
  if (e.key === "/" && !isEditable && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    document.querySelector<HTMLInputElement>("#drive-search")?.focus();
  }
}

onMounted(() => {
  const saved = localStorage.getItem("theme") as "dark" | "light" | null;
  if (saved) {
    theme.value = saved;
    document.documentElement.dataset.theme = saved;
  }
  document.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown);
});

function onThemeChange() {
  localStorage.setItem("theme", theme.value);
}

function onSearch(e: Event) {
  e.preventDefault();
  const q = searchQuery.value.trim();
  if (q) window.location.href = `/api/search?q=${encodeURIComponent(q)}`;
}
</script>

<template>
  <div class="min-h-screen flex flex-col bg-bg text-fg">
    <header class="sticky top-0 z-50 border-b border-border">
      <div class="absolute inset-0 bg-bg/80 backdrop-blur-md" />
      <div class="relative container min-h-14 flex items-center gap-3">
        <Link
          href="/"
          class="font-mono font-bold text-fg hover:text-accent transition-colors mr-2 shrink-0"
        >
          drive
        </Link>

        <form class="flex-1 max-w-md" @submit="onSearch">
          <div class="relative">
            <span
              class="absolute left-3 top-1/2 -translate-y-1/2 i-lucide:search w-3.5 h-3.5 text-fg-subtle pointer-events-none"
            />
            <input
              id="drive-search"
              v-model="searchQuery"
              type="search"
              placeholder="search files..."
              class="w-full pl-8 pr-3 py-1.5 rounded-lg border border-border bg-bg-subtle text-fg placeholder:text-fg-subtle text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>
        </form>

        <button
          type="button"
          class="ml-auto flex items-center justify-center w-8 h-8 rounded-lg border border-border bg-bg-subtle text-fg-muted hover:border-border-hover hover:text-fg transition-colors"
          :aria-label="`switch to ${theme === 'dark' ? 'light' : 'dark'} mode`"
          @click="
            toggleTheme();
            onThemeChange();
          "
        >
          <span :class="theme === 'dark' ? 'i-lucide:sun' : 'i-lucide:moon'" class="w-4 h-4" />
        </button>
      </div>
    </header>

    <main id="main-content" class="container flex-1 py-6 sm:py-8" tabindex="-1">
      <slot />
    </main>

    <footer class="border-t border-border mt-8">
      <div
        class="container min-h-12 flex items-center justify-between text-fg-subtle text-xs font-mono"
      >
        <span>drive</span>
        <span class="text-fg-subtle/60"><kbd>/</kbd> search</span>
        <span>void + vite+</span>
      </div>
    </footer>
  </div>
</template>
