import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the Express server runs on :3000 and Vite proxies API calls to it.
// In production, Express serves the built files from web/dist itself.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../", "");
  return {
    plugins: [react()],
    define: {
      "process.env.GEMINI_MODEL": JSON.stringify(env.GEMINI_MODEL || ""),
      "process.env.CLAUDE_MODEL": JSON.stringify(env.CLAUDE_MODEL || ""),
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
