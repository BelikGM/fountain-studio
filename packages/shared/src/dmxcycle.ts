/**
 * Измерение периода цикла T захваченного DMX-потока (§17 п.1: у готовой сцены
 * с внешнего источника цикл повторяется — зная T, её можно корректно завести
 * в секвенсор). Чистая функция над записанными кадрами — тестируется на
 * синтетике, движок применяет её к кольцевому буферу захвата.
 */

export interface CapturedFrame {
  atMs: number;
  data: Uint8Array;
}

export interface CycleMeasurement {
  /** Найденный период цикла, мс; null — не найден (мало данных или нет повторения). */
  periodMs: number | null;
  /** 0..1: насколько провал самоподобия на периоде глубже среднего уровня. */
  confidence: number;
  /** Сколько секунд записи участвовало в измерении. */
  analyzedMs: number;
}

/**
 * Ищет lag, при котором кадры максимально совпадают сами с собой (минимум
 * средней разности |f(t) − f(t+lag)|). Кадры пересэмплируются на равномерную
 * сетку gridMs; сравниваются только «живые» адреса (менявшиеся за запись) —
 * это сокращает работу на порядки и убирает шум мёртвых каналов.
 */
export function measureCyclePeriodMs(
  frames: CapturedFrame[],
  opts: { minPeriodMs?: number; maxPeriodMs?: number; gridMs?: number } = {},
): CycleMeasurement {
  const minPeriod = opts.minPeriodMs ?? 500;
  const maxPeriod = opts.maxPeriodMs ?? 120_000;
  const gridMs = opts.gridMs ?? 100;
  if (frames.length < 4) return { periodMs: null, confidence: 0, analyzedMs: 0 };

  const t0 = frames[0]!.atMs;
  const t1 = frames[frames.length - 1]!.atMs;
  const analyzedMs = t1 - t0;
  // Для уверенного вывода нужно видеть минимум два периода.
  if (analyzedMs < minPeriod * 2) return { periodMs: null, confidence: 0, analyzedMs };

  // Живые адреса: значение менялось хоть раз.
  const first = frames[0]!.data;
  const active: number[] = [];
  const len = first.length;
  outer: for (let a = 0; a < len; a++) {
    const v = first[a]!;
    for (let f = 1; f < frames.length; f++) {
      if (frames[f]!.data[a] !== v) {
        active.push(a);
        continue outer;
      }
    }
  }
  if (active.length === 0) return { periodMs: null, confidence: 0, analyzedMs };

  // Равномерная сетка: ближайший кадр не позже узла.
  const steps = Math.floor(analyzedMs / gridMs) + 1;
  const grid: Uint8Array[] = [];
  let fi = 0;
  for (let s = 0; s < steps; s++) {
    const t = t0 + s * gridMs;
    while (fi + 1 < frames.length && frames[fi + 1]!.atMs <= t) fi++;
    grid.push(frames[fi]!.data);
  }

  const lagMin = Math.max(1, Math.round(minPeriod / gridMs));
  const lagMax = Math.min(grid.length - 2, Math.round(Math.min(maxPeriod, analyzedMs / 2) / gridMs));
  if (lagMax < lagMin) return { periodMs: null, confidence: 0, analyzedMs };

  let bestLag = 0;
  let bestDist = Infinity;
  let distSum = 0;
  let distCount = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0;
    let n = 0;
    for (let s = 0; s + lag < grid.length; s++) {
      const fa = grid[s]!;
      const fb = grid[s + lag]!;
      for (const a of active) sum += Math.abs(fa[a]! - fb[a]!);
      n++;
    }
    const d = sum / Math.max(1, n * active.length);
    distSum += d;
    distCount++;
    if (d < bestDist) {
      bestDist = d;
      bestLag = lag;
    }
  }
  const avgDist = distSum / Math.max(1, distCount);
  if (avgDist <= 0) return { periodMs: null, confidence: 0, analyzedMs };
  const confidence = Math.max(0, Math.min(1, (avgDist - bestDist) / avgDist));
  // Провал должен быть заметным, иначе поток не циклится.
  if (confidence < 0.3) return { periodMs: null, confidence, analyzedMs };
  return { periodMs: bestLag * gridMs, confidence, analyzedMs };
}
