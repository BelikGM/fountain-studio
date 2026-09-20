/**
 * Эффекты плавности на треках/секвенсорах (§27 доработки, УХ п.16):
 * Quick — без сглаживания (как сейчас); Rate — экспоненциальное сглаживание
 * в обе стороны, сила 1..100 = скорость схождения к цели; Decay — то же самое,
 * но односторонне: плавно только при уменьшении значения, рост — мгновенно.
 * Та же математика (фильтр 1-го порядка), что уже используют инерция струи
 * форсунки (FountainScene.ts) и джиттер-EMA тикера (clock.ts) — здесь просто
 * применяется к самому DMX-выходу, а не только к превью.
 */
export type EffectMode = 'quick' | 'rate' | 'decay';

export interface TrackEffect {
  id: string;
  startMs: number;
  endMs: number;
  mode: 'rate' | 'decay';
  /** 1..100 — выше сила, быстрее сходится к целевому значению (короче постоянная времени). */
  strength: number;
}

/**
 * Один шаг фильтра: prev — предыдущее сглаженное значение, target — куда идём
 * в этом тике, dtMs — время с предыдущего тика. strength=100 → tau=20мс
 * (почти мгновенно), strength=1 → tau=2000мс (заметно плавно).
 */
export function smoothStep(prev: number, target: number, mode: EffectMode, strength: number, dtMs: number): number {
  if (mode === 'quick') return target;
  if (mode === 'decay' && target >= prev) return target; // рост — всегда мгновенно
  if (dtMs <= 0) return prev;
  const s = Math.max(1, Math.min(100, strength));
  const tauMs = 2000 / s;
  const k = 1 - Math.exp(-dtMs / tauMs);
  return prev + (target - prev) * k;
}

/**
 * За сколько секунд значение практически доходит до цели при этой силе.
 *
 * Зачем: «сила 1…100» человеку ничего не говорит, а фонтанщик думает в
 * секундах — «пусть гаснет за секунду». Фильтр подходит к цели асимптотически и
 * формально не достигает её никогда, поэтому «практически» здесь — это в
 * пределах одной единицы DMX из 255, то есть ln(255) ≈ 5,5 постоянных времени.
 *
 * Сверено с прогоном по тикам: сила 10 → 1,1 с (прогон дал 1,15), сила 1 →
 * 11,1 с (прогон 11,10).
 */
export function smoothReachSec(strength: number): number {
  const s = Math.max(1, Math.min(100, strength));
  return Math.round((Math.log(255) * (2000 / s)) / 100) / 10;
}

/** Зона эффекта, покрывающая tMs, или null — эффекта здесь нет (обычный Quick). */
export function activeEffectAt(effects: TrackEffect[], tMs: number): TrackEffect | null {
  for (const e of effects) {
    if (tMs >= e.startMs && tMs < e.endMs) return e;
  }
  return null;
}
