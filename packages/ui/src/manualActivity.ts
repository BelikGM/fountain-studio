/**
 * Последнее РУЧНОЕ вмешательство — фейдер на Отладке, проверка прибора в 3D.
 *
 * Статус-бар до сих пор отвечал только за воспроизведение: играет шоу или нет.
 * Но фонтан может работать и без всякого шоу — оператор поднял насос фейдером
 * или проверяет прибор в 3D. Тогда внизу честно писалось «воспроизведение
 * остановлено», хотя вода льётся и свет горит, и это сбивало с толку.
 *
 * Отдельный крошечный модуль, а не состояние в App: отметку ставят места,
 * которые к App никак не привязаны, и тянуть через них колбэк ради одной
 * строчки не за что.
 */

export type ManualWhere = 'console' | 'layout';

export interface ManualActivity {
  where: ManualWhere;
  /** Что именно тронули — короткой строкой для статус-бара. */
  what: string;
  atMs: number;
}

let last: ManualActivity | null = null;
const subs = new Set<(a: ManualActivity) => void>();

/**
 * Как часто сообщаем подписчикам, мс.
 *
 * Отметку ставит КАЖДОЕ движение пальцем по фейдеру, а в 3D — ещё и каждый
 * канал каждого прибора в наборе: «все насосы» на пятидесяти форсунках давали
 * полсотни вызовов на одно движение мыши. Подписчик у отметки один — строка
 * состояния внизу, и мерит она минуты. Пока сообщали сразу, эта строка
 * перерисовывала ВСЁ приложение по нескольку тысяч раз в секунду, и ползунки
 * на «Отладке» ехали рывками.
 */
const NOTIFY_MS = 1000;
let notifiedAtMs = 0;
let notifyTimer: number | undefined;

function notify(): void {
  notifiedAtMs = Date.now();
  notifyTimer = undefined;
  if (last) for (const fn of subs) fn(last);
}

export function noteManual(where: ManualWhere, what: string): void {
  last = { where, what, atMs: Date.now() };
  if (notifyTimer !== undefined) return;
  const waitMs = NOTIFY_MS - (Date.now() - notifiedAtMs);
  if (waitMs <= 0) notify();
  // Хвост: последнее вмешательство не должно потеряться, если человек
  // отпустил ползунок сразу после предыдущего сообщения.
  else notifyTimer = setTimeout(notify, waitMs) as unknown as number;
}

export function lastManual(): ManualActivity | null {
  return last;
}

export function subscribeManual(fn: (a: ManualActivity) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
