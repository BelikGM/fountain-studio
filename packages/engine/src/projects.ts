import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DMX_UNIVERSE_SIZE, emptyProject, sanitizeProject, type ConfigUniverse, type Project } from '@fountain-studio/shared';

/**
 * Проекты: где они лежат, как устроены и как программа помнит недавние.
 *
 * ── Главный принцип: объект — это ПАПКА ──────────────────────────────────
 * Один фонтан — одна самодостаточная папка. В ней лежит всё, что относится к
 * объекту: схема и адреса, настройки линий DMX, музыка шоу, журнал событий и
 * резервные копии. Папку можно заархивировать, отдать коллеге или унести на
 * флешке — у него откроется ровно то же самое, потому что «в программе»
 * ничего важного не остаётся.
 *
 *   Документы\Fountain Studio\Проекты\Новороссийск\
 *     project.json          схема, приборы, адреса, сцены, секвенсоры, шоу, расписание
 *     lines.json            вселенные, протокол, номера выходов, шаг тика, бэкапы
 *     Новороссийск.fsproj   файл-ярлык: двойной щелчок открывает объект
 *     audio\                музыка шоу
 *     logs\                 журнал событий
 *     backups\              авто-бэкапы
 *
 * ── Что остаётся в самой программе ──────────────────────────────────────
 * Только то, что к объекту не относится и переезжать с ним не должно:
 * список недавних проектов, лицензия (она привязана к компьютеру), секреты
 * (токен Telegram) и настройки редактора. Всё это живёт в папке данных
 * приложения, а не в проекте — иначе, отдавая объект коллеге, пришлось бы
 * отдавать и свой токен бота.
 *
 * Так же разложено у всех, кто работает с «документами»: Word и Blender
 * хранят документ отдельно от настроек программы, VS Code и Unity помнят
 * список недавних папок у себя, а сама папка проекта остаётся переносимой.
 */

/** Как называется файл проекта внутри папки объекта. */
export const PROJECT_FILE = 'project.json';
/** Настройки линий DMX этого объекта. */
export const LINES_FILE = 'lines.json';
/** Расширение файла-ярлыка, который открывает объект двойным щелчком. */
export const MARKER_EXT = '.fsproj';

export interface ProjectPaths {
  dir: string;
  projectFile: string;
  linesFile: string;
  audioDir: string;
  logsDir: string;
  backupsDir: string;
}

export function projectPaths(dir: string): ProjectPaths {
  return {
    dir,
    projectFile: path.join(dir, PROJECT_FILE),
    linesFile: path.join(dir, LINES_FILE),
    audioDir: path.join(dir, 'audio'),
    logsDir: path.join(dir, 'logs'),
    backupsDir: path.join(dir, 'backups'),
  };
}

/** Папка — это проект, если внутри лежит project.json. */
export function isProjectDir(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, PROJECT_FILE)).isFile();
  } catch {
    return false;
  }
}

/**
 * Человек мог указать сам файл (project.json или ярлык .fsproj), а не папку —
 * из Проводника открывают именно файл. Приводим к папке объекта.
 */
export function resolveProjectDir(target: string): string {
  try {
    if (fs.statSync(target).isFile()) return path.dirname(target);
  } catch {
    /* нет такого пути — вернём как есть, вызывающий разберётся */
  }
  return target;
}

// ---------------------------------------------------------------------------
// Настройки линий DMX (lines.json) — часть объекта, а не программы
// ---------------------------------------------------------------------------

export interface ProjectLines {
  tickMs: number;
  universes: ConfigUniverse[];
  backup: { enabled: boolean; intervalMin: number };
}

/**
 * Линии нового объекта: одна линия на том протоколе, которым пользуются на
 * объектах (интерфейс из комплекта FontanPlay). Пустой список оставлять
 * нельзя — человеку было бы некуда ставить приборы.
 */
export function defaultLines(): ProjectLines {
  return {
    tickMs: 50,
    universes: [
      { id: 1, label: 'Линия 1', outputs: [{ type: 'musidora', universe: 0, path: '', musidoraOut: 1 }] },
    ],
    backup: { enabled: true, intervalMin: 10 },
  };
}

