/**
 * Громкость и эквалайзер музыки, которую играет движок, — в децибелах, как
 * привыкли фонтанщики.
 *
 * ── Почему децибелы, а не проценты ───────────────────────────────────────
 * В FontanPlay громкость показывалась в дБ, и заказчик прислал снимок её окна
 * как образец (22.09.2026). Проценты к тому же обманчивы: 50 % — это не «вдвое
 * тише на слух», а всего −6 дБ; на слух вдвое тише — примерно −10 дБ. Шкала в
 * дБ совпадает с тем, как звук слышится, и с тем, что написано на усилителе.
 *
 * ── Громкость −12…+12 дБ (заказчик 24.09.2026) ───────────────────────────
 * 0 дБ — исходный уровень файла. Первая версия не давала поднять выше 0:
 * современные треки сведены почти в потолок, и подъём даёт перегруз. Заказчик
 * попросил возможность поднять тихий трек — поэтому до +12 дБ, но в конце
 * цепочки всегда стоит ограничитель: громкое место он мягко прижимает, а не
 * рвёт хрипом (см. playArgs в engine/audioplayer.ts).
 *
 * ── Почему нет «частоты» ─────────────────────────────────────────────────
 * В том же окне FontanPlay был ползунок «Friq 44100 Гц». Это скорость
 * воспроизведения: сдвиг ускоряет трек и повышает тон («пластинка не на той
 * скорости»), трек звучит испорченно и уезжает от воды. Такого ползунка здесь
 * сознательно нет; «частоты» у нас — это эквалайзер, он на синхронизацию с
 * водой не влияет вовсе.
 */

export const VOLUME_DB_MIN = -12;
export const VOLUME_DB_MAX = 12;

/**
 * Полосы эквалайзера, Гц — как просил заказчик (24.09.2026) и как в
 * настройках наушников и музыкальных программ. Это классические десять полос
 * Winamp, поэтому и готовые пресеты — оттуда.
 */
export const EQ_BANDS_HZ = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;
export const EQ_DB_MIN = -12;
export const EQ_DB_MAX = 12;

