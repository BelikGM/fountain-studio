/**
 * Автопостановка шоу под трек: разбор музыки → черновик, который правят руками.
 *
 * ── Чем это отличается от прежней версии ──────────────────────────────────
 * Раньше черновик строился «в лоб»: громкость рисовалась огибающей на первый
 * насос, высокие частоты — на второй, всплески — залпами первой сцены. Такой
 * черновик не похож на настоящее шоу, и вот почему (замерено 23.09.2026 по
 * восьми видео с объекта заказчика, квадрат 5×5 в Абхазии — см.
 * `docs/АВТОПОСТАНОВКА.md`):
 *
 *  · картина воды там меняется примерно КАЖДУЮ ДОЛЮ: медиана удержания 0,8
 *    доли (0,3–0,4 с при 120–150 BPM), причём 44 % смен короче доли;
 *  · три четверти смен попадают в сетку долей (±120 мс) — шоу построено по
 *    сетке, а не по огибающей;
 *  · прямой связи «громче — выше» в кадрах почти нет (корреляция 0,0–0,15):
 *    вода переключается между ФИГУРАМИ, а не ползёт за громкостью;
 *  · цвет держится дольше картины — от секунды в быстрых местах до десятков
 *    секунд в спокойных, и на стыке цветов свет коротко гаснет;
 *  · темнота — приём: в разных номерах от 0 до 47 % времени фонтан почти не
 *    светится (паузы между частями).
 *
 * Отсюда устройство здесь: сетка долей → части трека → на каждую «клетку»
 * выбирается ФИГУРА по геометрии объекта, а не значение по огибающей. Свет
 * живёт своим слоем с более длинным шагом.
 *
 * ── Физика, без которой шоу «не попадает» ────────────────────────────────
 * Вода не появляется мгновенно: от команды до полной струи проходит время
 * (разгон напора `riseMs`, у клапана — свой ход). Поэтому команда ставится
 * РАНЬШЕ доли на это время (см. leadMs): попасть должна вода, а не команда.
 *
 * Модуль чистый: ни движка, ни DOM. Всё, что он делает, проверяется
 * `npm -w @fountain-studio/engine run autoshow-test`.
 */
import { bandEnergyEnvelope, energyEnvelope, estimateTempo } from './audioanalysis';
import type { Nozzle } from './layout';
import type { PatchedDevice as Device, DeviceProfile, Scene } from './project';
import type { BlocksTrack, Show, ShowBlock, ShowTrack } from './show';

// ---------------------------------------------------------------------------
// Разбор трека
// ---------------------------------------------------------------------------

/** Часть трека: чем она отличается от соседних — по ней задаётся плотность событий. */
export type SectionKind = 'intro' | 'verse' | 'chorus' | 'break' | 'final';

export interface TrackSection {
  startMs: number;
  endMs: number;
  kind: SectionKind;
  /** Средняя громкость части, 0..1 от самой громкой части трека. */
  loud: number;
  /** Плотность ударов, шт/с. */
  onsetRate: number;
}

export interface TrackOnset {
  tMs: number;
  /** 0..1 — насколько удар выделяется. */
  strength: number;
}

export interface TrackMap {
  durationMs: number;
  bpm: number;
  /** Уверенность в темпе 0..1: ниже 0,25 — сетку лучше не навязывать. */
  bpmConfidence: number;
  /** Доли, мс. Пусто — темп не определён. */
  beatsMs: number[];
  /** Сильные доли (начала тактов), мс. */
  barsMs: number[];
  sections: TrackSection[];
  onsets: TrackOnset[];
  /** Шаг огибающих, мс. */
  hopMs: number;
  /** Общая громкость 0..1. */
  loud: number[];
  /** Низ 0..1 — им правится высота воды. */
  bass: number[];
  /** Верх 0..1 — им правится блеск света. */
  treble: number[];
}

const HOP_MS = 20;
/** Тише этого — считаем тишиной (доля от пика). */
const QUIET_LEVEL = 0.18;

