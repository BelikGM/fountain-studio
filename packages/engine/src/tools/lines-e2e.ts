/**
 * Сквозная проверка вселенных на ИЗОЛИРОВАННОМ движке — настоящий процесс и
 * настоящий WebSocket, как у редактора.
 *
 * Зачем отдельно от lines-selftest. Там движок собирается прямо в проверке, и
 * два бага прошли мимо: после «Применить» сервер дважды подряд запускал опрос
 * сети, и движок ПАДАЛ (setBroadcast EBADF); а первое же сообщение о
 * воспроизведении после применения говорило «ничего не играет». Оба видны
 * только через сервер — их и поймала эта проверка 22.09.2026.
 *
 * Порт 9531, своя папка данных и своя папка объекта во временной папке;
 * выходы — Art-Net на 127.0.0.1 и нестандартный порт. Рабочий объект, движок
 * на 9520 и интерфейс FountanPlay не трогаются (правило 4 в CLAUDE.md).
 *
 * Запуск: входит в npm -w @fountain-studio/engine run lines-test
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { sanitizeProject } from '@fountain-studio/shared';
import { createDemoProject } from '../demoproject';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-e2e-lines-'));
const appData = path.join(tmp, 'app');
const root = path.join(tmp, 'Проекты');
const proj = path.join(root, 'Проверка');
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(appData, 'app-config.json'), JSON.stringify({ server: { port: 9531 }, audio: { player: 'none' } }));
const project = sanitizeProject(createDemoProject());
fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify(project));
// Art-Net на 127.0.0.1 и нестандартный порт: интерфейс FountanPlay, занятый рабочим движком, не трогаем.
fs.writeFileSync(
  path.join(proj, 'lines.json'),
  JSON.stringify({ tickMs: 50, universes: [{ id: 1, label: 'Линия 1', outputs: [{ type: 'artnet', host: '127.0.0.1', port: 16454, universe: 0 }] }], backup: { enabled: false, intervalMin: 10 } }),
);

const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--app-data', appData, '--projects-root', root, '--project', proj], {
  cwd: path.resolve('.'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

try {
  let ws: WebSocket | null = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    ws = await new Promise<WebSocket | null>((res) => {
      const w = new WebSocket('ws://127.0.0.1:9531');
      w.once('open', () => res(w));
      w.once('error', () => res(null));
    });
  }
  if (!ws) throw new Error('изолированный движок не поднялся:\n' + log);
  const inbox: any[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const waitFor = async (pred: (m: any) => boolean, ms = 4000): Promise<any> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await sleep(20);
    }
    return null;
  };
  const hello0 = await waitFor((m) => m.type === 'hello');
  check('движок отдал список вселенных', hello0?.universes?.length === 1, JSON.stringify(hello0?.universes));
  check('автоимя «Линия 1» в редактор не уходит', hello0?.universes?.[0]?.label === '', JSON.stringify(hello0?.universes?.[0]));

  const maxScene = project.scenes.find((s) => s.name === 'Максимум')!;
  ws.send(JSON.stringify({ type: 'setScene', sceneId: maxScene.id }));
  await sleep(600);

  inbox.length = 0;
  ws.send(
    JSON.stringify({
      type: 'updateConfig',
      tickMs: 50,
      universes: [
        { id: 1, label: 'Линия 1', outputs: [{ type: 'artnet', host: '127.0.0.1', port: 16454, universe: 0 }] },
        { id: 2, label: '', outputs: [{ type: 'artnet', host: '127.0.0.1', port: 16454, universe: 1 }] },
      ],
    }),
  );
  const res = await waitFor((m) => m.type === 'configResult');
  check('движок ответил «применено»', res?.ok === true, JSON.stringify(res));
  check('и сказал, что именно', (res?.changes ?? []).some((c: string) => c.startsWith('добавлена вселенная 2')), JSON.stringify(res?.changes));
  const hello1 = await waitFor((m) => m.type === 'hello');
  check('всем редакторам ушёл новый список — две вселенные', hello1?.universes?.length === 2, JSON.stringify(hello1?.universes));
  await sleep(300);
  // Первое сообщение о воспроизведении после применения — именно оно раньше
  // говорило «ничего не играет», и редактор мигал остановкой.
  const firstPb = inbox.find((m) => m.type === 'playback');
  check('первое же сообщение после применения: сцена играет', firstPb?.state?.activeSceneId === maxScene.id, JSON.stringify(firstPb?.state?.activeSceneId));
  const pb = [...inbox].reverse().find((m) => m.type === 'playback');
  check('и продолжает играть', pb?.state?.activeSceneId === maxScene.id, JSON.stringify(pb?.state?.activeSceneId));
  const lines = JSON.parse(fs.readFileSync(path.join(proj, 'lines.json'), 'utf8'));
  check('в lines.json объекта — две вселенные', lines.universes?.length === 2, JSON.stringify(lines.universes));
  check('автоимя в файл не записано', lines.universes?.[0]?.label === '', JSON.stringify(lines.universes?.[0]));

  inbox.length = 0;
  ws.send(
    JSON.stringify({
      type: 'updateConfig',
      tickMs: 50,
      universes: [
        { id: 1, label: '', outputs: [{ type: 'artnet', host: '127.0.0.1', port: 16454, universe: 0 }] },
        { id: 2, label: '', outputs: [{ type: 'artnet', universe: 1 }] },
      ],
    }),
  );
  const bad = await waitFor((m) => m.type === 'configResult');
  check('кривая правка — отказ', bad?.ok === false, JSON.stringify(bad));
  check('отказ человеческими словами', /Вселенная 2: Art-Net: не указан IP-адрес/.test(bad?.message ?? ''), bad?.message);
  const lines2 = JSON.parse(fs.readFileSync(path.join(proj, 'lines.json'), 'utf8'));
  check('после отказа файл не тронут', lines2.universes?.[1]?.outputs?.[0]?.host === '127.0.0.1');

  inbox.length = 0;
  ws.send(JSON.stringify({ type: 'updateConfig', tickMs: 5, universes: lines2.universes }));
  const badTick = await waitFor((m) => m.type === 'configResult');
  check('такт вне 10–1000 — отказ с причиной', badTick?.ok === false && /такт/.test(badTick?.message ?? ''), badTick?.message);
  ws.close();
} catch (err) {
  failed++;
  console.log('✖', err);
} finally {
  child.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) console.log('--- лог движка ---\n' + log.split('\n').slice(-40).join('\n'));
console.log(`\nсквозная: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
