import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const api_target = process.env.API_URL ?? "http://localhost:3000"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    watch: {
      ignored: ["**/.runtime/**"],
    },
    proxy: {
      "/api": api_target,
    },
  },
})
