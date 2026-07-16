/** Размер вселенной DMX512 — 512 адресов (каналов). */
export const DMX_UNIVERSE_SIZE = 512;

/** Максимальное значение канала DMX. */
export const DMX_MAX_VALUE = 255;

/** Ограничение значения канала диапазоном 0–255. */
export function clampDmx(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(DMX_MAX_VALUE, Math.round(value)));
}
