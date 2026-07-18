import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Относительные пути ресурсов — сборка должна открываться и с file:// (Electron).
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
  },
});
