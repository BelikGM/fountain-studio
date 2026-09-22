/**
 * Самопроверка расписания на ПРЫЖКАХ ЧАСОВ.
 *
 * Планировщик ждёт точного совпадения секунды, сверяясь с часами дважды в
 * секунду. Но часы прыгают: перевод на зимнее/летнее время (в РФ его нет, но
 * программа поедет и туда, где есть), сверка времени по интернету после
 * долгого простоя, выход компьютера из сна. При прыжке вперёд нужной секунды
 * просто не бывает — вечерняя запись «21:00» не срабатывала вовсе. При
 * переводе назад та же запись, наоборот, приходит второй раз.
 *
 * Здесь часы подставляем руками: планировщику всё равно, откуда Date.
 *
 * Запуск: npm -w @fountain-studio/engine run schedule-test
 */
import { sanitizeProject, type Schedule } from '@fountain-studio/shared';
import { eventLog } from '../eventlog';
import { Scheduler } from '../schedule';
import type { Engine } from '../engine';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

/** Что планировщик попросил у движка — нам важен только сам факт и чего. */
interface Call {
  what: string;
  id: string;
}

function fakeEngine(calls: Call[]): Engine {
  const noop = (): void => {};
  return {
    takeOverForSchedule: noop,
    setDark: (mode: string | null) => calls.push({ what: 'dark', id: String(mode) }),
    playPlaylist: (id: string) => calls.push({ what: 'playlist', id }),
    playShow: (id: string) => calls.push({ what: 'show', id }),
    startSequence: (id: string) => calls.push({ what: 'sequence', id }),
    startSequenceGroup: (id: string) => calls.push({ what: 'group', id }),
    setScene: (id: string) => calls.push({ what: 'scene', id }),
  } as unknown as Engine;
}

/** Расписание: утренняя сцена, вечерний плейлист и ночной стоп. */
function schedules(): Schedule[] {
  const p = sanitizeProject({
    name: 'Проверка часов',
    scenes: [{ id: 'sc1', name: 'День', values: {} }],
    playlists: [{ id: 'pl1', name: 'Вечер', mode: 'once', items: [] }],
    shows: [{ id: 'sh1', name: 'Салют', durationMs: 60_000, tracks: [], cuts: [] }],
    schedules: [
      {
        id: 'sch1',
        name: 'Будни',
        enabled: true,
        entries: [
          { id: 'e-day', name: 'День', time: '10:00', days: [], enabled: true, blackoutSec: 0, action: { type: 'scene', refId: 'sc1' } },
          { id: 'e-eve', name: 'Вечер', time: '21:00', days: [], enabled: true, blackoutSec: 3, action: { type: 'playlist', refId: 'pl1' } },
          { id: 'e-show', name: 'Салют', time: '22:00', days: [], enabled: true, blackoutSec: 0, action: { type: 'show', refId: 'sh1' } },
          { id: 'e-off', name: 'Ночь', time: '23:00', days: [], enabled: true, blackoutSec: 0, action: { type: 'stopAll' } },
        ],
      },
    ],
  } as never);
  return p.schedules;
}

const at = (h: number, m: number, s = 0): Date => new Date(2026, 9, 25, h, m, s);

/** Прогон: подставляем часы по списку и смотрим, что попросили у движка. */
function run(times: Date[]): { calls: Call[]; log: string[] } {
  const calls: Call[] = [];
  const log: string[] = [];
  const off = eventLog.subscribe((e) => {
    if (e.source === 'schedule') log.push(e.message);
  });
  const sched = new Scheduler(fakeEngine(calls), schedules);
  for (const t of times) sched.check(t);
  sched.stop();
  off();
  return { calls, log };
}

