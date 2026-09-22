import fs from 'node:fs';
import path from 'node:path';
import { namesForRdm, sanitizeProject, sanitizeRemoteSettings, type ConfigUniverse } from '@fountain-studio/shared';
import { AudioStore } from './audio';
import { AudioPlayer } from './audioplayer';
import { BackupStore } from './backups';
import { TelegramNotifier } from './telegram';
import { buildSiteSnapshot } from './siteSnapshot';
import { loadAppConfig } from './config';
import { wireAlarmNotifications } from './alarms';
import { generateDemoWav } from './demoaudio';
import { DEMO_AUDIO_FILE, createDemoProject } from './demoproject';
import { DmxCapture } from './dmxcapture';
import { DmxTriggerWatcher } from './dmxtriggers';
import { Engine } from './engine';
import { NetworkMonitor } from './netmonitor';
import { RemoteControl } from './remotecontrol';
import { ProjectStore } from './project';
import { Scheduler } from './schedule';
import { eventLog } from './eventlog';
import { startServer } from './server';
import {
  copyProject,
  createProject,
  defaultAppDataDir,
  defaultProjectsRoot,
  forgetRecent,
  isProjectDir,
  migrateLegacyProject,
  projectPaths,
  readAppSettings,
  readLines,
  rememberOpened,
  writeAppSettings,
  resolveProjectDir,
  writeLines,
  writeMarker,
  type ProjectLines,
  type ProjectsApi,
} from './projects';

/**
 * Запуск движка.
 *
 * Объект («проект») — это папка, и её можно сменить НА ХОДУ, не перезапуская
 * программу: все хранилища умеют переключаться на другую папку (см. rebind у
 * ProjectStore, BackupStore, TelegramNotifier и т. д.). Поэтому сервер держит
 * одни и те же объекты всё время жизни процесса, а «открыть другой проект» —
 * это переприцеливание, а не пересборка мира.
 *
 * Движок может работать и БЕЗ открытого проекта: тогда вселенных нет, на линию
 * ничего не уходит, а редактор показывает экран выбора проекта.
 */

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const appDataDir = argValue('--app-data') ?? defaultAppDataDir();
const projectsRoot = argValue('--projects-root') ?? defaultProjectsRoot();
fs.mkdirSync(appDataDir, { recursive: true });

const config = loadAppConfig(appDataDir);
const engine = new Engine(config);

/**
 * Пока проект не открыт, хранилищам всё равно нужен какой-то путь. Даём им
 * служебную папку в данных программы: туда ничего осмысленного не попадёт —
 * редактор без открытого проекта показывает выбор проекта, а не рабочие
 * вкладки.
 */
const idleDir = path.join(appDataDir, 'no-project');
fs.mkdirSync(idleDir, { recursive: true });
const idle = projectPaths(idleDir);

const store = new ProjectStore(idle.projectFile);
const audio = new AudioStore(idle.audioDir);
const player = new AudioPlayer(config.audio, idle.audioDir);
const backups = new BackupStore(idle.projectFile, () => JSON.stringify(store.project, null, 2), config.backup);
const telegram = new TelegramNotifier(
  {
    // Токен — в папке ПРОГРАММЫ: папку объекта отдают коллеге, и свой токен
    // бота отдавать вместе с ней нельзя.
    secretsFile: path.join(appDataDir, 'fountain.secrets.json'),
    queueFile: path.join(idleDir, 'telegram-queue.json'),
  },
  () => store.project.name,
  () => buildSiteSnapshot({ engine, project: () => store.project, net: () => net?.state(), backups }),
  () => namesForRdm(store.project.devices),
);

/**
 * Команды из чата → действие на объекте. Отправщик уведомлений намеренно не
 * знает про движок (он про чат), поэтому связь делается здесь — в одном месте,
 * где видно и то и другое.
 */
telegram.onAction = (action) => {
  if (action.type === 'stopAll') engine.stopAllPlayback();
  else if (action.type === 'blackout') engine.blackout();
};

engine.playback.onShowAudio = (show) => {
  if (show && show.audioFile) player.play(show.audioFile, show.cuts);
  else player.stop();
};

// Мониторинг сети Art-Net: цели опроса зависят от линий открытого объекта,
// поэтому монитор создаётся один раз и перенастраивается при смене проекта.
const net = new NetworkMonitor({ targets: [], universes: [] });
const capture = new DmxCapture();
const dmxTriggers = new DmxTriggerWatcher();
net.onDmx = (universe, data, fromIp) => {
  capture.handle(universe, data, fromIp);
  dmxTriggers.handle(engine, store.project.dmxTriggers, universe, data);
};