/**
 * Годится ли список линий к применению.
 *
 * Проверяем и `outputs`: без него движок падает на `u.outputs.map(...)`, а
 * упавший движок на объекте — это остановленное шоу. Файл lines.json лежит в
 * папке объекта, его могут поправить руками или недописать при копировании,
 * поэтому доверять содержимому нельзя.
 */
export function linesUsable(universes: unknown): universes is ConfigUniverse[] {
  if (!Array.isArray(universes) || universes.length === 0) return false;
  const ids = universes.map((u: ConfigUniverse) => u?.id);
  if (new Set(ids).size !== ids.length) return false;
  return universes.every(
    (u: ConfigUniverse) => u && Number.isInteger(u.id) && u.id >= 1 && Array.isArray(u.outputs),
  );
}

export function readLines(dir: string): ProjectLines {
  const d = defaultLines();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LINES_FILE), 'utf8')) as Partial<ProjectLines>;
    const tickMs = Math.round(Number(raw.tickMs));
    const universes = Array.isArray(raw.universes) ? raw.universes : [];
    const linesOk = linesUsable(universes);
    return {
      tickMs: Number.isFinite(tickMs) && tickMs >= 10 && tickMs <= 1000 ? tickMs : d.tickMs,
      universes: linesOk ? universes : d.universes,
      backup: {
        enabled: typeof raw.backup?.enabled === 'boolean' ? raw.backup.enabled : d.backup.enabled,
        intervalMin: Number.isFinite(Number(raw.backup?.intervalMin))
          ? Math.round(Number(raw.backup!.intervalMin))
          : d.backup.intervalMin,
      },
    };
  } catch {
    return d;
  }
}

export function writeLines(dir: string, lines: ProjectLines): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LINES_FILE), JSON.stringify(lines, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Создание проекта
// ---------------------------------------------------------------------------

/** Имя папки из имени объекта: Windows не любит < > : " / \ | ? * и точку в конце. */
export function safeFolderName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned === '' ? 'Новый проект' : cleaned.slice(0, 80);
}

/** Свободная папка: «Новороссийск», занято — «Новороссийск 2» и так далее. */
export function freeDir(root: string, name: string): string {
  const base = safeFolderName(name);
  let dir = path.join(root, base);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(root, `${base} ${n}`);
  return dir;
}

/**
 * Завести новый объект. Возвращает путь папки.
 *
 * Проект создаётся НЕ пустым: в нём сразу одна линия DMX и файл-ярлык, чтобы
 * объект можно было открыть прямо из Проводника.
 */
export function createProject(root: string, name: string, project?: Project): ProjectPaths {
  const dir = freeDir(root, name);
  const paths = projectPaths(dir);
  fs.mkdirSync(paths.audioDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const base = project ?? emptyProject();
  const withName = sanitizeProject({ ...base, name: name.trim() || path.basename(dir) });
  fs.writeFileSync(paths.projectFile, JSON.stringify(withName, null, 2) + '\n', 'utf8');
  writeLines(dir, defaultLines());
  writeMarker(dir, withName.name);
  return paths;
}

/**
 * Копия объекта под новым именем («Сохранить как»).
 *
 * Зачем: на объекте часто нужен второй вариант шоу — попробовать другую
 * раскладку, не рискуя рабочей. Копируем ВСЮ папку (схема, линии, музыка), но
 * без журнала и бэкапов: это история именно того объекта, в копии она врала бы.
 */
export function copyProject(srcDir: string, root: string, newName: string): ProjectPaths {
  const dir = freeDir(root, newName);
  const paths = projectPaths(dir);
  fs.cpSync(srcDir, dir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      if (base === 'logs' || base === 'backups') return false;
      // Старый ярлык не тащим: имя другое, его перезапишем своим.
      return !base.toLowerCase().endsWith(MARKER_EXT);
    },
  });
  fs.mkdirSync(paths.audioDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  const name = newName.trim() || path.basename(dir);
  try {
    const raw = JSON.parse(fs.readFileSync(paths.projectFile, 'utf8')) as Project;
    fs.writeFileSync(paths.projectFile, JSON.stringify(sanitizeProject({ ...raw, name }), null, 2) + '\n', 'utf8');
  } catch {
    fs.writeFileSync(paths.projectFile, JSON.stringify(sanitizeProject({ ...emptyProject(), name }), null, 2) + '\n', 'utf8');
  }
  writeMarker(dir, name);
  return paths;
}

