import { defineConfig } from "void/config";

export default defineConfig({
  worker: {
    compatibility_date: "2026-08-30",
    compatibility_flags: ["nodejs_compat", "nodejs_als"],
  },
  cloudflare: { name: "drive" },
});
