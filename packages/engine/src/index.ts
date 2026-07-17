import path from 'node:path';
import { loadConfig } from './config';
import { Engine } from './engine';
import { ProjectStore } from './project';
import { startServer } from './server';

const config = loadConfig(process.argv);
const engine = new Engine(config);
const store = new ProjectStore(path.join(path.dirname(config.configFile), 'fountain.project.json'));

engine.setProject(store.project);
engine.start();
startServer(engine, store);

// Периодический отчёт о качестве тайминга в консоль (важно в headless-режиме).
setInterval(() => {
  const s = engine.stats();
  console.log(
    `[stats] тиков: ${s.ticks}, джиттер avg ${s.avgJitterMs} мс / max ${s.maxJitterMs} мс, кадров отправлено: ${s.framesSent}`,
  );
}, 10_000);

process.on('SIGINT', () => {
  console.log('\n[engine] остановка…');
  store.flush();
  engine.stop();
  process.exit(0);
});