/**
 * Файл-ярлык <Имя>.fsproj в папке объекта. Нужен, чтобы объект открывался из
 * Проводника двойным щелчком: расширение привязывается к приложению при
 * установке. Внутри — только имя объекта: путь брать нельзя, папку могли
 * переложить или прислать на другой компьютер.
 */
export function writeMarker(dir: string, name: string): void {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.toLowerCase().endsWith(MARKER_EXT)) fs.unlinkSync(path.join(dir, f));
    }
    fs.writeFileSync(
      path.join(dir, `${safeFolderName(name)}${MARKER_EXT}`),
      JSON.stringify({ fountainStudio: 1, name }, null, 2) + '\n',
      'utf8',
    );
  } catch (err) {
    console.error('[проекты] не удалось обновить файл-ярлык:', err);
  }
}

// ---------------------------------------------------------------------------
// Настройки самой программы: недавние проекты (в папке данных приложения)
// ---------------------------------------------------------------------------

export interface RecentProject {
  dir: string;
  name: string;
  openedAtMs: number;
}

export interface AppSettings {
  recent: RecentProject[];
  lastProjectDir: string | null;
  /** Старый расклад «один проект на установку» уже перенесён. */
  legacyMigrated?: boolean;
}

/** Сколько недавних помним: больше десятка в списке всё равно не читают. */
export const MAX_RECENT = 10;

const SETTINGS_FILE = 'app-settings.json';

export function readAppSettings(appDataDir: string): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(appDataDir, SETTINGS_FILE), 'utf8')) as Partial<AppSettings>;
    const recent = Array.isArray(raw.recent) ? raw.recent : [];
    return {
      recent: recent
        .filter((r) => r && typeof r.dir === 'string')
        .map((r) => ({ dir: r.dir, name: typeof r.name === 'string' ? r.name : path.basename(r.dir), openedAtMs: Number(r.openedAtMs) || 0 }))
        .slice(0, MAX_RECENT),
      lastProjectDir: typeof raw.lastProjectDir === 'string' ? raw.lastProjectDir : null,
      legacyMigrated: raw.legacyMigrated === true,
    };
  } catch {
    return { recent: [], lastProjectDir: null };
  }
}

