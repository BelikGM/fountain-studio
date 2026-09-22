/**
 * Самопроверка работы с проектами (см. projects.ts).
 *
 * Проверяет то, ради чего всё затевалось: объект — это самодостаточная папка,
 * проектов может быть сколько угодно, программа помнит недавние, папку можно
 * скопировать и открыть как есть, а старый расклад «один проект на установку»
 * переезжает без потерь.
 *
 * Запуск: npm -w @fountain-studio/engine run projects-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeProject } from '@fountain-studio/shared';
import {
  LINES_FILE,
  MARKER_EXT,
  MAX_RECENT,
  PROJECT_FILE,
  copyProject,
  createProject,
  defaultLines,
  forgetRecent,
  freeDir,
  isProjectDir,
  linesUsable,
  migrateLegacyProject,
  readAppSettings,
  readLines,
  rememberOpened,
  resolveProjectDir,
  safeFolderName,
  writeLines,
} from '../projects';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-projects-'));
const root = path.join(tmp, 'Проекты');
const appData = path.join(tmp, 'AppData');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(appData, { recursive: true });

// ---- Имена папок -----------------------------------------------------------
{
  check('имя чистится от запрещённых символов', safeFolderName('Саки: пруд/фонтан?') === 'Саки пруд фонтан');
  check('дефис в имени сохраняется', safeFolderName('Демо-проект') === 'Демо-проект', safeFolderName('Демо-проект'));
  check('пустое имя не ломает', safeFolderName('   ') === 'Новый объект');
  check('точка в конце убирается (Windows)', !safeFolderName('Объект.').endsWith('.'));
}

// ---- Создание проекта ------------------------------------------------------
const a = createProject(root, 'Новороссийск');
{
  check('папка объекта создана', fs.existsSync(a.dir));
  check('project.json на месте', fs.existsSync(path.join(a.dir, PROJECT_FILE)));
  check('lines.json на месте', fs.existsSync(path.join(a.dir, LINES_FILE)));
  check('папка аудио создана', fs.existsSync(a.audioDir));
  check('папка журнала создана', fs.existsSync(a.logsDir));
  const marker = fs.readdirSync(a.dir).find((f) => f.endsWith(MARKER_EXT));
  check('файл-ярлык для Проводника создан', marker === `Новороссийск${MARKER_EXT}`, String(marker));
  check('папка опознаётся как проект', isProjectDir(a.dir));

  const lines = readLines(a.dir);
  check('у нового объекта одна линия', lines.universes.length === 1, String(lines.universes.length));
  check('и она на протоколе интерфейса FontanPlay', lines.universes[0]?.outputs[0]?.type === 'musidora');
  check('шаг тика по умолчанию 50 мс', lines.tickMs === 50);

  const project = JSON.parse(fs.readFileSync(a.projectFile, 'utf8')) as { name: string; devices: unknown[] };
  check('имя объекта записано в проект', project.name === 'Новороссийск', project.name);
  check('новый объект пустой (приборов нет)', project.devices.length === 0);
}

// ---- Несколько проектов, имена не сталкиваются ------------------------------
const b = createProject(root, 'Новороссийск');
{
  check('второй объект с тем же именем получил свою папку', b.dir !== a.dir);
  check('и называется «Новороссийск 2»', path.basename(b.dir) === 'Новороссийск 2', path.basename(b.dir));
  check('оба существуют одновременно', isProjectDir(a.dir) && isProjectDir(b.dir));
  check('свободная папка ищется и без создания', path.basename(freeDir(root, 'Новороссийск')) === 'Новороссийск 3');
  // Имя объекта внутри project.json должно совпадать с именем папки — иначе
  // в «Недавних» две строки выглядели бы подписанными одинаково, и было бы
  // не понять, какая из них какая (нашли через скриншот экрана «Проекты»).
  const bProject = JSON.parse(fs.readFileSync(b.projectFile, 'utf8')) as { name: string };
  check('имя объекта в файле совпадает с именем папки', bProject.name === 'Новороссийск 2', bProject.name);
}

// ---- Открыть можно и по файлу, не только по папке ---------------------------
{
  const marker = path.join(a.dir, `Новороссийск${MARKER_EXT}`);
  check('путь к ярлыку приводится к папке', resolveProjectDir(marker) === a.dir);
  check('путь к project.json приводится к папке', resolveProjectDir(a.projectFile) === a.dir);
  check('путь к самой папке остаётся папкой', resolveProjectDir(a.dir) === a.dir);
}

// ---- Линии сохраняются В ОБЪЕКТЕ -------------------------------------------
{
  const lines = defaultLines();
  lines.tickMs = 25;
  lines.universes = [
    { id: 1, label: 'Линия 1', outputs: [{ type: 'musidora', universe: 0, path: '', musidoraOut: 1 }] },
    { id: 2, label: 'Линия 2', outputs: [{ type: 'musidora', universe: 0, path: '', musidoraOut: 2 }] },
  ];
  writeLines(a.dir, lines);
  const back = readLines(a.dir);
  check('линии сохранились в папке объекта', back.universes.length === 2 && back.tickMs === 25);
  check('у соседнего объекта линии свои', readLines(b.dir).universes.length === 1);
  const broken = path.join(root, 'Битый');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, LINES_FILE), '{это не json');
  check('битый lines.json не роняет чтение', readLines(broken).universes.length === 1);

  /*
   * Линия без `outputs` роняла движок на `u.outputs.map(...)` — то есть шоу на
   * объекте останавливалось из-за одного неполного поля в файле, который лежит
   * в папке объекта и правится руками. Такие линии не применяем.
   */
  const noOuts = path.join(root, 'Без выходов');
  fs.mkdirSync(noOuts, { recursive: true });
  fs.writeFileSync(path.join(noOuts, LINES_FILE), JSON.stringify({ tickMs: 50, universes: [{ id: 1, label: 'Битая' }] }));
  check('линия без выходов заменяется рабочей по умолчанию', readLines(noOuts).universes[0]?.outputs?.length === 1);
  check('линия без выходов признана негодной', !linesUsable([{ id: 1, label: 'Битая' }]));
  check('пустой список линий негоден', !linesUsable([]));
  check('повторяющиеся номера линий негодны', !linesUsable([...defaultLines().universes, ...defaultLines().universes]));
  check('нормальные линии годны', linesUsable(defaultLines().universes));
}

