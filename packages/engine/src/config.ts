import fs from 'node:fs';
import path from 'node:path';

export interface OutputConfig {
  type: 'artnet' | 'sacn';
  /** Адрес назначения. Для artnet обязателен (IP ноды или broadcast). Для sacn по умолчанию multicast. */
  host?: string;
  port?: number;
  /** Номер вселенной протокола: Art-Net — с 0, sACN — с 1. */
  universe: number;
  /** Слать broadcast (artnet). */
  broadcast?: boolean;
  /** Приоритет источника (sacn, по умолчанию 100). */
  priority?: number;
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
}

const DEFAULTS: EngineConfig = {
  server: { port: 9520 },
  timing: { tickMs: 50, spinMs: 10, uiFrameMs: 100 },
  audio: { player: 'auto', ffplayPath: 'ffplay' },
  universes: [],
};

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
    configFile: file,
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
