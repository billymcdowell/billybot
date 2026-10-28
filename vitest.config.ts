import path from "node:path";
import { defineConfig } from "vitest/config";

// Kept apart from vite.config.ts, which is shaped around the Tauri dev server.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
