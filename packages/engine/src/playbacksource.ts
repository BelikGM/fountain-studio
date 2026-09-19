/**
 * Откуда движок берёт уровни воспроизведения — общий интерфейс и протокол
 * обмена с worker-потоком.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 * Такты расчёта и отправки уже разделены (19.09.2026), но поток Node один: если
 * расчёт заблокирует event loop (тяжёлое шоу, сборка мусора, антивирус заморозил
 * процесс), встанут ОБА такта, и поток в линию всё равно прервётся. Полная
 * развязка — считать воспроизведение в отдельном потоке, а в главном оставить
 * только сборку кадра и отправку.
 *
 * ── Что уносится в поток, а что нет ───────────────────────────────────────
 * УНОСИТСЯ только воспроизведение: сцены, секвенсоры, шоу, плейлисты,
 * огибающие. Это самая тяжёлая часть и единственная, которая целиком
 * определяется временем.
 *
 * НЕ УНОСИТСЯ ничего, что человек крутит руками: ручная консоль, ветер,
 * служебное освещение, калибровка, тест-генератор, аварийное отключение,
 * переадресация. Они применяются в ГЛАВНОМ потоке поверх присланных уровней —
 * иначе фейдер оператора начал бы отставать на задержку обмена между потоками,
 * а «стоп» доходил бы до линии позже, чем нажат.
 *
 * ── Почему поток ведёт часы САМ ───────────────────────────────────────────
 * Если бы главный поток каждый тик присылал «посчитай на такое-то время», то
 * заблокированный главный поток остановил бы и расчёт — то есть ровно то, от
 * чего мы уходим. Поэтому у потока свой тикер и свои часы, а главный поток
 * присылает только поправки: пауза, снятие паузы и позиция звука.
 *
 * ── Как передаются кадры ──────────────────────────────────────────────────
 * Через `SharedArrayBuffer` — без копирования и без сообщений. Читать
 * полукадр нельзя, поэтому применён seqlock: перед записью поток увеличивает
 * счётчик (он становится нечётным), после записи увеличивает снова. Читатель
 * запоминает счётчик, копирует, сверяет счётчик: изменился или был нечётным —
 * значит прочитано вперемешку, берём прошлый кадр. Ни блокировок, ни ожидания:
 * главный поток никогда не встаёт в ожидании расчёта, а это и есть цель.
 */

import type { PlaybackState, Project, Show } from '@fountain-studio/shared';
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';

/**
 * Всё, что движку нужно от воспроизведения. Реализуют двое: `Playback` (здесь
 * же, в главном потоке — проверенный путь) и `WorkerPlayback` (в отдельном
 * потоке). Движок между ними не различает.
 */
export interface PlaybackSource {
  setUniverses(ids: number[]): void;
  setProject(project: Project): void;
  /**
   * Продвинуть воспроизведение к этому моменту. У `Playback` здесь и происходит
   * весь расчёт; у `WorkerPlayback` — только сверка часов, потому что считает
   * поток сам.
   */
  tick(nowMs: number): void;
  levels(universeId: number): Uint8Array | undefined;
  state(nowMs: number, pausedAll: boolean): PlaybackState;
  /** Растёт при любом изменении состояния — сигнал серверу разослать его. */
  readonly version: number;
  onShowAudio: ((show: Show | null) => void) | null;

  setScene(sceneId: string | null, nowMs: number): void;
  start(sequenceId: string, nowMs: number): void;
  pause(sequenceId: string, nowMs: number): void;
  resume(sequenceId: string, nowMs: number): void;
  stop(sequenceId: string): void;
  startGroup(groupId: string, nowMs: number): void;
  stopGroup(groupId: string): void;
  pauseGroup(groupId: string, nowMs: number): void;
  resumeGroup(groupId: string, nowMs: number): void;
  stopAll(): void;
  playPlaylist(playlistId: string, itemIndex: number | undefined, nowMs: number): void;
  skipPlaylist(dir: 1 | -1, nowMs: number): void;
  stopPlaylist(): void;
  playShow(showId: string, positionMs: number, nowMs: number): void;
  pauseShow(nowMs: number): void;
  seekShow(positionMs: number, nowMs: number): void;
  syncShow(positionMs: number, nowMs: number): void;
  stopShow(): void;

  /**
   * Пауза всего: у обоих реализаций часы воспроизведения замирают. У потока
   * это надо сообщить отдельно — он ведёт часы сам.
   */
  setPausedAll(paused: boolean): void;

