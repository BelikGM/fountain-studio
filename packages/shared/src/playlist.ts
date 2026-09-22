/**
 * Плейлисты и расписание.
 *
 * Плейлист — последовательность шоу с паузами между ними; исполняет движок
 * автономно (мастер-часы — тик движка, аудио — системный плеер ffplay, если
 * доступен). Расписание — запуск действий по системному времени ПК; работает,
 * пока запущен движок (для автономности движок ставится службой с watchdog).
 */

export interface PlaylistItem {
  showId: string;
  /** Пауза после этого шоу до следующего, мс. */
  gapMs: number;
}

export type PlaylistMode = 'once' | 'loop';

/**
 * Поведение при запуске плейлиста (§27 доработки, по примеру прежнего
 * приложения) — 'restart' (умолчание) начинает с первого пункта, 'resume'
 * продолжает с пункта, на котором плейлист был остановлен в прошлый раз.
 * Место хранится в папке объекта (playlist-positions.json), а не в проекте, —
 * и переживает перезапуск движка (до 23.09.2026 жило только в памяти).
 */
export type PlaylistStartMode = 'restart' | 'resume';

export interface Playlist {
  id: string;
  name: string;
  mode: PlaylistMode;
  onStart: PlaylistStartMode;
  items: PlaylistItem[];
}

export function sanitizePlaylists(raw: unknown, showIds: Set<string>): Playlist[] {
  if (!Array.isArray(raw)) return [];
  const out: Playlist[] = [];
  for (const p of raw as Playlist[]) {
    if (!p || typeof p.id !== 'string') continue;
    out.push({
      id: p.id,
      name: typeof p.name === 'string' ? p.name : 'Плейлист',
      mode: p.mode === 'loop' ? 'loop' : 'once',
      onStart: p.onStart === 'resume' ? 'resume' : 'restart',
      items: (Array.isArray(p.items) ? p.items : [])
        .filter((it) => it && showIds.has(it.showId))
        .map((it) => ({
          showId: it.showId,
          gapMs: Number.isFinite(it.gapMs) ? Math.max(0, Math.round(it.gapMs)) : 0,
        })),
    });
  }
  return out;
}

/**
 * Действие записи расписания.
 *
 * Запись — это ПЕРЕХОД, а не «запусти ещё одно» (так устроено и в FontanPlay:
 * строки расписания переключают режимы). То, что играло до неё,
 * останавливается, ручные правки с «Отладки» сбрасываются, и играет новое.
 * Раньше запись добавляла действие к уже идущему, и в 20:00 вода дневного
 * макроса смешивалась с шоу по правилу «кто больше».
 *
 *  · stopAll — «Стоп»: гаснет ВСЁ — программы, сцена покоя, служебный свет,
 *              ручные ползунки — до следующего запуска (записью расписания или
 *              руками). Заказчик 23.09.2026: «стоп тушит всё, никакой паузы и
 *              продолжить». До этого были отдельно «Пауза», «Стоп — в покой» и
 *              «Выключить» — разница между ними только путала.
 */
export type ScheduleAction =
  | { type: 'playlist'; refId: string }
  | { type: 'show'; refId: string }
  | { type: 'sequence'; refId: string }
  | { type: 'sequenceGroup'; refId: string }
  | { type: 'scene'; refId: string }
  | { type: 'stopAll' };

export function isScheduleProgram(a: ScheduleAction): a is Extract<ScheduleAction, { refId: string }> {
  return 'refId' in a;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  enabled: boolean;
  /** Дни недели как в Date.getDay(): 0=Вс … 6=Сб. Пустой список — каждый день. */
  days: number[];
  /** Время по системным часам ПК: «ЧЧ:ММ» или «ЧЧ:ММ:СС». */
  time: string;
  action: ScheduleAction;
  /**
   * Переход перед запуском: 0 — сразу (прежнее гаснет, новое начинается в тот
   * же миг); больше нуля — на столько секунд гасим всё (0 на все адреса), и
   * только потом запускаем. Нужен, когда в новом макросе участвует всё
   * оборудование и прыжок «с картины на картину» некрасив или вреден насосам.
   */
  blackoutSec: number;
}

