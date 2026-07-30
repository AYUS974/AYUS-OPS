import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// In dev, the Express server runs on :3000 and Vite proxies API calls to it.
// In production, Express serves the built files from web/dist itself.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../", "");
  return {
    plugins: [react()],
    define: {
      "process.env.GEMINI_MODEL": JSON.stringify(env.GEMINI_MODEL || ""),
      "process.env.ANTHROPIC_MODEL": JSON.stringify(env.ANTHROPIC_MODEL || ""),
    },
    build: {
      // Two pages: the dashboard and the floating desktop pill, which needs the
      // same bundler treatment so it can import the shared voice engine.
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL("./index.html", import.meta.url)),
          overlay: fileURLToPath(new URL("./overlay.html", import.meta.url)),
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: "http://localhost:3000",
          ws: true,
        },
        "/healthz": "http://localhost:3000",
      },
    },
  };
});