// ---- Обычный ход часов: ничего не меняется --------------------------------
{
  const { calls, log } = run([at(20, 59, 59), at(21, 0, 0), at(21, 0, 0), at(21, 0, 1)]);
  check('запись сработала ровно в своё время', calls.some((c) => c.what === 'dark' && c.id === 'transition'), JSON.stringify(calls));
  check('в свою минуту только один раз', calls.filter((c) => c.what === 'dark' && c.id === 'transition').length === 1);
  check('про часы в журнале ни слова', !log.some((m) => m.includes('часы')), log.join(' | '));
}

// ---- Часы ушли вперёд через время записи -----------------------------------
{
  // Сверка времени по интернету: 20:59:58 → 21:00:07, секунды 21:00:00 не было.
  const { calls, log } = run([at(20, 59, 58), at(21, 0, 7)]);
  check('пропущенный вечерний плейлист догнан', calls.some((c) => c.what === 'playlist' && c.id === 'pl1'), JSON.stringify(calls));
  check('догон — без гашения перехода', !calls.some((c) => c.what === 'dark' && c.id === 'transition'), JSON.stringify(calls));
  check('в журнале сказано про часы', log.some((m) => m.includes('часы ушли вперёд') && m.includes('догоняем')), log.join(' | '));
}

// ---- Компьютер спал: прыжок через несколько записей -------------------------
{
  // Уснул в 20:30, проснулся в 23:30: пропущены 21:00, 22:00 и 23:00.
  const { calls } = run([at(20, 30), at(23, 30)]);
  check('после сна включается ПОСЛЕДНЯЯ пропущенная запись', calls.length > 0 && calls[calls.length - 1]!.what === 'dark' && calls[calls.length - 1]!.id === 'off', JSON.stringify(calls));
  check('промежуточные записи не гоняются подряд', !calls.some((c) => c.what === 'playlist'), JSON.stringify(calls));
}

// ---- Одиночное шоу после долгого прыжка заново не поднимаем -----------------
{
  // Уснул в 21:30, проснулся в 22:40: последнее пропущенное — шоу в 22:00.
  const { calls, log } = run([at(21, 30), at(22, 40)]);
  check('шоу после долгого прыжка не запускается', !calls.some((c) => c.what === 'show'), JSON.stringify(calls));
  check('в журнале объяснено, почему шоу пропущено', log.some((m) => m.includes('шоу заново не запускаем')), log.join(' | '));
}

// ---- Короткий прыжок через шоу: шоу всё-таки запускаем ----------------------
{
  const { calls } = run([at(21, 59, 58), at(22, 0, 6)]);
  check('шоу запускается, если прыжок короткий', calls.some((c) => c.what === 'show' && c.id === 'sh1'), JSON.stringify(calls));
}

// ---- Часы перевели назад: второй раз не запускаем ---------------------------
{
  // Осенний перевод: 22:30 → 21:30. Запись 22:00 уже отрабатывала.
  const { calls, log } = run([at(22, 30), at(21, 30), at(22, 0, 0)]);
  check('запись после перевода назад повторно не идёт', !calls.some((c) => c.what === 'show'), JSON.stringify(calls));
  check('в журнале сказано про перевод назад', log.some((m) => m.includes('часы перевели назад')), log.join(' | '));
  check('в журнале названы пропущенные записи', log.some((m) => m.includes('22:00')), log.join(' | '));
}

// ---- Перевод назад не глушит записи, до которых дело ещё не дошло ------------
{
  // 22:30 → 21:30, а дальше время идёт: 23:00 должно сработать как обычно.
  const { calls } = run([at(22, 30), at(21, 30), at(22, 59, 59), at(23, 0, 0)]);
  check('следующая по ходу запись работает как обычно', calls.some((c) => c.what === 'dark' && c.id === 'off'), JSON.stringify(calls));
}

// ---- Мелкая заминка ПК — не повод писать в журнал ---------------------------
{
  const { log } = run([at(12, 0, 0), at(12, 0, 30)]);
  check('заминка в полминуты журнал не засоряет', log.length === 0, log.join(' | '));
}

console.log(`расписание и прыжки часов: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
