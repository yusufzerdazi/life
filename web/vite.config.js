import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // desktop.html: the desktop app's page (desktop/).
      input: { main: "index.html", desktop: "desktop.html" },
    },
  },
  server: {
    port: 5173,
    host: true, // expose the dev server on the local network (e.g. for a wall display)
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
