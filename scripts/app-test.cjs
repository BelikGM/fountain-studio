/**
 * Проверка УСТАНОВЛЕННОЙ программы (собранные engine.cjs, playback-worker.cjs
 * и окно Electron), а не движка из исходников.
 *
 * Зачем отдельно. 23.09.2026 выяснилось, что собранная программа не могла
 * поднять движок вовсе (import.meta в CommonJS), поток расчёта в ней не
 * поднимался никогда, а закрытие окна гасило фонтан. Всё это не видно ни
 * одной проверкой из исходников — только запуском того, что уходит на объект.
 *
 * Что проверяется: движок поднимается из сборки; закрыли окно — фонтан
 * работает, программа значком у часов; «Остановить фонтан и выйти» гасит
 * движок по-хорошему; скрытый запуск (как при автозапуске Windows); упавший
 * движок поднимается сам; запись автозапуска в реестр ставится и снимается.
 *
 * Свой порт 9541, временные папки и тестовое имя записи автозапуска — рабочий
 * движок (9520), объекты и настоящий автозапуск не трогаются.
 *
 * Запуск: npm run app-test (сначала собирает программу).
 */
const { spawn, execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { pathToFileURL } = require('url');
const pathToFileUrl = (p) => pathToFileURL(p).href;

const ROOT = path.resolve(__dirname, '..');
const PORT = 9541;
const electron = path.join(ROOT, 'node_modules/electron/dist/electron.exe');
let passed = 0;
let failed = 0;
const check = (ok, name) => {
  console.log(`${ok ? '  ✓' : '  ✖'} ${name}`);
  ok ? passed++ : failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = () =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT, timeout: 500 });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.once('timeout', () => (s.destroy(), resolve(false)));
  });
const portPid = () => {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.includes(`:${PORT} `) && l.includes('LISTENING'));
    return line ? Number(line.trim().split(/\s+/).pop()) : null;
  } catch {
    return null;
  }
};
const waitFor = async (cond, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cond()) return true;
    await sleep(250);
  }
  return false;
};

function launch(extraArgs, extraEnv) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-app-ud-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-app-data-'));
  fs.writeFileSync(path.join(ud, 'app-config.json'), JSON.stringify({ server: { port: PORT } }));
  // Тестовое имя записи автозапуска: первый запуск установленной программы
  // включает автозапуск сам, и без этого проверка записала бы НАСТОЯЩИЙ.
  const env = { ...process.env, FOUNTAIN_LOCAL_UI: '1', FOUNTAIN_ENGINE_PORT: String(PORT), FOUNTAIN_DATA_DIR: data, FOUNTAIN_AUTOSTART_NAME: 'FountainStudioTEST', FOUNTAIN_TEST_FIRST_AUTOSTART: '1', ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(electron, [path.join(ROOT, 'packages/app'), `--user-data-dir=${ud}`, ...extraArgs], { env });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  let exited = false;
  proc.on('exit', () => (exited = true));
  return { proc, getLog: () => log, isExited: () => exited };
}