/** Подпись полосы: «60», «1 к», «12 к». */
export function eqBandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000} к` : String(hz);
}

export interface AudioLevel {
  /** −12…+12 дБ, шаг 0,5. 0 — как в файле. */
  volumeDb: number;
  /** Звук выключен совсем — как «Volume is OFF» в FontanPlay. */
  muted: boolean;
  /** Эквалайзер: подъём/срез каждой полосы EQ_BANDS_HZ, дБ. Нет — ровно. */
  eq?: number[];
  /** Старый тембр (до 24.09.2026) — читается только для перевода в полосы. */
  bassDb?: number;
  trebleDb?: number;
}

export interface EqPreset {
  id: string;
  name: string;
  /** Десять значений по EQ_BANDS_HZ, дБ. */
  gains: number[];
}

/**
 * Готовые настройки — как в Winamp и музыкальных программах (значения —
 * классические пресеты Winamp, округлены до 0,5 дБ и обрезаны до ±12 дБ).
 * «Своя настройка» — это то, что человек накрутил руками, её в списке
 * пресетов нет: она появляется сама, стоит сдвинуть любой ползунок.
 */
export const EQ_PRESETS: EqPreset[] = [
  { id: 'flat', name: 'По умолчанию', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'classical', name: 'Классическая музыка', gains: [0, 0, 0, 0, 0, 0, -7, -7, -7, -9.5] },
  { id: 'club', name: 'Клубная музыка', gains: [0, 0, 8, 5.5, 5.5, 5.5, 3, 0, 0, 0] },
  { id: 'dance', name: 'Танцевальная музыка', gains: [9.5, 7, 2.5, 0, 0, -5.5, -7, -7, 0, 0] },
  { id: 'bass', name: 'Усиление НЧ', gains: [9.5, 9.5, 9.5, 5.5, 1.5, -4, -8, -10.5, -11, -11] },
  { id: 'bass-treble', name: 'Усиление НЧ и ВЧ', gains: [7, 5.5, 0, -7, -5, 1.5, 8, 11, 12, 12] },
  { id: 'treble', name: 'Усиление ВЧ', gains: [-9.5, -9.5, -9.5, -4, 2.5, 11, 12, 12, 12, 12] },
  { id: 'laptop', name: 'Колонки ноутбука', gains: [5, 11, 5.5, -3, -2.5, 1.5, 5, 9.5, 12, 12] },
  { id: 'hall', name: 'Большой зал', gains: [10.5, 10.5, 5.5, 5.5, 0, -5, -5, -5, 0, 0] },
];
/** Не пресет, а своё — так подписываем, когда полосы накручены руками. */
export const EQ_CUSTOM_ID = 'custom';

function clampDb(raw: unknown, lo: number, hi: number): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, Math.round(v * 2) / 2));
}

/**
 * Полосы эквалайзера из настроек. Нет массива — переводим старый тембр:
 * «низкие» ложатся на 60 и 170 Гц, «высокие» — на 6–16 кГц (там же, где
 * работали прежние фильтры bass/treble).
 */
export function clampEq(raw: unknown, legacyBassDb?: unknown, legacyTrebleDb?: unknown): number[] {
  if (Array.isArray(raw)) return EQ_BANDS_HZ.map((_, i) => clampDb(raw[i], EQ_DB_MIN, EQ_DB_MAX));
  const bass = clampDb(legacyBassDb, EQ_DB_MIN, EQ_DB_MAX);
  const treble = clampDb(legacyTrebleDb, EQ_DB_MIN, EQ_DB_MAX);
  return EQ_BANDS_HZ.map((hz) => (hz <= 170 ? bass : hz >= 6000 ? treble : 0));
}

/** Какой пресет совпадает с полосами; не совпал ни один — «своя настройка». */
export function eqPresetOf(eq: number[]): string {
  const p = EQ_PRESETS.find((x) => x.gains.every((g, i) => Math.abs(g - (eq[i] ?? 0)) < 0.01));
  return p ? p.id : EQ_CUSTOM_ID;
}

export function eqIsFlat(eq: number[] | undefined): boolean {
  return !eq || eq.every((g) => g === 0);
}

/**
 * Ширина полосы в октавах — до середины между соседями (в логарифме).
 * Полосы Winamp расставлены неравномерно: 12, 14 и 16 кГц стоят тесно, и с
 * одной октавой на каждую подъём трёх соседних сложился бы в +30 дБ.
 */
export function eqBandWidthOct(i: number): number {
  const f = EQ_BANDS_HZ[i]!;
  const prev = EQ_BANDS_HZ[i - 1];
  const next = EQ_BANDS_HZ[i + 1];
  const lo = prev ? Math.log2(f / prev) / 2 : Math.log2((next ?? f * 2) / f) / 2;
  const hi = next ? Math.log2(next / f) / 2 : lo;
  return Math.max(0.15, lo + hi);
}

/** Старый тембр: оставлено для перевода старых настроек и проверок. */
export const TONE_DB_MIN = -12;
export const TONE_DB_MAX = 6;
export function clampToneDb(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  return Math.max(TONE_DB_MIN, Math.min(TONE_DB_MAX, Math.round(v)));
}

/** «+3 дБ», «−6 дБ», «0 дБ» — со знаком: важно, подъём это или срез. */
export function toneDbLabel(db: number): string {
  const v = Math.round(Number(db) * 2) / 2;
  if (!Number.isFinite(v) || v === 0) return '0 дБ';
  const txt = Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  return v > 0 ? `+${txt} дБ` : `−${txt} дБ`;
}

export function clampVolumeDb(raw: number): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  return clampDb(v, VOLUME_DB_MIN, VOLUME_DB_MAX);
}

/**
 * Перевод из процентов, в которых громкость хранилась первые сутки
 * (22.09.2026): проценты — это амплитуда, 20·lg(p/100).
 */
export function levelFromPercent(percent: number): AudioLevel {
  const p = Number(percent);
  if (!Number.isFinite(p)) return { volumeDb: 0, muted: false };
  if (p <= 0) return { volumeDb: VOLUME_DB_MIN, muted: true };
  return { volumeDb: clampVolumeDb(20 * Math.log10(Math.min(100, p) / 100)), muted: false };
}

/** Громкость словами: «−6 дБ», «+3 дБ», «0 дБ», «звук выключен». */
export function volumeDbLabel(level: AudioLevel): string {
  if (level.muted) return 'звук выключен';
  return toneDbLabel(clampVolumeDb(level.volumeDb));
}
