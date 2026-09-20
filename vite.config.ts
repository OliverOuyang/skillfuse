import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { llmProxyPlugin } from "./vite/llmProxyPlugin"

// https://vite.dev/config/
export default defineConfig({
  base: "./",
  plugins: [react(), llmProxyPlugin()],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
