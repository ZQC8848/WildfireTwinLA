import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("../packages/core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    fs: { allow: [".."] },
  },
});
