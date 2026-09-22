/**
 * Fountain Studio — главный процесс Electron.
 *
 * Идеология прежняя: движок — отдельный процесс, редактор — окно поверх него.
 * При старте: если порт 9520 уже занят (движок крутится службой-watchdog или
 * запущен вручную) — просто подключаемся; иначе поднимаем движок сами из
 * бандла engine.cjs.
 *
 * Закрытие окна НЕ останавливает фонтан (23.09.2026). Раньше окно гасило
 * движок, который само запустило, — в установленной программе это значило
 * «закрыл редактор — фонтан встал», вопреки главному правилу проекта. Теперь
 * окно прячется, программа остаётся значком у часов, движок играет дальше.
 * Остановить фонтан и выйти — пунктом в меню значка, с вопросом.
 *
 * С ключом --hidden программа стартует сразу значком, без окна — так её
 * запускает автозапуск Windows (см. engine/src/autostart.ts). Движок, упавший
 * сам по себе, поднимается заново через 2 с.
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
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net: enet, protocol, Tray, utilityProcess } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Порт и папку данных можно подменить — только для проверки программы на
// своей машине, чтобы не задеть рабочий движок и рабочие объекты.
const ENGINE_PORT = Number(process.env.FOUNTAIN_ENGINE_PORT) || 9520;
/** Запуск автозапуском: без окна, только значок у часов. */
const startHidden = process.argv.includes('--hidden');
const DEV_URL = 'http://localhost:5180';
// В разработке (npm run app:dev) UI отдаёт vite, движок запускает concurrently.
const isDev = !app.isPackaged && !process.env.FOUNTAIN_LOCAL_UI;

/** @type {import('electron').UtilityProcess | null} */
let engineProc = null;
/** Аргументы запуска движка — нужны, чтобы поднять его заново после падения. */
let engineArgs = [];
/** Человек выбрал «Остановить фонтан и выйти» (или Windows завершает работу). */
let quitting = false;
/** Падения подряд вскоре после старта — чтобы не перезапускать бесконечно. */
let quickCrashes = 0;
let engineStartedAt = 0;
/** @type {import('electron').Tray | null} */
let tray = null;
let backgroundHintShown = false;

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
  const dir = process.env.FOUNTAIN_DATA_DIR || path.join(app.getPath('documents'), 'Fountain Studio');
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
  engineArgs = args;
  forkEngine();
}

/**
 * Команда, которой Windows запустит программу при входе: сама программа с
 * ключом --hidden. Из исходников (проверка) — electron.exe с папкой приложения.
 */
function autostartCommand() {
  return app.isPackaged
    ? `"${process.execPath}" --hidden`
    : `"${process.execPath}" "${app.getAppPath()}" --hidden`;
}

function forkEngine() {
  const bundle = path.join(__dirname, 'engine.cjs');
  engineStartedAt = Date.now();
  engineProc = utilityProcess.fork(bundle, engineArgs, {
    serviceName: 'fountain-engine',
    stdio: 'inherit',
    cwd: dataDir(),
    env: { ...process.env, FOUNTAIN_APP_CMD: autostartCommand() },
  });
  engineProc.on('exit', (code) => {
    console.log(`[app] движок завершился (код ${code})`);
    engineProc = null;
    if (quitting) return;
    // Движок упал сам — поднимаем заново: фонтан не должен ждать человека.
    // Пять падений подряд в первые 10 с — это не сбой, а поломка: говорим.
    quickCrashes = Date.now() - engineStartedAt < 10_000 ? quickCrashes + 1 : 0;
    if (quickCrashes >= 5) {
      dialog.showErrorBox('Fountain Studio', 'Движок падает сразу после запуска. Фонтан не управляется — нужна помощь наладчика.');
      return;
    }
    setTimeout(() => {
      if (!quitting && !engineProc) forkEngine();
    }, 2000);
  });
}

/** Попросить движок закончиться по-хорошему (погасить приборы), потом добить. */
function stopEngine() {
  return new Promise((resolve) => {
    const proc = engineProc;
    if (!proc) return resolve();
    const timer = setTimeout(() => {
      console.log('[app] движок не ответил за 3 с — остановлен принудительно');
      try {
        proc.kill();
      } catch {
        /* уже нет */
      }
      resolve();
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(timer);
      console.log('[app] движок остановился сам — приборы погашены безопасным кадром');
      resolve();
    });
    try {
      proc.postMessage('shutdown');
    } catch {
      proc.kill();
    }
  });
}

async function quitWithEngine(ask = true) {
  if (ask) {
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      type: 'warning',
      buttons: ['Остановить и выйти', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      title: 'Fountain Studio',
      message: 'Остановить фонтан и выйти?',
      detail: 'Приборы погаснут, расписание не сработает, пока программу не запустят снова.',
    };
    const r = win && win.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 0) return;
  }
  quitting = true;
  await stopEngine();
  app.quit();
}

function showWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

/** Значок у часов — пока движок наш: через него открывают редактор и выходят. */
function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('Fountain Studio — фонтан работает');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть Fountain Studio', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Остановить фонтан и выйти…', click: () => void quitWithEngine(true) },
    ]),
  );
  tray.on('double-click', () => showWindow());
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
  // Windows завершает работу — окно прятать нельзя, иначе оно держит выход.
  win.on('session-end', () => {
    quitting = true;
  });
  // Закрыли окно — прячем его, а фонтан работает дальше (если движок наш).
  win.on('close', (e) => {
    if (quitting || !engineProc) return;
    e.preventDefault();
    win.hide();
    console.log('[app] окно спрятано — фонтан работает в фоне');
    if (!backgroundHintShown && tray) {
      backgroundHintShown = true;
      tray.displayBalloon({
        title: 'Fountain Studio работает в фоне',
        content: 'Фонтан продолжает играть. Открыть редактор — значок у часов; остановить фонтан и выйти — там же.',
      });
    }
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
  return win;
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
    // Программа могла работать значком без окна — открываем окно.
    const win = showWindow();
    if (dir) {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win.webContents.send('open-project', dir));
      else win.webContents.send('open-project', dir);
    }
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
    if (engineProc) createTray();
    if (startHidden) {
      // Автозапуск, а движок уже работает где-то ещё (служба) — хозяйничать
      // тут нечем, тихо выходим.
      if (!engineProc) app.quit();
    } else {
      createWindow();
    }
    app.on('activate', () => showWindow());
    // Только для проверки программы: закрыть окно и/или выйти через N мс, как
    // это сделал бы человек, — без этого закрытие не проверить автоматически.
    const closeMs = Number(process.env.FOUNTAIN_TEST_CLOSE_WINDOW_MS);
    if (closeMs > 0) setTimeout(() => BrowserWindow.getAllWindows()[0]?.close(), closeMs);
    const quitMs = Number(process.env.FOUNTAIN_TEST_QUIT_MS);
    if (quitMs > 0) setTimeout(() => void quitWithEngine(false), quitMs);
  });
}

// Windows завершает работу или человек вышел иначе — движок гасим по-хорошему.
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', (e) => {
  if (!engineProc) return;
  e.preventDefault();
  void stopEngine().then(() => app.quit());
});

app.on('window-all-closed', () => {
  // Движок наш — программа остаётся значком у часов, фонтан работает.
  // Движок чужой (служба) — окну здесь больше нечего делать.
  if (engineProc && !quitting) return;
  app.quit();
});
