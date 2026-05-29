<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{
  driveIdx: number;
  folderId: string;
  returnPath: string;
}>();

const password = ref("");
const error = ref("");
const loading = ref(false);

async function submit() {
  if (!password.value.trim()) return;
  loading.value = true;
  error.value = "";

  try {
    const res = await fetch("/api/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driveIdx: props.driveIdx,
        folderId: props.folderId,
        password: password.value,
      }),
    });

    if (res.ok) {
      window.location.reload();
    } else {
      const data = (await res.json()) as { error?: string };
      error.value = data.error ?? "incorrect password";
    }
  } catch {
    error.value = "network error, please try again";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col items-center justify-center py-24 gap-6">
    <span class="i-lucide:lock w-12 h-12 text-fg-subtle" aria-hidden="true" />
    <div class="flex flex-col items-center gap-2 text-center">
      <h2 class="text-lg font-mono text-fg">password required</h2>
      <p class="text-sm text-fg-muted">this folder is protected</p>
    </div>

    <form class="flex flex-col gap-3 w-full max-w-xs" @submit.prevent="submit">
      <input
        v-model="password"
        type="password"
        placeholder="enter password"
        autocomplete="current-password"
        class="w-full px-4 py-2.5 rounded-lg border border-border bg-bg-subtle text-fg placeholder:text-fg-subtle text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent/50"
        :disabled="loading"
      />
      <p v-if="error" class="text-xs text-red-400 font-mono">{{ error }}</p>
      <button type="submit" class="btn-accent w-full justify-center" :disabled="loading">
        <span v-if="loading" class="i-lucide:loader-circle w-4 h-4 animate-spin" />
        <span v-else class="i-lucide:unlock w-4 h-4" />
        {{ loading ? "verifying..." : "unlock" }}
      </button>
    </form>
  </div>
</template>
