/**
 * Самопроверка диалога о несохранённых правках при переключении объекта.
 *
 * Проверяет то, из-за чего он и появился: правка проекта, ещё не долетевшая
 * до диска (окно до 500 мс — см. ProjectStore), не должна молча потеряться и
 * не должна молча сохраниться, если человек этого не просил. Логика живёт в
 * обработчике openProject/createProject/copyProject/closeProject в
 * server.ts — она завязана на реальную сборку движка (index.ts: линии,
 * projects.ts, ProjectStore), поэтому тест поднимает НАСТОЯЩИЙ index.ts
 * отдельным процессом на изолированной папке данных и говорит с ним по
 * WebSocket, как это делает редактор.
 *
 * Запуск: npm -w @fountain-studio/engine run dirty-guard-test
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ENTRY = path.join(__dirname, '..', 'index.ts');
// Абсолютный путь к CLI tsx, а не голое имя пакета: движок запускается с cwd во
// временной папке, где своего node_modules нет и «--import tsx» не разрешится.
const TSX_CLI = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = 9534;

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-dirty-guard-'));
const appDataDir = path.join(tmp, 'app');
const projectsRoot = path.join(tmp, 'projects');
fs.mkdirSync(appDataDir, { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });
fs.writeFileSync(path.join(appDataDir, 'app-config.json'), JSON.stringify({ server: { port: PORT } }, null, 2));

interface AnyMsg {
  type: string;
  [k: string]: unknown;
}

function startEngine(): ChildProcess {
  return spawn(process.execPath, [TSX_CLI, ENGINE_ENTRY, '--app-data', appDataDir, '--projects-root', projectsRoot], {
    cwd: tmp,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

interface Conn {
  ws: WebSocket;
  last: Record<string, AnyMsg>;
}

function connect(): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = (): void => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const state: Conn = { ws, last: {} };
      ws.on('open', () => {
        ws.on('message', (raw: Buffer) => {
          const m = JSON.parse(raw.toString()) as AnyMsg;
          state.last[m.type] = m;
        });
        resolve(state);
      });
      ws.on('error', () => {
        if (Date.now() - started > 25_000) {
          reject(new Error('движок не поднялся за 25 с'));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function waitFor(st: Conn, type: string, ms = 5000): Promise<AnyMsg | undefined> {
  const t0 = Date.now();
  const before = st.last[type];
  while (Date.now() - t0 < ms) {
    if (st.last[type] && st.last[type] !== before) return st.last[type];
    await sleep(50);
  }
  return st.last[type];
}

function send(st: Conn, msg: AnyMsg): void {
  st.ws.send(JSON.stringify(msg));
}

(async () => {
  const eng = startEngine();
  const st = await connect();
  await sleep(2000);

  const projState = (): { current: { dir: string; name: string } | null } =>
    st.last['projects']!.state as { current: { dir: string; name: string } | null };

  check('первый запуск сам открыл демо-объект', projState().current !== null);
  const demoDir = projState().current!.dir;

  send(st, { type: 'createProject', name: 'Новороссийск' });
  await waitFor(st, 'projectResult');
  await sleep(600);
  const novDir = projState().current!.dir;
  check('второй объект создан и открыт', projState().current!.name === 'Новороссийск');

  // --- 1. Правка + попытка переключиться БЕЗ force -------------------------
  const before1 = st.last['project']!.project as { name: string };
  send(st, { type: 'updateProject', project: { ...before1, name: 'Новороссийск (правка)' } });
  send(st, { type: 'openProject', dir: demoDir }); // сразу следом, до дебаунса записи в 500 мс
  const r1 = await waitFor(st, 'projectResult');
  check('без force движок отказал и попросил решить', r1?.ok === false && r1?.unsavedChanges === true, JSON.stringify(r1));
  await sleep(700);
  check('объект остался прежним — переключения не было', projState().current!.dir === novDir);

  // --- 2. «Сохранить и открыть» (force, без discard) ------------------------
  send(st, { type: 'openProject', dir: demoDir, force: true });
  const r2 = await waitFor(st, 'projectResult');
  check('с force переключение прошло', r2?.ok === true, JSON.stringify(r2));
  await sleep(700);
  check('открыт демо-объект', projState().current!.dir === demoDir);
  const savedNov = JSON.parse(fs.readFileSync(path.join(novDir, 'project.json'), 'utf8')) as { name: string };
  check('правка сохранилась на диске (force = сохранить)', savedNov.name === 'Новороссийск (правка)', savedNov.name);

  // --- 3. Правка + «Не сохранять и открыть» (force + discard) --------------
  send(st, { type: 'openProject', dir: novDir, force: true });
  await waitFor(st, 'projectResult');
  await sleep(700);
  const before2 = st.last['project']!.project as { name: string };
  send(st, { type: 'updateProject', project: { ...before2, name: 'Эту правку выбросим' } });
  send(st, { type: 'openProject', dir: demoDir, force: true, discard: true });
  const r3 = await waitFor(st, 'projectResult');
  check('с force+discard переключение прошло', r3?.ok === true, JSON.stringify(r3));
  await sleep(700);
  const afterDiscard = JSON.parse(fs.readFileSync(path.join(novDir, 'project.json'), 'utf8')) as { name: string };
  check('discard — правка НЕ попала на диск', afterDiscard.name === 'Новороссийск (правка)', afterDiscard.name);

  // --- 4. closeProject подчиняется тому же правилу --------------------------
  send(st, { type: 'openProject', dir: novDir, force: true });
  await waitFor(st, 'projectResult');
  await sleep(700);
  const before3 = st.last['project']!.project as { name: string };
  send(st, { type: 'updateProject', project: { ...before3, name: 'Перед закрытием' } });
  send(st, { type: 'closeProject' });
  const r4 = await waitFor(st, 'projectResult');
  check('closeProject тоже спросил', r4?.ok === false && r4?.unsavedChanges === true, JSON.stringify(r4));
  check('у закрытия нет targetName (цели нет)', r4?.targetName === undefined);
  await sleep(500);
  check('объект остался открытым', projState().current !== null);
  send(st, { type: 'closeProject', force: true });
  const r5 = await waitFor(st, 'projectResult');
  check('с force закрытие прислало успешный итог', r5?.ok === true && typeof r5?.message === 'string', JSON.stringify(r5));
  await sleep(500);
  check('объект действительно закрыт', projState().current === null);
  const savedBeforeClose = JSON.parse(fs.readFileSync(path.join(novDir, 'project.json'), 'utf8')) as { name: string };
  check('правка перед закрытием сохранена (force без discard = сохранить)', savedBeforeClose.name === 'Перед закрытием');

  // --- 5. createProject/copyProject подчиняются тому же правилу ------------
  send(st, { type: 'openProject', dir: novDir, force: true });
  await waitFor(st, 'projectResult');
  await sleep(700);
  const before4 = st.last['project']!.project as { name: string };
  send(st, { type: 'updateProject', project: { ...before4, name: 'Ещё правка' } });
  send(st, { type: 'createProject', name: 'Третий объект' });
  const r6 = await waitFor(st, 'projectResult');
  check(
    'createProject тоже спросил и назвал цель',
    r6?.ok === false && r6?.unsavedChanges === true && r6?.targetName === 'Третий объект',
    JSON.stringify(r6),
  );
  send(st, { type: 'createProject', name: 'Третий объект', force: true, discard: true });
  const r7 = await waitFor(st, 'projectResult');
  check('с force+discard создание прошло', r7?.ok === true, JSON.stringify(r7));
  await sleep(500);
  const novAfter = JSON.parse(fs.readFileSync(path.join(novDir, 'project.json'), 'utf8')) as { name: string };
  check('discard не дал сохраниться отменённой правке', novAfter.name !== 'Ещё правка', novAfter.name);

  // --- 6. Новый объект/копия в указанной папке (кнопка «Обзор…» в UI) ------
  const customDir = path.join(tmp, 'другая-папка');
  send(st, { type: 'createProject', name: 'В своей папке', parentDir: customDir });
  const r8 = await waitFor(st, 'projectResult');
  check('создание с parentDir прошло', r8?.ok === true, JSON.stringify(r8));
  await sleep(500);
  check('папка объекта легла туда, куда просили', projState().current!.dir.startsWith(customDir));
  send(st, { type: 'copyProject', name: 'Копия в своей папке', parentDir: customDir });
  const r9 = await waitFor(st, 'projectResult');
  check('копирование с parentDir прошло', r9?.ok === true, JSON.stringify(r9));
  await sleep(500);
  check('копия тоже легла в указанную папку', projState().current!.dir.startsWith(customDir));

  st.ws.close();
  eng.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`несохранённые правки: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
