/**
 * Снимки НАСТОЯЩЕГО окна программы (Electron из packages/app) — со своей
 * строкой заголовка, меню «Файл / Правка / Вид…» и кнопками Windows.
 *
 * Зачем. Снимки ui-shot открывают редактор в своём окне, без preload
 * программы, — строку заголовка и меню (они есть только в настольной
 * программе) там не увидеть, а кнопки Windows рисуются вообще вне страницы.
 * Здесь: изолированный движок (порт 9533, временная папка, демо-проект),
 * окно программы в режиме разработки (редактор с Vite, npm run dev должен
 * работать), управление по протоколу отладки Chromium (порт 9334), снимки —
 * страница (Page.captureScreenshot) и окно целиком (scripts/window-shot.ps1,
 * PrintWindow — вместе с кнопками Windows).
 *
 * ЗАПУСКАТЬ ТОЛЬКО НА НЕВИДИМОМ РАБОЧЕМ СТОЛЕ — окно программы настоящее:
 *   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-hidden.ps1  *     -Command 'cmd /c npm -w @fountain-studio/engine run app-shots -- <папка> > app-shots.log 2>&1'
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { sanitizeProject } from '@fountain-studio/shared';
import { fileURLToPath } from 'node:url';
import { createDemoProject } from '../demoproject';
import { defaultAppDataDir } from '../projects';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const OUT = path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2] ?? path.join(os.tmpdir(), 'fs-app-shots'));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 9533;
const DBG = 9334;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => {
  console.log(s);
  fs.appendFileSync(path.join(OUT, 'log.txt'), s + '\n');
};
fs.writeFileSync(path.join(OUT, 'log.txt'), '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-titlebar-'));
const appData = path.join(tmp, 'app');
const root = path.join(tmp, 'Проекты');
const proj = path.join(root, 'Демо');
fs.mkdirSync(appData, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(appData, 'app-config.json'), JSON.stringify({ server: { port: PORT } }));
const lic = path.join(defaultAppDataDir(), 'fountain.license.json');
if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(appData, 'fountain.license.json'));
fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify(sanitizeProject(createDemoProject())));
fs.writeFileSync(
  path.join(proj, 'lines.json'),
  JSON.stringify({ tickMs: 50, universes: [{ id: 1, label: '', outputs: [{ type: 'artnet', host: '127.0.0.1', port: 16455, universe: 0 }] }], backup: { enabled: false, intervalMin: 10 } }),
);

const engine = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--app-data', appData, '--projects-root', root, '--project', proj], {
  cwd: path.join(REPO, 'packages/engine'),
  stdio: 'ignore',
});
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-titlebar-ud-'));
const env = { ...process.env, FOUNTAIN_ENGINE_PORT: String(PORT) } as NodeJS.ProcessEnv;
delete env.ELECTRON_RUN_AS_NODE;
let app: ReturnType<typeof spawn> | null = null;

async function waitWs(url: string): Promise<boolean> {
  for (let i = 0; i < 80; i++) {
    const ok = await new Promise<boolean>((res) => {
      const w = new WebSocket(url);
      w.once('open', () => (w.close(), res(true)));
      w.once('error', () => res(false));
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

let seq = 0;
async function main(): Promise<void> {
  if (!(await waitWs(`ws://127.0.0.1:${PORT}`))) throw new Error('движок не поднялся');
  app = spawn(path.join(REPO, 'node_modules/electron/dist/electron.exe'), [path.join(REPO, 'packages/app'), `--remote-debugging-port=${DBG}`, `--user-data-dir=${ud}`], {
    env,
    stdio: 'ignore',
  });
  let target: { webSocketDebuggerUrl: string; url: string } | undefined;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(500);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      target = list.find((t) => t.type === 'page' && t.url.includes('5180'));
    } catch {
      /* ещё не поднялось */
    }
  }
  if (!target) throw new Error('окно не открылось');
  log('страница: ' + target.url);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once('open', r));
  const pending = new Map<number, (v: unknown) => void>();
  ws.on('message', (m) => {
    const d = JSON.parse(String(m)) as { id?: number; result?: unknown };
    if (d.id && pending.has(d.id)) pending.get(d.id)!(d.result);
  });
  const cdp = (method: string, params: object = {}) =>
    new Promise<any>((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expr: string): Promise<unknown> => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r?.result?.value ?? r?.exceptionDetails?.exception?.description;
  };
  const shot = async (name: string): Promise<void> => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const win = (name: string): void => {
    const o = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts', 'window-shot.ps1'), '-Out', path.join(OUT, name + '.png')], { encoding: 'utf8' });
    log(name + ': ' + o.trim());
  };
  const resize = (size: string): void => {
    const o = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(REPO, 'scripts', 'window-shot.ps1'), '-Resize', size], { encoding: 'utf8' });
    log('размер окна ' + size + ': ' + o.trim());
  };

  await sleep(3000);
  await js(`localStorage.setItem('fs-tour-done', '1'); location.reload(); 'ok'`);
  await sleep(4000);
  log('заголовок: ' + (await js(`(() => { const t = document.querySelector('.titlebar'); if (!t) return 'НЕТ строки заголовка'; const r = t.getBoundingClientRect(); return 'высота ' + r.height + ', меню: ' + [...t.querySelectorAll('.menubar-btn')].map((b) => b.textContent).join(' | ') + '; справа отступ ' + t.style.paddingRight + '; title: ' + t.querySelector('.titlebar-title').textContent; })()`)));
  log('шапка: ' + (await js(`[...document.querySelectorAll('header.topbar > *')].map((e) => e.className || e.tagName).join(' | ')`)));
  await shot('1-page');
  win('1-window');
  for (const [i, label] of ['Файл', 'Правка', 'Вид', 'Воспроизведение', 'Справка'].entries()) {
    await js(`[...document.querySelectorAll('.menubar-btn')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(); 'ok'`);
    await sleep(350);
    log(`меню «${label}»: ` + (await js(`[...document.querySelectorAll('.menu-drop .menu-item, .menu-drop .menu-note')].map((b) => (b.disabled ? '(' : '') + b.textContent.trim() + (b.disabled ? ')' : '')).join(' / ')`)));
    await shot(`2-menu-${i + 1}`);
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 'ok'`);
    await sleep(200);
  }
  // Подменю «Вид → Вкладка».
  await js(`[...document.querySelectorAll('.menubar-btn')].find((b) => b.textContent.trim() === 'Вид').click(); 'ok'`);
  await sleep(250);
  await js(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.includes('Вкладка')).click(); 'ok'`);
  await sleep(300);
  await shot('3-submenu');
  // «Мельче» — масштаб 90 %.
  await js(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim().startsWith('Мельче')).click(); 'ok'`);
  await sleep(600);
  log('после «Мельче»: ' + (await js(`innerWidth + ' px по CSS, масштаб ' + localStorage.getItem('fs-zoom')`)));
  await shot('4-zoom90');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', code: 'Digit0', ctrlKey: true })); 'ok'`);
  await sleep(500);
  log('после Ctrl+0: ' + (await js(`innerWidth + ' px, масштаб ' + localStorage.getItem('fs-zoom')`)));
  // Светлая тема — цвета кнопок Windows вслед.
  await js(`[...document.querySelectorAll('.menubar-btn')].find((b) => b.textContent.trim() === 'Вид').click(); 'ok'`);
  await sleep(250);
  await js(`[...document.querySelectorAll('.menu-item')].find((b) => b.textContent.trim() === 'Светлая тема').click(); 'ok'`);
  await sleep(700);
  win('5-window-light');
  // Узкое окно — меню одной кнопкой. Размер окна меняет сама Windows (MoveWindow
  // в window-shot.ps1) — так же, как если бы человек потянул за край.
  {
    resize('900x640');
    await sleep(1200);
    log('узкое окно: ' + (await js(`innerWidth + '×' + innerHeight + ', кнопка меню: ' + !!document.querySelector('.menubar-burger') + ', вкладок видно ' + document.querySelectorAll('nav.tabs > .tab').length`)));
    win('6-window-narrow-light');
    await js(`document.querySelector('.menubar-burger').click(); 'ok'`);
    await sleep(300);
    await shot('7-burger');
  }
  ws.close();
}

main()
  .catch((e) => log('✖ ' + (e instanceof Error ? e.message : String(e))))
  .finally(async () => {
    try {
      app?.kill();
    } catch {
      /* */
    }
    engine.kill();
    await sleep(800);
    try {
      // Только своё дерево процессов — чужие окна Electron не трогаем.
      if (app?.pid) execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* уже нет */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  });
