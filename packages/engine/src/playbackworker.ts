/**
 * Отдельный поток расчёта воспроизведения. Точка входа worker_threads.
 *
 * Здесь живёт `Playback` — сцены, секвенсоры, шоу, плейлисты, огибающие — и свой
 * тикер. Поток считает кадры НА ЗАПАС ВПЕРЁД и кладёт их в кольцо в общей
 * памяти, помечая каждый кадр временем, на которое он посчитан. Главный поток
 * берёт из кольца кадр ровно на свой момент и никогда не ждёт расчёта.
 *
 * Разбор устройства и причин — в `playbacksource.ts`.
 *
 * ── Ключевое: время одно на два потока ────────────────────────────────────
 * Раньше поток вёл собственный счёт тиков, а главный поток брал «последний
 * посчитанный кадр». Для предрасчёта так нельзя: чтобы взять кадр НА СВОЙ
 * МОМЕНТ, читателю нужна общая с писателем сетка времени. Сетка — стенные часы,
 * округлённые до такта: её одинаково видят оба потока, и сверять их не нужно.
 *
 * Внутреннее время воспроизведения при этом не равно стенному: пауза всего
 * останавливает его, накапливая pauseOffsetMs. Поэтому метка в ячейке — стенная
 * (по ней читает главный поток), а `Playback` получает стенную минус пауза.
 *
 * Про надёжность: этот поток не трогает ни сеть, ни диск, ни выходы на линию.
 * Всё, что он может, — посчитать кадр. Если он всё-таки упадёт, главный поток
 * это увидит (счётчик посчитанных кадров перестанет расти) и уйдёт в аварийное
 * отключение — см. WorkerPlayback.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';
import { Ticker } from './clock';
import { Playback } from './playback';
import {
  workerGridMs,
  workerLayout,
  workerSlotIndex,
  workerSlots,
  WorkerHeader,
  WORKER_MAX_UNIVERSES,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerInit,
} from './playbacksource';

const init = workerData as WorkerInit;
const port = parentPort;
if (!port) throw new Error('playbackworker: запущен не как worker_threads');

const layout = workerLayout(workerSlots(init.tickMs, init.lookaheadMs));
const header = new Int32Array(init.buffer, 0, WorkerHeader.Size);
const slotSeq = new Int32Array(init.buffer, layout.seqOffset, layout.slots);
const slotTarget = new Float64Array(init.buffer, layout.targetOffset, layout.slots);
const slotData = new Uint8Array(init.buffer, layout.dataOffset, layout.slots * WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE);
const SLOT_BYTES = WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE;

Atomics.store(header, WorkerHeader.Slots, layout.slots);
Atomics.store(header, WorkerHeader.TickMs, init.tickMs);

let universeIds = [...init.universeIds];
const playback = new Playback(universeIds);

/** Смена шоу в автономном воспроизведении — играть звук умеет только главный поток. */
playback.onShowAudio = (show) => post({ e: 'showAudio', show });

/**
 * Пауза всего: внутреннее время воспроизведения замирает. Реализовано как у
 * движка — не продвигать его, а накапливать «упущенное», чтобы после снятия
 * паузы шоу продолжилось с того же места, а не скачком вперёд.
 */
let pausedAll = false;
let pauseOffsetMs = 0;
/** На какое стенное время считаем следующий кадр. */
let nextTarget = workerGridMs(Date.now(), init.tickMs);
/** Внутреннее время воспроизведения последнего посчитанного кадра. */
let lastTimeline = nextTarget;
let lastVersion = -1;
let lastStateJson = '';

function post(e: WorkerEvent): void {
  port!.postMessage(e);
}

/** Стенное время → внутреннее время воспроизведения. */
function timelineOf(wallMs: number): number {
  return wallMs - pauseOffsetMs;
}

/**
 * Посчитать и записать кадр на момент `target` (стенные часы).
 *
 * Порядок записи важен: сначала делаем счётчик ячейки нечётным, потом пишем,
 * потом чётным. Читатель по нечётному счётчику или по изменившемуся значению
 * понимает, что прочитал вперемешку, и берёт прошлый кадр. Atomics нужны
 * именно для того, чтобы эти записи не переставились местами.
 */
function produce(target: number): void {
  const timeline = timelineOf(target);
  try {
    playback.tick(timeline);
  } catch (err) {
    // Ошибка расчёта одного кадра не должна валить поток целиком: уйдёт прошлый
    // кадр, а в журнал главного потока попадёт предупреждение. Падать тут —
    // значит гасить воду из-за одной битой сцены.
    post({ e: 'warn', text: `ошибка расчёта кадра: ${String(err)}` });
  }
  lastTimeline = timeline;

  const i = workerSlotIndex(target, init.tickMs, layout.slots);
  Atomics.add(slotSeq, i, 1);
  const count = Math.min(universeIds.length, WORKER_MAX_UNIVERSES);
  const base = i * SLOT_BYTES;
  for (let k = 0; k < count; k++) {
    const lv = playback.levels(universeIds[k]!);
    const at = base + k * DMX_UNIVERSE_SIZE;
    if (lv) slotData.set(lv, at);
    else slotData.fill(0, at, at + DMX_UNIVERSE_SIZE);
  }
  slotTarget[i] = target;
  Atomics.store(header, WorkerHeader.Count, count);
  Atomics.add(header, WorkerHeader.Produced, 1);
  Atomics.add(slotSeq, i, 1);
}

/**
 * Состояние отправляем ТОЛЬКО когда оно изменилось: главному потоку оно нужно,
 * чтобы разослать редакторам, а слать двадцать раз в секунду одно и то же —
 * впустую нагружать обмен между потоками.
 *
 * Сравниваем и по version, и по самому состоянию: version растёт на действиях
 * оператора, а позиция шоу меняется сама, без version.
 */
