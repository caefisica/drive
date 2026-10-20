import { voidVue } from "@void/vue/plugin";
import { defineConfig, lazyPlugins } from "vite-plus";
import { voidPlugin } from "void";
import UnoCSS from "unocss/vite";

// Vitest 5 cannot start with @cloudflare/vite-plugin. Wrangler provides D1 and
// KV to the tests.
const plugins = () =>
  process.env["VITEST"] ? [UnoCSS(), ...voidVue()] : [voidPlugin(), UnoCSS(), ...voidVue()];

export default defineConfig({
  plugins: lazyPlugins(plugins),
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    overrides: [{ files: ["**/*.md"], options: { printWidth: 80, proseWrap: "always" } }],
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    plugins: ["unicorn", "typescript", "oxc", "vue"],
    rules: {
      "no-console": "warn",
      "typescript/consistent-type-imports": "error",
    },
    overrides: [
      {
        files: ["routes/**/*", "db/**/*", "src/**/*", "crons/**/*", "queues/**/*"],
        rules: {
          "no-console": "off",
        },
      },
    ],
    ignorePatterns: [
      "scripts/**",
      ".output/**",
      ".data/**",
      ".void/**",
      ".cache/**",
      "dist/**",
      "node_modules/**",
    ],
  },
});
