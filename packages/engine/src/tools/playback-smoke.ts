/**
 * Смоук-тест воспроизведения: поднимает движок с WebSocket-сервером в этом же
 * процессе, подключается клиентом и проверяет: загрузку проекта, статическую
 * сцену, HTP-слияние с ручной консолью, секвенсор с фейдом и переходами шагов,
 * общий стоп, шоу-таймлайн (блоки, огибающие, опережение дорожек, транспорт),
 * монтажную арифметику вырезок, хранилище аудио и сохранение проекта на диск.
 *
 * Запуск: npm run smoke (или npm -w @fountain-studio/engine run smoke)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  editedToSourceMs,
  emptyProject,
  insunitsToMeters,
  keptSegments,
  layoutFromDxf,
  mergeCuts,
  parseDxf,
  ringPositions,
  sanitizeProject,
  shiftDeviceAddresses,
  sourceToEditedMs,
  swapDeviceAddresses,
  type NetworkState,
  type PlaybackState,
  type Project,
  type ClientMessage,
  type ServerMessage,
} from '@fountain-studio/shared';
import { AudioStore } from '../audio';
import dgram from 'node:dgram';
import { Engine } from '../engine';
import { NetworkMonitor } from '../netmonitor';
import { ProjectStore } from '../project';
import { Scheduler } from '../schedule';
import { startServer } from '../server';

const PORT = 9521;
const MOCK_NODE_PORT = 16454; // мок-нода Art-Net (не 6454, чтобы не мешать реальным)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fountain-smoke-'));
const projectFile = path.join(tmpDir, 'fountain.project.json');

// Мок-нода: отвечает на ArtPoll (ArtPollReply) и ArtTodRequest (ArtTodData с 2 UID),
// пока mockNodeAlive = true. Умолкание имитирует пропажу ноды из сети.
let mockNodeAlive = true;
const mockNode = dgram.createSocket({ type: 'udp4', reuseAddr: true });
mockNode.on('message', (msg, rinfo) => {
  if (!mockNodeAlive || msg.toString('latin1', 0, 8) !== 'Art-Net\0') return;
  const op = msg.readUInt16LE(8);
  if (op === 0x2000) {
    const reply = Buffer.alloc(239);
    reply.write('Art-Net\0', 0, 'latin1');
    reply.writeUInt16LE(0x2100, 8); // OpPollReply
    // Имена в Art-Net — ASCII (кириллица в latin1 не кодируется).
    reply.write('MockNode', 26, 'latin1'); // ShortName
    reply.write('Smoke test node', 44, 'latin1'); // LongName
    reply.writeUInt8(1, 173); // NumPortsLo = 1
    reply.writeUInt8(0x80, 174); // PortTypes[0]: выход
    reply.writeUInt8(0, 190); // SwOut[0] → вселенная 0
    mockNode.send(reply, rinfo.port, rinfo.address);
  } else if (op === 0x8000) {
    const uids = [
      [0x4d, 0x4f, 0x00, 0x00, 0x00, 0x01],
      [0x4d, 0x4f, 0x00, 0x00, 0x00, 0x02],
    ];
    const tod = Buffer.alloc(28 + uids.length * 6);
    tod.write('Art-Net\0', 0, 'latin1');
    tod.writeUInt16LE(0x8100, 8); // OpTodData
    tod.writeUInt8(0, 21); // Net
    tod.writeUInt8(0, 23); // Address
    tod.writeUInt16BE(uids.length, 24);
    tod.writeUInt8(1, 26); // BlockCount
    tod.writeUInt8(uids.length, 27);
    uids.forEach((u, i) => tod.set(u, 28 + i * 6));
    mockNode.send(tod, rinfo.port, rinfo.address);
  }
});
mockNode.bind(MOCK_NODE_PORT, '127.0.0.1');

const engine = new Engine({
  server: { port: PORT },
  timing: { tickMs: 50, spinMs: 10, uiFrameMs: 40 },
  audio: { player: 'none', ffplayPath: 'ffplay' },
  universes: [{ id: 1, label: 'Тест', outputs: [{ type: 'artnet', host: '127.0.0.1', universe: 0 }] }],
});
const store = new ProjectStore(projectFile);
engine.setProject(store.project);
engine.start();
const net = new NetworkMonitor({
  targets: ['127.0.0.1'],
  universes: [0],
  port: MOCK_NODE_PORT,
  pollMs: 150,
  nodeTimeoutMs: 700,
  rdmTimeoutMs: 5000,
});
net.start();
const wss = startServer(engine, store, new AudioStore(path.join(tmpDir, 'audio')), net);

// Демо-проект: насос (адрес 1), клапан (2), RGB (10–12).
const demo: Project = {
  ...emptyProject('Смоук-тест'),
  devices: [
    { id: 'pump1', name: 'Насос 1', profileId: 'pump', universe: 1, address: 1 },
    { id: 'valve1', name: 'Клапан 1', profileId: 'valve', universe: 1, address: 2 },
    { id: 'rgb1', name: 'RGB 1', profileId: 'rgb', universe: 1, address: 10 },
  ],
  scenes: [
    { id: 'sceneA', name: 'Картина A', values: { pump1: [200], valve1: [255], rgb1: [255, 0, 40] } },
    { id: 'sceneB', name: 'Картина B', values: { pump1: [60], rgb1: [0, 128, 255] } },
  ],
  sequences: [
    {
      id: 'seq1',
      name: 'Секвенсор 1',
      mode: 'loop',
      steps: [
        { sceneId: 'sceneA', holdMs: 600, fadeMs: 0 },
        { sceneId: 'sceneB', holdMs: 600, fadeMs: 400 },
      ],
    },
  ],
  shows: [
    {
      id: 'show1',
      name: 'Шоу 1',
      audioFile: null,
      durationMs: 4000,
      cuts: [],
      tracks: [
        {
          id: 'trkBlocks',
          name: 'Блоки',
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks: [
            // Сцена A на 0.5–2.0 с; секвенсор seq1 на 2.5–3.7 с.
            { id: 'b1', type: 'scene', refId: 'sceneA', startMs: 500, durationMs: 1500, fadeInMs: 0, fadeOutMs: 0 },
            { id: 'b2', type: 'sequence', refId: 'seq1', startMs: 2500, durationMs: 1200, fadeInMs: 0, fadeOutMs: 0 },
          ],
        },
        {
          id: 'trkEnv',
          name: 'Зелёный RGB',
          kind: 'envelope',
          offsetMs: 0,
          muted: false,
          deviceId: 'rgb1',
          channel: 1,
          points: [
            { tMs: 0, value: 0 },
            { tMs: 2000, value: 200 },
            { tMs: 4000, value: 0 },
          ],
        },
        {
          // Опережение +1000 мс: точки 3.0–4.0 с исполняются на позиции 2.0–3.0 с.
          id: 'trkValve',
          name: 'Клапан (опережение 1 с)',
          kind: 'envelope',
          offsetMs: 1000,
          muted: false,
          deviceId: 'valve1',
          channel: 0,
          points: [
            { tMs: 3000, value: 255 },
            { tMs: 4000, value: 255 },
          ],
        },
      ],
    },
    {
      id: 'showP1',
      name: 'Короткое 1',
      audioFile: null,
      durationMs: 600,
      cuts: [],
      tracks: [
        {
          id: 'p1t',
          name: 'Блоки',
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks: [{ id: 'p1b', type: 'scene', refId: 'sceneA', startMs: 0, durationMs: 600, fadeInMs: 0, fadeOutMs: 0 }],
        },
      ],
    },
    {
      id: 'showP2',
      name: 'Короткое 2',
      audioFile: null,
      durationMs: 500,
      cuts: [],
      tracks: [
        {
          id: 'p2t',
          name: 'Блоки',
          kind: 'blocks',
          offsetMs: 0,
          muted: false,
          blocks: [{ id: 'p2b', type: 'scene', refId: 'sceneB', startMs: 0, durationMs: 500, fadeInMs: 0, fadeOutMs: 0 }],
        },
      ],
    },
  ],
  playlists: [
    {
      id: 'pl1',
      name: 'Вечерняя программа',
      mode: 'once',
      items: [
        { showId: 'showP1', gapMs: 300 },
        { showId: 'showP2', gapMs: 0 },
      ],
    },
  ],
};

let frame = new Uint8Array(512);
let playback: PlaybackState = { activeSceneId: null, running: [], show: null, playlist: null };
let projectEcho: Project | null = null;
let audioMsg: { name: string; dataBase64: string } | null = null;
let networkState: NetworkState | null = null;
let sawStep1 = false;
let sawFadeMidpoint = false;

const failures: string[] = [];
function check(cond: boolean, label: string): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) failures.push(label);
}

const ch = (addr: number): number => frame[addr - 1] ?? 0;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const send = (msg: ClientMessage): void => ws.send(JSON.stringify(msg));

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === 'frame' && msg.universe === 1) {
    frame = new Uint8Array(Buffer.from(msg.data, 'base64'));
    // Ловим промежуточный кадр фейда шага 2: насос между 60 и 200 не включительно.
    if (playback.running.length > 0 && playback.running[0]!.stepIndex === 1) {
      if (ch(1) > 60 && ch(1) < 200) sawFadeMidpoint = true;
    }
  } else if (msg.type === 'playback') {
    playback = msg.state;
    if (playback.running.some((r) => r.stepIndex === 1)) sawStep1 = true;
  } else if (msg.type === 'project') {
    projectEcho = msg.project;
  } else if (msg.type === 'audio') {
    audioMsg = { name: msg.name, dataBase64: msg.dataBase64 };
  } else if (msg.type === 'network') {
    networkState = msg.state;
  }
});

function waitFor(label: string, cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Таймаут ожидания: ${label}`));
      }
    }, 10);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await waitFor('подключение', () => ws.readyState === WebSocket.OPEN);

  console.log('— Проект —');
  send({ type: 'updateProject', project: demo });
  await waitFor('эхо проекта', () => projectEcho !== null && projectEcho.devices.length === 3);
  check(projectEcho!.name === 'Смоук-тест', 'проект принят и разослан обратно');

  console.log('— Статическая сцена —');
  send({ type: 'setScene', sceneId: 'sceneA' });
  await waitFor('кадр сцены A', () => ch(1) === 200 && ch(2) === 255 && ch(10) === 255 && ch(12) === 40);
  check(true, 'сцена A на выходе: насос 200, клапан 255, RGB (255,0,40)');
  check(playback.activeSceneId === 'sceneA', 'состояние воспроизведения: активна сцена A');

  console.log('— HTP: ручной слой против сцены —');
  send({ type: 'setChannel', universe: 1, channel: 1, value: 250 });
  await waitFor('ручной 250 побеждает', () => ch(1) === 250);
  check(true, 'фейдер 250 поверх сцены 200 → на выходе 250');
  send({ type: 'setChannel', universe: 1, channel: 1, value: 100 });
  await sleep(200);
  check(ch(1) === 200, 'фейдер 100 под сценой 200 → на выходе 200 (HTP)');
  send({ type: 'setChannel', universe: 1, channel: 1, value: 0 });
  send({ type: 'setScene', sceneId: null });
  await waitFor('сцена снята', () => ch(1) === 0 && ch(10) === 0);
  check(true, 'сцена выключена — каналы в ноль');

  console.log('— Секвенсор с фейдом —');
  send({ type: 'startSequence', sequenceId: 'seq1' });
  await waitFor('шаг 1: сцена A', () => ch(1) === 200 && ch(2) === 255);
  check(true, 'шаг 1 отработал (без фейда, сразу 200)');
  await waitFor('переход на шаг 2', () => sawStep1, 2000);
  await waitFor('фейд завершён: сцена B', () => ch(1) === 60 && ch(11) === 128, 2000);
  check(sawFadeMidpoint, 'во время фейда были промежуточные значения (60 < насос < 200)');
  check(ch(2) === 0, 'клапан ушёл в 0 (его нет в сцене B)');
  await waitFor('цикл: возврат на шаг 1', () => playback.running[0]?.stepIndex === 0, 2000);
  check(true, 'режим loop вернулся на первый шаг');

  console.log('— Пауза/стоп —');
  send({ type: 'pauseSequence', sequenceId: 'seq1' });
  await waitFor('пауза отражена', () => playback.running[0]?.paused === true);
  const held = ch(1);
  await sleep(300);
  check(ch(1) === held, `на паузе значение держится (${held})`);
  send({ type: 'resumeSequence', sequenceId: 'seq1' });
  await waitFor('снят с паузы', () => playback.running[0]?.paused === false);
  send({ type: 'stopAllPlayback' });
  await waitFor('общий стоп', () => playback.running.length === 0 && ch(1) === 0 && ch(10) === 0);
  check(true, 'общий стоп — все каналы в ноль');

  console.log('— Шоу: перемотка на паузе (стейтлес-рендер таймлайна) —');
  send({ type: 'playShow', showId: 'show1', positionMs: 0 });
  send({ type: 'pauseShow' });
  await waitFor('шоу на паузе', () => playback.show !== null && !playback.show.playing);
  send({ type: 'seekShow', positionMs: 1000 });
  await waitFor('позиция 1.0 с', () => ch(1) === 200 && ch(11) === 100);
  check(true, '1.0 с: блок сцены A (насос 200) + огибающая зелёного = 100');
  send({ type: 'seekShow', positionMs: 2200 });
  await waitFor('позиция 2.2 с', () => ch(2) === 255 && ch(1) === 0 && ch(11) === 180);
  check(true, '2.2 с: опережение +1 с — клапан 255 от точек 3.0–4.0 с, блок сцены уже погас');
  send({ type: 'seekShow', positionMs: 2600 });
  await waitFor('позиция 2.6 с', () => ch(1) === 200 && ch(2) === 255 && ch(11) === 140);
  check(true, '2.6 с: блок-секвенсор шаг 1 (сцена A целиком)');
  send({ type: 'seekShow', positionMs: 3300 });
  await waitFor('позиция 3.3 с', () => ch(1) === 130 && ch(2) === 128 && ch(11) === 70);
  check(true, '3.3 с: шаг 2 в середине фейда (насос 130, клапан 128), огибающая HTP 70');

  console.log('— Шоу: воспроизведение, синхронизация, автопауза в конце —');
  send({ type: 'playShow', showId: 'show1', positionMs: 0 });
  await waitFor('шоу играет', () => playback.show?.playing === true);
  send({ type: 'syncShow', positionMs: 2200 });
  await waitFor('тихая коррекция позиции', () => ch(2) === 255, 1000);
  check(true, 'syncShow перекинул позицию по аудио-часам без остановки');
  await waitFor(
    'автопауза в конце',
    () => playback.show?.playing === false && playback.show.positionMs === 4000,
    3000,
  );
  check(true, 'конец таймлайна: автопауза ровно на 4.000 с');
  send({ type: 'stopShow' });
  await waitFor('стоп шоу', () => playback.show === null && ch(1) === 0 && ch(2) === 0 && ch(11) === 0);
  check(true, 'стоп шоу — слой снят, каналы в ноль');

  console.log('— Монтаж вырезок (хелперы) —');
  const cuts = mergeCuts([
    { startMs: 3000, endMs: 3500 },
    { startMs: 1000, endMs: 2000 },
    { startMs: 1800, endMs: 2000 },
  ]);
  check(
    cuts.length === 2 && cuts[0]!.startMs === 1000 && cuts[0]!.endMs === 2000,
    'mergeCuts: сортировка и слияние пересечений',
  );
  check(editedToSourceMs(cuts, 2600) === 4100, 'editedToSourceMs: 2.6 с монтажа = 4.1 с исходника');
  check(sourceToEditedMs(cuts, 4100) === 2600, 'sourceToEditedMs: обратное преобразование');
  const segs = keptSegments(cuts, 5000);
  check(
    segs.length === 3 && segs[2]!.startMs === 3500 && segs[2]!.endMs === 5000,
    'keptSegments: куски аудио между вырезками',
  );

  console.log('— Плейлист: автономная последовательность шоу —');
  send({ type: 'playPlaylist', playlistId: 'pl1' });
  await waitFor(
    'элемент 1 играет',
    () => playback.playlist?.itemIndex === 0 && playback.playlist.inGap === false && ch(1) === 200,
  );
  check(true, 'элемент 1: «Короткое 1» на выходе (сцена A)');
  await waitFor('пауза между шоу', () => playback.playlist?.inGap === true && ch(1) === 0, 2000);
  check(true, 'после 0.6 с — пауза между шоу, каналы в ноль');
  await waitFor(
    'элемент 2 играет',
    () => playback.playlist?.itemIndex === 1 && ch(1) === 60 && ch(11) === 128,
    2000,
  );
  check(true, 'через 0.3 с паузы — элемент 2 (сцена B)');
  await waitFor(
    'плейлист завершён',
    () => playback.playlist === null && playback.show === null && ch(1) === 0 && ch(11) === 0,
    2000,
  );
  check(true, 'режим «один раз»: плейлист закончился, всё в ноль');

  console.log('— Плейлист: перехват управления редактором —');
  send({ type: 'playPlaylist', playlistId: 'pl1' });
  await waitFor('плейлист снова играет', () => playback.playlist !== null && ch(1) === 200);
  send({ type: 'pauseShow' });
  await waitFor(
    'редактор перехватил шоу',
    () => playback.playlist === null && playback.show !== null && !playback.show.playing,
  );
  check(true, 'pauseShow из редактора снял плейлист, шоу осталось на паузе');
  send({ type: 'stopShow' });
  await waitFor('шоу остановлено', () => playback.show === null && ch(1) === 0);

  console.log('— Расписание по системному времени —');
  const scheduler = new Scheduler(engine, () => store.project.schedule);
  scheduler.start();
  const at = new Date(Date.now() + 1500);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  const ss = String(at.getSeconds()).padStart(2, '0');
  send({
    type: 'updateProject',
    project: {
      ...demo,
      schedule: [
        {
          id: 'sch1',
          name: 'Тестовый запуск',
          enabled: true,
          days: [],
          time: `${hh}:${mm}:${ss}`,
          action: { type: 'scene', refId: 'sceneA' },
        },
      ],
    },
  });
  await waitFor(
    'расписание сработало',
    () => playback.activeSceneId === 'sceneA' && ch(1) === 200,
    5000,
  );
  check(true, `запись «${hh}:${mm}:${ss} → сцена» сработала по системным часам`);
  scheduler.stop();
  send({ type: 'setScene', sceneId: null });
  await waitFor('сцена снята', () => ch(1) === 0);

  console.log('— Калибровка min/max (0 остаётся 0, 1–255 → min–max) —');
  send({
    type: 'updateProject',
    project: {
      ...demo,
      devices: demo.devices.map((d) => (d.id === 'pump1' ? { ...d, trim: [{ min: 50, max: 200 }] } : d)),
    },
  });
  send({ type: 'setScene', sceneId: 'sceneA' });
  // Сцена даёт насосу 200 → калибровка: 50 + 200·150/255 = 168.
  await waitFor('калиброванный выход', () => ch(1) === 168 && ch(2) === 255);
  check(true, 'насос 200 → 168 по калибровке 50–200; клапан без калибровки — 255');
  send({ type: 'setScene', sceneId: null });
  await waitFor('ноль остаётся нулём', () => ch(1) === 0);
  check(true, 'выключенный канал не поднимается до min');

  console.log('— Переадресация (хелперы патча) —');
  const swapped = swapDeviceAddresses(demo, 'pump1', 'rgb1');
  check(
    swapped.devices.find((d) => d.id === 'pump1')!.address === 10 &&
      swapped.devices.find((d) => d.id === 'rgb1')!.address === 1,
    'swapDeviceAddresses: насос и RGB поменялись адресами',
  );
  const shifted = shiftDeviceAddresses(demo, ['pump1', 'valve1'], 5);
  check(
    shifted.devices.find((d) => d.id === 'pump1')!.address === 6 &&
      shifted.devices.find((d) => d.id === 'valve1')!.address === 7 &&
      shifted.devices.find((d) => d.id === 'rgb1')!.address === 10,
    'shiftDeviceAddresses: выбранные +5, остальные на месте',
  );

  console.log('— 3D-схема и DXF —');
  const layoutRaw = {
    bowls: [{ id: 'bowl1', name: 'Чаша', shape: 'circle', x: 0, y: 0, radius: 5, width: 10, length: 10, height: 0.3 }],
    nozzles: [
      { id: 'noz1', name: 'Ф1', kind: 'straight', x: 1, y: 2, z: 0, tiltDeg: 0, headingDeg: 0, maxHeightM: 5, riseMs: 800, fallMs: 1100, pumpDeviceId: 'pump1', valveDeviceId: 'нет-такого', lightDeviceId: 'rgb1' },
      { id: 'noz2', name: 'Ф2', kind: 'не-тип', x: 9999, y: 0, z: 0, tiltDeg: 200 },
    ],
    lights: [{ id: 'lt1', name: 'П1', x: 0, y: 1, z: -0.2, deviceId: 'rgb1' }],
  };
  const sanitized = sanitizeProject({ ...demo, layout: layoutRaw });
  const noz1 = sanitized.layout.nozzles.find((n) => n.id === 'noz1')!;
  const noz2 = sanitized.layout.nozzles.find((n) => n.id === 'noz2')!;
  check(
    sanitized.layout.bowls.length === 1 &&
      noz1.pumpDeviceId === 'pump1' &&
      noz1.valveDeviceId === null &&
      noz1.lightDeviceId === 'rgb1' &&
      noz2.kind === 'straight' &&
      noz2.x === 1000 &&
      noz2.tiltDeg === 85 &&
      sanitized.layout.lights[0]!.deviceId === 'rgb1',
    'sanitizeLayout: битые ссылки и значения приведены, элементы сохранены',
  );
  const ring = ringPositions(4, 2);
  check(
    ring.length === 4 &&
      Math.abs(ring[0]!.x - 2) < 1e-9 &&
      Math.abs(ring[1]!.y - 2) < 1e-9 &&
      Math.abs(ring[2]!.x + 2) < 1e-9,
    'ringPositions: 4 точки по кольцу радиуса 2',
  );
  const dxfText = [
    '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'POINT', '8', 'FORSUNKI', '10', '1000', '20', '2000',
    '0', 'CIRCLE', '8', 'CHASHA', '10', '0', '20', '0', '40', '5000',
    '0', 'INSERT', '8', 'SVET', '2', 'LAMP', '10', '3000', '20', '0',
    '0', 'LWPOLYLINE', '8', 'BORT', '70', '1', '90', '4',
    '10', '-1000', '20', '-1000', '10', '1000', '20', '-1000', '10', '1000', '20', '1000', '10', '-1000', '20', '1000',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const dxf = parseDxf(dxfText);
  check(
    dxf.insunits === 4 &&
      dxf.points.length === 3 &&
      dxf.polylines.length === 1 &&
      dxf.polylines[0]!.closed &&
      dxf.layers.join(',') === 'BORT,CHASHA,FORSUNKI,SVET',
    'parseDxf: точки, окружность, вставка, полилиния и $INSUNITS разобраны',
  );
  const imported = layoutFromDxf(dxf, {
    unitScale: insunitsToMeters(dxf.insunits),
    layerRoles: { FORSUNKI: 'nozzle', SVET: 'light', CHASHA: 'bowl', BORT: 'bowl' },
    center: false,
  });
  check(
    imported.nozzles.length === 1 &&
      Math.abs(imported.nozzles[0]!.x - 1) < 1e-9 &&
      Math.abs(imported.nozzles[0]!.y - 2) < 1e-9 &&
      imported.lights.length === 1 &&
      imported.bowls.length === 2 &&
      imported.bowls.find((b) => b.shape === 'circle')!.radius === 5 &&
      imported.bowls.find((b) => b.shape === 'rect')!.width === 2,
    'layoutFromDxf: мм → метры, слои разложены по ролям, чаши из круга и контура',
  );

  console.log('— Мониторинг сети (мок-нода Art-Net/RDM) —');
  await waitFor(
    'обнаружение ноды',
    () => networkState !== null && networkState.nodes.length === 1 && !networkState.nodes[0]!.lost,
    5000,
  );
  check(
    networkState!.nodes[0]!.shortName === 'MockNode' && networkState!.nodes[0]!.outputUniverses.join(',') === '0',
    'ArtPoll: нода найдена, имя и выходная вселенная разобраны',
  );
  await waitFor('TOD от ноды', () => networkState !== null && networkState.rdmDevices.length === 2, 5000);
  check(
    networkState!.rdmDevices.map((d) => d.uid).join(' ') === '4d4f:00000001 4d4f:00000002' &&
      networkState!.rdmDevices.every((d) => d.universe === 0 && !d.lost),
    'ArtTodRequest: 2 RDM-прибора с UID на вселенной 0',
  );
  check(
    networkState!.log.some((e) => e.text.includes('MockNode')) &&
      networkState!.log.some((e) => e.text.includes('4d4f:00000001')),
    'журнал: появление ноды и приборов записано',
  );
  mockNodeAlive = false; // нода «выдернута из сети»
  await waitFor(
    'потеря ноды по таймауту',
    () => networkState !== null && networkState.nodes[0]!.lost,
    5000,
  );
  check(
    networkState!.log.some((e) => e.text.includes('ПОТЕРЯНА')),
    'умолкшая нода помечена потерянной, событие в журнале',
  );

  console.log('— Хранилище аудио —');
  const audioData = Buffer.from('НЕ-НАСТОЯЩИЙ-MP3: проверка хранилища').toString('base64');
  send({ type: 'uploadAudio', name: 'тест.mp3', dataBase64: audioData });
  send({ type: 'getAudio', name: 'тест.mp3' });
  await waitFor('ответ getAudio', () => audioMsg !== null);
  check(audioMsg!.name === 'тест.mp3' && audioMsg!.dataBase64 === audioData, 'аудиофайл сохранён и отдан байт в байт');

  console.log('— Сохранение проекта —');
  await sleep(700); // дебаунс записи 500 мс
  const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as Project;
  check(
    saved.devices.length === 3 &&
      saved.sequences.length === 1 &&
      saved.shows.length === 3 &&
      saved.playlists.length === 1 &&
      saved.devices.find((d) => d.id === 'pump1')?.trim?.[0]?.min === 50,
    'fountain.project.json записан на диск (шоу, плейлисты, калибровка)',
  );

  console.log(failures.length === 0 ? '\nСМОУК-ТЕСТ ПРОЙДЕН' : `\nПРОВАЛОВ: ${failures.length}`);
}

main()
  .catch((err) => {
    console.error('✗', err instanceof Error ? err.message : err);
    failures.push('исключение');
  })
  .finally(() => {
    ws.close();
    wss.close();
    net.stop();
    mockNode.close();
    engine.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(failures.length === 0 ? 0 : 1);
  });