// Внешние пульты: включаются и перенастраиваются на ходу с вкладки «Внешние
// пульты»; при старте — как записано в настройках программы.
const remote = new RemoteControl(
  engine,
  () => store.project.oscBindings,
  () => store.project.mqttBindings,
  sanitizeRemoteSettings({ osc: config.osc, mqtt: config.mqtt }),
  { password: config.mqtt?.password, clientId: config.mqtt?.clientId },
  // Датчик ветра может присылать показание в MQTT — на том же брокере.
  {
    topics: () => (engine.windSensor.mqttTopic ? [engine.windSensor.mqttTopic] : []),
    onMessage: (topic, payload) => engine.windSensor.handleMqtt(topic, payload),
  },
);
engine.windSensor.onTopicChange = () => remote.refreshSubscriptions();
remote.start();
wireAlarmNotifications(remote);

/** Какой объект открыт сейчас; null — ни одного (экран выбора проекта). */
let current: { dir: string; name: string } | null = null;

/** Опрашивать Art-Net имеет смысл только там, где такие выходы есть. */
function configureNet(universes: ConfigUniverse[]): void {
  const artnet = universes.flatMap((u) => u.outputs.filter((o) => o.type === 'artnet'));
  net.configure({
    targets: [...new Set(artnet.map((o) => (o.broadcast ? '255.255.255.255' : (o.host ?? '127.0.0.1'))))],
    universes: [...new Set(artnet.map((o) => o.universe))],
  });
  if (artnet.length > 0) net.start();
  else net.stop();
}

export interface OpenResult {
  ok: boolean;
  error?: string;
}

/**
 * Открыть объект из папки. Порядок важен: сначала линии, потом проект —
 * калибровка приборов и насосы на Modbus индексируются по вселенным, и
 * setProject должен увидеть уже новый их состав.
 */
function openProject(target: string): OpenResult {
  const dir = path.resolve(resolveProjectDir(target));
  if (!isProjectDir(dir)) return { ok: false, error: `В папке «${path.basename(dir)}» нет файла объекта project.json — это не папка объекта` };
  const p = projectPaths(dir);
  const lines = readLines(dir);
  try {
    engine.stopAllPlayback();
    engine.applyConfig(lines.universes, lines.tickMs);
    store.rebind(p.projectFile);
    engine.setProject(store.project);
    audio.setDir(p.audioDir);
    player.setDir(p.audioDir);
    fs.mkdirSync(p.audioDir, { recursive: true });
    backups.rebind(p.projectFile, lines.backup);
    eventLog.attachFile(dir);
    telegram.rebind(path.join(dir, 'telegram-queue.json'));
    configureNet(lines.universes);
    current = { dir, name: store.project.name };
    writeMarker(dir, store.project.name);
    rememberOpened(appDataDir, dir, store.project.name);
    eventLog.log('проект', `открыт «${store.project.name}» (${dir})`);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[проекты] не удалось открыть:', error);
    return { ok: false, error };
  }
}

/** Закрыть объект: вывод на линию прекращается, редактор уходит на выбор проекта. */
function closeProject(): void {
  if (!current) return;
  const was = current.name;
  engine.stopAllPlayback();
  engine.applyConfig([], config.timing.tickMs);
  store.rebind(idle.projectFile);
  audio.setDir(idle.audioDir);
  player.setDir(idle.audioDir);
  backups.rebind(idle.projectFile, { enabled: false, intervalMin: 10 });
  telegram.rebind(path.join(idleDir, 'telegram-queue.json'));
  net.configure({ targets: [], universes: [] });
  net.stop();
  current = null;
  const s = readAppSettings(appDataDir);
  s.lastProjectDir = null;
  writeAppSettings(appDataDir, s);
  eventLog.log('проект', `закрыт «${was}»`);
}

