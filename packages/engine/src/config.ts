import fs from 'node:fs';
import path from 'node:path';

export interface OutputConfig {
  type: 'artnet' | 'sacn' | 'usb-dmx' | 'open-dmx' | 'musidora';
  /** Адрес назначения. Для artnet обязателен (IP ноды или broadcast). Для sacn по умолчанию multicast. */
  host?: string;
  port?: number;
  /** Номер вселенной протокола: Art-Net — с 0, sACN — с 1. Для usb-dmx не используется. */
  universe: number;
  /** Слать broadcast (artnet). */
  broadcast?: boolean;
  /** Приоритет источника (sacn, по умолчанию 100). */
  priority?: number;
  /** COM-порт USB-DMX адаптера (usb-dmx и open-dmx), напр. "COM5". */
  path?: string;
  /**
   * Скорость порта.
   *
   * usb-dmx (протокол ENTTEC DMX USB PRO): значение НИ НА ЧТО не влияет —
   * адаптер работает через виртуальный COM-порт FTDI, и драйвер эту настройку
   * игнорирует; тайминг DMX512 держит сам виджет. Оставлено для совместимости
   * с экзотическими клонами на настоящем UART.
   *
   * open-dmx («свисток» без контроллера): здесь скорость РЕАЛЬНАЯ и менять её
   * нельзя — 250000 задано стандартом DMX512.
   */
  baudRate?: number;
  /** fountanplay/musidora: выход интерфейса 1…3 (разъём DMX). */
  musidoraOut?: number;
}

export interface UniverseConfig {
  id: number;
  label?: string;
  outputs: OutputConfig[];
}

export interface EngineConfig {
  server: { port: number };
  timing: {
    /** Шаг тика, мс (50 = 20 Гц). */
    tickMs: number;
    /** За сколько мс до цели переходить с setTimeout на точную добивку по event loop. */
    spinMs: number;
    /** Как часто слать кадры в UI, мс. */
    uiFrameMs: number;
  };
  /** Системный плеер для автономного воспроизведения (плейлисты/расписание). */
  audio: {
    /** auto — ffplay, если найден; none — без звука. */
    player: 'auto' | 'ffplay' | 'none';
    ffplayPath: string;
  };
  universes: UniverseConfig[];
  /** Авто-бэкапы проекта (§27 доработки, УХ п.5) — именованные снимки по расписанию. */
  backup: { enabled: boolean; intervalMin: number };
  /** OSC-пульт (TouchOSC и т.п.): слушаем адрес/действие из project.oscBindings. Выключено по умолчанию. */
  osc?: { enabled: boolean; port: number };
  /**
   * Считать воспроизведение в ОТДЕЛЬНОМ потоке (worker_threads).
   *
   * Зачем: такты расчёта и отправки уже разделены, но поток Node один — если
   * расчёт заблокирует event loop, встанут оба такта. В отдельном потоке
   * блокировка расчёта физически не может задержать кадр (см.
   * playbacksource.ts).
   *
   * ВКЛЮЧЕНО по умолчанию (19.09.2026, по решению заказчика): на объект должна
   * уезжать сразу лучшая версия, а не «сначала проверим по кнопке». Выключить,
   * если на объекте что-то пойдёт не так, — `{"playbackWorker": false}` в
   * app-config.json рядом с настройками программы.
   *
   * Держать это выключаемым всё равно надо: если поток не поднимется (раскладка
   * файлов, политика запуска на машине объекта), движок сам вернётся к расчёту
   * в главном потоке и напишет причину в журнал — фонтан не встанет.
   */
  playbackWorker?: boolean;
  /**
   * Насколько вперёд поток считает кадры, мс (предрасчёт). 0 — считать только
   * текущий кадр.
   *
   * Памяти запас почти не стоит: кадр — 512 байт на линию. Ограничивает
   * ЗАДЕРЖКА РЕАКЦИИ: команда транспорта (запустить шоу, включить сцену)
   * попадает в кадры не раньше, чем кончится посчитанный запас.
   *
   * Важно, что это НЕ влияет на уже идущее шоу: его блоки срабатывают точно
   * по своему таймлайну, и быстрая работа клапанами (очередь «как из
   * автомата») от запаса не страдает. Сдвигается только момент, когда команда
   * человека попадает в кабель. «Стоп» не ждёт запаса вовсе — главный поток
   * глушит воду сам. Подробный разбор и замеры — в playbacksource.ts.
   */
  playbackLookaheadMs?: number;
  /**
   * Откуда прочитаны настройки программы. Нужен, чтобы дописать в тот же файл
   * переключатель подготовки кадров: в установленном приложении человек до
   * этого файла руками не доберётся.
   */
  configFile?: string;
  /**
   * Отзыв лицензии (§27 доработки, «Продукт») — необязательный слой поверх
   * офлайн-проверки подписи, см. licenseRevocation.ts. Без revocationUrl
   * ничего никуда не стучится: по умолчанию выключено.
   */
  license?: { revocationUrl?: string };
  /** MQTT: телеметрия/удалённые команды через брокер. Выключено по умолчанию. */
  mqtt?: {
    enabled: boolean;
    host: string;
    port?: number;
    clientId?: string;
    username?: string;
    password?: string;
    /** Префикс топиков: команды — `${topicPrefix}/cmd/<binding.topic>`, статус — `${topicPrefix}/status`. */
    topicPrefix?: string;
  };
}

