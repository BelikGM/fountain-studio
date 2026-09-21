import { smoothnessFromSaved, type TrackEffect } from './smoothing';

/**
 * Модель шоу: звуковая дорожка + дорожки управления на общем таймлайне.
 *
 * Время шоу — «смонтированное»: вырезки (cuts) уже удалены из аудио, блоки и
 * огибающие ставятся по смонтированной шкале. Аудио играет редактор (Web Audio),
 * он же — мастер-часы: во время воспроизведения шлёт движку позицию, движок
 * экстраполирует её между сообщениями по своему тику.
 *
 * Опережение дорожки (offsetMs > 0): значения дорожки читаются на offsetMs
 * раньше таймлайна — так вода, которой нужно время на разгон, запускается
 * раньше света, хотя на экране блоки стоят в одной сетке.
 */

/** Вырезанный фрагмент исходного аудио (по исходной шкале файла), мс. */
export interface CutRange {
  startMs: number;
  endMs: number;
}

/** Блок на дорожке: сцена или секвенсор, растянутые на отрезок таймлайна. */
export interface ShowBlock {
  id: string;
  type: 'scene' | 'sequence';
  refId: string;
  startMs: number;
  durationMs: number;
  /** Плавный ввод/вывод значений блока (масштабирование 0→1→0), мс. */
  fadeInMs: number;
  fadeOutMs: number;
}

export interface EnvelopePoint {
  tMs: number;
  /** 0–255. */
  value: number;
}

interface ShowTrackBase {
  id: string;
  name: string;
  /** Опережение чтения дорожки, мс (может быть отрицательным — запаздывание). */
  offsetMs: number;
  muted: boolean;
}

/** Дорожка блоков (сцены/секвенсоры). */
export interface BlocksTrack extends ShowTrackBase {
  kind: 'blocks';
  blocks: ShowBlock[];
  /**
   * Зоны эффекта плавности (§27 доработки, УХ п.16) — временные промежутки
   * дорожки, где выходной сигнал сглаживается (Rate/Decay) вместо обычного
   * мгновенного применения (Quick). Вне зон — как сейчас, без изменений.
   */
  effects: TrackEffect[];
}

/** Огибающая: значение одного канала устройства, рисуется мышью по точкам. */
export interface EnvelopeTrack extends ShowTrackBase {
  kind: 'envelope';
  deviceId: string;
  /** Индекс канала в профиле устройства (0-based). */
  channel: number;
  points: EnvelopePoint[];
}

export type ShowTrack = BlocksTrack | EnvelopeTrack;

export interface Show {
  id: string;
  name: string;
  /** Имя аудиофайла в папке audio/ рядом с проектом; null — шоу без музыки. */
  audioFile: string | null;
  /** Длительность смонтированного таймлайна, мс (аудио минус вырезки; без аудио — вручную). */
  durationMs: number;
  cuts: CutRange[];
  tracks: ShowTrack[];
}

/** Сортирует вырезки и сливает пересекающиеся/смежные — инвариант остальных функций. */
export function mergeCuts(cuts: CutRange[]): CutRange[] {
  const sorted = [...cuts].sort((a, b) => a.startMs - b.startMs);
  const merged: CutRange[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, c.endMs);
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/** Суммарная длительность вырезок, мс. */
export function cutsTotalMs(cuts: CutRange[]): number {
  return cuts.reduce((sum, c) => sum + (c.endMs - c.startMs), 0);
}

/**
 * Смонтированное время → исходное время файла (вырезки перепрыгиваются).
 * Вырезки должны быть отсортированы и не пересекаться (гарантирует sanitizeShows).
 */
export function editedToSourceMs(cuts: CutRange[], tMs: number): number {
  let src = tMs;
  for (const c of cuts) {
    if (src < c.startMs) break;
    src += c.endMs - c.startMs;
  }
  return src;
}

/** Исходное время файла → смонтированное (точки внутри вырезки схлопываются к её началу). */
export function sourceToEditedMs(cuts: CutRange[], srcMs: number): number {
  let removed = 0;
  for (const c of cuts) {
    if (srcMs <= c.startMs) break;
    removed += Math.min(srcMs, c.endMs) - c.startMs;
  }
  return srcMs - removed;
}

/** Непрерывные куски исходного аудио, оставшиеся после вырезок (по исходной шкале). */
export function keptSegments(cuts: CutRange[], sourceDurationMs: number): CutRange[] {
  const segments: CutRange[] = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.startMs > pos) segments.push({ startMs: pos, endMs: Math.min(c.startMs, sourceDurationMs) });
    pos = Math.max(pos, c.endMs);
  }
  if (pos < sourceDurationMs) segments.push({ startMs: pos, endMs: sourceDurationMs });
  return segments;
}

