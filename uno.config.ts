import {
  defineConfig,
  presetIcons,
  presetTypography,
  presetWind4,
  transformerVariantGroup,
} from "unocss";

export default defineConfig({
  presets: [
    presetWind4(),
    presetIcons({
      extraProperties: {
        display: "inline-block",
        "forced-color-adjust": "preserve-parent-color",
      },
      warn: true,
      scale: 1.2,
    }),
    presetTypography(),
  ],
  transformers: [transformerVariantGroup()],
  theme: {
    font: {
      mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      sans: "'IBM Plex Sans', 'Inter', 'Segoe UI', system-ui, sans-serif",
    },
    colors: {
      bg: {
        DEFAULT: "var(--bg)",
        subtle: "var(--bg-subtle)",
        muted: "var(--bg-muted)",
        elevated: "var(--bg-elevated)",
      },
      fg: {
        DEFAULT: "var(--fg)",
        muted: "var(--fg-muted)",
        subtle: "var(--fg-subtle)",
      },
      border: {
        DEFAULT: "var(--border)",
        hover: "var(--border-hover)",
      },
      accent: {
        DEFAULT: "var(--accent)",
      },
    },
  },
  shortcuts: [
    ["container", "max-w-5xl mx-auto px-4 sm:px-6"],
    ["flex-split", "flex items-center justify-between"],
    ["focus-ring", "outline-none focus-visible:(ring-2 ring-fg/50 ring-offset-2 ring-offset-bg)"],
    ["surface", "rounded-xl border border-border bg-bg-subtle"],
    ["table-shell", "surface overflow-hidden"],
    ["drive-tab", "px-3 py-1.5 rounded-lg text-sm font-mono border transition-colors focus-ring"],
    [
      "table-head-row",
      "grid grid-cols-[1rem_minmax(0,1fr)] sm:grid-cols-[1rem_minmax(0,1fr)_6.25rem] md:grid-cols-[1rem_minmax(0,1fr)_6.25rem_8rem] items-center gap-3 px-3 py-2 border-b border-border text-xs text-fg-subtle font-mono uppercase tracking-wide",
    ],
    [
      "table-body-row",
      "group grid grid-cols-[1rem_minmax(0,1fr)] sm:grid-cols-[1rem_minmax(0,1fr)_6.25rem] md:grid-cols-[1rem_minmax(0,1fr)_6.25rem_8rem] items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-bg-muted/70 transition-colors",
    ],
    [
      "btn",
      "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-bg-subtle text-fg-muted text-sm font-mono hover:border-border-hover hover:text-fg transition-colors focus-ring",
    ],
    [
      "btn-accent",
      "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-accent/40 bg-accent/10 text-fg text-sm font-mono hover:bg-accent/15 transition-colors focus-ring",
    ],
  ],
});