const DEFAULTS: EngineConfig = {
  server: { port: 9520 },
  timing: { tickMs: 50, spinMs: 10, uiFrameMs: 100 },
  audio: { player: 'auto', ffplayPath: 'ffplay' },
  universes: [],
  backup: { enabled: true, intervalMin: 10 },
};

/**
 * Настройки САМОЙ ПРОГРАММЫ (не объекта): порт, тайминги планировщика,
 * звуковой плеер, внешние пульты. Лежат в папке данных приложения и при
 * переключении проектов не меняются.
 *
 * Всё, что относится к объекту — вселенные, шаг тика, бэкапы, — живёт в
 * lines.json внутри папки проекта (см. projects.ts). Поэтому здесь список
 * вселенных пустой: его подставляет открытый проект.
 */
export function loadAppConfig(appDataDir: string): EngineConfig & { configFile: string } {
  const file = path.join(appDataDir, 'app-config.json');
  let raw: Partial<EngineConfig> = {};
  try {
    if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EngineConfig>;
  } catch (err) {
    console.error('[config] не удалось прочитать настройки программы:', err);
  }
  return {
    server: { ...DEFAULTS.server, ...raw.server },
    timing: { ...DEFAULTS.timing, ...raw.timing },
    audio: { ...DEFAULTS.audio, ...raw.audio },
    universes: [],
    backup: { ...DEFAULTS.backup, ...raw.backup },
    configFile: file,
    ...(raw.osc ? { osc: raw.osc } : {}),
    ...(raw.mqtt ? { mqtt: raw.mqtt } : {}),
    ...(raw.license ? { license: raw.license } : {}),
    // По умолчанию ВКЛЮЧЕНО: выключается только явным false в настройках.
    playbackWorker: raw.playbackWorker !== false,
    ...(typeof raw.playbackLookaheadMs === 'number' && Number.isFinite(raw.playbackLookaheadMs)
      ? { playbackLookaheadMs: Math.max(0, Math.min(2000, Math.round(raw.playbackLookaheadMs))) }
      : {}),
  };
}

/**
 * Дописать настройки ПРОГРАММЫ, не потеряв остальное.
 *
 * Читаем-правим-пишем, а не перезаписываем целиком: в этом файле лежит и то,
 * чего мы тут не касаемся, — адрес списка отозванных лицензий, настройки MQTT,
 * порт OSC. Перезапись «своим» объектом стёрла бы их молча, и на объекте это
 * выяснилось бы через неделю неработающим отзывом.
 */
export function saveAppConfigPatch(configFile: string, patch: Partial<EngineConfig>): void {
  try {
    let all: Record<string, unknown> = {};
    if (fs.existsSync(configFile)) {
      all = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    }
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ ...all, ...patch }, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] не удалось сохранить настройки программы:', err);
  }
}

/** Ищет fountain.config.json вверх от cwd; путь можно задать через --config. */
export function loadConfig(argv: string[]): EngineConfig & { configFile: string } {
  const flagIdx = argv.indexOf('--config');
  const explicit = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;
  const file = explicit ? path.resolve(explicit) : findUp('fountain.config.json', process.cwd());
  if (!file || !fs.existsSync(file)) {
    throw new Error(
      `Не найден fountain.config.json (искал от ${process.cwd()}). Укажите путь: --config <файл>`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EngineConfig>;
  const config: EngineConfig & { configFile: string } = {
    server: { ...DEFAULTS.server, ...raw.server },
    timing: { ...DEFAULTS.timing, ...raw.timing },
    audio: { ...DEFAULTS.audio, ...raw.audio },
    universes: raw.universes ?? [],
    backup: { ...DEFAULTS.backup, ...raw.backup },
    configFile: file,
    ...(raw.osc ? { osc: raw.osc } : {}),
    ...(raw.mqtt ? { mqtt: raw.mqtt } : {}),
    // По умолчанию ВКЛЮЧЕНО: выключается только явным false в настройках.
    playbackWorker: raw.playbackWorker !== false,
    ...(typeof raw.playbackLookaheadMs === 'number' && Number.isFinite(raw.playbackLookaheadMs)
      ? { playbackLookaheadMs: Math.max(0, Math.min(2000, Math.round(raw.playbackLookaheadMs))) }
      : {}),
  };
  if (config.universes.length === 0) {
    throw new Error(`В ${file} не задано ни одной вселенной (universes)`);
  }
  console.log(`[config] загружен ${file}`);
  return config;
}

function findUp(name: string, from: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