/** Значение огибающей в момент t: вне диапазона точек — 0, между точками — линейно. */
export function envelopeValue(points: EnvelopePoint[], tMs: number): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (tMs < first.tMs || tMs > last.tMs) return 0;
  // Точек в огибающей немного (сотни) — линейный проход достаточен и на тике.
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (tMs <= b.tMs) {
      if (b.tMs === a.tMs) return b.value;
      const t = (tMs - a.tMs) / (b.tMs - a.tMs);
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

/**
 * Прореживание живой записи огибающей (§27 доработки, УХ п.17б) — алгоритм
 * Рамера–Дугласа–Пекера по отклонению значения от прямой между концами
 * сегмента: точка остаётся, только если без неё кривая заметно исказится
 * (>toleranceValue). Не трогает первую/последнюю точку — иначе огибающая
 * «сжимается» по краям (envelopeValue() отдаёт 0 за пределами первой/последней).
 */
export function decimateEnvelope(points: EnvelopePoint[], toleranceValue: number): EnvelopePoint[] {
  if (points.length <= 2 || toleranceValue <= 0) return points.map((p) => ({ ...p }));
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  const rdp = (lo: number, hi: number): void => {
    if (hi - lo < 2) return;
    const a = points[lo]!;
    const b = points[hi]!;
    const dt = b.tMs - a.tMs;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i]!;
      const expected = dt === 0 ? a.value : a.value + ((b.value - a.value) * (p.tMs - a.tMs)) / dt;
      const dist = Math.abs(p.value - expected);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceValue) {
      keep[maxIdx] = true;
      rdp(lo, maxIdx);
      rdp(maxIdx, hi);
    }
  };
  rdp(0, points.length - 1);
  return points.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}

/**
 * Сглаживание значений огибающей — скользящее среднее по временному окну
 * (не по числу точек: живая запись пишет точки неравномерно), с треугольным
 * весом — ближние точки сильнее влияют на результат. Точки по времени не
 * двигаются, меняется только value — так дрожь руки на записи фейдера
 * превращается в плавную кривую, а не в резкие изломы между точками.
 */
export function smoothEnvelopeValues(points: EnvelopePoint[], windowMs: number): EnvelopePoint[] {
  if (points.length <= 2 || windowMs <= 0) return points.map((p) => ({ ...p }));
  const half = windowMs / 2;
  return points.map((p) => {
    let sum = 0;
    let weight = 0;
    for (const q of points) {
      const d = Math.abs(q.tMs - p.tMs);
      if (d > half) continue;
      const w = 1 - d / half;
      sum += q.value * w;
      weight += w;
    }
    return { tMs: p.tMs, value: Math.max(0, Math.min(255, Math.round(weight > 0 ? sum / weight : p.value))) };
  });
}

/** Множитель фейдов блока (0..1) в локальном времени блока. */
export function blockFadeGain(block: ShowBlock, localMs: number): number {
  let gain = 1;
  if (block.fadeInMs > 0 && localMs < block.fadeInMs) gain = Math.min(gain, localMs / block.fadeInMs);
  const tail = block.durationMs - localMs;
  if (block.fadeOutMs > 0 && tail < block.fadeOutMs) gain = Math.min(gain, Math.max(0, tail / block.fadeOutMs));
  return Math.max(0, Math.min(1, gain));
}

