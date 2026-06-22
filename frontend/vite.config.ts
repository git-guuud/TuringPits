import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // A leading "." allows the domain and all its subdomains, so any ngrok tunnel works
  // without re-editing this on each restart (the public URL changes per session).
  server: { port: 5173, allowedHosts: [".ngrok-free.dev"] },
});
