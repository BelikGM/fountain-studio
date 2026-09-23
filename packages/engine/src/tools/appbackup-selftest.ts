/**
 * Самопроверка резервной копии настроек ПРОГРАММЫ (не объекта).
 *
 * Копия объекта не содержит ни лицензии, ни токена бота, ни настроек движка:
 * они лежат в папке данных приложения. Умер диск — объект вернулся бы из
 * копии, а лицензию и бота пришлось бы заводить заново. Проверяем то, ради
 * чего копия и делается: в файл попало всё нужное, обратно оно кладётся
 * целым, а чужой или битый архив не затирает рабочие настройки.
 *
 * Тест поднимает НАСТОЯЩИЙ index.ts на изолированной папке данных и говорит
 * с ним по WebSocket, как редактор (рабочие данные не трогаются — правило 4).
 *
 * Запуск: npm -w @fountain-studio/engine run appbackup-test
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createZip, readZip } from '../zip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ENTRY = path.join(__dirname, '..', 'index.ts');
const TSX_CLI = path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const PORT = 9537;

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-appbackup-'));
const appDataDir = path.join(tmp, 'app');
const projectsRoot = path.join(tmp, 'projects');
fs.mkdirSync(appDataDir, { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });
fs.writeFileSync(
  path.join(appDataDir, 'app-config.json'),
  JSON.stringify({ server: { port: PORT }, audio: { volumeDb: -7 } }, null, 2),
);
fs.writeFileSync(path.join(appDataDir, 'fountain.secrets.json'), JSON.stringify({ telegram: { token: 'секрет-123' } }));
fs.writeFileSync(path.join(appDataDir, 'fountain.license.json'), JSON.stringify({ payload: 'лицензия', sig: 'подпись' }));

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
  return undefined;
}

function send(st: Conn, msg: AnyMsg): void {
  st.ws.send(JSON.stringify(msg));
}

(async () => {
  const eng = startEngine();
  const st = await connect();
  await sleep(1500);

  // --- 1. Выгрузка: в файле всё, ради чего копия и делается ----------------
  // Редактор присылает и настройки своего окна (они в браузере, движок их не видит).
  send(st, { type: 'exportAppSettings', uiPrefs: { 'fs-hotkeys': '{"blackout":"F12"}', 'fountain.view.prefs': '{"rotateSpeed":0.3}' } });
  const exp = await waitFor(st, 'appSettingsExport');
  check('движок отдал файл копии', exp !== undefined && typeof exp.dataBase64 === 'string');
  const zip = Buffer.from(String(exp?.dataBase64 ?? ''), 'base64');
  const names = readZip(zip).map((e) => e.name);
  check('в копии лицензия', names.includes('fountain.license.json'), names.join(', '));
  check('в копии токен бота', names.includes('fountain.secrets.json'), names.join(', '));
  check('в копии настройки движка', names.includes('app-config.json'), names.join(', '));
  check('в копии список недавних объектов', names.includes('app-settings.json'), names.join(', '));
  check('в копии есть объяснение для человека', names.includes('ЧТО-ЭТО.txt'), names.join(', '));
  check('в копии настройки окна редактора (горячие клавиши, камера)', names.includes('ui-prefs.json'), names.join(', '));
  check('имя файла с датой', /^fountain-настройки-\d{4}-\d{2}-\d{2}\.zip$/u.test(String(exp?.filename)), String(exp?.filename));
  const secretsInZip = readZip(zip).find((e) => e.name === 'fountain.secrets.json');
  check('токен внутри копии настоящий', secretsInZip?.data.toString('utf8').includes('секрет-123') === true);
  // Рабочих данных объектов в копии настроек быть не должно — у них свой перенос.
  check('объектов в копии настроек нет', !names.some((n) => n === 'project.json' || n.startsWith('audio/')), names.join(', '));

  // --- 2. Восстановление: то, что потеряли, вернулось целым ----------------
  fs.rmSync(path.join(appDataDir, 'fountain.secrets.json'));
  fs.writeFileSync(path.join(appDataDir, 'fountain.license.json'), 'испорчено');
  send(st, { type: 'importAppSettings', dataBase64: zip.toString('base64') });
  const imp = await waitFor(st, 'appSettingsImportResult');
  check('восстановление прошло', imp?.ok === true, String(imp?.message));
  check('в ответе сказано про перезапуск', String(imp?.message).includes('ерезапуст'), String(imp?.message));
  const back = (imp as { uiPrefs?: Record<string, string> } | undefined)?.uiPrefs;
  check('настройки окна редактора вернулись редактору', back?.['fs-hotkeys'] === '{"blackout":"F12"}', JSON.stringify(back));
  const secrets = fs.readFileSync(path.join(appDataDir, 'fountain.secrets.json'), 'utf8');
  check('токен бота вернулся', secrets.includes('секрет-123'), secrets);
  const lic = fs.readFileSync(path.join(appDataDir, 'fountain.license.json'), 'utf8');
  check('лицензия вернулась целой', lic.includes('подпись'), lic);

  // --- 3. Чужой и битый архив не затирают настройки ------------------------
  const foreign = createZip([{ name: 'project.json', data: Buffer.from('{}', 'utf8') }]);
  send(st, { type: 'importAppSettings', dataBase64: foreign.toString('base64') });
  const bad1 = await waitFor(st, 'appSettingsImportResult');
  check('копия объекта не принимается за настройки', bad1?.ok === false, String(bad1?.message));
  check('человеку сказано, что это не тот файл', String(bad1?.message).includes('копия проекта'), String(bad1?.message));

  const broken = createZip([{ name: 'app-config.json', data: Buffer.from('это не json', 'utf8') }]);
  send(st, { type: 'importAppSettings', dataBase64: broken.toString('base64') });
  const bad2 = await waitFor(st, 'appSettingsImportResult');
  check('битый файл настроек отвергнут', bad2?.ok === false, String(bad2?.message));
  const cfg = fs.readFileSync(path.join(appDataDir, 'app-config.json'), 'utf8');
  check('настройки движка от битого архива не пострадали', cfg.includes('-7'), cfg);

  send(st, { type: 'importAppSettings', dataBase64: Buffer.from('вообще не zip').toString('base64') });
  const bad3 = await waitFor(st, 'appSettingsImportResult');
  check('не-архив не роняет движок', bad3?.ok === false, String(bad3?.message));
  send(st, { type: 'exportAppSettings' });
  check('движок жив после всех отказов', (await waitFor(st, 'appSettingsExport')) !== undefined);

  st.ws.close();
  eng.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`копия настроек программы: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
