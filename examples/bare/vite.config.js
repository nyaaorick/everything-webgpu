import { defineConfig } from "vite";
import { everythingWebGPU } from "everything-webgpu/vite";

// The plugin's whole job is `optimizeDeps.exclude`, which stops Vite's
// dependency pre-bundler rewriting the decode worker's URL to a path that does
// not exist. The plugin source carries the measurement.
//
// Worth knowing while reading this example: **it cannot demonstrate the bug.**
// The dependency here is `file:../..`, and Vite never pre-bundles a linked
// package, so this line is a no-op in this project. Only a real install
// reproduces it — `npm run verify-consumer` in the repo root does that, and
// asserts the failure as well as the fix.
export default defineConfig({
  plugins: [everythingWebGPU()],
  build: {
    // The WebLLM bundle is one big lazy chunk on purpose; silence the warning.
    chunkSizeWarningLimit: 8000,
  },
});