export function writeAppSettings(appDataDir: string, s: AppSettings): void {
  try {
    fs.mkdirSync(appDataDir, { recursive: true });
    fs.writeFileSync(path.join(appDataDir, SETTINGS_FILE), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[проекты] не удалось сохранить настройки программы:', err);
  }
}

/** Открыли проект — он становится первым в списке недавних. */
export function rememberOpened(appDataDir: string, dir: string, name: string): AppSettings {
  const s = readAppSettings(appDataDir);
  const rest = s.recent.filter((r) => path.resolve(r.dir) !== path.resolve(dir));
  const next: AppSettings = {
    ...s,
    recent: [{ dir, name, openedAtMs: Date.now() }, ...rest].slice(0, MAX_RECENT),
    lastProjectDir: dir,
  };
  writeAppSettings(appDataDir, next);
  return next;
}

export function forgetRecent(appDataDir: string, dir: string): AppSettings {
  const s = readAppSettings(appDataDir);
  const next: AppSettings = {
    ...s,
    recent: s.recent.filter((r) => path.resolve(r.dir) !== path.resolve(dir)),
  };
  writeAppSettings(appDataDir, next);
  return next;
}

// ---------------------------------------------------------------------------
// Где что лежит по умолчанию
// ---------------------------------------------------------------------------

/**
 * Папка данных программы. В собранном приложении её передаёт Electron
 * (`--app-data`), при запуске из исходников считаем сами — так движок можно
 * гонять и без приложения (headless на объекте).
 */
export function defaultAppDataDir(): string {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Fountain Studio') : path.join(os.homedir(), '.fountain-studio');
}

/** Куда складываем проекты по умолчанию: рядом с документами, на виду. */
export function defaultProjectsRoot(): string {
  const home = os.homedir();
  const docs = path.join(home, 'Documents');
  const base = fs.existsSync(docs) ? docs : home;
  return path.join(base, 'Fountain Studio', 'Проекты');
}

// ---------------------------------------------------------------------------
// Переезд со старого расклада «один проект на установку»
// ---------------------------------------------------------------------------

/**
 * Раньше объект лежал одной кучей рядом с fountain.config.json:
 * fountain.project.json, audio/, backups/. Переносим это в папку-проект.
 *
 * Именно КОПИРУЕМ, а не перемещаем: если что-то пойдёт не так, старое остаётся
 * на месте и человек ничего не теряет. Повторно не делаем — отметка в
 * настройках программы.
 */
export function migrateLegacyProject(legacyConfigFile: string, projectsRoot: string): ProjectPaths | null {
  const legacyDir = path.dirname(legacyConfigFile);
  const legacyProject = path.join(legacyDir, 'fountain.project.json');
  if (!fs.existsSync(legacyProject)) return null;
  let project: Project;
  try {
    project = sanitizeProject(JSON.parse(fs.readFileSync(legacyProject, 'utf8')));
  } catch {
    return null;
  }
  const name = project.name?.trim() || 'Объект';
  fs.mkdirSync(projectsRoot, { recursive: true });
  const paths = createProject(projectsRoot, name, project);

  // Линии берём из старого конфига, если он читается.
  try {
    const cfg = JSON.parse(fs.readFileSync(legacyConfigFile, 'utf8')) as {
      timing?: { tickMs?: number };
      universes?: ConfigUniverse[];
      backup?: { enabled: boolean; intervalMin: number };
    };
    const d = defaultLines();
    writeLines(paths.dir, {
      tickMs: Number(cfg.timing?.tickMs) || d.tickMs,
      universes: Array.isArray(cfg.universes) && cfg.universes.length > 0 ? cfg.universes : d.universes,
      backup: cfg.backup ?? d.backup,
    });
  } catch {
    /* линии останутся по умолчанию */
  }

  copyDirIfExists(path.join(legacyDir, 'audio'), paths.audioDir);
  copyDirIfExists(path.join(legacyDir, 'backups'), paths.backupsDir);
  copyDirIfExists(path.join(legacyDir, 'logs'), paths.logsDir);
  console.log(`[проекты] старый проект перенесён в ${paths.dir} (исходные файлы оставлены на месте)`);
  return paths;
}

function copyDirIfExists(from: string, to: string): void {
  try {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      const src = path.join(from, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(to, f));
    }
  } catch (err) {
    console.error('[проекты] не удалось скопировать', from, err);
  }
}

/**
 * То, что сервер умеет делать с проектами. Интерфейс объявлен здесь, а не в
 * index.ts, чтобы server.ts не ссылался на точку входа (иначе модули начали бы
 * ссылаться друг на друга по кругу).
 */
export interface ProjectsApi {
  appDataDir: string;
  projectsRoot: string;
  current(): { dir: string; name: string } | null;
  open(target: string): { ok: boolean; error?: string };
  close(): void;
  create(name: string, parentDir?: string): { ok: boolean; error?: string; dir?: string };
  /** «Сохранить как»: копия открытого объекта под новым именем. */
  copy(newName: string): { ok: boolean; error?: string; dir?: string };
  /** Сохранить линии DMX открытого объекта (вкладка «Настройки»). */
  saveLines(tickMs: number, universes: ConfigUniverse[]): void;
  saveBackupConfig(enabled: boolean, intervalMin: number): void;
  recent(): RecentProject[];
  forget(dir: string): void;
}

/** Пригодится проверкам: сколько адресов в одной линии. */
export const CHANNELS_PER_LINE = DMX_UNIVERSE_SIZE;
