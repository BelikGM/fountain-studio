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
  workerGridMs,
  workerLayout,
  workerSlotIndex,
  workerSlots,
  WorkerHeader,
  WORKER_LOOKAHEAD_MS,
  WORKER_MAX_UNIVERSES,
  type WorkerLayout,
  type PlaybackSource,
  type WorkerCommand,
  type WorkerCommandBody,
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
  // CommonJS (собранный engine.cjs): __dirname — переменная МОДУЛЯ, а не
  // глобальная. Прежняя проверка globalThis.__dirname её не видела, путь
  // уходил в process.cwd(), и в установленной программе поток расчёта не
  // поднимался никогда — движок молча считал одним потоком. Поймано
  // 23.09.2026 проверкой собранного приложения (npm run app-test).
  if (typeof __dirname === 'string') return __dirname;
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
  private readonly layout: WorkerLayout;
  private readonly slotSeq: Int32Array;
  private readonly slotTarget: Float64Array;
  private readonly slotData: Uint8Array;
  /** Последний целиком прочитанный кадр на вселенную — отдаём его движку. */
  private readonly lastGood = new Map<number, Uint8Array>();
  /** На какое время был кадр, который мы отдаём сейчас. */
  private lastTakenTarget = -1;
  /**
   * Сколько раз кадра на нужный момент не оказалось и пришлось повторить
   * прежний. Ради этого предрасчёт и делался — по этому числу видно, помогает
   * ли он (см. stats движка).
   */
  private repeats = 0;
  private taken = 0;
  /**
   * До какого момента (стенные часы) глушим вклад воспроизведения. 0 — не глушим.
   *
   * Это главный ответ на возражение против предрасчёта: «стоп» не должен ждать
   * буфер. Отменить уже посчитанные кадры нельзя (воспроизведение не
   * отматывается назад), но ВНИЗ главный поток может всегда: отдаём движку
   * пустые уровни, и вода уходит в тот же тик.
   *
   * Держим заглушку ПО ВРЕМЕНИ, а не по подтверждению от потока, и это важно:
   * поток разбирает команду сразу, его состояние мгновенно становится «ничего
   * не играет», а кадры на запас вперёд ещё лежат старые. Снимать заглушку по
   * состоянию значило бы вернуть в линию как раз то, что человек остановил, —
   * ровно это и поймала самопроверка.
   */
  private muteUntilMs = 0;
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
  /** Отложенный старт звука — см. startAudio. */
  private audioTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  onShowAudio: ((show: Show | null) => void) | null = null;

  constructor(
    private readonly file: string,
    private readonly tickMs: number,
    private readonly spinMs: number,
    universeIds: number[],
    private readonly lookaheadMs: number,
  ) {
    this.layout = workerLayout(workerSlots(tickMs, lookaheadMs));
    this.buffer = new SharedArrayBuffer(this.layout.bytes);
    this.header = new Int32Array(this.buffer, 0, WorkerHeader.Size);
    this.slotSeq = new Int32Array(this.buffer, this.layout.seqOffset, this.layout.slots);
    this.slotTarget = new Float64Array(this.buffer, this.layout.targetOffset, this.layout.slots);
    this.slotData = new Uint8Array(
      this.buffer,
      this.layout.dataOffset,
      this.layout.slots * WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE,
    );
    this.universeIds = [...universeIds];
    this.spawn();
  }

  /**
   * Создать поток. Бросает, если не получилось: точка сборки поймает и перейдёт
   * на расчёт в главном потоке.
   */
  static create(tickMs: number, spinMs: number, universeIds: number[], lookaheadMs = WORKER_LOOKAHEAD_MS): WorkerPlayback {
    const file = resolveWorkerFile();
    if (!file) throw new Error('не найден файл потока расчёта (playback-worker.cjs / playbackworker.ts)');
    return new WorkerPlayback(file, tickMs, spinMs, universeIds, lookaheadMs);
  }

  private spawn(): void {
    const init: WorkerInit = {
      buffer: this.buffer,
      universeIds: this.universeIds,
      tickMs: this.tickMs,
      spinMs: this.spinMs,
      lookaheadMs: this.lookaheadMs,
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
        this.startAudio(e.show);
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

  /**
   * Отправить команду, поставив ей стенное время. Время нужно воркеру, чтобы
   * сдвинуть позицию на глубину запаса (см. WorkerCommand).
   */
  /**
   * Запуск и остановка звука с поправкой на глубину запаса.
   *
   * Поток сообщает «пора играть шоу» в тот момент, когда РАЗОБРАЛ команду, а
   * свет этого шоу появится на линии на глубину запаса позже: кадры до этого
   * момента уже посчитаны и переписать их нельзя. Если запустить звук сразу,
   * музыка ушла бы вперёд света ровно на запас — а это самое заметное, что
   * можно испортить в светомузыкальном фонтане.
   *
   * Поэтому СТАРТ задерживаем на ту же глубину, и начало сходится точно.
   * ОСТАНОВКА идёт немедленно: тишина раньше времени — мелочь, а музыка,
   * играющая после «стоп», — нет. Ожидающий старт при остановке снимается,
   * иначе звук включился бы уже после того, как всё остановили.
   */
  private startAudio(show: Show | null): void {
    if (this.audioTimer) {
      clearTimeout(this.audioTimer);
      this.audioTimer = null;
    }
    if (!show) {
      this.onShowAudio?.(null);
      return;
    }
    const delay = this.lookaheadMs + this.tickMs;
    if (delay <= 0) {
      this.onShowAudio?.(show);
      return;
    }
    this.audioTimer = setTimeout(() => {
      this.audioTimer = null;
      this.onShowAudio?.(show);
    }, delay);
    this.audioTimer.unref?.();
  }

  private send(c: WorkerCommandBody): void {
    this.worker?.postMessage({ ...c, atMs: Date.now() } as WorkerCommand);
  }

  /**
   * Команда «всё выключить»: заглушаем вклад воспроизведения сразу и ждём
   * подтверждения от потока. Без этого «стоп» ждал бы конца посчитанного
   * запаса — до 200 мс воды, которую человек уже остановил.
   */
  private sendAndMute(c: WorkerCommandBody): void {
    // Запас плюс два такта: за это время все уже посчитанные кадры уйдут в
    // линию, и дальше пойдут те, что поток посчитал уже с учётом команды.
    this.muteUntilMs = Date.now() + this.lookaheadMs + 2 * this.tickMs;
    this.send(c);
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
   * Забрать из кольца кадр НА ЭТОТ МОМЕНТ. Поток считает сам и с запасом
   * вперёд, поэтому здесь только чтение общей памяти — оно никогда не ждёт.
   *
   * Кадр ищется не «последний посчитанный», а ровно на текущий момент сетки: в
   * этом и смысл предрасчёта. Не нашёлся (поток запнулся, кольцо ещё не
   * заполнено) — пробуем предыдущие моменты, и только если и там ничего,
   * повторяем прошлый кадр и считаем это в `repeats`.
   */
  tick(_nowMs: number): void {
    const produced = Atomics.load(this.header, WorkerHeader.Produced);
    if (produced === this.lastTicks) {
      // Поток не посчитал ни одного кадра с прошлого раза. Одиночный пропуск —
      // обычное дело (сборка мусора), долгий — уже авария (см. STALL_TICKS).
      this.sameTicks++;
    } else {
      this.lastTicks = produced;
      this.sameTicks = 0;
    }

    const want = workerGridMs(Date.now(), this.tickMs);
    this.taken++;
    // Назад смотрим не дальше, чем на длину кольца: дальше лежат уже
    // перезаписанные ячейки от прошлых оборотов.
    for (let back = 0; back < this.layout.slots - 1; back++) {
      const target = want - back * this.tickMs;
      if (target <= this.lastTakenTarget && back > 0) break;
      if (this.readSlot(target)) {
        this.lastTakenTarget = target;
        if (back > 0) this.repeats++;
        return;
      }
    }
    this.repeats++;
  }

  /** Прочитать ячейку на это время. false — там не тот кадр или идёт запись. */
  private readSlot(target: number): boolean {
    const i = workerSlotIndex(target, this.tickMs, this.layout.slots);
    const seq1 = Atomics.load(this.slotSeq, i);
    if (seq1 % 2 !== 0) return false; // поток пишет прямо сейчас
    if (this.slotTarget[i] !== target) return false; // в ячейке кадр другого момента
    const count = Math.min(Atomics.load(this.header, WorkerHeader.Count), WORKER_MAX_UNIVERSES);
    const base = i * WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE;
    const staging: Uint8Array[] = [];
    for (let k = 0; k < count; k++) {
      const at = base + k * DMX_UNIVERSE_SIZE;
      staging.push(this.slotData.slice(at, at + DMX_UNIVERSE_SIZE));
    }
    if (Atomics.load(this.slotSeq, i) !== seq1) return false; // прочитали вперемешку
    for (let k = 0; k < count; k++) {
      const id = this.universeIds[k];
      if (id === undefined) continue;
      this.lastGood.set(id, staging[k]!);
    }
    return true;
  }

  seed(levels: ReadonlyMap<number, Uint8Array>, state: PlaybackState): void {
    for (const id of this.universeIds) {
      const v = levels.get(id);
      // Копия: прежний источник свой буфер ещё может переписать или отдать.
      if (v && !this.lastGood.has(id)) this.lastGood.set(id, Uint8Array.from(v));
    }
    // Своё состояние поток пришлёт через миллисекунды и перезапишет это.
    if (!this.cachedState) this.cachedState = state;
  }

  levels(universeId: number): Uint8Array | undefined {
    // Заглушка после «стоп»: вниз главный поток может немедленно, не дожидаясь,
    // пока кончится посчитанный запас.
    if (Date.now() < this.muteUntilMs) return undefined;
    return this.lastGood.get(universeId);
  }

  /** Сколько раз пришлось повторить кадр и сколько всего кадров взято. */
  frameStats(): { repeats: number; taken: number } {
    return { repeats: this.repeats, taken: this.taken };
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
    if (sceneId === null) this.sendAndMute({ c: 'setScene', sceneId });
    else this.send({ c: 'setScene', sceneId });
  }
  start(id: string): void {
    this.send({ c: 'start', id });
  }
  startAt(id: string, stepIndex: number, paused: boolean): void {
    this.send({ c: 'startAt', id, stepIndex, paused });
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
    this.sendAndMute({ c: 'stopAll' });
  }
  playPlaylist(id: string, itemIndex: number | undefined): void {
    this.send({ c: 'playPlaylist', id, itemIndex });
  }
  skipPlaylist(dir: 1 | -1): void {
    this.send({ c: 'skipPlaylist', dir });
  }
  stopPlaylist(): void {
    this.sendAndMute({ c: 'stopPlaylist' });
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
    this.sendAndMute({ c: 'stopShow' });
  }

  dispose(): void {
    this.disposed = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    if (this.audioTimer) clearTimeout(this.audioTimer);
    this.send({ c: 'shutdown' });
    void this.worker?.terminate();
    this.worker = null;
  }
}
