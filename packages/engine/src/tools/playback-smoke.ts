/**
 * Смоук-тест воспроизведения: поднимает движок с WebSocket-сервером в этом же
 * процессе, подключается клиентом и проверяет: загрузку проекта, статическую
 * сцену, HTP-слияние с ручной консолью, секвенсор с фейдом и переходами шагов,
 * общий стоп и сохранение проекта на диск.
 *
 * Запуск: npm run smoke (или npm -w @fountain-studio/engine run smoke)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  emptyProject,
  type PlaybackState,
  type Project,
  type ClientMessage,
  type ServerMessage,
} from '@fountain-studio/shared';
import { Engine } from '../engine';
import { ProjectStore } from '../project';
import { startServer } from '../server';

const PORT = 9521;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fountain-smoke-'));
const projectFile = path.join(tmpDir, 'fountain.project.json');

const engine = new Engine({
  server: { port: PORT },
  timing: { tickMs: 50, spinMs: 10, uiFrameMs: 40 },
  universes: [{ id: 1, label: 'Тест', outputs: [{ type: 'artnet', host: '127.0.0.1', universe: 0 }] }],
});
const store = new ProjectStore(projectFile);
engine.setProject(store.project);
engine.start();
const wss = startServer(engine, store);

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
};

let frame = new Uint8Array(512);
let playback: PlaybackState = { activeSceneId: null, running: [] };
let projectEcho: Project | null = null;
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

  console.log('— Сохранение проекта —');
  await sleep(700); // дебаунс записи 500 мс
  const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as Project;
  check(saved.devices.length === 3 && saved.sequences.length === 1, 'fountain.project.json записан на диск');

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
    engine.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(failures.length === 0 ? 0 : 1);
  });