const projects: ProjectsApi = {
  appDataDir,
  projectsRoot,
  /*
   * Имя берём ЖИВЫМ из store.project.name, а не из зафиксированного при
   * открытии current.name: человек может переименовать объект после
   * открытия (updateProject), и заголовок/список проектов должны увидеть
   * новое имя сразу, а не только после следующего переключения.
   */
  current: () => (current ? { dir: current.dir, name: store.project.name } : null),
  open: openProject,
  close: closeProject,
  create(name: string, parentDir?: string): OpenResult & { dir?: string } {
    try {
      const root = parentDir && parentDir.trim() !== '' ? parentDir : projectsRoot;
      fs.mkdirSync(root, { recursive: true });
      const p = createProject(root, name);
      const opened = openProject(p.dir);
      return { ...opened, dir: p.dir };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  /**
   * «Сохранить как»: копия открытого объекта под новым именем.
   *
   * Сначала сбрасываем проект на диск: копировать надо то, что человек видит
   * на экране, а не последнее сохранённое состояние.
   */
  copy(newName: string, parentDir?: string): OpenResult & { dir?: string } {
    if (!current) return { ok: false, error: 'Объект не открыт — копировать нечего' };
    try {
      store.flush();
      const root = parentDir && parentDir.trim() !== '' ? parentDir : projectsRoot;
      fs.mkdirSync(root, { recursive: true });
      const p = copyProject(current.dir, root, newName);
      const opened = openProject(p.dir);
      return { ...opened, dir: p.dir };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  /** Сохранить настройки линий открытого объекта (вкладка «Настройки»). */
  saveLines(tickMs: number, universes: ConfigUniverse[]): void {
    if (!current) return;
    const prev = readLines(current.dir);
    const next: ProjectLines = { tickMs, universes, backup: prev.backup };
    writeLines(current.dir, next);
    configureNet(universes);
  },
  saveBackupConfig(enabled: boolean, intervalMin: number): void {
    if (!current) return;
    const prev = readLines(current.dir);
    writeLines(current.dir, { ...prev, backup: { enabled, intervalMin } });
  },
  recent: () => readAppSettings(appDataDir).recent,
  forget: (dir: string) => forgetRecent(appDataDir, dir),
};

startServer(engine, store, audio, backups, net, capture, remote, telegram, projects, player);

const scheduler = new Scheduler(engine, () => store.project.schedules);
scheduler.start();

// ---------------------------------------------------------------------------
// Что открыть при запуске
// ---------------------------------------------------------------------------

function firstRunSetup(): void {
  const settings = readAppSettings(appDataDir);

  // 1. Явно указали объект (ярлык из Проводника, автозапуск, командная строка).
  const wanted = argValue('--project');
  if (wanted) {
    const r = openProject(wanted);
    if (r.ok) return;
    console.error(`[проекты] не удалось открыть ${wanted}: ${r.error}`);
  }

  // 2. Последний открытый — обычный случай: человек вчера работал, сегодня
  //    пришёл и продолжает с того же фонтана.
  if (settings.lastProjectDir && isProjectDir(settings.lastProjectDir)) {
    if (openProject(settings.lastProjectDir).ok) return;
  }

  /*
   * 3. Переезд со старого расклада «один проект на установку».
   *
   * Только когда открывать больше нечего: иначе обновившаяся программа при
   * каждом запуске лезла бы за старым конфигом вместо объекта, с которым
   * человек уже работает. Старые файлы копируются, а не переносятся — если
   * переезд выйдет комом, исходники на месте.
   */
  if (!settings.legacyMigrated && settings.recent.length === 0) {
    const legacy = argValue('--config');
    const candidates = [legacy, path.join(appDataDir, 'fountain.config.json'), path.join(process.cwd(), 'fountain.config.json')];
    for (const c of candidates) {
      if (!c || !fs.existsSync(c)) continue;
      const moved = migrateLegacyProject(c, projectsRoot);
      const s = readAppSettings(appDataDir);
      s.legacyMigrated = true;
      writeAppSettings(appDataDir, s);
      if (moved) {
        openProject(moved.dir);
        return;
      }
      break;
    }
  }

  // 4. Совсем первый запуск: заводим демо-объект, чтобы человек сразу увидел
  //    работающую программу, а не пустой экран.
  if (settings.recent.length === 0) {
    try {
      const p = createProject(projectsRoot, 'Демо-фонтан', sanitizeProject(createDemoProject()));
      fs.mkdirSync(p.audioDir, { recursive: true });
      fs.writeFileSync(path.join(p.audioDir, DEMO_AUDIO_FILE), generateDemoWav());
      openProject(p.dir);
      console.log('[проекты] первый запуск: создан демо-проект');
      return;
    } catch (err) {
      console.error('[проекты] не удалось создать демо-проект:', err);
    }
  }

  // 5. Ничего не открыли — редактор покажет список недавних.
  console.log('[проекты] проект не открыт — выберите его в редакторе');
}

firstRunSetup();
engine.start();
// Объект открыт, движок пошёл — включить то, что по расписанию должно идти
// сейчас (перезапуск посреди дня не должен оставлять фонтан тёмным).
scheduler.catchUp(new Date());

setInterval(() => {
  const s = engine.stats();
  console.log(
    `[stats] тиков: ${s.ticks}, джиттер avg ${s.avgJitterMs} мс / max ${s.maxJitterMs} мс, кадров отправлено: ${s.framesSent}`,
  );
}, 10_000);

process.on('SIGINT', () => {
  console.log('\n[engine] остановка…');
  scheduler.stop();
  player.stop();
  void remote.stop();
  backups.stop();
  telegram.stop();
  store.flush();
  void eventLog.flush();
  engine.stop();
  process.exit(0);
});
