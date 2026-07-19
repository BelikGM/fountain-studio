import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Относительные пути ресурсов — сборка должна открываться и с file:// (Electron).
  base: './',
  plugins: [react()],
  server: {
    port: 5180, // не 5173 — этот порт на машине разработчика занят другим проектом
    strictPort: true,
    // Явный IPv4 — на части машин голый "localhost" резолвится в ::1 первым,
    // и раздельные IPv4/IPv6 сокеты дают путаницу, слушает ли порт вообще
    // (поймано на этом же проекте: curl на 127.0.0.1 давал отказ, хотя vite
    // писал «ready» — просто занял только ::1).
    host: '127.0.0.1',
  },
});
