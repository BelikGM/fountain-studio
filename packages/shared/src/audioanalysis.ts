/**
 * Аудиоанализ трека для автопостановки шоу (§17 п.5). Чистые функции над PCM-
 * сэмплами (моно Float32 + частота дискретизации) — без Web Audio и внешних
 * библиотек, поэтому считаются и в редакторе (из decodeAudioData, ShowView уже
 * его использует), и в тестах на голых массивах. Результат — черновик: темп,
 * огибающая громкости, доли и тишина; человек дорабатывает на таймлайне.
 *
 * Это НЕ «умная» модель и не обучение на видео (то — отдельный дальний спайк,
 * §17 п.4): простая, детерминированная эвристика по энергии и автокорреляции.
 */

/** Результат анализа энергии по окнам. */
export interface EnergyEnvelope {
  /** Шаг окна, мс. */
  hopMs: number;
  /** RMS-громкость каждого окна, 0..1. */
  rms: number[];
}

/**
 * RMS-громкость по неперекрывающимся окнам hopMs. Значения нормируются к пику
 * (самый громкий кусок трека = 1) — удобно раскладывать в высоту струй.
 */
export function energyEnvelope(samples: Float32Array, sampleRate: number, hopMs = 50): EnergyEnvelope {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const rms: number[] = [];
  for (let start = 0; start < samples.length; start += hop) {
    const end = Math.min(start + hop, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
    rms.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  const peak = rms.reduce((m, v) => (v > m ? v : m), 0);
  if (peak > 0) for (let i = 0; i < rms.length; i++) rms[i] = rms[i]! / peak;
  return { hopMs, rms };
}

/** Огибающая громкости как точки 0–255 для дорожки шоу (§17 п.5: громкость → высота воды). */
export function loudnessEnvelopePoints(
  env: EnergyEnvelope,
  opts: { min?: number; max?: number; gamma?: number } = {},
): { tMs: number; value: number }[] {
  const min = opts.min ?? 0;
  const max = opts.max ?? 255;
  const gamma = opts.gamma ?? 1;
  return env.rms.map((v, i) => ({
    tMs: i * env.hopMs,
    value: Math.round(min + Math.pow(Math.max(0, Math.min(1, v)), gamma) * (max - min)),
  }));
}

/** Границы тишины: отрезки, где RMS ниже порога дольше minSilenceMs. */
export function silenceRanges(
  env: EnergyEnvelope,
  opts: { threshold?: number; minSilenceMs?: number } = {},
): { startMs: number; endMs: number }[] {
  const threshold = opts.threshold ?? 0.05;
  const minSilence = opts.minSilenceMs ?? 400;
  const ranges: { startMs: number; endMs: number }[] = [];
  let runStart = -1;
  for (let i = 0; i <= env.rms.length; i++) {
    const quiet = i < env.rms.length && env.rms[i]! < threshold;
    if (quiet && runStart < 0) runStart = i;
    else if (!quiet && runStart >= 0) {
      const startMs = runStart * env.hopMs;
      const endMs = i * env.hopMs;
      if (endMs - startMs >= minSilence) ranges.push({ startMs, endMs });
      runStart = -1;
    }
  }
  return ranges;
}

export interface TempoResult {
  bpm: number;
  /** Уверенность 0..1 (высота пика автокорреляции относительно среднего). */
  confidence: number;
  /** Позиции долей по найденному темпу, мс (от первого заметного онсета). */
  beatsMs: number[];
}

/**
 * Оценка темпа по автокорреляции функции нарастания энергии (onset envelope).
 * Ищем период в музыкальном диапазоне minBpm..maxBpm; из него получаем BPM и
 * раскладываем сетку долей. Годится для авторазметки под воду/свет — не для
 * точного бит-трекинга (акценты и синкопы человек правит вручную).
 */
export function estimateTempo(
  samples: Float32Array,
  sampleRate: number,
  opts: { minBpm?: number; maxBpm?: number; hopMs?: number } = {},
): TempoResult {
  const minBpm = opts.minBpm ?? 70;
  const maxBpm = opts.maxBpm ?? 180;
  const hopMs = opts.hopMs ?? 10;
  const env = energyEnvelope(samples, sampleRate, hopMs);
  // Onset envelope: положительная разность энергии (нарастание громкости).
  const onset: number[] = [0];
  for (let i = 1; i < env.rms.length; i++) {
    onset.push(Math.max(0, env.rms[i]! - env.rms[i - 1]!));
  }
  const mean = onset.reduce((s, v) => s + v, 0) / Math.max(1, onset.length);
  const centered = onset.map((v) => v - mean);

  const lagMin = Math.round(60000 / maxBpm / hopMs);
  const lagMax = Math.round(60000 / minBpm / hopMs);
  let bestLag = 0;
  let bestScore = -Infinity;
  let scoreSum = 0;
  let scoreCount = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0;
    for (let i = lag; i < centered.length; i++) sum += centered[i]! * centered[i - lag]!;
    scoreSum += sum;
    scoreCount++;
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return { bpm: 0, confidence: 0, beatsMs: [] };

  const avgScore = scoreSum / Math.max(1, scoreCount);
  const confidence = avgScore > 0 ? Math.max(0, Math.min(1, (bestScore - avgScore) / (bestScore + avgScore))) : 0;
  const periodMs = bestLag * hopMs;
  const bpm = Math.round(60000 / periodMs);

  // Первый заметный онсет — фаза сетки долей.
  let firstBeat = 0;
  const onsetThreshold = mean * 2;
  for (let i = 0; i < onset.length; i++) {
    if (onset[i]! > onsetThreshold) {
      firstBeat = i * hopMs;
      break;
    }
  }
  const totalMs = (env.rms.length - 1) * hopMs;
  const beatsMs: number[] = [];
  for (let t = firstBeat; t <= totalMs; t += periodMs) beatsMs.push(Math.round(t));

  return { bpm, confidence, beatsMs };
}

/** Категория темпа для выбора стиля автопостановки (§17 п.5: быстрый темп → быстрая смена картин). */
export function tempoCategory(bpm: number): 'slow' | 'medium' | 'fast' {
  if (bpm > 0 && bpm < 90) return 'slow';
  if (bpm <= 130) return 'medium';
  return 'fast';
}
