/**
 * Самопроверка: объект правят ДВА редактора сразу.
 *
 * Каждый редактор шлёт движку объект целиком, поэтому раньше правки спорили
 * молча: наладчик на объекте добавлял сцену, второй за столом в это же время
 * правил расписание — и тот, чья правка приходила последней, затирал чужую
 * работу целиком. Здесь проверяем то, что должно этому мешать: движок метит
 * автора правки и версию объекта, правку «поверх чужой» не принимает, а
 * редакторы знают друг о друге.
 *
 * Поднимает НАСТОЯЩИЙ index.ts на изолированной папке (рабочие данные не
 * трогаются — правило 4 в CLAUDE.md) и говорит с ним двумя соединениями.
 *
 * Запуск: npm -w @fountain-studio/engine run editors-test
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ENTRY = path.join(__dirname, '..', 'index.ts');
const TSX_CLI = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = 9538;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-editors-'));
const appDataDir = path.join(tmp, 'app');
const projectsRoot = path.join(tmp, 'projects');
fs.mkdirSync(appDataDir, { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });
fs.writeFileSync(path.join(appDataDir, 'app-config.json'), JSON.stringify({ server: { port: PORT } }));

interface AnyMsg {
  type: string;
  [k: string]: unknown;
}

interface Conn {
  ws: WebSocket;
  last: Record<string, AnyMsg>;
  /** Все пришедшие объекты — по ним видно, чью правку редактор увидел. */
  projects: AnyMsg[];
  rejected: AnyMsg[];
}

function startEngine(): ChildProcess {
  return spawn(process.execPath, [TSX_CLI, ENGINE_ENTRY, '--app-data', appDataDir, '--projects-root', projectsRoot], {
    cwd: tmp,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function connect(): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = (): void => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const state: Conn = { ws, last: {}, projects: [], rejected: [] };
      ws.on('open', () => {
        ws.on('message', (raw: Buffer) => {
          const m = JSON.parse(raw.toString()) as AnyMsg;
          state.last[m.type] = m;
          if (m.type === 'project') state.projects.push(m);
          if (m.type === 'projectRejected') state.rejected.push(m);
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

function send(st: Conn, msg: AnyMsg): void {
  st.ws.send(JSON.stringify(msg));
}

/** Объект последней известной версии с новым именем — чем не правка. */
function renamed(st: Conn, name: string): { project: Record<string, unknown>; rev: number } {
  const last = st.projects[st.projects.length - 1]!;
  const project = { ...(last.project as Record<string, unknown>), name };
  return { project, rev: Number(last.rev) };
}

const nameIn = (st: Conn): string => String((st.projects[st.projects.length - 1]!.project as { name: string }).name);

(async () => {
  const eng = startEngine();
  const a = await connect();
  await sleep(300);
  const b = await connect();
  await sleep(1200);

  // --- 1. Редакторы знают друг о друге ------------------------------------
  const idA = String(a.last['clientId']?.id ?? '');
  const idB = String(b.last['clientId']?.id ?? '');
  check('каждый редактор получил свой номер', idA !== '' && idB !== '' && idA !== idB, `${idA}/${idB}`);
  const listA = (a.last['editors']?.list ?? []) as { id: string }[];
  check('движок говорит, что редакторов двое', listA.length === 2, JSON.stringify(listA));

  // --- 2. Чужая правка ВИДНА, а не съедается как своя ----------------------
  const beforeB = b.projects.length;
  send(a, { type: 'updateProject', ...renamed(a, 'Правка первого') });
  await sleep(600);
  check('второй редактор увидел чужую правку', b.projects.length > beforeB && nameIn(b) === 'Правка первого', nameIn(b));
  const echo = b.projects[b.projects.length - 1]!;
  check('в отклике помечен автор правки', echo.by === idA, String(echo.by));
  check('версия объекта выросла', Number(echo.rev) > 1, String(echo.rev));

  // --- 3. Правка поверх чужой не принимается -------------------------------
  const stale = { ...(a.projects[1]!.project as Record<string, unknown>), name: 'Старая основа' };
  send(b, { type: 'updateProject', project: stale, rev: 1 });
  await sleep(600);
  check('движок отверг правку поверх чужой', b.rejected.length === 1, JSON.stringify(b.rejected));
  check('человеку сказано, где смотреть', String(b.rejected[0]?.message ?? '').includes('в другом редакторе'), String(b.rejected[0]?.message));
  check('объект в движке не затёрт', nameIn(b) === 'Правка первого', nameIn(b));
  check('первый редактор чужой отказ не увидел', a.rejected.length === 0);

  // --- 4. Свои правки подряд принимаются (отклик ещё в пути) ---------------
  const base = renamed(a, 'Первая подряд');
  send(a, { type: 'updateProject', project: base.project, rev: base.rev });
  send(a, { type: 'updateProject', project: { ...base.project, name: 'Вторая подряд' }, rev: base.rev });
  await sleep(700);
  check('две свои правки подряд прошли', nameIn(a) === 'Вторая подряд' && a.rejected.length === 0, nameIn(a));

  // --- 5. Обновившись, второй редактор правит спокойно ---------------------
  const fresh = renamed(b, 'Правка второго');
  send(b, { type: 'updateProject', project: fresh.project, rev: fresh.rev });
  await sleep(600);
  check('правка на свежей версии принята', nameIn(a) === 'Правка второго', nameIn(a));
  check('отказов больше не было', b.rejected.length === 1);

  // --- 6. Редактор ушёл — предупреждение снимается -------------------------
  b.ws.close();
  await sleep(600);
  const listAfter = (a.last['editors']?.list ?? []) as { id: string }[];
  check('после ухода второго остался один', listAfter.length === 1, JSON.stringify(listAfter));

  a.ws.close();
  eng.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`два редактора сразу: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
