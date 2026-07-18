/**
 * Fountain Studio — главный процесс Electron.
 *
 * Идеология прежняя: движок — отдельный процесс, редактор — окно поверх него.
 * При старте: если порт 9520 уже занят (движок крутится службой-watchdog или
 * запущен вручную) — просто подключаемся; иначе поднимаем движок сами из
 * бандла engine.cjs. Закрытие окна гасит только тот движок, который запустили
 * мы: фонтан под службой продолжает работать без редактора.
 *
 * Данные (fountain.config.json, fountain.project.json, audio/) живут в
 * «Документы\Fountain Studio» — обновление приложения их не трогает.
 */
const { app, BrowserWindow, dialog, utilityProcess } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ENGINE_PORT = 9520;
const DEV_URL = 'http://localhost:5173';
// В разработке (npm run app:dev) UI отдаёт vite, движок запускает concurrently.
const isDev = !app.isPackaged && !process.env.FOUNTAIN_LOCAL_UI;

/** @type {import('electron').UtilityProcess | null} */
let engineProc = null;

function dataDir() {
  const dir = path.join(app.getPath('documents'), 'Fountain Studio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Первый запуск: кладём конфиг по умолчанию (Art-Net на 127.0.0.1, 3 вселенных). */
function ensureConfig(dir) {
  const file = path.join(dir, 'fountain.config.json');
  if (!fs.existsSync(file)) fs.copyFileSync(path.join(__dirname, 'default-config.json'), file);
  return file;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port, timeout: 700 });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    const fail = () => {
      sock.destroy();
      resolve(false);
    };
    sock.once('error', fail);
    sock.once('timeout', fail);
  });
}

async function startEngineIfNeeded() {
  if (isDev) return; // в dev движок запускает npm run app:dev
  if (await portInUse(ENGINE_PORT)) {
    console.log('[app] движок уже работает (порт 9520) — подключаемся к нему');
    return;
  }
  const bundle = path.join(__dirname, 'engine.cjs');
  if (!fs.existsSync(bundle)) {
    dialog.showErrorBox(
      'Fountain Studio',
      'Не найден engine.cjs — соберите приложение: npm run app:build',
    );
    return;
  }
  const cfg = ensureConfig(dataDir());
  engineProc = utilityProcess.fork(bundle, ['--config', cfg], {
    serviceName: 'fountain-engine',
    stdio: 'inherit',
    // Движок работает в папке данных: fountain.project.json и audio/ лягут рядом с конфигом.
    cwd: path.dirname(cfg),
  });
  engineProc.on('exit', (code) => {
    console.log(`[app] движок завершился (код ${code})`);
    engineProc = null;
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    title: 'Fountain Studio',
  });
  if (isDev) {
    // Vite может подняться позже Electron — пробуем, пока не откроется.
    const tryLoad = () => {
      win.loadURL(DEV_URL).catch(() => setTimeout(tryLoad, 1000));
    };
    win.webContents.on('did-fail-load', () => setTimeout(tryLoad, 1000));
    tryLoad();
  } else {
    win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  }
}

app.whenReady().then(async () => {
  await startEngineIfNeeded();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Гасим только свой движок; служба-watchdog остаётся работать.
  if (engineProc) engineProc.kill();
  app.quit();
});
