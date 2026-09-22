/**
 * Склонение по числу: plural(3, 'адрес', 'адреса', 'адресов') → «адреса».
 *
 * Зачем: в интерфейсе были «адрес(ов)» и «адр.» — так пишут, когда лень
 * склонять, а читается как недоделка.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(Math.trunc(n)) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/**
 * Длительность словами: «8 с», «1 мин 20 с», «1 ч 05 мин». Было «0.2 мин» —
 * с точкой вместо запятой и в минутах для восьмисекундного шоу.
 */
export function durationRu(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} ч ${String(m).padStart(2, '0')} мин`;
  if (m > 0) return s > 0 ? `${m} мин ${s} с` : `${m} мин`;
  return `${s} с`;
}

/**
 * Дробное число по-русски — с запятой: num(19.4, 1) → «19,4». В интерфейсе
 * местами выходило «19.4 м» и «4.0 с»: так пишут в коде, а не в тексте.
 */
export function num(x: number, digits = 1): string {
  return x.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** «3 адреса» — число вместе со словом. */
export function countOf(n: number, one: string, few: string, many: string): string {
  return `${n} ${plural(n, one, few, many)}`;
}
