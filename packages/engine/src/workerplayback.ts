/**
 * Воспроизведение, посчитанное в ОТДЕЛЬНОМ потоке. Сторона главного потока.
 *
 * Снаружи выглядит ровно как `Playback` (см. `PlaybackSource`), поэтому движок
 * не знает, где считается кадр. Внутри — worker_threads, общая память с seqlock
 * и обмен сообщениями; разбор устройства и причин — в `playbacksource.ts`.
 *
 * ── Что происходит, если поток не поднялся ────────────────────────────────
 * Ничего страшного: движок остаётся на проверенном пути. Решение о запасном
 * варианте принимает не этот класс, а точка сборки (см. createPlaybackSource):
 * не удалось создать поток — работаем прежним способом в главном потоке, и в
 * журнал уходит причина. Фонтан при этом играет как играл.
 *
 * ── Что происходит, если поток УМЕР на ходу ───────────────────────────────
 * Это другое дело: состояние воспроизведения потеряно, и «доиграть» его
 * главному потоку неоткуда — он не знает, где была середина шоу. Поэтому
 * healthy становится false, движок уходит в аварийное отключение (вода вниз), а
 * поток поднимается заново и остаётся БЕЗ воспроизведения. Угадывать позицию
 * шоу и «продолжать» её было бы хуже: на объекте это выглядело бы как прыжок
 * картинки, а вода при этом уже могла лить не туда.
 */

import path from 'node:path';
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { DMX_UNIVERSE_SIZE, type PlaybackState, type Project, type Show } from '@fountain-studio/shared';
import { eventLog } from './eventlog';
import {
  workerBufferBytes,
  WorkerHeader,
  WORKER_FRAMES_OFFSET,
  WORKER_MAX_UNIVERSES,
  type PlaybackSource,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerInit,
} from './playbacksource';

/**
 * Сколько тиков подряд счётчик потока может не расти, прежде чем считать поток
 * вставшим. При такте 50 мс это 1 секунда — короче ставить нельзя: сборка
 * мусора в потоке иногда занимает десятки миллисекунд, и объявлять аварию из-за
 * неё значило бы гасить воду на ровном месте.
 */
const STALL_TICKS = 20;

/** Через сколько после смерти потока пробуем поднять его заново, мс. */
const RESPAWN_DELAY_MS = 2000;

/**
 * Папка этого модуля — и в собранном приложении, и в разработке.
 *
 * Две ветки нужны потому, что движок живёт в двух видах сразу: в разработке его
 * запускает tsx как модули ESM (там есть `import.meta.url`, но нет
 * `__dirname`), а в установщик он попадает одним бандлом CommonJS (там
 * наоборот). Ошибиться нельзя: без правильного пути поток просто не поднимется,
 * и развязка молча не заработает.
 */
function moduleDir(): string {
  const g = globalThis as { __dirname?: string };
  if (typeof g.__dirname === 'string') return g.__dirname;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const url = import.meta?.url;
    if (url) return path.dirname(new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    // сборка в CommonJS: import.meta недоступен — сюда мы и не попадём
  }
  return process.cwd();
}

/**
 * Где лежит файл потока. В собранном приложении рядом с engine.cjs лежит
 * playback-worker.cjs (см. packages/app/package.json), в разработке — исходник
 * на TypeScript рядом с этим файлом.
 */
function resolveWorkerFile(): string | null {
  const here = moduleDir();
  const candidates = [
    process.env.FS_PLAYBACK_WORKER,
    path.join(here, 'playback-worker.cjs'),
    path.join(here, 'playbackworker.ts'),
  ].filter((p): p is string => typeof p === 'string' && p !== '');
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // недоступный путь — просто пробуем следующий
    }
  }
  return null;
}

export class WorkerPlayback implements PlaybackSource {
  private worker: Worker | null = null;
  private readonly buffer: SharedArrayBuffer;
  private readonly header: Int32Array;
  private readonly frames: Uint8Array;
  /** Последний целиком прочитанный кадр на вселенную — отдаём его движку. */
  private readonly lastGood = new Map<number, Uint8Array>();
  private universeIds: number[] = [];
  /** Проект помним, чтобы восстановить поток после смерти. */
  private project: Project | null = null;
  private pausedAll = false;
  private cachedState: PlaybackState | null = null;
  private cachedVersion = 0;
  private dead = false;
  private lastTicks = -1;
  private sameTicks = 0;
  private respawnTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  onShowAudio: ((show: Show | null) => void) | null = null;