/**
 * Расписание целиком. Их может быть несколько («Будни», «Выходные», «Зима»),
 * у каждого галочка «активно». Срабатывают записи только активных.
 */
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  entries: ScheduleEntry[];
}

export const SCHEDULE_BLACKOUT_MAX_SEC = 60;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

interface ScheduleRefIds {
  playlists: Set<string>;
  shows: Set<string>;
  sequences: Set<string>;
  sequenceGroups: Set<string>;
  scenes: Set<string>;
}

export function sanitizeScheduleEntries(raw: unknown, ids: ScheduleRefIds): ScheduleEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleEntry[] = [];
  for (const e of raw as ScheduleEntry[]) {
    if (!e || typeof e.id !== 'string' || typeof e.time !== 'string' || !TIME_RE.test(e.time)) continue;
    const a = e.action;
    if (!a) continue;
    let action: ScheduleAction | null = null;
    // «Пауза» и «Выключить» жили один день (22.09.2026) — теперь это «Стоп».
    const t = a.type as string;
    if (t === 'stopAll' || t === 'pause' || t === 'off') action = { type: 'stopAll' };
    else if (a.type === 'playlist' && ids.playlists.has(a.refId)) action = { type: 'playlist', refId: a.refId };
    else if (a.type === 'show' && ids.shows.has(a.refId)) action = { type: 'show', refId: a.refId };
    else if (a.type === 'sequence' && ids.sequences.has(a.refId)) action = { type: 'sequence', refId: a.refId };
    else if (a.type === 'sequenceGroup' && ids.sequenceGroups.has(a.refId))
      action = { type: 'sequenceGroup', refId: a.refId };
    else if (a.type === 'scene' && ids.scenes.has(a.refId)) action = { type: 'scene', refId: a.refId };
    if (!action) continue;
    const bo = Number(e.blackoutSec);
    out.push({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : '',
      enabled: e.enabled !== false,
      days: (Array.isArray(e.days) ? e.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      time: e.time,
      action,
      blackoutSec: Number.isFinite(bo) ? Math.max(0, Math.min(SCHEDULE_BLACKOUT_MAX_SEC, Math.round(bo))) : 0,
    });
  }
  return out;
}

/**
 * Расписания объекта. До 22.09.2026 расписание было одно и лежало списком
 * записей в project.schedule — такие объекты открываются с одним активным
 * расписанием «Основное».
 */
export function sanitizeSchedules(raw: unknown, legacy: unknown, ids: ScheduleRefIds): Schedule[] {
  if (Array.isArray(raw)) {
    const out: Schedule[] = [];
    for (const s of raw as Schedule[]) {
      if (!s || typeof s.id !== 'string') continue;
      out.push({
        id: s.id,
        name: typeof s.name === 'string' && s.name.trim() !== '' ? s.name : 'Расписание',
        enabled: s.enabled !== false,
        entries: sanitizeScheduleEntries(s.entries, ids),
      });
    }
    if (out.length > 0) return out;
  }
  return [{ id: 'main', name: 'Основное', enabled: true, entries: sanitizeScheduleEntries(legacy, ids) }];
}

// ── Время, коллизии, «что должно идти сейчас» ──────────────────────────────

