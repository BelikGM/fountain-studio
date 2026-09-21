/**
 * Эффект плавности на дорожках шоу и на секвенсорах: резкий перепад значения
 * превращается в переход. Режимы: без сглаживания; плавно вверх и вниз; плавно
 * только вниз (рост мгновенный). Математика — фильтр первого порядка, та же, что
 * у инерции струи в 3D и у сглаживания джиттера тикера.
 *
 * ── Шкала «плавность 1…100» ─────────────────────────────────────────────
 * Больше — плавнее: плавность N — это переход примерно за N/10 секунды,
 * от 0,1 с при 1 до 10 с при 100. Каждая единица — десятая доля секунды.
 *
 * Так сделано 22.09.2026 по просьбе заказчика. Раньше шкала была «сила» и шла
 * наоборот: 1 — самый плавный (≈ 11 с), 100 — почти мгновенно. Для человека
 * это перевёрнуто: «сила плавности 100» должна быть самой плавной. А сами
 * 11 секунд ни из чего не следовали: постоянная времени при силе 1 была взята
 * 2 с произвольно, и 11 с получались как 2 с × ln 255. Теперь верх шкалы — ровно
 * 10 с, и число на поле само говорит время.
 *
 * Старые проекты хранили `strength`; при загрузке он переводится в
 * `smoothness` по тому же времени перехода (legacyStrengthToSmoothness), так
 * что готовые шоу звучат и выглядят как прежде.
 */
export type EffectMode = 'quick' | 'rate' | 'decay';

/** Границы шкалы плавности. */
export const SMOOTHNESS_MIN = 1;
export const SMOOTHNESS_MAX = 100;
/** Для новой зоны — переход примерно за секунду. */
export const SMOOTHNESS_DEFAULT = 10;

export interface TrackEffect {
  id: string;
  startMs: number;
  endMs: number;
  mode: 'rate' | 'decay';
  /** 1…100 — больше плавнее: переход примерно за smoothness/10 секунды. */
  smoothness: number;
}

/**
 * «Практически дошло» — в пределах одной единицы DMX из 255. Фильтр подходит к
 * цели асимптотически и формально не доходит никогда; ln(255) ≈ 5,5 постоянных
 * времени — это и есть «практически».
 */
const REACH_TAUS = Math.log(255);

export function clampSmoothness(v: number): number {
  return Math.max(SMOOTHNESS_MIN, Math.min(SMOOTHNESS_MAX, Math.round(v)));
}

/** За сколько секунд значение практически доходит до цели при этой плавности. */
export function smoothReachSec(smoothness: number): number {
  return clampSmoothness(smoothness) / 10;
}

/**
 * Один шаг фильтра: prev — предыдущее сглаженное значение, target — куда идём
 * в этом тике, dtMs — время с предыдущего тика.
 */
export function smoothStep(prev: number, target: number, mode: EffectMode, smoothness: number, dtMs: number): number {
  if (mode === 'quick') return target;
  if (mode === 'decay' && target >= prev) return target; // рост — всегда мгновенно
  if (dtMs <= 0) return prev;
  const tauMs = (smoothReachSec(smoothness) * 1000) / REACH_TAUS;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return prev + (target - prev) * k;
}

/**
 * Старая «сила» (1…100, больше — БЫСТРЕЕ, постоянная времени 2000/сила мс) →
 * новая плавность с тем же временем перехода. Сила 1 (≈ 11 с) упирается в
 * верх новой шкалы — 10 с.
 */
export function legacyStrengthToSmoothness(strength: number): number {
  const s = Math.max(1, Math.min(100, strength));
  const reachSec = (REACH_TAUS * 2000) / s / 1000;
  return clampSmoothness(reachSec * 10);
}

/**
 * Плавность из сохранённого проекта: новое поле, а если его нет — перевод из
 * старой «силы». Ни того ни другого — значение для новой зоны.
 */
export function smoothnessFromSaved(raw: { smoothness?: unknown; strength?: unknown }): number {
  const sm = Number(raw.smoothness);
  if (raw.smoothness !== undefined && Number.isFinite(sm)) return clampSmoothness(sm);
  const st = Number(raw.strength);
  if (raw.strength !== undefined && Number.isFinite(st)) return legacyStrengthToSmoothness(st);
  return SMOOTHNESS_DEFAULT;
}

/** Зона эффекта, покрывающая tMs, или null — эффекта здесь нет. */
export function activeEffectAt(effects: TrackEffect[], tMs: number): TrackEffect | null {
  for (const e of effects) {
    if (tMs >= e.startMs && tMs < e.endMs) return e;
  }
  return null;
}