  constructor(
    private readonly file: string,
    private readonly tickMs: number,
    private readonly spinMs: number,
    universeIds: number[],
  ) {
    this.buffer = new SharedArrayBuffer(workerBufferBytes());
    this.header = new Int32Array(this.buffer, 0, WorkerHeader.Size);
    this.frames = new Uint8Array(this.buffer, WORKER_FRAMES_OFFSET, WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE);
    this.universeIds = [...universeIds];
    this.spawn();
  }

  /**
   * Создать поток. Бросает, если не получилось: точка сборки поймает и перейдёт
   * на расчёт в главном потоке.
   */
  static create(tickMs: number, spinMs: number, universeIds: number[]): WorkerPlayback {
    const file = resolveWorkerFile();
    if (!file) throw new Error('не найден файл потока расчёта (playback-worker.cjs / playbackworker.ts)');
    return new WorkerPlayback(file, tickMs, spinMs, universeIds);
  }

  private spawn(): void {
    const init: WorkerInit = {
      buffer: this.buffer,
      universeIds: this.universeIds,
      tickMs: this.tickMs,
      spinMs: this.spinMs,
    };
    const w = new Worker(this.file, {
      workerData: init,
      // В разработке поток запускается из TypeScript — ему нужен тот же
      // загрузчик, с которым поднят главный поток (tsx). В собранном
      // приложении это обычный .cjs, и execArgv пустой.
      execArgv: this.file.endsWith('.ts') ? process.execArgv : [],
    });
    w.on('message', (e: WorkerEvent) => this.onEvent(e));
    w.on('error', (err) => this.onDeath(`ошибка потока расчёта: ${String(err)}`));
    w.on('exit', (code) => {
      if (this.disposed) return;
      this.onDeath(`поток расчёта завершился (код ${code})`);
    });
    // Поток не должен держать процесс живым сам по себе: движок закрывается по
    // своим правилам, а не ждёт воркер.
    w.unref();
    this.worker = w;
    this.dead = false;
    this.lastTicks = -1;
    this.sameTicks = 0;
    if (this.project) this.send({ c: 'setProject', project: this.project });
    if (this.pausedAll) this.send({ c: 'setPausedAll', paused: true });
  }

  private onEvent(e: WorkerEvent): void {
    switch (e.e) {
      case 'state':
        this.cachedState = e.state;
        this.cachedVersion = e.version;
        return;
      case 'showAudio':
        this.onShowAudio?.(e.show);
        return;
      case 'ready':
        eventLog.log('engine', 'расчёт кадра идёт в отдельном потоке');
        return;
      case 'warn':
        eventLog.log('engine', `поток расчёта: ${e.text}`, 'warn');
        return;
    }
  }

