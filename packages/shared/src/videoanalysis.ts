/**
 * Анализ видео для автопостановки (§17 п.4 «обучение на видео»). Честно:
 * настоящее «обучение» (распознавание хореографии профессиональных шоу,
 * перенос паттернов) — исследовательская ML/CV-задача, не то, что можно
 * сделать за один заход, и не то, чему есть точный план от пользователя.
 * Вместо этого — рабочий прототип попроще, но реальный: извлечение яркости
 * и доминирующего цвета по кадрам («паттерны движения/цвета» из исходной
 * формулировки плана), детерминированно и прозрачно, без нейросетей.
 * Тот же приём, что audioanalysis.ts — чистые функции над сэмплами, чтобы
 * проверяться в Node на синтетике; сама выборка кадров из файла — DOM-API
 * (HTMLVideoElement/canvas), поэтому живёт в packages/ui, не здесь.
 */

export interface VideoFrameSample {
  atMs: number;
  /** Перцептивная яркость кадра (Rec.709), 0..1. */
  brightness: number;
  /** Средний цвет кадра, 0..255 на канал. */
  color: { r: number; g: number; b: number };
}

/** Средние яркость/цвет по RGBA-пикселям одного кадра (например, из canvas.getImageData().data). */
export function sampleFrameStats(pixels: ArrayLike<number>): { brightness: number; color: { r: number; g: number; b: number } } {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    r += pixels[i]!;
    g += pixels[i + 1]!;
    b += pixels[i + 2]!;
  }
  r /= Math.max(1, n);
  g /= Math.max(1, n);
  b /= Math.max(1, n);
  const brightness = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return { brightness: Math.max(0, Math.min(1, brightness)), color: { r: Math.round(r), g: Math.round(g), b: Math.round(b) } };
}

/** Огибающая яркости как точки 0–255 для дорожки шоу — тот же приём, что loudnessEnvelopePoints в audioanalysis.ts. */
export function brightnessEnvelopePoints(
  samples: VideoFrameSample[],
  opts: { min?: number; max?: number; gamma?: number } = {},
): { tMs: number; value: number }[] {
  const min = opts.min ?? 0;
  const max = opts.max ?? 255;
  const gamma = opts.gamma ?? 1;
  return samples.map((s) => ({
    tMs: Math.round(s.atMs),
    value: Math.round(min + Math.pow(s.brightness, gamma) * (max - min)),
  }));
}

/** Огибающая одного канала цвета (r/g/b) как точки 0–255 — для RGB-прибора нужны три такие дорожки. */
export function colorChannelEnvelopePoints(
  samples: VideoFrameSample[],
  channel: 'r' | 'g' | 'b',
): { tMs: number; value: number }[] {
  return samples.map((s) => ({ tMs: Math.round(s.atMs), value: Math.max(0, Math.min(255, Math.round(s.color[channel]))) }));
}

export interface ColorChangeEvent {
  tMs: number;
  /** Евклидово расстояние между соседними средними цветами кадров, 0..441 (√(255²×3)). */
  delta: number;
}

/**
 * Резкие смены цвета/яркости кадра — кандидаты на монтажные склейки видео
 * (годится триггерить смену сцены/секвенсора синхронно с монтажом ролика).
 */
export function colorChangeEvents(samples: VideoFrameSample[], opts: { thresholdDelta?: number } = {}): ColorChangeEvent[] {
  const threshold = opts.thresholdDelta ?? 60;
  const events: ColorChangeEvent[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!.color;
    const b = samples[i]!.color;
    const delta = Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
    if (delta >= threshold) events.push({ tMs: Math.round(samples[i]!.atMs), delta });
  }
  return events;
}
