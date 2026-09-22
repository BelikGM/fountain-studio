/**
 * Громкость вечерней программы — в децибелах, как привыкли фонтанщики.
 *
 * ── Почему децибелы, а не проценты ───────────────────────────────────────
 * В FontanPlay громкость показывалась в дБ, и заказчик прислал снимок её окна
 * как образец (22.09.2026). Проценты к тому же обманчивы: 50 % — это не «вдвое
 * тише на слух», а всего −6 дБ; на слух вдвое тише — примерно −10 дБ. Шкала в
 * дБ совпадает с тем, как звук слышится, и с тем, что написано на усилителе.
 *
 * 0 дБ — исходный уровень файла. Выше не поднимаем: современные треки сведены
 * почти в потолок, и любое усиление сверх исходного даёт перегруз — на объекте
 * это слышно как хрип в колонках. Кому мало — крутить усилитель.
 *
 * ── Почему нет «частоты» ─────────────────────────────────────────────────
 * В том же окне FontanPlay был ползунок «Friq 44100 Гц». По самой программе
 * видно, что это: звук там играет библиотека BASS, а у ползунка есть кнопка
 * «вернуть на середину». Это скорость воспроизведения — 44100 Гц обычная
 * частота файла, сдвиг ускоряет трек и одновременно повышает тон («пластинка не
 * на той скорости»). Трек звучит испорченно и уезжает от воды, поэтому такого
 * ползунка здесь сознательно нет.
 */

/** Тише −40 дБ на улице уже не слышно; дальше — только «звук выключен». */
export const VOLUME_DB_MIN = -40;
export const VOLUME_DB_MAX = 0;

export interface AudioLevel {
  /** −40…0 дБ, шаг 0,5. 0 — как в файле. */
  volumeDb: number;
  /** Звук выключен совсем — как «Volume is OFF» в FontanPlay. */
  muted: boolean;
  /** Низкие частоты, дБ (−12…+6). 0 — как в файле. */
  bassDb?: number;
  /** Высокие частоты, дБ (−12…+6). 0 — как в файле. */
  trebleDb?: number;
}

/**
 * Тембр — низкие и высокие частоты, как ручки «Bass» и «Treble» на усилителе.
 *
 * Зачем: колонки на объектах разные — где-то бубнит низ, где-то режут верха, —
 * и подстроить звук под место нужно без усилителя под рукой. Появилось после
 * разбора «частоты» из FontanPlay (22.09.2026): её не делаем (это скорость и
 * тон трека), а тембр на синхронизацию с водой не влияет вовсе.
 *
 * Срез −12 дБ — почти убрать; подъём до +6 дБ — заметно добавить. Сильнее
 * поднимать нельзя: даже с защитой от перегруза на громком треке звук начнёт
 * сжиматься, и «добавленный» низ съест громкость остального.
 */
export const TONE_DB_MIN = -12;
export const TONE_DB_MAX = 6;
/** Где начинаются «низкие» и «высокие», Гц — как у ручек тембра на усилителе. */
export const BASS_HZ = 100;
export const TREBLE_HZ = 6000;

export function clampToneDb(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  return Math.max(TONE_DB_MIN, Math.min(TONE_DB_MAX, Math.round(v)));
}

/** «+3 дБ», «−6 дБ», «0 дБ» — со знаком: у тембра важно, подъём это или срез. */
export function toneDbLabel(db: number): string {
  const v = clampToneDb(db);
  return v === 0 ? '0 дБ' : v > 0 ? `+${v} дБ` : `−${Math.abs(v)} дБ`;
}

export function clampVolumeDb(raw: number): number {
  const v = Number(raw);
  if (!Number.isFinite(v)) return VOLUME_DB_MAX;
  return Math.max(VOLUME_DB_MIN, Math.min(VOLUME_DB_MAX, Math.round(v * 2) / 2));
}

/**
 * Перевод из процентов, в которых громкость хранилась первые сутки
 * (22.09.2026): проценты — это амплитуда, 20·lg(p/100).
 */
export function levelFromPercent(percent: number): AudioLevel {
  const p = Number(percent);
  if (!Number.isFinite(p)) return { volumeDb: VOLUME_DB_MAX, muted: false };
  if (p <= 0) return { volumeDb: VOLUME_DB_MIN, muted: true };
  return { volumeDb: clampVolumeDb(20 * Math.log10(Math.min(100, p) / 100)), muted: false };
}

/** Громкость словами: «−6 дБ», «0 дБ», «выключен». */
export function volumeDbLabel(level: AudioLevel): string {
  if (level.muted) return 'звук выключен';
  const db = clampVolumeDb(level.volumeDb);
  const txt = Math.abs(db).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  return db === 0 ? '0 дБ' : `−${txt} дБ`;
}