function publishState(): void {
  /*
   * Состояние считаем на момент, который СЕЙЧАС УХОДИТ В ЛИНИЮ, а не на самый
   * дальний посчитанный. Иначе позиция шоу в редакторе стояла бы на глубину
   * запаса впереди воды: перемотал на 1,0 с — а показывает 1,2 с. Это поймала
   * самопроверка, и это была настоящая ошибка, а не придирка теста.
   */
  const state = playback.state(timelineOf(workerGridMs(Date.now(), init.tickMs)), pausedAll);
  const json = JSON.stringify(state);
  if (playback.version === lastVersion && json === lastStateJson) return;
  lastVersion = playback.version;
  lastStateJson = json;
  post({ e: 'state', state, version: playback.version });
}

const ticker = new Ticker(init.tickMs, init.spinMs, () => {
  const now = Date.now();
  if (pausedAll) {
    // Пауза: стенное время идёт, внутреннее стоит. Кадры всё равно считаем —
    // картина должна держаться, а не пропадать из кольца.
    pauseOffsetMs += init.tickMs;
  }
  const horizon = now + init.lookaheadMs;

  // Отстали катастрофически (поток замирал) — не считаем тысячу кадров задним
  // числом, а перепрыгиваем на сетку от «сейчас». Воспроизведение переживает
  // скачок времени как перемотку вперёд, это его штатный случай.
  const floor = workerGridMs(now, init.tickMs) - layout.slots * init.tickMs;
  if (nextTarget < floor) nextTarget = workerGridMs(now, init.tickMs);

  let produced = 0;
  while (nextTarget <= horizon && produced < layout.slots) {
    produce(nextTarget);
    nextTarget += init.tickMs;
    produced++;
  }
  publishState();
});

port.on('message', (msg: WorkerCommand) => {
  try {
    apply(msg);
  } catch (err) {
    post({ e: 'warn', text: `ошибка команды ${msg.c}: ${String(err)}` });
  }
});

/**
 * Поправка позиции на глубину запаса — ТОЛЬКО для сверки со звуком.
 *
 * Сверка приходит от плеера: «звук сейчас на позиции P». Но кадр, который поток
 * считает в этот момент, уйдёт в линию позже — в момент `nextTarget`, когда звук
 * будет уже на P + (nextTarget − atMs). Без поправки свет отстал бы от музыки
 * ровно на глубину запаса.
 *
 * ── Почему НЕ применяем это к запуску и перемотке ─────────────────────────
 * Сначала я сдвигал и их — и обе самопроверки это поймали. «Запустить шоу с
 * позиции 0» должно показать шоу С НУЛЯ, а не с 0,25 с: сдвиг съедал начало,
 * а начало шоу — это как раз удар на первую долю. «Перемотать на 1,0 с» на
 * ПАУЗЕ должно показать ровно 1,0 с — там время не идёт вовсе, и сдвигать
 * нечего. Поэтому запуск и перемотка ставят позицию как есть, а появляются на
 * линии на глубину запаса позже — для нажатия рукой это незаметно. Со звуком
 * это согласовано иначе: старт звука задерживается на ту же глубину (см.
 * WorkerPlayback), поэтому начало сходится точно.
 */
function syncShift(atMs: number): number {
  return Math.max(0, nextTarget - atMs);
}

/** Внутреннее время первого кадра, на который команда может повлиять. */
function commandTimeline(): number {
  return timelineOf(nextTarget);
}

function apply(msg: WorkerCommand): void {
  const t = commandTimeline();
  switch (msg.c) {
    case 'setUniverses':
      universeIds = [...msg.ids];
      playback.setUniverses(msg.ids);
      return;
    case 'setProject':
      playback.setProject(msg.project);
      return;
    case 'setPausedAll':
      pausedAll = msg.paused;
      return;
    case 'setScene':
      playback.setScene(msg.sceneId, t);
      return;
    case 'start':
      playback.start(msg.id, t);
      return;
    case 'startAt':
      playback.startAt(msg.id, msg.stepIndex, msg.paused, t);
      return;
    case 'pause':
      playback.pause(msg.id, t);
      return;
    case 'resume':
      playback.resume(msg.id, t);
      return;
    case 'stop':
      playback.stop(msg.id);
      return;
    case 'startGroup':
      playback.startGroup(msg.id, t);
      return;
    case 'stopGroup':
      playback.stopGroup(msg.id);
      return;
    case 'pauseGroup':
      playback.pauseGroup(msg.id, t);
      return;
    case 'resumeGroup':
      playback.resumeGroup(msg.id, t);
      return;
    case 'stopAll':
      playback.stopAll();
      return;
    case 'playPlaylist':
      playback.playPlaylist(msg.id, msg.itemIndex, t);
      return;
    case 'skipPlaylist':
      playback.skipPlaylist(msg.dir, t);
      return;
    case 'stopPlaylist':
      playback.stopPlaylist();
      return;
    case 'playShow':
      playback.playShow(msg.id, msg.positionMs, t);
      return;
    case 'pauseShow':
      playback.pauseShow(t);
      return;
    case 'seekShow':
      playback.seekShow(msg.positionMs, t);
      return;
    case 'syncShow':
      // Единственная команда со сдвигом — см. syncShift.
      playback.syncShow(msg.positionMs + syncShift(msg.atMs), t);
      return;
    case 'stopShow':
      playback.stopShow();
      return;
    case 'shutdown':
      ticker.stop();
      port!.close();
      return;
  }
}

ticker.start();
post({ e: 'ready' });
