import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // expose the dev server on the local network (e.g. for a wall display)
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
