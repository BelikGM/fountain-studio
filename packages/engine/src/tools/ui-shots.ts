/**
 * Снимки редактора на ИЗОЛИРОВАННОМ движке — для проверок, которые что-то
 * нажимают («+ Вселенная», «Применить», «звук выключен»).
 *
 * Поднимает отдельный движок на порту 9531: своя временная папка данных, своя
 * папка объекта с демо-проектом, выходы — Art-Net на 127.0.0.1 и нестандартный
 * порт (интерфейс FountanPlay и сеть не трогаются). Лицензия этого компьютера
 * КОПИРУЕТСЯ во временную папку — иначе редактор покажет экран активации;
 * оригинал не меняется. Потом прогоняет сценарий scripts/ui-shot.cjs с адресом
 * редактора `?engine=9531` и гасит движок. Рабочий объект и движок на 9520 не
 * трогаются (правило 4 в CLAUDE.md).
 *
 * Запуск (редактор должен быть поднят: npm run dev):
 *   npm -w @fountain-studio/engine run ui-shots -- <сценарий.json>
 * В сценарии url можно не писать — подставится http://127.0.0.1:5180/?engine=9531.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { sanitizeProject } from '@fountain-studio/shared';
import { createDemoProject } from '../demoproject';
import { defaultAppDataDir } from '../projects';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9531;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const scenarioArg = process.argv.slice(2).find((a) => a.endsWith('.json'));
if (!scenarioArg) {
  console.error('Нужен сценарий: npm -w @fountain-studio/engine run ui-shots -- сценарий.json');
  process.exit(2);
}
const scenarioFile = path.resolve(process.env.INIT_CWD ?? process.cwd(), scenarioArg);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ui-shots-'));
const appData = path.join(tmp, 'app');
const root = path.join(tmp, 'Проекты');
const proj = path.join(root, 'Проверка');
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
// Настройки программы для изолированного движка — можно дополнить из сценария
// (поле appConfig): например, несуществующий проигрыватель, чтобы увидеть
// предупреждение «нечем играть музыку».
const scenarioHead = JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) as {
  appConfig?: Record<string, unknown>;
  lines?: Record<string, unknown>;
  engineEnv?: Record<string, string>;
  /** Свой проект вместо демо (путь к project.json) — например, большой, чтобы проверить скорость. */
  projectFile?: string;
};
const scenarioAppConfig = scenarioHead.appConfig ?? {};
fs.writeFileSync(path.join(appData, 'app-config.json'), JSON.stringify({ ...scenarioAppConfig, server: { port: PORT } }));
const license = path.join(defaultAppDataDir(), 'fountain.license.json');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(appData, 'fountain.license.json'));
else console.warn('лицензии на этом компьютере нет — редактор покажет экран активации');
const ownProject = scenarioHead.projectFile
  ? JSON.parse(fs.readFileSync(path.resolve(path.dirname(scenarioFile), scenarioHead.projectFile), 'utf8'))
  : createDemoProject();
fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify(sanitizeProject(ownProject)));
fs.writeFileSync(
  path.join(proj, 'lines.json'),
  JSON.stringify({
    tickMs: 50,
    universes: [{ id: 1, label: '', outputs: [{ type: 'artnet', host: '127.0.0.1', port: 16454, universe: 0 }] }],
    backup: { enabled: false, intervalMin: 10 },
    // lines сценария — свои вселенные и выходы (например, USB-DMX на COM-порту).
    ...scenarioHead.lines,
  }),
);

const engine = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/index.ts', '--app-data', appData, '--projects-root', root, '--project', proj],
  // engineEnv сценария — переменные для движка (например, FOUNTAIN_TEST_COM_PORTS:
  // «подключённые» COM-порты, которых на машине разработчика нет).
  { cwd: path.resolve(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...scenarioHead.engineEnv } },
);
let log = '';
engine.stdout.on('data', (d) => (log += d));
engine.stderr.on('data', (d) => (log += d));

async function waitEngine(): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    const ok = await new Promise<boolean>((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      w.once('open', () => {
        w.close();
        res(true);
      });
      w.once('error', () => res(false));
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

let code = 0;
try {
  if (!(await waitEngine())) throw new Error('изолированный движок не поднялся:\n' + log);
  const sc = JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) as { url?: string };
  if (!sc.url) sc.url = `http://127.0.0.1:5180/?engine=${PORT}`;
  if (!sc.url.includes(`engine=${PORT}`)) throw new Error(`сценарий смотрит не на изолированный движок: ${sc.url}`);
  const scFile = path.join(tmp, 'scenario.json');
  fs.writeFileSync(scFile, JSON.stringify(sc));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // VS Code выставляет его, и Electron стартует как голый Node
  const repo = path.resolve(__dirname, '..', '..', '..', '..');
  const electronBin = path.join(repo, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  code = await new Promise<number>((res) => {
    const el = spawn(electronBin, [path.join(repo, 'scripts', 'ui-shot.cjs'), scFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    el.stdout.on('data', (d) => process.stdout.write(d));
    el.stderr.on('data', (d) => {
      const t = String(d);
      if (!/ERROR:|DevTools|GPU|gpu/.test(t)) process.stderr.write(t);
    });
    el.on('exit', (c) => res(c ?? 1));
  });
} catch (err) {
  console.error('✖', err instanceof Error ? err.message : err);
  code = 1;
} finally {
  engine.kill();
  await sleep(400);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