export function sanitizeShows(raw: unknown, sceneIds: Set<string>, sequenceIds: Set<string>, deviceIds: Set<string>): Show[] {
  if (!Array.isArray(raw)) return [];
  const shows: Show[] = [];
  for (const s of raw as Show[]) {
    if (!s || typeof s.id !== 'string') continue;
    const show: Show = {
      id: s.id,
      name: typeof s.name === 'string' ? s.name : s.id,
      audioFile: typeof s.audioFile === 'string' ? s.audioFile : null,
      durationMs: Number.isFinite(s.durationMs) ? Math.max(0, Math.round(s.durationMs)) : 0,
      cuts: mergeCuts(
        (Array.isArray(s.cuts) ? s.cuts : [])
          .filter((c) => c && Number.isFinite(c.startMs) && Number.isFinite(c.endMs) && c.endMs > c.startMs)
          .map((c) => ({ startMs: Math.max(0, Math.round(c.startMs)), endMs: Math.round(c.endMs) })),
      ),
      tracks: [],
    };
    for (const t of Array.isArray(s.tracks) ? s.tracks : []) {
      if (!t || typeof t.id !== 'string') continue;
      const base = {
        id: t.id,
        name: typeof t.name === 'string' ? t.name : 'Дорожка',
        offsetMs: Number.isFinite(t.offsetMs) ? Math.round(t.offsetMs) : 0,
        muted: t.muted === true,
      };
      if (t.kind === 'envelope') {
        if (!deviceIds.has(t.deviceId)) continue;
        show.tracks.push({
          ...base,
          kind: 'envelope',
          deviceId: t.deviceId,
          channel: Number.isInteger(t.channel) && t.channel >= 0 ? t.channel : 0,
          points: (Array.isArray(t.points) ? t.points : [])
            .filter((p) => p && Number.isFinite(p.tMs) && Number.isFinite(p.value))
            .map((p) => ({ tMs: Math.max(0, Math.round(p.tMs)), value: Math.max(0, Math.min(255, Math.round(p.value))) }))
            .sort((a, b) => a.tMs - b.tMs),
        });
      } else {
        const rawEffects = Array.isArray((t as BlocksTrack).effects) ? (t as BlocksTrack).effects : [];
        show.tracks.push({
          ...base,
          kind: 'blocks',
          blocks: (Array.isArray((t as BlocksTrack).blocks) ? (t as BlocksTrack).blocks : [])
            .filter(
              (b) =>
                b &&
                typeof b.id === 'string' &&
                (b.type === 'scene' ? sceneIds.has(b.refId) : b.type === 'sequence' && sequenceIds.has(b.refId)),
            )
            .map((b) => ({
              id: b.id,
              type: b.type,
              refId: b.refId,
              startMs: Number.isFinite(b.startMs) ? Math.max(0, Math.round(b.startMs)) : 0,
              durationMs: Number.isFinite(b.durationMs) ? Math.max(100, Math.round(b.durationMs)) : 1000,
              fadeInMs: Number.isFinite(b.fadeInMs) ? Math.max(0, Math.round(b.fadeInMs)) : 0,
              fadeOutMs: Number.isFinite(b.fadeOutMs) ? Math.max(0, Math.round(b.fadeOutMs)) : 0,
            }))
            .sort((a, b) => a.startMs - b.startMs),
          effects: rawEffects
            .filter(
              (e) =>
                e &&
                typeof e.id === 'string' &&
                (e.mode === 'rate' || e.mode === 'decay') &&
                Number.isFinite(e.startMs) &&
                Number.isFinite(e.endMs) &&
                e.endMs > e.startMs,
            )
            .map((e) => ({
              id: e.id,
              mode: e.mode,
              startMs: Math.max(0, Math.round(e.startMs)),
              endMs: Math.round(e.endMs),
              // Старые проекты хранили «силу» с обратной шкалой — переводим.
              smoothness: smoothnessFromSaved(e as { smoothness?: unknown; strength?: unknown }),
            }))
            .sort((a, b) => a.startMs - b.startMs),
        });
      }
    }
    shows.push(show);
  }
  return shows;
}
