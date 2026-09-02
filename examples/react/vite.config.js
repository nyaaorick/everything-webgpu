import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { everythingWebGPU } from "everything-webgpu/vite";

// See ../bare/vite.config.js — the plugin sets `optimizeDeps.exclude` so Vite's
// dependency pre-bundler leaves the decode worker's URL alone.
export default defineConfig({
  plugins: [react(), everythingWebGPU()],
  build: {
    chunkSizeWarningLimit: 8000,
  },
});
