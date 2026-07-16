import { loadConfig } from './config';
import { Engine } from './engine';
import { startServer } from './server';

const config = loadConfig(process.argv);
const engine = new Engine(config);

engine.start();
startServer(engine);

// Периодический отчёт о качестве тайминга в консоль (важно в headless-режиме).
setInterval(() => {
  const s = engine.stats();
  console.log(
    `[stats] тиков: ${s.ticks}, джиттер avg ${s.avgJitterMs} мс / max ${s.maxJitterMs} мс, кадров отправлено: ${s.framesSent}`,
  );
}, 10_000);

process.on('SIGINT', () => {
  console.log('\n[engine] остановка…');
  engine.stop();
  process.exit(0);
});