  /**
   * Всё ли в порядке с источником. false у `WorkerPlayback`, когда поток умер:
   * движок обязан уйти в аварийное отключение, а не тянуть последний кадр.
   * У `Playback` всегда true — ломаться там нечему отдельно от процесса.
   */
  readonly healthy: boolean;

  /** Закрыть источник (остановить поток). Для `Playback` — ничего. */
  dispose(): void;
}

// ══ Раскладка общей памяти ═════════════════════════════════════════════════

/**
 * Сколько вселенных вмещает общий буфер. Взято с запасом: ограничения на число
 * вселенных в программе нет, но 64 линии DMX — это 32 тысячи каналов, столько
 * не бывает даже на очень больших объектах, а буфер на них весит 32 КБ.
 */
export const WORKER_MAX_UNIVERSES = 64;

/** Слова заголовка (Int32) перед полем кадров. */
export const enum WorkerHeader {
  /** Счётчик seqlock: нечётный — идёт запись. */
  Seq = 0,
  /** Сколько вселенных сейчас заполнено. */
  Count = 1,
  /**
   * Сколько тиков поток посчитал. По нему главный поток видит, что расчёт
   * идёт: счётчик перестал расти — значит поток встал или умер. Переполнение
   * int32 безобидно: сравнивается только «изменился или нет».
   */
  Ticks = 2,
  Size = 3,
}

/** Размер общего буфера, байт. */
export function workerBufferBytes(): number {
  return WorkerHeader.Size * 4 + WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE;
}

/** Смещение поля кадров в буфере, байт. */
export const WORKER_FRAMES_OFFSET = WorkerHeader.Size * 4;

// ══ Сообщения ══════════════════════════════════════════════════════════════

/** Команда главного потока воркеру. Имена — как у методов Playback. */
export type WorkerCommand =
  | { c: 'setUniverses'; ids: number[] }
  | { c: 'setProject'; project: Project }
  | { c: 'setPausedAll'; paused: boolean }
  | { c: 'setScene'; sceneId: string | null }
  | { c: 'start'; id: string }
  | { c: 'pause'; id: string }
  | { c: 'resume'; id: string }
  | { c: 'stop'; id: string }
  | { c: 'startGroup'; id: string }
  | { c: 'stopGroup'; id: string }
  | { c: 'pauseGroup'; id: string }
  | { c: 'resumeGroup'; id: string }
  | { c: 'stopAll' }
  | { c: 'playPlaylist'; id: string; itemIndex: number | undefined }
  | { c: 'skipPlaylist'; dir: 1 | -1 }
  | { c: 'stopPlaylist' }
  | { c: 'playShow'; id: string; positionMs: number }
  | { c: 'pauseShow' }
  | { c: 'seekShow'; positionMs: number }
  | { c: 'syncShow'; positionMs: number }
  | { c: 'stopShow' }
  | { c: 'shutdown' };

/** Ответ воркера главному потоку. */
export type WorkerEvent =
  /** Состояние воспроизведения — присылается, когда изменилось. */
  | { e: 'state'; state: PlaybackState; version: number }
  /** Пора запустить или остановить системный аудиоплеер (он в главном потоке). */
  | { e: 'showAudio'; show: Show | null }
  /** Поток поднялся и готов считать. */
  | { e: 'ready' }
  /** Поток поймал ошибку, но продолжает работать — в журнал. */
  | { e: 'warn'; text: string };

/** Что воркер получает при создании. */
export interface WorkerInit {
  buffer: SharedArrayBuffer;
  universeIds: number[];
  tickMs: number;
  spinMs: number;
}

/**
 * Собрать источник уровней: в отдельном потоке, если так настроено и если поток
 * удалось поднять, иначе — проверенным путём в главном потоке.
 *
 * Запасной вариант тут не «на всякий случай», а по делу: поток может не
 * подняться из-за раскладки файлов в собранном приложении или из-за политики
 * запуска на машине объекта. Фонтан в этом случае должен играть как играл, а не
 * стоять — поэтому отказ потока это запись в журнал, а не остановка.
 */
export function createPlaybackSource(
  useWorker: boolean,
  universeIds: number[],
  tickMs: number,
  spinMs: number,
  make: {
    inline: (ids: number[]) => PlaybackSource;
    worker: (tickMs: number, spinMs: number, ids: number[]) => PlaybackSource;
    log: (text: string, level?: 'info' | 'warn' | 'error') => void;
  },
): PlaybackSource {
  if (!useWorker) return make.inline(universeIds);
  try {
    return make.worker(tickMs, spinMs, universeIds);
  } catch (err) {
    make.log(`не удалось поднять поток расчёта (${String(err)}) — считаю в главном потоке`, 'warn');
    return make.inline(universeIds);
  }
}
