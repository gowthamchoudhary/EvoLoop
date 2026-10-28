import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// __BUILD_TIME__ is baked in at build time and shown in the footer.
export default defineConfig({
  plugins: [react()],
  base: "./",
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/public": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
    },
  },
});