function normalize(values: number[]): number[] {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

/** Значение огибающей на момент времени. */
function at(values: number[], hopMs: number, tMs: number): number {
  const i = Math.round(tMs / hopMs);
  if (i < 0) return values[0] ?? 0;
  if (i >= values.length) return values[values.length - 1] ?? 0;
  return values[i] ?? 0;
}

/**
 * Удары (онсеты) по нарастанию энергии в полосах.
 *
 * По общей громкости удары теряются под ровным фоном (синтезаторный «ковёр»,
 * шум толпы на записи с объекта). Складываем нарастание по трём полосам: бас
 * даёт бочку, верх — щелчки и хай-хэт, их сумма выделяет долю там, где общая
 * громкость почти не меняется.
 */
function detectOnsets(bass: number[], mid: number[], treble: number[], hopMs: number): TrackOnset[] {
  const n = Math.min(bass.length, mid.length, treble.length);
  const flux: number[] = [0];
  for (let i = 1; i < n; i++) {
    const d =
      Math.max(0, bass[i]! - bass[i - 1]!) * 1.2 +
      Math.max(0, mid[i]! - mid[i - 1]!) +
      Math.max(0, treble[i]! - treble[i - 1]!) * 1.4;
    flux.push(d);
  }
  const win = Math.max(1, Math.round(500 / hopMs));
  const out: TrackOnset[] = [];
  let lastMs = -Infinity;
  for (let i = 1; i < flux.length - 1; i++) {
    const from = Math.max(0, i - win);
    const to = Math.min(flux.length, i + win);
    let sum = 0;
    for (let j = from; j < to; j++) sum += flux[j]!;
    const avg = sum / Math.max(1, to - from);
    const v = flux[i]!;
    if (v <= avg * 1.6 || v < flux[i - 1]! || v < flux[i + 1]!) continue;
    const tMs = i * hopMs;
    // Ближе 90 мс — это один и тот же удар: у воды всё равно нет такого хода.
    if (tMs - lastMs < 90) continue;
    lastMs = tMs;
    out.push({ tMs, strength: Math.max(0, Math.min(1, (v / Math.max(1e-6, avg) - 1.6) / 3)) });
  }
  return out;
}

/**
 * Части трека: режем по тактам и склеиваем соседние такты похожей громкости.
 *
 * Плотность событий в шоу задаётся именно частью: в припеве чаще и выше, в
 * проигрыше реже и ниже. Без разметки автопостановка сыпала одинаково ровно
 * всю песню — от этого шоу и выглядело скучным.
 */
function detectSections(
  loud: number[],
  hopMs: number,
  barsMs: number[],
  onsets: TrackOnset[],
  durationMs: number,
): TrackSection[] {
  const bounds = barsMs.length >= 2 ? barsMs : [0, durationMs];
  const bars: { startMs: number; endMs: number; loud: number; rate: number }[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const startMs = bounds[i]!;
    const endMs = i + 1 < bounds.length ? bounds[i + 1]! : durationMs;
    if (endMs - startMs < 200) continue;
    let sum = 0;
    let n = 0;
    for (let t = startMs; t < endMs; t += hopMs) {
      sum += at(loud, hopMs, t);
      n++;
    }
    const inBar = onsets.filter((o) => o.tMs >= startMs && o.tMs < endMs).length;
    bars.push({ startMs, endMs, loud: n > 0 ? sum / n : 0, rate: (inBar * 1000) / (endMs - startMs) });
  }
  if (bars.length === 0) return [{ startMs: 0, endMs: durationMs, kind: 'verse', loud: 1, onsetRate: 0 }];

  let peak = 0;
  for (const b of bars) if (b.loud > peak) peak = b.loud;
  const rel = (v: number): number => (peak > 0 ? v / peak : 0);
  const classify = (b: { loud: number }): SectionKind => {
    const r = rel(b.loud);
    if (r < 0.35) return 'break';
    if (r > 0.78) return 'chorus';
    return 'verse';
  };

  const out: TrackSection[] = [];
  for (const b of bars) {
    const kind = classify(b);
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.endMs = b.endMs;
      last.loud = (last.loud + rel(b.loud)) / 2;
      last.onsetRate = (last.onsetRate + b.rate) / 2;
    } else {
      out.push({ startMs: b.startMs, endMs: b.endMs, kind, loud: rel(b.loud), onsetRate: b.rate });
    }
  }
  /*
   * Куски короче ЧЕТЫРЁХ тактов сливаем с соседом, и так несколько раз, пока
   * коротких не останется. Дёрганая разметка даёт дёрганое шоу: на сверке с
   * объектом в одном треке выходило 47 «частей» — плотность скакала каждые
   * пару секунд, и никакой формы у номера не было.
   */
  const barMs = bars[0] ? bars[0].endMs - bars[0].startMs : 2000;
  let merged: TrackSection[] = out;
  for (let pass = 0; pass < 4; pass++) {
    const next: TrackSection[] = [];
    for (const s of merged) {
      const prev = next[next.length - 1];
      if (prev && s.endMs - s.startMs < barMs * 4) {
        prev.endMs = s.endMs;
        continue;
      }
      next.push({ ...s });
    }
    if (next.length === merged.length) {
      merged = next;
      break;
    }
    merged = next;
  }
  if (merged.length > 0) {
    const first = merged[0]!;
    if (first.kind !== 'chorus' && first.startMs < barMs * 2) first.kind = 'intro';
    const last = merged[merged.length - 1]!;
    if (last.kind === 'chorus') last.kind = 'final';
  }
  return merged;
}

