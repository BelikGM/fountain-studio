/**
 * Fountain Studio — главный процесс Electron.
 *
 * Идеология прежняя: движок — отдельный процесс, редактор — окно поверх него.
 * При старте: если порт 9520 уже занят (движок крутится службой-watchdog или
 * запущен вручную) — просто подключаемся; иначе поднимаем движок сами из
 * бандла engine.cjs. Закрытие окна гасит только тот движок, который запустили
 * мы: фонтан под службой продолжает работать без редактора.
 *
 * Данные разложены на две части:
 *  · объекты («проекты») — папками в «Документы\Fountain Studio\Проекты»,
 *    каждая самодостаточна и переносится на другой компьютер целиком;
 *  · настройки самой программы (недавние проекты, лицензия, секреты) — в
 *    папке данных приложения, они с объектом не путешествуют.
 *
 * Объект можно открыть тремя способами: выбрать в программе, передать путь
 * аргументом `--project <папка>` или дважды щёлкнуть файл .fsproj в папке
 * объекта — Windows запустит приложение и передаст путь сюда.
 */
const { app, BrowserWindow, dialog, ipcMain, net: enet, protocol, utilityProcess } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ENGINE_PORT = 9520;
const DEV_URL = 'http://localhost:5180';
// В разработке (npm run app:dev) UI отдаёт vite, движок запускает concurrently.
const isDev = !app.isPackaged && !process.env.FOUNTAIN_LOCAL_UI;

/** @type {import('electron').UtilityProcess | null} */
let engineProc = null;

/**
 * Какой объект просят открыть: `--project <путь>` или просто путь к файлу
 * .fsproj / папке (так Windows передаёт двойной щелчок по файлу).
 */
function projectFromArgs(argv) {
  const i = argv.indexOf('--project');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  for (const a of argv.slice(1)) {
    if (typeof a !== 'string' || a.startsWith('-')) continue;
    if (a.toLowerCase().endsWith('.fsproj')) return a;
  }
  return '';
}

function dataDir() {
  const dir = path.join(app.getPath('documents'), 'Fountain Studio');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Папка со своими 3D-моделями форсунок, прожекторов и чаш.
 *
 * Лежит рядом с конфигом и проектом, в «Документы\Fountain Studio\models», а
 * НЕ внутри установленного приложения: то, что упаковано в приложение, при
 * обновлении затирается и вообще доступно только на чтение. Сюда пользователь
 * кладёт свои .glb и правит index.json.
 */
function modelsDir() {
  const dir = path.join(dataDir(), 'models');
  fs.mkdirSync(dir, { recursive: true });
  const index = path.join(dir, 'index.json');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(
      index,
      JSON.stringify(
        {
          note:
            'Свои 3D-модели. Положите файл .glb рядом с этим файлом и добавьте запись в models: ' +
            '{ "file": "имя.glb", "name": "как назвать в списке", "for": "nozzle" | "light" | "bowl" }.',
          models: [],
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  return dir;
}

/**
 * Отдаём эту папку окну по схеме usermodels://local/<имя файла>.
 *
 * Окно в собранном приложении открыто через file:// и просто так читать
 * произвольную папку на диске не может — нужна своя схема. Наружу отдаём
 * ТОЛЬКО имя файла из этой папки: путь из адреса срезается, чтобы адресом
 * нельзя было выйти за её пределы.
 */
function serveModels() {
  protocol.handle('usermodels', (request) => {
    let name = '';
    try {
      name = path.basename(decodeURIComponent(new URL(request.url).pathname));
    } catch {
      name = '';
    }
    if (!name || name === '.' || name === '..') return new Response('', { status: 404 });
    const file = path.join(modelsDir(), name);
    if (!fs.existsSync(file)) return new Response('', { status: 404 });
    return enet.fetch(pathToFileURL(file).toString());
  });
}

/** Где по умолчанию лежат объекты. Движку передаём явно, чтобы совпадало. */
function projectsRoot() {
  const dir = path.join(dataDir(), 'Проекты');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  const args = [
    '--app-data',
    app.getPath('userData'),
    '--projects-root',
    projectsRoot(),
  ];
  // Старый конфиг — только чтобы движок один раз перенёс прежний единственный
  // проект в новую раскладку; дальше он не нужен.
  const legacy = path.join(dataDir(), 'fountain.config.json');
  if (fs.existsSync(legacy)) args.push('--config', legacy);
  const wanted = projectFromArgs(process.argv);
  if (wanted) args.push('--project', wanted);
  engineProc = utilityProcess.fork(bundle, args, {
    serviceName: 'fountain-engine',
    stdio: 'inherit',
    cwd: dataDir(),
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
    webPreferences: {
      // Мостик на один случай: пришёл путь к объекту из Проводника, и окно
      // должно попросить движок его открыть.
      preload: path.join(__dirname, 'preload.cjs'),
    },
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

// Схему надо объявить до готовности приложения, иначе fetch из окна её не увидит.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'usermodels',
    privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true },
  },
]);

/**
 * Вторую копию программы поднимать нельзя: движок займёт тот же порт 9520, и
 * на одной линии DMX окажется два хозяина. Поэтому вторая копия только
 * передаёт путь к объекту первой и закрывается, а первая открывает его у себя.
 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const dir = projectFromArgs(argv);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (dir) win.webContents.send('open-project', dir);
  });

  // Выбор папки объекта обычным окном Windows: путь руками никто вводить не должен.
  ipcMain.handle('choose-project-folder', async (_e, startIn) => {
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      title: 'Выберите папку объекта',
      properties: ['openDirectory'],
      buttonLabel: 'Открыть объект',
      ...(typeof startIn === 'string' && startIn !== '' ? { defaultPath: startIn } : {}),
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || r.filePaths.length === 0 ? '' : r.filePaths[0];
  });

  app.whenReady().then(async () => {
    serveModels();
    await startEngineIfNeeded();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  // Гасим только свой движок; служба-watchdog остаётся работать.
  if (engineProc) engineProc.kill();
  app.quit();
});
