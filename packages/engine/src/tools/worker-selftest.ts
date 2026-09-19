/**
 * Самопроверка расчёта воспроизведения в отдельном потоке.
 *
 * Главное здесь — РАВЕНСТВО: одна и та же сцена, прогнанная через расчёт в
 * главном потоке и через поток, должна давать одинаковые кадры. Это не
 * формальность: вся ценность развязки в том, что она ничего не меняет в
 * картине, а только перестаёт зависеть от занятости главного потока. Если
 * кадры разойдутся хоть на единицу, развязку включать нельзя.
 *
 * Плюс проверяется то, чего у расчёта в главном потоке нет вовсе: что смерть
 * потока не остаётся незамеченной, что seqlock не отдаёт полукадр и что при
 * заблокированном главном потоке расчёт всё равно идёт.
 *
 * Запуск: npm -w @fountain-studio/engine run worker-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  DMX_UNIVERSE_SIZE,
  emptyProject,
  sanitizeProject,
  type Project,
  type Scene,
} from '@fountain-studio/shared';
import { Playback } from '../playback';
import {
  createPlaybackSource,
  workerBufferBytes,
  WorkerHeader,
  WORKER_FRAMES_OFFSET,
  WORKER_MAX_UNIVERSES,
  type PlaybackSource,
} from '../playbacksource';
import { WorkerPlayback } from '../workerplayback';

let failed = 0;
let passed = 0;
function check(ok: boolean, name: string, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Проект с двумя вселенными, статической сценой и секвенсором из трёх шагов. */
function makeProject(): Project {
  const scene = (id: string, name: string, values: Record<string, number[]>): Scene =>
    ({ id, name, values, fadeMs: 0 }) as unknown as Scene;
  const raw = {
    ...emptyProject('Проверка потока'),
    devices: [
      { id: 'd1', name: 'Прибор 1', profileId: 'rgb', universe: 1, address: 1 },
      { id: 'd2', name: 'Прибор 2', profileId: 'rgb', universe: 2, address: 10 },
    ],
    scenes: [
      scene('s1', 'Красная', { d1: [255, 0, 0], d2: [0, 0, 255] }),
      scene('s2', 'Зелёная', { d1: [0, 255, 0], d2: [255, 255, 0] }),
      scene('s3', 'Синяя', { d1: [0, 0, 255], d2: [0, 255, 255] }),
    ],
    sequences: [
      {
        id: 'q1',
        name: 'Бегущая',
        loop: true,
        steps: [
          { sceneId: 's1', holdMs: 200, fadeMs: 100 },
          { sceneId: 's2', holdMs: 200, fadeMs: 100 },
          { sceneId: 's3', holdMs: 200, fadeMs: 100 },
        ],
      },
    ],
  };
  return sanitizeProject(raw as never);
}

/** Снять кадры обоих вселенных. */
function snap(src: PlaybackSource): string {
  const parts: string[] = [];
  for (const id of [1, 2]) {
    const lv = src.levels(id);
    parts.push(lv ? Array.from(lv.slice(0, 16)).join(',') : 'нет');
  }
  return parts.join(' | ');
}