  private onDeath(reason: string): void {
    if (this.disposed || this.dead) return;
    this.dead = true;
    this.worker = null;
    eventLog.log('engine', `${reason} — воспроизведение остановлено, поднимаю поток заново`, 'error');
    // Состояние воспроизведения потеряно: честно показываем «ничего не играет»,
    // а не последнее известное — иначе редактор будет рисовать идущее шоу,
    // которого нет.
    this.cachedState = null;
    this.lastGood.clear();
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.disposed) return;
      try {
        this.spawn();
      } catch (err) {
        eventLog.log('engine', `не удалось поднять поток расчёта: ${String(err)}`, 'error');
      }
    }, RESPAWN_DELAY_MS);
    this.respawnTimer.unref?.();
  }

  private send(c: WorkerCommand): void {
    this.worker?.postMessage(c);
  }

  // ── PlaybackSource ───────────────────────────────────────────────────────

  get healthy(): boolean {
    return !this.dead && this.sameTicks < STALL_TICKS;
  }

  get version(): number {
    return this.cachedVersion;
  }

  setUniverses(ids: number[]): void {
    this.universeIds = [...ids];
    this.lastGood.clear();
    this.send({ c: 'setUniverses', ids });
  }

  setProject(project: Project): void {
    this.project = project;
    this.send({ c: 'setProject', project });
  }

  /**
   * Забрать последний готовый кадр. Поток считает сам, поэтому здесь только
   * чтение общей памяти — и оно никогда не ждёт.
   */
  tick(_nowMs: number): void {
    const ticks = Atomics.load(this.header, WorkerHeader.Ticks);
    if (ticks === this.lastTicks) {
      // Поток не посчитал ни одного кадра с прошлого раза. Одиночный пропуск —
      // обычное дело (сборка мусора), долгий — уже авария (см. STALL_TICKS).
      this.sameTicks++;
      return;
    }
    this.lastTicks = ticks;
    this.sameTicks = 0;

    const seq1 = Atomics.load(this.header, WorkerHeader.Seq);
    if (seq1 % 2 !== 0) return; // поток пишет прямо сейчас — берём прошлый кадр
    const count = Math.min(Atomics.load(this.header, WorkerHeader.Count), WORKER_MAX_UNIVERSES);
    const staging: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const at = i * DMX_UNIVERSE_SIZE;
      staging.push(this.frames.slice(at, at + DMX_UNIVERSE_SIZE));
    }
    if (Atomics.load(this.header, WorkerHeader.Seq) !== seq1) return; // прочитали вперемешку
    for (let i = 0; i < count; i++) {
      const id = this.universeIds[i];
      if (id === undefined) continue;
      this.lastGood.set(id, staging[i]!);
    }
  }

  levels(universeId: number): Uint8Array | undefined {
    return this.lastGood.get(universeId);
  }

  state(nowMs: number, pausedAll: boolean): PlaybackState {
    if (this.cachedState) return { ...this.cachedState, pausedAll };
    // Поток ещё не прислал состояние (первые миллисекунды) или умер. Честно
    // отвечаем «ничего не играет»: выдумывать здесь нечего.
    return { pausedAll, activeSceneId: null, running: [], show: null, playlist: null };
  }

  setPausedAll(paused: boolean): void {
    this.pausedAll = paused;
    this.send({ c: 'setPausedAll', paused });
  }

  setScene(sceneId: string | null): void {
    this.send({ c: 'setScene', sceneId });
  }
  start(id: string): void {
    this.send({ c: 'start', id });
  }
  pause(id: string): void {
    this.send({ c: 'pause', id });
  }
  resume(id: string): void {
    this.send({ c: 'resume', id });
  }
  stop(id: string): void {
    this.send({ c: 'stop', id });
  }
  startGroup(id: string): void {
    this.send({ c: 'startGroup', id });
  }
  stopGroup(id: string): void {
    this.send({ c: 'stopGroup', id });
  }
  pauseGroup(id: string): void {
    this.send({ c: 'pauseGroup', id });
  }
  resumeGroup(id: string): void {
    this.send({ c: 'resumeGroup', id });
  }
  stopAll(): void {
    this.send({ c: 'stopAll' });
  }
  playPlaylist(id: string, itemIndex: number | undefined): void {
    this.send({ c: 'playPlaylist', id, itemIndex });
  }
  skipPlaylist(dir: 1 | -1): void {
    this.send({ c: 'skipPlaylist', dir });
  }
  stopPlaylist(): void {
    this.send({ c: 'stopPlaylist' });
  }
  playShow(id: string, positionMs: number): void {
    this.send({ c: 'playShow', id, positionMs });
  }
  pauseShow(): void {
    this.send({ c: 'pauseShow' });
  }
  seekShow(positionMs: number): void {
    this.send({ c: 'seekShow', positionMs });
  }
  syncShow(positionMs: number): void {
    this.send({ c: 'syncShow', positionMs });
  }
  stopShow(): void {
    this.send({ c: 'stopShow' });
  }

  dispose(): void {
    this.disposed = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.send({ c: 'shutdown' });
    void this.worker?.terminate();
    this.worker = null;
  }
}
