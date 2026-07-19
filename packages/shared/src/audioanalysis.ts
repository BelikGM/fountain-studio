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

// ── Спектральный анализ (§5 доработки: «максимально всё, что можешь») ──────
//
// FFT (радикс-2, in-place) — стандартный, хорошо изученный алгоритм; вход
// дополняется нулями до ближайшей степени двойки. Даёт полосы частот
// (бас/средние/высокие → раздельные огибающие для воды/света), спектральный
// центроид («яркость» звука) и точки-«форте» (залпы). Не ИИ и не обучение —
// прозрачная, детерминированная арифметика по спектру.

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Быстрое преобразование Фурье, in-place, длина real/imag — степень двойки. */
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i]!;
      real[i] = real[j]!;
      real[j] = tr;
      const ti = imag[i]!;
      imag[i] = imag[j]!;
      imag[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const ur = real[i + k]!;
        const ui = imag[i + k]!;
        const vr = real[i + k + half]! * wr - imag[i + k + half]! * wi;
        const vi = real[i + k + half]! * wi + imag[i + k + half]! * wr;
        real[i + k] = ur + vr;
        imag[i + k] = ui + vi;
        real[i + k + half] = ur - vr;
        imag[i + k + half] = ui - vi;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
}

/** Амплитудный спектр одного окна (окно Ханна против утечки спектра). Длина — fftSize/2 бинов. */
function windowSpectrum(samples: Float32Array, start: number, fftSize: number): Float64Array {
  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const s = start + i < samples.length ? samples[start + i]! : 0;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
    real[i] = s * w;
  }
  fft(real, imag);
  const mags = new Float64Array(fftSize / 2);
  for (let k = 0; k < fftSize / 2; k++) mags[k] = Math.hypot(real[k]!, imag[k]!);
  return mags;
}

export interface FrequencyBand {
  loHz: number;
  hiHz: number;
  /** Энергия полосы по окнам, нормирована к своему пику (0..1). */
  energy: number[];
}

export interface BandEnergyEnvelope {
  hopMs: number;
  bands: FrequencyBand[];
}

const DEFAULT_BANDS: { loHz: number; hiHz: number }[] = [
  { loHz: 20, hiHz: 250 }, // бас — §17 п.5: громкость/бас → высота воды
  { loHz: 250, hiHz: 2000 }, // средние
  { loHz: 2000, hiHz: 8000 }, // высокие — блеск, «искры» света
];

/**
 * Энергия по полосам частот (по умолчанию бас/средние/высокие) через FFT с
 * окном Ханна. Каждая полоса нормируется к своему пику независимо — можно
 * раздать бас насосам, верха — вспышкам света, не оглядываясь на то, что
 * куда громче в оригинале.
 */
export function bandEnergyEnvelope(
  samples: Float32Array,
  sampleRate: number,
  bands: { loHz: number; hiHz: number }[] = DEFAULT_BANDS,
  hopMs = 50,
  fftSize = 1024,
): BandEnergyEnvelope {
  const size = nextPowerOfTwo(fftSize);
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const binHz = sampleRate / size;
  const raw: number[][] = bands.map(() => []);
  for (let start = 0; start + size <= samples.length; start += hop) {
    const mags = windowSpectrum(samples, start, size);
    bands.forEach((b, bi) => {
      const loBin = Math.max(1, Math.floor(b.loHz / binHz));
      const hiBin = Math.min(size / 2 - 1, Math.ceil(b.hiHz / binHz));
      let sum = 0;
      let n = 0;
      for (let k = loBin; k <= hiBin; k++) {
        sum += mags[k]!;
        n++;
      }
      raw[bi]!.push(n > 0 ? sum / n : 0);
    });
  }
  const result: FrequencyBand[] = bands.map((b, bi) => {
    const e = raw[bi]!;
    const peak = e.reduce((m, v) => (v > m ? v : m), 0);
    return { loHz: b.loHz, hiHz: b.hiHz, energy: peak > 0 ? e.map((v) => v / peak) : e };
  });
  return { hopMs, bands: result };
}

/** Огибающая полосы как точки 0–255 для дорожки шоу — тот же приём, что loudnessEnvelopePoints. */
export function bandEnvelopePoints(
  band: FrequencyBand,
  hopMs: number,
  opts: { min?: number; max?: number; gamma?: number } = {},
): { tMs: number; value: number }[] {
  const min = opts.min ?? 0;
  const max = opts.max ?? 255;
  const gamma = opts.gamma ?? 1;
  return band.energy.map((v, i) => ({
    tMs: i * hopMs,
    value: Math.round(min + Math.pow(Math.max(0, Math.min(1, v)), gamma) * (max - min)),
  }));
}

export interface SpectralCentroidEnvelope {
  hopMs: number;
  /** «Яркость» звука — средневзвешенная по амплитуде частота спектра, Гц. */
  centroidHz: number[];
}

/** Спектральный центроид: выше у резких/ярких звуков (тарелки, синтезаторные лиды), ниже у баса/баритона. */
export function spectralCentroidEnvelope(
  samples: Float32Array,
  sampleRate: number,
  hopMs = 50,
  fftSize = 1024,
): SpectralCentroidEnvelope {
  const size = nextPowerOfTwo(fftSize);
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const binHz = sampleRate / size;
  const centroidHz: number[] = [];
  for (let start = 0; start + size <= samples.length; start += hop) {
    const mags = windowSpectrum(samples, start, size);
    let weighted = 0;
    let total = 0;
    for (let k = 1; k < mags.length; k++) {
      weighted += mags[k]! * k * binHz;
      total += mags[k]!;
    }
    centroidHz.push(total > 0 ? weighted / total : 0);
  }
  return { hopMs, centroidHz };
}

export interface PeakEvent {
  tMs: number;
  /** 0..1 — насколько всплеск выделяется относительно локального среднего. */
  strength: number;
}

/**
 * Заметные всплески громкости — «форте» (§17 п.5: форте → залпы). RMS выше
 * скользящего среднего (~1 с) в thresholdRatio раз и не ближе minGapMs к
 * предыдущему всплеску (не дробим один залп на десяток событий).
 */
export function peakEvents(
  env: EnergyEnvelope,
  opts: { thresholdRatio?: number; minGapMs?: number } = {},
): PeakEvent[] {
  const thresholdRatio = opts.thresholdRatio ?? 1.5;
  const minGapSteps = Math.max(1, Math.round((opts.minGapMs ?? 200) / env.hopMs));
  const windowSteps = Math.max(1, Math.round(1000 / env.hopMs));
  const events: PeakEvent[] = [];
  let lastPeakStep = -Infinity;
  for (let i = 0; i < env.rms.length; i++) {
    const from = Math.max(0, i - windowSteps);
    let sum = 0;
    for (let j = from; j < i; j++) sum += env.rms[j]!;
    const n = i - from;
    const localAvg = n > 0 ? sum / n : 0;
    if (localAvg <= 0) continue;
    const ratio = env.rms[i]! / localAvg;
    if (ratio >= thresholdRatio && i - lastPeakStep >= minGapSteps) {
      events.push({ tMs: i * env.hopMs, strength: Math.max(0, Math.min(1, (ratio - thresholdRatio) / thresholdRatio + 0.5)) });
      lastPeakStep = i;
    }
  }
  return events;
}
