import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const RUNNER_PORT = Number(process.env.PATCHLINGS_PORT ?? 4317);
const RUNNER_TARGET = `http://localhost:${RUNNER_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/stream": {
        target: RUNNER_TARGET,
        ws: true
      },
      "/export/storytime": {
        target: RUNNER_TARGET
      },
      "/health": {
        target: RUNNER_TARGET
      },
      "/patchlings-assets": {
        target: RUNNER_TARGET
      }
    }
  },
  preview: {
    port: 5173,
    host: true
  }
});