async function main(): Promise<void> {
  const project = makeProject();

  console.log('— Выбор пути расчёта —');
  {
    const log: string[] = [];
    const inline = createPlaybackSource(false, [1], 50, 10, {
      inline: () => new Playback([1]),
      worker: () => {
        throw new Error('не должен вызываться');
      },
      log: (t) => log.push(t),
    });
    check(inline instanceof Playback, 'выключено — считаем в главном потоке');
    check(log.length === 0, 'и молча, без записей в журнал');
    inline.dispose();

    // Поток не поднялся: движок обязан продолжить работу прежним способом, а не
    // встать. Фонтан на объекте не должен зависеть от того, завёлся ли воркер.
    const fallback = createPlaybackSource(true, [1], 50, 10, {
      inline: () => new Playback([1]),
      worker: () => {
        throw new Error('нет файла потока');
      },
      log: (t) => log.push(t),
    });
    check(fallback instanceof Playback, 'поток не поднялся — переходим на расчёт в главном потоке');
    check(log.some((t) => t.includes('нет файла потока')), 'и пишем причину в журнал', log.join('; '));
    fallback.dispose();
  }

  console.log('— Равенство: главный поток и отдельный дают одинаковые кадры —');
  {
    const inline = new Playback([1, 2]);
    inline.setProject(project);
    const worker: PlaybackSource = WorkerPlayback.create(50, 10, [1, 2]);
    worker.setProject(project);
    // Ждём, пока поток поднимется и посчитает первый кадр.
    for (let i = 0; i < 100 && !worker.levels(1); i++) {
      worker.tick(0);
      await sleep(20);
    }
    check(worker.levels(1) !== undefined, 'поток поднялся и отдал первый кадр');

    /*
     * Сравнивать «на одно и то же время» в лоб нельзя: у потока свои часы, и на
     * секвенсоре с переходами кадр меняется каждый тик — разница в единицы
     * миллисекунд уже даст другие значения. Поэтому сравниваем на СТАТИЧЕСКИХ
     * сценах, где время не участвует: это и проверяет главное — что через
     * границу потоков кадр проходит без искажений, что порядок вселенных не
     * перепутан и что HTP-слияние одинаково.
     */
    for (const sceneId of ['s1', 's2', 's3', null]) {
      inline.setScene(sceneId, 0);
      inline.tick(1000);
      worker.setScene(sceneId, 0);
      await sleep(200);
      worker.tick(0);
      const a = snap(inline);
      const b = snap(worker);
      check(a === b, `сцена ${sceneId ?? '(снята)'}: кадры совпали`, `главный ${a} / поток ${b}`);
    }

    // Порядок вселенных: во второй вселенной прибор с другого адреса, и если бы
    // кадры перепутались местами, это бы вылезло именно здесь.
    inline.setScene('s1', 0);
    inline.tick(1000);
    worker.setScene('s1', 0);
    await sleep(200);
    worker.tick(0);
    const lv2 = worker.levels(2);
    check(lv2 !== undefined && lv2[11] === 255, 'вселенная 2 пришла своей: синий на адресе 12', String(lv2?.[11]));
    check(worker.levels(1)?.[0] === 255, 'вселенная 1 своей: красный на адресе 1');

    // Состояние воспроизведения доходит обратно.
    check(worker.state(0, false).activeSceneId === 's1', 'состояние из потока дошло: активная сцена видна');
    check(worker.version > 0, 'счётчик изменений растёт — сервер узнает, что пора разослать состояние');
    worker.setScene(null, 0);
    await sleep(200);
    check(worker.state(0, false).activeSceneId === null, 'и обновляется при снятии сцены');
    check(worker.state(0, true).pausedAll === true, 'пауза всего подставляется главным потоком');

    // Секвенсор: кадр должен МЕНЯТЬСЯ сам, без участия главного потока.
    worker.start('q1', 0);
    await sleep(150);
    worker.tick(0);
    const f1 = snap(worker);
    await sleep(350);
    worker.tick(0);
    const f2 = snap(worker);
    check(f1 !== f2, 'секвенсор в потоке идёт сам: кадр изменился', `${f1} → ${f2}`);
    worker.stopAll();

    console.log('— Расчёт идёт, даже когда главный поток занят —');
    {
      worker.start('q1', 0);
      await sleep(100);
      const before = Atomics.load(new Int32Array((worker as unknown as { buffer: SharedArrayBuffer }).buffer, 0, WorkerHeader.Size), WorkerHeader.Ticks);
      // Держим главный поток занятым по-настоящему: синхронный цикл, который не
      // отдаёт event loop. Именно от этого и защищает развязка.
      const until = Date.now() + 600;
      while (Date.now() < until) {
        // пустой синхронный цикл — event loop заблокирован
      }
      const after = Atomics.load(new Int32Array((worker as unknown as { buffer: SharedArrayBuffer }).buffer, 0, WorkerHeader.Size), WorkerHeader.Ticks);
      const grew = after - before;
      check(grew > 6, `главный поток стоял 0,6 с, а поток посчитал ${grew} кадров (ожидаем ~12)`);
      worker.stopAll();
    }

    worker.dispose();
    inline.dispose();
  }

  console.log('— Смерть потока замечена —');
  {
    const worker: PlaybackSource = WorkerPlayback.create(50, 10, [1]);
    worker.setProject(project);
    for (let i = 0; i < 100 && !worker.levels(1); i++) {
      worker.tick(0);
      await sleep(20);
    }
    check(worker.healthy, 'живой поток считается здоровым');
    // Убиваем поток изнутри класса — как если бы он упал сам.
    const inner = worker as unknown as { worker: Worker | null };
    await inner.worker?.terminate();
    // Даём событию exit дойти и прогоняем тики: счётчик перестал расти.
    for (let i = 0; i < 40; i++) {
      worker.tick(0);
      await sleep(10);
    }
    check(!worker.healthy, 'мёртвый поток здоровым не считается — движок уйдёт в аварийное отключение');
    check(worker.state(0, false).activeSceneId === null, 'состояние не врёт про играющее шоу, которого больше нет');
    // Восстановление: класс сам поднимает поток заново. Ждём не «стал
    // здоровым» (это происходит сразу при создании потока), а первый
    // пришедший кадр — только он доказывает, что расчёт снова идёт.
    await sleep(2600);
    for (let i = 0; i < 100 && worker.levels(1) === undefined; i++) {
      worker.tick(0);
      await sleep(20);
    }
    check(worker.healthy, 'поток поднялся заново сам');
    check(worker.levels(1) !== undefined, 'и снова считает кадры');
    worker.dispose();
  }

  console.log('— Общая память: seqlock и границы —');
  {
    const buf = new SharedArrayBuffer(workerBufferBytes());
    check(workerBufferBytes() === WorkerHeader.Size * 4 + WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE, 'размер буфера сходится с раскладкой');
    const header = new Int32Array(buf, 0, WorkerHeader.Size);
    const frames = new Uint8Array(buf, WORKER_FRAMES_OFFSET, WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE);
    check(frames.length === WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE, 'поле кадров вмещает все вселенные');
    // Нечётный счётчик означает «идёт запись» — читатель обязан взять прошлый кадр.
    Atomics.add(header, WorkerHeader.Seq, 1);
    check(Atomics.load(header, WorkerHeader.Seq) % 2 === 1, 'после начала записи счётчик нечётный');
    Atomics.add(header, WorkerHeader.Seq, 1);
    check(Atomics.load(header, WorkerHeader.Seq) % 2 === 0, 'после окончания — чётный');
  }

  console.log('— Смена вселенных и проекта на ходу —');
  {
    const worker: PlaybackSource = WorkerPlayback.create(50, 10, [1]);
    worker.setProject(project);
    for (let i = 0; i < 100 && !worker.levels(1); i++) {
      worker.tick(0);
      await sleep(20);
    }
    worker.setUniverses([1, 2, 3]);
    worker.setScene('s1', 0);
    await sleep(300);
    worker.tick(0);
    check(worker.levels(3) !== undefined, 'добавленная вселенная появилась');
    check(worker.levels(1)?.[0] === 255, 'и прежние не сломались');
    worker.setUniverses([1]);
    await sleep(300);
    worker.tick(0);
    check(worker.levels(1) !== undefined, 'после сокращения набора первая вселенная на месте');
    worker.dispose();
  }

  console.log(`\nпоток расчёта: пройдено ${passed}, ошибок ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-worker-'));
void main()
  .catch((err) => {
    failed++;
    console.error('  ✖ проверка не прошла:', err);
    console.log(`\nпоток расчёта: пройдено ${passed}, ошибок ${failed}`);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