/** Разбор трека: темп, сетка долей и тактов, части, удары, полосы. */
export function analyzeTrack(samples: Float32Array, sampleRate: number): TrackMap {
  const durationMs = (samples.length / sampleRate) * 1000;
  const env = energyEnvelope(samples, sampleRate, HOP_MS);
  const loud = normalize([...env.rms]);
  const bands = bandEnergyEnvelope(
    samples,
    sampleRate,
    [
      { loHz: 20, hiHz: 250 },
      { loHz: 250, hiHz: 2000 },
      { loHz: 2000, hiHz: 8000 },
    ],
    HOP_MS,
  );
  const bass = normalize(bands.bands[0]?.energy ?? []);
  const mid = normalize(bands.bands[1]?.energy ?? []);
  const treble = normalize(bands.bands[2]?.energy ?? []);
  const tempo = estimateTempo(samples, sampleRate);
  const onsets = detectOnsets(bass, mid, treble, HOP_MS);

  /*
   * Фазу сетки берём по УДАРАМ, а не по первому громкому месту: у записи с
   * объекта первым громким местом может оказаться хлопок в толпе, и вся сетка
   * уезжала на полдоли.
   */
  const beatMs = tempo.bpm > 0 ? 60000 / tempo.bpm : 0;
  let beatsMs: number[] = [];
  if (beatMs > 0) {
    let bestPhase = 0;
    let bestScore = -1;
    for (let p = 0; p < beatMs; p += beatMs / 24) {
      let score = 0;
      for (const o of onsets) {
        const k = Math.round((o.tMs - p) / beatMs);
        const err = Math.abs(o.tMs - (p + k * beatMs));
        if (err < beatMs * 0.12) score += o.strength + 0.2;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPhase = p;
      }
    }
    for (let t = bestPhase; t <= durationMs; t += beatMs) beatsMs.push(Math.round(t));
  }
  if (beatsMs.length === 0) {
    // Без темпа сетка всё равно нужна — берём полсекунды, это «средний шаг».
    for (let t = 0; t <= durationMs; t += 500) beatsMs.push(t);
  }
  const barsMs = beatsMs.filter((_, i) => i % 4 === 0);
  const sections = detectSections(loud, HOP_MS, barsMs, onsets, durationMs);

  return {
    durationMs,
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    beatsMs,
    barsMs,
    sections,
    onsets,
    hopMs: HOP_MS,
    loud,
    bass,
    treble,
  };
}

// ---------------------------------------------------------------------------
// Фигуры по геометрии объекта
// ---------------------------------------------------------------------------

/**
 * Фигура — это КАРТИНА на всех форсунках сразу, а не значение одного прибора.
 * Именно фигурами (и переключением между ними по долям) собрано настоящее шоу
 * на объекте: см. разбор в шапке.
 */
export type FigureKind =
  | 'all' // все на полную — самая сильная точка
  | 'wave' // волна слева направо
  | 'waveBack' // волна обратно
  | 'center' // от центра к краям
  | 'edges' // края выше центра
  | 'rows' // ряды по очереди
  | 'cols' // колонки по очереди
  | 'checker' // шахматка
  | 'random' // случайная горсть
  | 'low' // все низко — «кипение»
  | 'single'; // одна струя — точка внимания

