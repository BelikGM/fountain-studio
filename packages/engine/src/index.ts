import path from 'node:path';
import { AudioStore } from './audio';
import { AudioPlayer } from './audioplayer';
import { loadConfig } from './config';
import { DmxCapture } from './dmxcapture';
import { Engine } from './engine';
import { NetworkMonitor } from './netmonitor';
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

// Мониторинг сети: опрашиваем адреса Art-Net-выходов из конфига (ArtPoll + TOD).
const artnetOutputs = config.universes.flatMap((u) =>
  u.outputs.filter((o) => o.type === 'artnet'),
);
const net =
  artnetOutputs.length > 0
    ? new NetworkMonitor({
        targets: [...new Set(artnetOutputs.map((o) => (o.broadcast ? '255.255.255.255' : o.host ?? '127.0.0.1')))],
        universes: [...new Set(artnetOutputs.map((o) => o.universe))],
      })
    : undefined;
// Захват входящего ArtDMX (§17 п.1): снятие готовых сцен с внешнего источника.
const capture = new DmxCapture();
if (net) net.onDmx = (universe, data, fromIp) => capture.handle(universe, data, fromIp);
net?.start();

startServer(engine, store, audio, net, capture);

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
