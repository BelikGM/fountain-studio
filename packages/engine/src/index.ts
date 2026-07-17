import path from 'node:path';
import { AudioStore } from './audio';
import { AudioPlayer } from './audioplayer';
import { loadConfig } from './config';
import { Engine } from './engine';
import { ProjectStore } from './project';
import { Scheduler } from './schedule';
import { startServer } from './server';

const config = loadConfig(process.argv);
const engine = new Engine(config);
const projectDir = path.dirname(config.configFile);
const store = new ProjectStore(path.join(projectDir, 'fountain.project.json'));
const audio = new AudioStore(path.join(projectDir, 'audio'));

// Автономный звук: плейлист сменил шоу — движок сам включает/глушит плеер.
const player = new AudioPlayer(config.audio, path.join(projectDir, 'audio'));
engine.playback.onShowAudio = (show) => {
  if (show && show.audioFile) player.play(show.audioFile, show.cuts);
  else player.stop();
};

engine.setProject(store.project);
engine.start();
startServer(engine, store, audio);

// Расписание по системному времени ПК — работает, пока запущен движок.
const scheduler = new Scheduler(engine, () => store.project.schedule);
scheduler.start();

// Периодический отчёт о качестве тайминга в консоль (важно в headless-режиме).
setInterval(() => {
  const s = engine.stats();
  console.log(
    `[stats] тиков: ${s.ticks}, джиттер avg ${s.avgJitterMs} мс / max ${s.maxJitterMs} мс, кадров отправлено: ${s.framesSent}`,
  );
}, 10_000);

process.on('SIGINT', () => {
  console.log('\n[engine] остановка…');
  scheduler.stop();
  player.stop();
  store.flush();
  engine.stop();
  process.exit(0);
});
