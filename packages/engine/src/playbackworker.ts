/**
 * Отдельный поток расчёта воспроизведения. Точка входа worker_threads.
 *
 * Здесь живёт `Playback` — сцены, секвенсоры, шоу, плейлисты, огибающие — и свой
 * тикер. Каждый тик поток считает уровни всех вселенных и кладёт их в общую
 * память; главный поток забирает последний готовый кадр, когда ему удобно, и
 * никогда не ждёт расчёта.
 *
 * Разбор, что и почему тут делается, — в `playbacksource.ts`.
 *
 * Про надёжность: этот поток не трогает ни сеть, ни диск, ни выходы на линию.
 * Всё, что он может, — посчитать кадр. Если он всё-таки упадёт, главный поток
 * это увидит (счётчик тиков перестанет расти и придёт событие exit) и уйдёт в
 * аварийное отключение — см. WorkerPlayback.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { DMX_UNIVERSE_SIZE } from '@fountain-studio/shared';
import { Ticker } from './clock';
import { Playback } from './playback';
import {
  WorkerHeader,
  WORKER_FRAMES_OFFSET,
  WORKER_MAX_UNIVERSES,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerInit,
} from './playbacksource';

const init = workerData as WorkerInit;
const port = parentPort;
if (!port) throw new Error('playbackworker: запущен не как worker_threads');

const header = new Int32Array(init.buffer, 0, WorkerHeader.Size);
const frames = new Uint8Array(init.buffer, WORKER_FRAMES_OFFSET, WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE);

let universeIds = [...init.universeIds];
const playback = new Playback(universeIds);

/** Смена шоу в автономном воспроизведении — играть звук умеет только главный поток. */
playback.onShowAudio = (show) => post({ e: 'showAudio', show });

/**
 * Пауза всего: часы воспроизведения замирают. Реализовано как у движка — не
 * продвигать nowMs, а накапливать «упущенное» время, чтобы после снятия паузы
 * шоу продолжилось с того же места, а не скачком вперёд.
 */
let pausedAll = false;
let pauseOffsetMs = 0;
let nowMs = 0;
let lastVersion = -1;
let lastStateJson = '';

function post(e: WorkerEvent): void {
  port!.postMessage(e);
}

/**
 * Записать кадры в общую память под seqlock.
 *
 * Порядок важен: сначала делаем счётчик нечётным, потом пишем, потом чётным.
 * Читатель по нечётному счётчику или по изменившемуся значению понимает, что
 * прочитал вперемешку, и берёт прошлый кадр. Atomics нужны именно для того,
 * чтобы эти записи не переставились местами.
 */
function publish(): void {
  Atomics.add(header, WorkerHeader.Seq, 1);
  const count = Math.min(universeIds.length, WORKER_MAX_UNIVERSES);
  for (let i = 0; i < count; i++) {
    const lv = playback.levels(universeIds[i]!);
    const at = i * DMX_UNIVERSE_SIZE;
    if (lv) frames.set(lv, at);
    else frames.fill(0, at, at + DMX_UNIVERSE_SIZE);
  }
  Atomics.store(header, WorkerHeader.Count, count);
  Atomics.add(header, WorkerHeader.Ticks, 1);
  Atomics.add(header, WorkerHeader.Seq, 1);
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
  const state = playback.state(nowMs, pausedAll);
  const json = JSON.stringify(state);
  if (playback.version === lastVersion && json === lastStateJson) return;
  lastVersion = playback.version;
  lastStateJson = json;
  post({ e: 'state', state, version: playback.version });
}

const ticker = new Ticker(init.tickMs, init.spinMs, (n) => {
  if (pausedAll) pauseOffsetMs += init.tickMs;
  nowMs = n * init.tickMs - pauseOffsetMs;
  try {
    playback.tick(nowMs);
  } catch (err) {
    // Ошибка в расчёте одного тика не должна валить поток целиком: кадр уйдёт
    // прошлый, а в журнал главного потока попадёт предупреждение. Падать тут —
    // значит гасить воду из-за одной битой сцены.
    post({ e: 'warn', text: `ошибка расчёта кадра: ${String(err)}` });
  }
  publish();
  publishState();
});

port.on('message', (msg: WorkerCommand) => {
  try {
    apply(msg);
  } catch (err) {
    post({ e: 'warn', text: `ошибка команды ${msg.c}: ${String(err)}` });
  }
});

function apply(msg: WorkerCommand): void {
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
      playback.setScene(msg.sceneId, nowMs);
      return;
    case 'start':
      playback.start(msg.id, nowMs);
      return;
    case 'pause':
      playback.pause(msg.id, nowMs);
      return;
    case 'resume':
      playback.resume(msg.id, nowMs);
      return;
    case 'stop':
      playback.stop(msg.id);
      return;
    case 'startGroup':
      playback.startGroup(msg.id, nowMs);
      return;
    case 'stopGroup':
      playback.stopGroup(msg.id);
      return;
    case 'pauseGroup':
      playback.pauseGroup(msg.id, nowMs);
      return;
    case 'resumeGroup':
      playback.resumeGroup(msg.id, nowMs);
      return;
    case 'stopAll':
      playback.stopAll();
      return;
    case 'playPlaylist':
      playback.playPlaylist(msg.id, msg.itemIndex, nowMs);
      return;
    case 'skipPlaylist':
      playback.skipPlaylist(msg.dir, nowMs);
      return;
    case 'stopPlaylist':
      playback.stopPlaylist();
      return;
    case 'playShow':
      playback.playShow(msg.id, msg.positionMs, nowMs);
      return;
    case 'pauseShow':
      playback.pauseShow(nowMs);
      return;
    case 'seekShow':
      playback.seekShow(msg.positionMs, nowMs);
      return;
    case 'syncShow':
      playback.syncShow(msg.positionMs, nowMs);
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
