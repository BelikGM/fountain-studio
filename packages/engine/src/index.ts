import path from 'node:path';
import { AudioStore } from './audio';
import { AudioPlayer } from './audioplayer';
import { BackupStore } from './backups';
import { loadConfig } from './config';
import { DmxCapture } from './dmxcapture';
import { Engine } from './engine';
import { MqttController } from './mqttcontroller';
import { NetworkMonitor } from './netmonitor';
import { OscServer } from './oscserver';
import { ProjectStore } from './project';
import { Scheduler } from './schedule';
import { startServer } from './server';

const config = loadConfig(process.argv);
const engine = new Engine(config);
const projectDir = path.dirname(config.configFile);
const store = new ProjectStore(path.join(projectDir, 'fountain.project.json'));
const audio = new AudioStore(path.join(projectDir, 'audio'));
const backups = new BackupStore(
  path.join(projectDir, 'fountain.project.json'),
  () => JSON.stringify(store.project, null, 2),
  config.backup,
);

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

// Удалённое управление (§1 доработки): OSC-пульт и/или MQTT — оба отключены
// по умолчанию, включаются per-installation в fountain.config.json.
const osc = config.osc?.enabled
  ? new OscServer(engine, config.osc.port, () => store.project.oscBindings)
  : undefined;
osc?.start();
const mqtt = config.mqtt?.enabled
  ? new MqttController(engine, config.mqtt, () => store.project.mqttBindings)
  : undefined;
mqtt?.startTelemetry();

startServer(engine, store, audio, backups, net, capture, osc, mqtt);

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
  osc?.stop();
  mqtt?.stop();
  backups.stop();
  store.flush();
  engine.stop();
  process.exit(0);
});
