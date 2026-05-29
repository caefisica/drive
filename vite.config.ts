import { voidVue } from "@void/vue/plugin";
import { defineConfig } from "vite-plus";
import { voidPlugin } from "void";
import UnoCSS from "unocss/vite";

export default defineConfig({
  plugins: [voidPlugin(), UnoCSS(), ...voidVue()],
  staged: {
    "*": "vp check --fix",
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