(async () => {
  console.log('— закрыли окно: фонтан работает, выход гасит движок по-хорошему —');
  {
    const a = launch([], { FOUNTAIN_TEST_CLOSE_WINDOW_MS: '6000', FOUNTAIN_TEST_QUIT_MS: '14000' });
    check(await waitFor(listening, 15000), 'движок поднялся на своём порту');
    await sleep(9000);
    check(a.getLog().includes('окно спрятано'), 'окно закрыли — оно спрятано, а не закрыта программа');
    check((await listening()) && !a.isExited(), 'после закрытия окна движок работает, программа жива (значок у часов)');
    check(await waitFor(async () => !(await listening()) && a.isExited(), 12000), '«Остановить фонтан и выйти» — движок остановлен, программа вышла');
    check(a.getLog().includes('остановился сам') && !a.getLog().includes('принудительно'), 'движок остановился по-хорошему (безопасный кадр), а не убит');
  }
  await sleep(1500);
  console.log('— скрытый запуск (как при автозапуске Windows) —');
  {
    const b = launch(['--hidden'], { FOUNTAIN_TEST_QUIT_MS: '9000' });
    check(await waitFor(listening, 15000), '--hidden: движок поднялся без окна');
    check(!b.getLog().includes('окно спрятано'), '--hidden: окна не было вовсе');
    check(await waitFor(async () => !(await listening()) && b.isExited(), 12000), '--hidden: выход тоже по-хорошему');
  }
  await sleep(1500);
  console.log('— движок упал сам: программа поднимает его заново —');
  {
    const c = launch([], {});
    check(await waitFor(listening, 15000), 'движок поднялся');
    const pid1 = portPid();
    try {
      execSync(`taskkill /PID ${pid1} /F`, { stdio: 'ignore' });
    } catch {
      /* */
    }
    await sleep(1000);
    const back = await waitFor(async () => (await listening()) && portPid() !== pid1, 10000);
    check(back, `движок убит (pid ${pid1}) — через пару секунд работает снова (pid ${portPid()})`);
    try {
      execSync(`taskkill /PID ${c.proc.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* */
    }
    await sleep(1500);
  }
  console.log('— автозапуск установленной программы (реестр, тестовое имя) —');
  {
    // Первый запуск (временная папка данных — «чистая» машина) включает
    // автозапуск сам: программа должна подниматься после перезагрузки.
    let firstRun = false;
    try {
      execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v FountainStudioTEST', { stdio: 'ignore' });
      firstRun = true;
    } catch {
      firstRun = false;
    }
    check(firstRun, 'первый запуск установленной программы сам включил автозапуск с Windows');
    try {
      execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v FountainStudioTEST /f', { stdio: 'ignore' });
    } catch {
      /* записи нет — нечего убирать */
    }
  }
  {
    const code = [
      "import { isAutostartEnabled, isAutostartSupported, setAutostart } from './packages/engine/src/autostart.ts';",
      'const out = { supported: isAutostartSupported(), set: setAutostart(true).ok, on: isAutostartEnabled(), unset: setAutostart(false).ok, off: !isAutostartEnabled() };',
      'console.log(JSON.stringify(out));',
    ].join('\n');
    const env = {
      ...process.env,
      FOUNTAIN_APP_CMD: '"C:\\Program Files\\Fountain Studio\\Fountain Studio.exe" --hidden',
      FOUNTAIN_AUTOSTART_NAME: 'FountainStudioTEST',
    };
    const file = path.join(os.tmpdir(), `fs-autostart-${process.pid}.mts`);
    fs.writeFileSync(file, code.replace('./packages/engine/src/autostart.ts', pathToFileUrl(path.join(ROOT, 'packages/engine/src/autostart.ts'))));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), file], { cwd: ROOT, env, encoding: 'utf8' });
    fs.rmSync(file, { force: true });
    let res = {};
    try {
      res = JSON.parse((r.stdout || '').trim().split('\n').pop());
    } catch {
      console.log(r.stdout, r.stderr);
    }
    check(res.supported === true, 'в установленной программе автозапуск доступен');
    check(res.set === true && res.on === true, 'включили — запись в «Автозагрузке» Windows есть');
    check(res.unset === true && res.off === true, 'выключили — записи нет');
  }
  console.log('— автозапуск движка из исходников (реестр, тестовое имя) —');
  {
    // Из исходников — тоже записью в «Автозагрузке», без прав администратора:
    // задачу планировщика «при входе» обычный пользователь не создаст.
    const code = [
      "import { isAutostartEnabled, isAutostartSupported, setAutostart } from './packages/engine/src/autostart.ts';",
      'const set = setAutostart(true);',
      'const out = { supported: isAutostartSupported(), set: set.ok, err: set.error ?? "", on: isAutostartEnabled(), unset: setAutostart(false).ok, off: !isAutostartEnabled() };',
      'console.log(JSON.stringify(out));',
    ].join('\n');
    const env = { ...process.env, FOUNTAIN_AUTOSTART_NAME: 'FountainStudioDEVTEST' };
    delete env.FOUNTAIN_APP_CMD;
    const file = path.join(os.tmpdir(), `fs-autostart-dev-${process.pid}.mts`);
    fs.writeFileSync(file, code.replace('./packages/engine/src/autostart.ts', pathToFileUrl(path.join(ROOT, 'packages/engine/src/autostart.ts'))));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), file], { cwd: ROOT, env, encoding: 'utf8' });
    fs.rmSync(file, { force: true });
    let res = {};
    try {
      res = JSON.parse((r.stdout || '').trim().split('\n').pop());
    } catch {
      console.log(r.stdout, r.stderr);
    }
    check(res.supported === true, 'из исходников автозапуск доступен');
    check(res.set === true && res.on === true, `включили без прав администратора — запись есть${res.err ? ' (' + res.err + ')' : ''}`);
    check(res.unset === true && res.off === true, 'выключили — записи нет');
  }
  console.log(`\nустановленная программа: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
})();