export const FIGURE_NAMES: Record<FigureKind, string> = {
  all: 'все',
  wave: 'волна',
  waveBack: 'волна назад',
  center: 'из центра',
  edges: 'по краям',
  rows: 'рядами',
  cols: 'колоннами',
  checker: 'шахматка',
  random: 'горстью',
  low: 'кипение',
  single: 'одна струя',
};

/** Нормированные координаты форсунок: 0..1 по X и Y, для фигур. */
export interface FigureGeometry {
  nx: number[];
  ny: number[];
}

export function figureGeometry(nozzles: Nozzle[]): FigureGeometry {
  const xs = nozzles.map((n) => n.x);
  const ys = nozzles.map((n) => n.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return {
    nx: xs.map((x) => (x - minX) / spanX),
    ny: ys.map((y) => (y - minY) / spanY),
  };
}

/**
 * Уровни фигуры для каждой форсунки, 0..1.
 *
 * `phase` — где фигура «сейчас» (0..1): по нему волна едет, а ряды сменяются.
 * `seed` — чтобы «горсть» не была одинаковой каждый раз.
 */
export function figureLevels(kind: FigureKind, geo: FigureGeometry, phase: number, seed = 0): number[] {
  const n = geo.nx.length;
  const out = new Array<number>(n).fill(0);
  const band = (v: number, center: number, width: number): number =>
    Math.max(0, 1 - Math.abs(v - center) / width);
  for (let i = 0; i < n; i++) {
    const x = geo.nx[i]!;
    const y = geo.ny[i]!;
    switch (kind) {
      case 'all':
        out[i] = 1;
        break;
      case 'low':
        out[i] = 0.28;
        break;
      case 'wave':
        out[i] = 0.25 + 0.75 * band(x, phase, 0.35);
        break;
      case 'waveBack':
        out[i] = 0.25 + 0.75 * band(x, 1 - phase, 0.35);
        break;
      case 'center': {
        const d = Math.hypot(x - 0.5, y - 0.5) / 0.71;
        out[i] = 0.2 + 0.8 * band(d, phase, 0.3);
        break;
      }
      case 'edges': {
        const d = Math.hypot(x - 0.5, y - 0.5) / 0.71;
        out[i] = 0.2 + 0.8 * Math.min(1, d * 1.6);
        break;
      }
      case 'rows':
        out[i] = 0.2 + 0.8 * band(y, phase, 0.28);
        break;
      case 'cols':
        out[i] = 0.2 + 0.8 * band(x, phase, 0.28);
        break;
      case 'checker': {
        // Шахматка по сетке 5×5 и любой другой: округляем координаты в клетки.
        const cell = Math.round(x * 4) + Math.round(y * 4);
        const on = (cell + Math.round(phase * 2)) % 2 === 0;
        out[i] = on ? 1 : 0.15;
        break;
      }
      case 'random': {
        // Псевдослучайно, но устойчиво: один и тот же seed даёт ту же горсть.
        const h = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
        const r = h - Math.floor(h);
        out[i] = r > 0.55 ? 0.6 + 0.4 * r : 0.1;
        break;
      }
      case 'single': {
        const pick = Math.floor(phase * n) % Math.max(1, n);
        out[i] = i === pick ? 1 : 0;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Сборка черновика
// ---------------------------------------------------------------------------

export interface AutoShowInput {
  show: Show;
  nozzles: Nozzle[];
  devices: Device[];
  profiles: Map<string, DeviceProfile>;
  map: TrackMap;
  /** Генератор идентификаторов — в shared своего нет. */
  uid: () => string;
  /** Палитра света. Пусто — взять встроенную AUTO_PALETTE. */
  palette?: { rgb: [number, number, number]; name: string }[];
}

export interface AutoShowReport {
  /** Короткий человеческий итог для строки состояния. */
  summary: string;
  /** Что померили по получившемуся шоу — «самокритика». */
  grade: AutoGrade;
  /** Сколько каких фигур поставлено. */
  figures: { kind: FigureKind; count: number }[];
}

export interface AutoShowResult {
  scenes: Scene[];
  tracks: ShowTrack[];
  report: AutoShowReport;
}

/**
 * Палитра: насыщенные основные цвета — такие и стоят на объекте (на видео
 * видны красный, синий, зелёный, белый, фиолетовый, бирюзовый). Белый нужен
 * для самых сильных мест: он читается ярче любого цветного.
 *
 * Имя у каждого своё — человеческое: сцена в объекте должна называться
 * «⚡ свет красный», а не «⚡ свет 255,30,30».
 */
export const AUTO_PALETTE: { rgb: [number, number, number]; name: string }[] = [
  { rgb: [255, 30, 30], name: 'красный' },
  { rgb: [30, 80, 255], name: 'синий' },
  { rgb: [30, 255, 90], name: 'зелёный' },
  { rgb: [255, 255, 255], name: 'белый' },
  { rgb: [190, 40, 255], name: 'фиолетовый' },
  { rgb: [0, 220, 230], name: 'бирюзовый' },
  { rgb: [255, 140, 0], name: 'оранжевый' },
  { rgb: [255, 40, 160], name: 'малиновый' },
];

/**
 * Сколько ВОСЬМЫХ держится картина в каждой части.
 *
 * Сетка именно восьмыми: по замеру объекта 44 % смен короче доли, а медиана
 * удержания — 0,8 доли. Первая версия считала долями и держала картину 2,5
 * доли — втрое дольше настоящего шоу, отчего черновик выглядел вялым (сверка
 * с восемью видео, 23.09.2026).
 */
const HOLD_EIGHTHS: Record<SectionKind, number> = {
  intro: 4, // две доли
  verse: 2, // доля
  chorus: 1, // полдоли — как в припеве на объекте
  break: 4,
  final: 1,
};

/**
 * Через сколько тактов меняется цвет. Замер по объекту: от 19 смен в минуту в
 * спокойном номере до 60–95 в быстрых. Такт при 120 BPM — две секунды, значит
 * припев с шагом в такт даёт ~30 смен в минуту, куплет с шагом в два такта —
 * ~15. Прежние 4–8 тактов давали 7–13 смен и читались как «свет застыл».
 */
const COLOR_BARS: Record<SectionKind, number> = {
  intro: 2,
  verse: 2,
  chorus: 1,
  break: 4,
  final: 1,
};

/** Уровень воды по частям: доля от полного. */
const SECTION_LEVEL: Record<SectionKind, number> = {
  intro: 0.45,
  verse: 0.7,
  chorus: 1,
  break: 0.3,
  final: 1,
};

/** Какие фигуры уместны в части — чтобы в проигрыше не жарила «все на полную». */
const SECTION_FIGURES: Record<SectionKind, FigureKind[]> = {
  intro: ['low', 'wave', 'center', 'single', 'rows'],
  verse: ['wave', 'waveBack', 'rows', 'cols', 'checker', 'center'],
  chorus: ['all', 'wave', 'center', 'edges', 'checker', 'random'],
  break: ['low', 'single', 'center', 'wave'],
  final: ['all', 'center', 'edges', 'wave', 'random'],
};

function sectionAt(map: TrackMap, tMs: number): TrackSection {
  for (const s of map.sections) if (tMs >= s.startMs && tMs < s.endMs) return s;
  return map.sections[map.sections.length - 1] ?? { startMs: 0, endMs: map.durationMs, kind: 'verse', loud: 0.7, onsetRate: 0 };
}

/** Канал устройства по роли; −1 — такого канала нет. */
function channelOf(profiles: Map<string, DeviceProfile>, device: Device, role: string): number {
  const p = profiles.get(device.profileId);
  if (!p) return -1;
  return p.channels.findIndex((c) => c.role === role);
}

/**
 * Черновик шоу: сцены-фигуры + дорожка блоков на воду и дорожка на свет.
 *
 * Почему сцены, а не огибающие на каждый прибор: человек должен УВИДЕТЬ, из
 * чего состоит шоу, и править его как свою работу — переставить блок, поменять
 * сцену, растянуть. Огибающая из тысяч точек не правится руками вовсе.
 */
export function buildAutoShow(input: AutoShowInput): AutoShowResult {
  const { show, nozzles, devices, profiles, map, uid } = input;
  const palette = input.palette && input.palette.length > 0 ? input.palette : AUTO_PALETTE;
  const geo = figureGeometry(nozzles);
  const byId = new Map(devices.map((d) => [d.id, d]));

  // Приборы воды: насос форсунки (высота) и клапан (есть/нет струи).
  const pumps = nozzles.map((n) => (n.pumpDeviceId ? byId.get(n.pumpDeviceId) ?? null : null));
  const valves = nozzles.map((n) => (n.valveDeviceId ? byId.get(n.valveDeviceId) ?? null : null));
  const lamps = devices.filter((d) => profiles.get(d.profileId)?.kind === 'lamp');

  const scenes: Scene[] = [];
  const sceneKey = new Map<string, Scene>();
  const figureCount = new Map<FigureKind, number>();

  /** Сцена для фигуры на заданном уровне; одинаковые переиспользуем. */
  const figureScene = (kind: FigureKind, phaseStep: number, level: number): Scene => {
    const lvlQ = Math.round(level * 4) / 4; // четверти — чтобы сцен было немного
    const key = `${kind}|${phaseStep}|${lvlQ}`;
    const found = sceneKey.get(key);
    if (found) return found;
    const levels = figureLevels(kind, geo, phaseStep / 4, phaseStep);
    const values: Record<string, number[]> = {};
    for (let i = 0; i < nozzles.length; i++) {
      const lvl = Math.max(0, Math.min(1, levels[i]! * lvlQ));
      const pump = pumps[i];
      if (pump) {
        const ch = channelOf(profiles, pump, 'intensity');
        if (ch >= 0) {
          const arr = values[pump.id] ?? new Array<number>(profiles.get(pump.profileId)?.channels.length ?? 1).fill(0);
          arr[ch] = Math.round(lvl * 255);
          values[pump.id] = arr;
        }
      }
      const valve = valves[i];
      if (valve) {
        const ch = channelOf(profiles, valve, 'open');
        if (ch >= 0) {
          const arr = values[valve.id] ?? new Array<number>(profiles.get(valve.profileId)?.channels.length ?? 1).fill(0);
          // Клапан двухпозиционный: ниже четверти считаем «закрыт».
          arr[ch] = lvl > 0.25 ? 255 : 0;
          values[valve.id] = arr;
        }
      }
    }
    const scene: Scene = { id: uid(), name: `⚡ ${FIGURE_NAMES[kind]} ${Math.round(lvlQ * 100)} %`, values };
    scenes.push(scene);
    sceneKey.set(key, scene);
    return scene;
  };

  /** Сцена света: весь объект одним цветом. */
  const colorScene = (rgb: [number, number, number], name: string): Scene => {
    const key = `color|${rgb.join(',')}`;
    const found = sceneKey.get(key);
    if (found) return found;
    const values: Record<string, number[]> = {};
    for (const lamp of lamps) {
      const p = profiles.get(lamp.profileId);
      if (!p) continue;
      const arr = new Array<number>(p.channels.length).fill(0);
      p.channels.forEach((c, i) => {
        if (c.role === 'red') arr[i] = rgb[0];
        if (c.role === 'green') arr[i] = rgb[1];
        if (c.role === 'blue') arr[i] = rgb[2];
        if (c.role === 'white') arr[i] = Math.min(rgb[0], rgb[1], rgb[2]);
        if (c.role === 'intensity') arr[i] = 255;
      });
      values[lamp.id] = arr;
    }
    const scene: Scene = { id: uid(), name: `⚡ свет ${name}`, values };
    scenes.push(scene);
    sceneKey.set(key, scene);
    return scene;
  };

  /**
   * На сколько ставить команду РАНЬШЕ доли.
   *
   * Вода не появляется мгновенно: напор разгоняется `riseMs`. Если ставить
   * команду на долю, струя поднимется уже после неё — ровно то «несовпадение»,
   * из-за которого шоу выглядит несобранным. Берём медиану по форсункам
   * объекта, но не больше полудоли: иначе команда уедет в предыдущую долю.
   */
  const beatMs = map.bpm > 0 ? 60000 / map.bpm : 500;
  const rises = nozzles.map((n) => n.riseMs).sort((a, b) => a - b);
  const leadMs = Math.min(beatMs / 2, rises[Math.floor(rises.length / 2)] ?? 300);

  // ── Вода: по клетке на каждую «картину» ────────────────────────────────────
  const waterBlocks: ShowBlock[] = [];
  /*
   * Сетка восьмыми: между долями ставим середину. Настоящее шоу меняет картину
   * и внутри доли — без этого черновик получался вдвое реже оригинала.
   */
  const grid: number[] = [];
  for (let k = 0; k < map.beatsMs.length; k++) {
    const t = map.beatsMs[k]!;
    if (t > show.durationMs) break;
    grid.push(t);
    const next = map.beatsMs[k + 1];
    if (next !== undefined && next <= show.durationMs) grid.push(Math.round((t + next) / 2));
  }
  let i = 0;
  let lastKind: FigureKind | null = null;
  let phase = 0;
  while (i < grid.length) {
    const tBeat = grid[i]!;
    const sec = sectionAt(map, tBeat);
    const holdEighths = HOLD_EIGHTHS[sec.kind];
    const endIdx = Math.min(grid.length - 1, i + holdEighths);
    const tEnd = grid[endIdx] ?? tBeat + (holdEighths * beatMs) / 2;

    // Фигура: из набора части, не повторяя предыдущую.
    const list = SECTION_FIGURES[sec.kind];
    let kind = list[phase % list.length]!;
    if (kind === lastKind) kind = list[(phase + 1) % list.length]!;
    lastKind = kind;

    // Уровень: базовый по части, приподнятый басом на этом месте.
    const bass = at(map.bass, map.hopMs, tBeat);
    const level = Math.max(0.15, Math.min(1, SECTION_LEVEL[sec.kind] * (0.75 + 0.35 * bass)));
    const scene = figureScene(kind, phase % 4, level);
    figureCount.set(kind, (figureCount.get(kind) ?? 0) + 1);

    const startMs = Math.max(0, Math.round(tBeat - leadMs));
    waterBlocks.push({
      id: uid(),
      type: 'scene',
      refId: scene.id,
      startMs,
      durationMs: Math.max(120, Math.round(tEnd - tBeat + leadMs)),
      fadeInMs: sec.kind === 'break' || sec.kind === 'intro' ? Math.round(Math.min(400, beatMs / 2)) : 0,
      fadeOutMs: 0,
    });
    phase++;
    // Строго вперёд: на последней клетке endIdx упирался в i, и цикл крутился
    // вечно, набивая блоки до исчерпания памяти (поймано самопроверкой).
    i = Math.max(i + 1, endIdx);
  }

  // ── Свет: свой слой, шаг длиннее ──────────────────────────────────────────
  /*
   * Цвет держится дольше картины и меняется на границах частей и раз в
   * несколько тактов внутри них; на стыке — короткое гашение, как на объекте.
   */
  const lightBlocks: ShowBlock[] = [];
  if (lamps.length > 0) {
    const barMs = beatMs * 4;
    let ci = 0;
    for (const sec of map.sections) {
      const step = barMs * COLOR_BARS[sec.kind];
      for (let t = sec.startMs; t < Math.min(sec.endMs, show.durationMs); t += step) {
        const c = palette[ci % palette.length]!;
        ci++;
        const scene = colorScene(c.rgb, c.name);
        const dur = Math.min(step, Math.min(sec.endMs, show.durationMs) - t);
        // Короткая темнота на стыке — разрыв между блоками в 120 мс.
        lightBlocks.push({
          id: uid(),
          type: 'scene',
          refId: scene.id,
          startMs: Math.round(t),
          durationMs: Math.max(200, Math.round(dur - 120)),
          fadeInMs: sec.kind === 'break' ? 300 : 60,
          fadeOutMs: 80,
        });
      }
    }
  }

  const tracks: ShowTrack[] = [];
  if (waterBlocks.length > 0) {
    tracks.push({
      id: uid(),
      name: 'Вода — фигуры по долям',
      kind: 'blocks',
      offsetMs: 0,
      muted: false,
      blocks: waterBlocks,
      effects: [],
    } satisfies BlocksTrack);
  }
  if (lightBlocks.length > 0) {
    tracks.push({
      id: uid(),
      name: 'Свет — цвет по частям',
      kind: 'blocks',
      offsetMs: 0,
      muted: false,
      blocks: lightBlocks,
      effects: [],
    } satisfies BlocksTrack);
  }

  const grade = gradeAutoShow({ waterBlocks, lightBlocks, map, leadMs });
  const figures = [...figureCount.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
  const summary =
    `${waterBlocks.length} картин воды и ${lightBlocks.length} смен цвета, ` +
    `темп ${map.bpm > 0 ? `${map.bpm} BPM` : 'не определён'}, частей ${map.sections.length}, ` +
    `команда ставится на ${Math.round(leadMs)} мс раньше доли`;

  return { scenes, tracks, report: { summary, grade, figures } };
}

// ---------------------------------------------------------------------------
// Самокритика: измеримые признаки качества
// ---------------------------------------------------------------------------

export interface AutoGrade {
  /**
   * Доля картин, попавших в СЕТКУ (доли и восьмые) — около 1, мы их туда и
   * ставим. Считаем по восьмым, а не только по долям: настоящее шоу меняет
   * картину и внутри доли, и мы тоже.
   */
  onBeat: number;
  /** Медиана удержания картины, в долях. Ориентир по объекту — 0,6–1,0 в припеве. */
  holdBeats: number;
  /** Доля картин короче 150 мс — «мигание ради мигания», должно быть 0. */
  tooShort: number;
  /** Сколько смен цвета в минуту. Ориентир — 20–60. */
  colorPerMin: number;
  /** Доля времени, когда вода почти не идёт (паузы). Ориентир — 0,05–0,4. */
  quietShare: number;
  /** Замечания человеческим языком — то, что стоит поправить руками. */
  notes: string[];
}

export function gradeAutoShow(args: {
  waterBlocks: ShowBlock[];
  lightBlocks: ShowBlock[];
  map: TrackMap;
  leadMs: number;
}): AutoGrade {
  const { waterBlocks, lightBlocks, map, leadMs } = args;
  const beatMs = map.bpm > 0 ? 60000 / map.bpm : 500;
  // Сетка восьмых: доли плюс их середины.
  const grid: number[] = [];
  for (let k = 0; k < map.beatsMs.length; k++) {
    grid.push(map.beatsMs[k]!);
    const next = map.beatsMs[k + 1];
    if (next !== undefined) grid.push((map.beatsMs[k]! + next) / 2);
  }
  const nearBeat = (t: number): boolean =>
    grid.some((b) => Math.abs(b - t) <= Math.max(60, beatMs * 0.12));
  const onBeat =
    waterBlocks.length > 0
      ? waterBlocks.filter((b) => nearBeat(b.startMs + leadMs)).length / waterBlocks.length
      : 0;
  const holds = waterBlocks.map((b) => b.durationMs / beatMs).sort((a, b) => a - b);
  const holdBeats = holds[Math.floor(holds.length / 2)] ?? 0;
  const tooShort = waterBlocks.length > 0 ? waterBlocks.filter((b) => b.durationMs < 150).length / waterBlocks.length : 0;
  const minutes = Math.max(1 / 60, map.durationMs / 60000);
  const colorPerMin = lightBlocks.length / minutes;

  // «Тихо» — доля времени в частях, где уровень низкий.
  let quietMs = 0;
  for (const s of map.sections) if (s.kind === 'break' || s.kind === 'intro') quietMs += s.endMs - s.startMs;
  const quietShare = map.durationMs > 0 ? quietMs / map.durationMs : 0;

  const notes: string[] = [];
  if (map.bpmConfidence < 0.25) {
    notes.push('темп определился неуверенно — проверьте сетку долей и поправьте начало, иначе картины поедут мимо');
  }
  if (tooShort > 0) notes.push('есть картины короче 150 мс — вода не успеет их показать, лучше объединить');
  if (holdBeats > 3) notes.push('картина держится дольше трёх долей — в припеве это выглядит вяло');
  if (colorPerMin > 90) notes.push('цвет меняется чаще раза в секунду — на объекте это читается как мигание');
  if (quietShare > 0.55) notes.push('больше половины трека отдано тихим частям — проверьте разметку, шоу может показаться пустым');
  if (lightBlocks.length === 0) notes.push('в объекте нет светильников — свет не расставлен, только вода');

  return { onBeat, holdBeats, tooShort, colorPerMin, quietShare, notes };
}
