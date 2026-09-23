import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  build: {
    outDir: "../../web-dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:47831",
      "/ws": { target: "ws://127.0.0.1:47831", ws: true },
    },
  },
});
