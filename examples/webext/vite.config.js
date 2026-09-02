import { resolve } from "node:path";
import { defineConfig } from "vite";
import { everythingWebGPU } from "everything-webgpu/vite";

// Same plugin as the other two examples, plus two things an extension needs
// that a web page does not:
//
//   - `entryFileNames: "[name].js"`, because manifest.json names its background
//     script statically and cannot follow a content hash. Chunks and the decode
//     worker keep their hashes — nothing outside the bundle refers to them.
//   - `base: ""`, so the built index.html uses relative URLs. An extension page
//     is served from moz-extension://<uuid>/, where a leading "/" still
//     resolves, but relative keeps `dist/` loadable as a plain folder too.
export default defineConfig({
  base: "",
  plugins: [everythingWebGPU()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        background: resolve(import.meta.dirname, "src/background.js"),
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