/** Секунда суток записи: «22:00» и «22:00:00» — одно и то же время. */
export function scheduleSecondOfDay(time: string): number {
  const [h, m, s] = time.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

function daysOverlap(a: number[], b: number[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((d) => b.includes(d));
}

export interface ScheduleCollision {
  /** Запись, с которой совпало время. */
  otherId: string;
  otherScheduleName: string;
  /** true — эта запись «выигрывает» (она раньше в списке), false — не сработает. */
  wins: boolean;
}

/**
 * Записи, которые сработали бы в одну и ту же секунду в один и тот же день
 * (в том числе из разных активных расписаний). Так быть не должно: «в 22:00
 * включить макрос» и «в 22:00 выключить» — непонятно, что имелось в виду. В
 * интерфейсе такие строки красные; движок в этом случае исполняет только
 * первую по порядку (расписания сверху вниз, записи сверху вниз) и пишет о
 * второй в журнал.
 */
export function findScheduleCollisions(schedules: Schedule[]): Map<string, ScheduleCollision[]> {
  const flat: { e: ScheduleEntry; s: Schedule; order: number }[] = [];
  let order = 0;
  for (const s of schedules) {
    if (!s.enabled) continue;
    for (const e of s.entries) if (e.enabled) flat.push({ e, s, order: order++ });
  }
  const out = new Map<string, ScheduleCollision[]>();
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i]!;
      const b = flat[j]!;
      if (scheduleSecondOfDay(a.e.time) !== scheduleSecondOfDay(b.e.time)) continue;
      if (!daysOverlap(a.e.days, b.e.days)) continue;
      (out.get(a.e.id) ?? out.set(a.e.id, []).get(a.e.id)!).push({ otherId: b.e.id, otherScheduleName: b.s.name, wins: true });
      (out.get(b.e.id) ?? out.set(b.e.id, []).get(b.e.id)!).push({ otherId: a.e.id, otherScheduleName: a.s.name, wins: false });
    }
  }
  return out;
}

/** Записи активных расписаний по порядку: сначала расписания, внутри — записи. */
export function activeScheduleEntries(schedules: Schedule[]): { entry: ScheduleEntry; schedule: Schedule }[] {
  const out: { entry: ScheduleEntry; schedule: Schedule }[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    for (const e of s.entries) if (e.enabled) out.push({ entry: e, schedule: s });
  }
  return out;
}

/**
 * Записи, время которых попало в промежуток (from; to] — по дням недели, как
 * они и срабатывают. Нужно, когда часы ПРЫГНУЛИ: перевод часов, сверка по
 * интернету, выход из сна, оживший после простоя компьютер. Планировщик
 * сверяется с часами дважды в секунду и ждёт точного совпадения секунды, а при
 * прыжке этой секунды просто не бывает — без этого вечерняя программа не
 * запускалась вовсе, и узнавали об этом от зрителей.
 *
 * Промежуток дальше недели не смотрим: это уже не прыжок часов, а другой день.
 */
export function scheduleEntriesInWindow(
  schedules: Schedule[],
  from: Date,
  to: Date,
): { entry: ScheduleEntry; schedule: Schedule; at: Date }[] {
  const out: { entry: ScheduleEntry; schedule: Schedule; at: Date }[] = [];
  if (to.getTime() <= from.getTime()) return out;
  const days = Math.min(8, Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 2);
  for (const { entry, schedule } of activeScheduleEntries(schedules)) {
    const sec = scheduleSecondOfDay(entry.time);
    for (let d = 0; d < days; d++) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + d);
      const at = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Math.floor(sec / 3600),
        Math.floor((sec % 3600) / 60),
        sec % 60,
      );
      if (at.getTime() <= from.getTime() || at.getTime() > to.getTime()) continue;
      if (entry.days.length > 0 && !entry.days.includes(at.getDay())) continue;
      out.push({ entry, schedule, at });
    }
  }
  // По времени, а при совпадении — в порядке расписаний, как в движке.
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * Последняя запись, которая должна была сработать до `now` (смотрим неделю
 * назад). Это «что должно идти сейчас» — по ней движок после перезапуска
 * посреди дня возвращает дневную программу, а не ждёт следующей записи.
 */
export function lastDueScheduleEntry(
  schedules: Schedule[],
  now: Date,
): { entry: ScheduleEntry; schedule: Schedule; at: Date } | null {
  const list = activeScheduleEntries(schedules);
  let best: { entry: ScheduleEntry; schedule: Schedule; at: Date } | null = null;
  for (const { entry, schedule } of list) {
    const sec = scheduleSecondOfDay(entry.time);
    for (let d = 0; d <= 7; d++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60);
      if (at.getTime() > now.getTime()) continue;
      if (entry.days.length > 0 && !entry.days.includes(at.getDay())) continue;
      // Первая по порядку выигрывает и при равном времени — как в движке.
      if (!best || at.getTime() > best.at.getTime()) best = { entry, schedule, at };
      break;
    }
  }
  return best;
}