// ---- «Сохранить как»: копия объекта под новым именем -------------------------
{
  fs.mkdirSync(path.join(a.dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'logs', '2026-09-17.jsonl'), '{"t":1}\n');
  fs.mkdirSync(path.join(a.dir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'backups', 'снимок.json'), '{}');
  fs.writeFileSync(path.join(a.audioDir, 'марш.wav'), 'звук');

  const dup = copyProject(a.dir, root, 'Новороссийск — вариант 2');
  check('копия создана отдельной папкой', isProjectDir(dup.dir) && dup.dir !== a.dir);
  check('в копии те же линии', readLines(dup.dir).tickMs === 25 && readLines(dup.dir).universes.length === 2);
  check('музыка скопирована', fs.existsSync(path.join(dup.audioDir, 'марш.wav')));
  const dupName = (JSON.parse(fs.readFileSync(dup.projectFile, 'utf8')) as { name: string }).name;
  check('у копии новое имя объекта', dupName === 'Новороссийск — вариант 2', dupName);
  const dupMarker = fs.readdirSync(dup.dir).filter((f) => f.endsWith(MARKER_EXT));
  check('ярлык в копии один и с новым именем', dupMarker.length === 1 && dupMarker[0] === `Новороссийск — вариант 2${MARKER_EXT}`);
  // Журнал и бэкапы — история ИСХОДНОГО объекта, в копии она врала бы.
  check('журнал в копию не уехал', fs.readdirSync(path.join(dup.dir, 'logs')).length === 0);
  check('бэкапы в копию не уехали', !fs.existsSync(path.join(dup.dir, 'backups')));
  check('исходный объект не тронут', fs.existsSync(path.join(a.dir, 'logs', '2026-09-17.jsonl')));

  // Копия под ЗАНЯТЫМ именем — папка получает «2», и имя внутри файла должно
  // совпасть с ней же, а не с запрошенным именем дословно (та же причина,
  // что и у createProject выше).
  const dup2 = copyProject(a.dir, root, 'Новороссийск — вариант 2');
  check('копия с занятым именем получила свою папку', path.basename(dup2.dir) === 'Новороссийск — вариант 2 2', path.basename(dup2.dir));
  const dup2Name = (JSON.parse(fs.readFileSync(dup2.projectFile, 'utf8')) as { name: string }).name;
  check('и имя в файле совпадает с папкой', dup2Name === path.basename(dup2.dir), dup2Name);
}

