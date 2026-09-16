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

export function noteManual(where: ManualWhere, what: string): void {
  last = { where, what, atMs: Date.now() };
  for (const fn of subs) fn(last);
}

export function lastManual(): ManualActivity | null {
  return last;
}

export function subscribeManual(fn: (a: ManualActivity) => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
