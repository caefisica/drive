import { voidVue } from "@void/vue/plugin";
import { defineConfig, lazyPlugins } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";
import { voidPlugin } from "void";
import UnoCSS from "unocss/vite";

// Vitest 5 cannot start with @cloudflare/vite-plugin. Wrangler provides D1 and
// KV to the tests.
const plugins = () =>
  process.env["VITEST"] ? [UnoCSS(), ...voidVue()] : [voidPlugin(), UnoCSS(), ...voidVue()];

// These tests call D1 and KV. Files in this project share a worker without isolation,
// so the platform proxy boots once per worker instead of once per file.
// src/test-support/platform.ts owns the shared boot.
const bindingTests = [
  "queues/_crawl.test.ts",
  "routes/api/_handlers.test.ts",
  "routes/api/_search.test.ts",
  "src/index-urls.test.ts",
  "src/integrations/google-drive.test.ts",
  "src/loaders.test.ts",
  "src/services/drive-sync.test.ts",
  "src/services/listing.test.ts",
];

export default defineConfig({
  plugins: lazyPlugins(plugins),
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, ...bindingTests],
        },
      },
      {
        extends: true,
        test: {
          name: "bindings",
          include: bindingTests,
          setupFiles: ["src/test-support/platform-setup.ts"],
          isolate: false,
          // Each worker boots one workerd and serves every file it is given. The unit project
          // starts Wrangler too, so the two do not run at the same time.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
          // A D1 call through the proxy takes 70 to 140 ms, so the longest tests make a few hundred
          // round trips and run 5 to 10 s on a busy host. Their hooks make the same calls.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
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