// ---- Папку можно скопировать и открыть как есть ------------------------------
{
  const copy = path.join(tmp, 'Перенос', 'Новороссийск');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.cpSync(a.dir, copy, { recursive: true });
  check('копия папки опознаётся как проект', isProjectDir(copy));
  check('в копии те же линии', readLines(copy).tickMs === 25);
  const p = JSON.parse(fs.readFileSync(path.join(copy, PROJECT_FILE), 'utf8')) as { name: string };
  check('в копии то же имя объекта', p.name === 'Новороссийск');
}

// ---- Недавние проекты ------------------------------------------------------
{
  rememberOpened(appData, a.dir, 'Новороссийск');
  rememberOpened(appData, b.dir, 'Новороссийск 2');
  const s = readAppSettings(appData);
  check('последний открытый — первый в списке', s.recent[0]?.dir === b.dir, s.recent[0]?.dir);
  check('оба объекта в списке', s.recent.length === 2);
  check('запомнен последний открытый', s.lastProjectDir === b.dir);

  rememberOpened(appData, a.dir, 'Новороссийск');
  const s2 = readAppSettings(appData);
  check('повторное открытие не плодит дубли', s2.recent.length === 2, String(s2.recent.length));
  check('и поднимает объект наверх', s2.recent[0]?.dir === a.dir);

  for (let i = 0; i < MAX_RECENT + 5; i++) rememberOpened(appData, path.join(root, `Объект ${i}`), `Объект ${i}`);
  check(`список недавних не длиннее ${MAX_RECENT}`, readAppSettings(appData).recent.length === MAX_RECENT);

  const dropped = readAppSettings(appData).recent[0]!.dir;
  forgetRecent(appData, dropped);
  check('объект убирается из списка', !readAppSettings(appData).recent.some((r) => r.dir === dropped));
}

// ---- Переезд со старого расклада -------------------------------------------
{
  const legacy = path.join(tmp, 'Старый');
  fs.mkdirSync(path.join(legacy, 'audio'), { recursive: true });
  const old = sanitizeProject({ ...JSON.parse(fs.readFileSync(a.projectFile, 'utf8')), name: 'Севастополь 60 лет' });
  fs.writeFileSync(path.join(legacy, 'fountain.project.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(legacy, 'audio', 'track.wav'), 'звук');
  const cfg = path.join(legacy, 'fountain.config.json');
  fs.writeFileSync(
    cfg,
    JSON.stringify({
      timing: { tickMs: 40 },
      universes: [{ id: 1, label: 'Старая линия', outputs: [{ type: 'artnet', host: '10.0.0.5', universe: 0 }] }],
      backup: { enabled: false, intervalMin: 30 },
    }),
  );

  const moved = migrateLegacyProject(cfg, root);
  check('старый проект перенесён', !!moved && isProjectDir(moved.dir));
  if (moved) {
    check('имя объекта сохранилось', path.basename(moved.dir) === 'Севастополь 60 лет', path.basename(moved.dir));
    const lines = readLines(moved.dir);
    check('линии перенесены из старого конфига', lines.universes[0]?.outputs[0]?.type === 'artnet' && lines.tickMs === 40);
    check('настройка бэкапов перенесена', lines.backup.intervalMin === 30 && lines.backup.enabled === false);
    check('музыка перенесена', fs.existsSync(path.join(moved.audioDir, 'track.wav')));
    check('исходные файлы остались на месте', fs.existsSync(path.join(legacy, 'fountain.project.json')));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`проекты: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
