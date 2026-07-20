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
 * продолжает с пункта, на котором плейлист был остановлен в прошлый раз
 * (движок помнит это в памяти, не в проекте — как и остальное состояние
 * воспроизведения; после перезапуска движка снова начнёт сначала).
 */
export type PlaylistStartMode = 'restart' | 'resume';

export interface Playlist {
  id: string;
  name: string;
  mode: PlaylistMode;
  onStart: PlaylistStartMode;
  items: PlaylistItem[];
}

export type ScheduleAction =
  | { type: 'playlist'; refId: string }
  | { type: 'show'; refId: string }
  | { type: 'sequence'; refId: string }
  | { type: 'scene'; refId: string }
  /** Полный стоп воспроизведения (вечернее выключение фонтана). */
  | { type: 'stopAll' };

export interface ScheduleEntry {
  id: string;
  name: string;
  enabled: boolean;
  /** Дни недели как в Date.getDay(): 0=Вс … 6=Сб. Пустой список — каждый день. */
  days: number[];
  /** Время по системным часам ПК: «ЧЧ:ММ» или «ЧЧ:ММ:СС». */
  time: string;
  action: ScheduleAction;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

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

export function sanitizeSchedule(
  raw: unknown,
  ids: { playlists: Set<string>; shows: Set<string>; sequences: Set<string>; scenes: Set<string> },
): ScheduleEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduleEntry[] = [];
  for (const e of raw as ScheduleEntry[]) {
    if (!e || typeof e.id !== 'string' || typeof e.time !== 'string' || !TIME_RE.test(e.time)) continue;
    const a = e.action;
    if (!a) continue;
    let action: ScheduleAction | null = null;
    if (a.type === 'stopAll') action = { type: 'stopAll' };
    else if (a.type === 'playlist' && ids.playlists.has(a.refId)) action = { type: 'playlist', refId: a.refId };
    else if (a.type === 'show' && ids.shows.has(a.refId)) action = { type: 'show', refId: a.refId };
    else if (a.type === 'sequence' && ids.sequences.has(a.refId)) action = { type: 'sequence', refId: a.refId };
    else if (a.type === 'scene' && ids.scenes.has(a.refId)) action = { type: 'scene', refId: a.refId };
    if (!action) continue;
    out.push({
      id: e.id,
      name: typeof e.name === 'string' ? e.name : '',
      enabled: e.enabled !== false,
      days: (Array.isArray(e.days) ? e.days : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      time: e.time,
      action,
    });
  }
  return out;
}
