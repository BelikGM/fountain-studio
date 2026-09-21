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
  FRAME_LOOKAHEAD_MS,
  FRAME_MODES,
  frameModeFromConfig,
  frameModeLabel,
  frameModeToConfig,
  emptyProject,
  sanitizeProject,
  type Project,
  type Scene,
} from '@fountain-studio/shared';
import { Playback } from '../playback';
import {
  createPlaybackSource,
  workerGridMs,
  workerLayout,
  workerSlotIndex,
  workerSlots,
  WorkerHeader,
  WORKER_LOOKAHEAD_MS,
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
/**
 * Сколько ждать, чтобы команда транспорта дошла до КАДРОВ.
 *
 * Не мгновенно, и это не дефект: кадры на WORKER_LOOKAHEAD_MS вперёд уже
 * посчитаны, а воспроизведение назад не отматывается. Команда попадает в
 * кадры, начиная с первого непосчитанного. Уже идущее шоу это не трогает —
 * его блоки срабатывают по своему таймлайну.
 */
const APPLY_MS = WORKER_LOOKAHEAD_MS + 3 * 50;

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
        id: 'q2',
        name: 'Медленная',
        loop: true,
        steps: [
          { sceneId: 's1', holdMs: 4000, fadeMs: 0 },
          { sceneId: 's2', holdMs: 4000, fadeMs: 0 },
          { sceneId: 's3', holdMs: 4000, fadeMs: 0 },
        ],
      },
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
      await sleep(APPLY_MS);
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
    await sleep(APPLY_MS);
    worker.tick(0);
    const lv2 = worker.levels(2);
    check(lv2 !== undefined && lv2[11] === 255, 'вселенная 2 пришла своей: синий на адресе 12', String(lv2?.[11]));
    check(worker.levels(1)?.[0] === 255, 'вселенная 1 своей: красный на адресе 1');

    // Состояние воспроизведения доходит обратно.
    check(worker.state(0, false).activeSceneId === 's1', 'состояние из потока дошло: активная сцена видна');
    check(worker.version > 0, 'счётчик изменений растёт — сервер узнает, что пора разослать состояние');
    worker.setScene(null, 0);
    await sleep(APPLY_MS);
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
      const before = Atomics.load(new Int32Array((worker as unknown as { buffer: SharedArrayBuffer }).buffer, 0, WorkerHeader.Size), WorkerHeader.Produced);
      // Держим главный поток занятым по-настоящему: синхронный цикл, который не
      // отдаёт event loop. Именно от этого и защищает развязка.
      const until = Date.now() + 600;
      while (Date.now() < until) {
        // пустой синхронный цикл — event loop заблокирован
      }
      const after = Atomics.load(new Int32Array((worker as unknown as { buffer: SharedArrayBuffer }).buffer, 0, WorkerHeader.Size), WorkerHeader.Produced);
      const grew = after - before;
      check(grew > 6, `главный поток стоял 0,6 с, а поток посчитал ${grew} кадров (ожидаем ~12)`);
      worker.stopAll();
    }

    worker.dispose();
    inline.dispose();
  }

  console.log('— Предрасчёт: запас вперёд и мгновенный «стоп» —');
  {
    const worker: PlaybackSource = WorkerPlayback.create(50, 10, [1, 2]);
    worker.setProject(project);
    for (let i = 0; i < 100 && !worker.levels(1); i++) {
      worker.tick(0);
      await sleep(20);
    }

    /*
     * Главное свойство предрасчёта: кадр на ТЕКУЩИЙ момент уже лежит готовым.
     * Проверяем через счётчик повторов: если кадры приходят вовремя, повторять
     * прошлый почти не приходится. Без запаса каждый пропущенный тик потока
     * давал бы повтор.
     */
    worker.start('q1', 0);
    await sleep(APPLY_MS);
    const inner = worker as unknown as { frameStats(): { repeats: number; taken: number } };
    const before = inner.frameStats();
    for (let i = 0; i < 40; i++) {
      worker.tick(0);
      await sleep(50);
    }
    const after = inner.frameStats();
    const taken = after.taken - before.taken;
    const repeats = after.repeats - before.repeats;
    check(taken >= 35, `кадров взято ${taken} из 40 запросов`);
    check(repeats * 10 < taken, `повторов ${repeats} из ${taken} — меньше 10%: кадр на свой момент почти всегда готов`);

    // «Стоп» не ждёт запаса: вклад воспроизведения обнуляется в тот же тик.
    worker.tick(0);
    check(worker.levels(1) !== undefined, 'до стопа уровни есть');
    worker.stopAll();
    worker.tick(0);
    check(worker.levels(1) === undefined, 'сразу после «стоп» вклад воспроизведения обнулён — вода уходит в тот же тик');
    // И заглушка держится всю глубину запаса, а не снимается по состоянию.
    await sleep(WORKER_LOOKAHEAD_MS / 2);
    worker.tick(0);
    check(worker.levels(1) === undefined, 'на середине запаса всё ещё заглушено — старые кадры в линию не уходят');
    await sleep(APPLY_MS);
    worker.tick(0);
    check(worker.levels(1) !== undefined, 'после запаса заглушка снята — кадры снова идут (уже пустые)');
    const lv = worker.levels(1);
    check(lv !== undefined && lv.every((v) => v === 0), 'и они действительно пустые: воспроизведение остановлено');

    // Снятие сцены — тоже мгновенно.
    worker.setScene('s1', 0);
    await sleep(APPLY_MS);
    worker.tick(0);
    check(worker.levels(1)?.[0] === 255, 'сцена включилась');
    worker.setScene(null, 0);
    worker.tick(0);
    check(worker.levels(1) === undefined, 'снятие сцены гасит вклад немедленно');
    worker.dispose();
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
    // Кольцо адресуется прямо по времени: читателю не надо ничего искать,
    // он считает номер ячейки и проверяет метку времени в ней.
    const slots = workerSlots(50, WORKER_LOOKAHEAD_MS);
    const layout = workerLayout(slots);
    check(slots >= WORKER_LOOKAHEAD_MS / 50 + 1, `ячеек хватает на запас (${slots} при ${WORKER_LOOKAHEAD_MS} мс)`);
    check(layout.targetOffset % 8 === 0, 'метки времени выровнены по 8 байт — иначе Float64Array не создать');
    check(layout.bytes === layout.dataOffset + slots * WORKER_MAX_UNIVERSES * DMX_UNIVERSE_SIZE, 'размер буфера сходится с раскладкой');
    check(layout.bytes < 1_000_000, `кольцо весит ${Math.round(layout.bytes / 1024)} КБ — памяти это не стоит почти ничего`);
    const buf = new SharedArrayBuffer(layout.bytes);
    const seq = new Int32Array(buf, layout.seqOffset, slots);
    const target = new Float64Array(buf, layout.targetOffset, slots);
    check(target.length === slots, 'метка времени есть у каждой ячейки');
    // Номер ячейки: соседние моменты — соседние ячейки, через оборот — та же.
    check(workerSlotIndex(1000, 50, slots) !== workerSlotIndex(1050, 50, slots), 'соседние моменты ложатся в разные ячейки');
    check(
      workerSlotIndex(1000, 50, slots) === workerSlotIndex(1000 + slots * 50, 50, slots),
      'через полный оборот ячейка та же — кольцо замыкается',
    );
    check(workerGridMs(1234, 50) === 1200, 'сетка времени округляет вниз до такта');
    check(workerGridMs(1200, 50) === 1200, 'ровный момент остаётся собой');
    // Нечётный счётчик ячейки означает «идёт запись» — читатель берёт прошлый кадр.
    Atomics.add(seq, 0, 1);
    check(Atomics.load(seq, 0) % 2 === 1, 'после начала записи счётчик ячейки нечётный');
    Atomics.add(seq, 0, 1);
    check(Atomics.load(seq, 0) % 2 === 0, 'после окончания — чётный');
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
    await sleep(APPLY_MS);
    worker.tick(0);
    check(worker.levels(3) !== undefined, 'добавленная вселенная появилась');
    check(worker.levels(1)?.[0] === 255, 'и прежние не сломались');
    worker.setUniverses([1]);
    await sleep(APPLY_MS);
    worker.tick(0);
    check(worker.levels(1) !== undefined, 'после сокращения набора первая вселенная на месте');
    worker.dispose();
  }

  console.log('— Режим подготовки кадров: раскладка на настройки —');
  {
    // Наружу один список из трёх вариантов, внутри — две величины. Ошибка в
    // раскладке означала бы, что переключатель в настройках врёт.
    check(FRAME_MODES.length === 3, 'три варианта: заранее, сразу в потоке, в главном потоке');
    check(
      FRAME_MODES.every((m) => m.label.trim() !== '' && m.hint.length > 40),
      'у каждого есть понятная подпись и объяснение',
    );
    const ahead = frameModeToConfig('ahead');
    check(ahead.playbackWorker && ahead.playbackLookaheadMs === FRAME_LOOKAHEAD_MS, 'заранее = поток + запас');
    const instant = frameModeToConfig('instant');
    check(instant.playbackWorker && instant.playbackLookaheadMs === 0, 'сразу в потоке = поток без запаса');
    const inline = frameModeToConfig('inline');
    check(!inline.playbackWorker, 'в главном потоке = без потока');
    // Обратное преобразование должно быть согласовано с прямым, иначе настройки
    // с диска прочитались бы как другой режим.
    for (const m of FRAME_MODES) {
      const c = frameModeToConfig(m.id);
      check(frameModeFromConfig(c.playbackWorker, c.playbackLookaheadMs) === m.id, `режим «${m.label}» читается обратно собой`);
    }
    check(frameModeFromConfig(false, 500) === 'inline', 'без потока запас не имеет значения');
    // Не цепляемся за конкретные слова: подписи пишутся для человека и будут
    // переписываться. Проверяем, что подпись берётся из списка, а не выдумана.
    check(
      FRAME_MODES.every((m) => frameModeLabel(m.id) === m.label),
      'подпись режима берётся из списка, а не выдумывается',
    );
    check(frameModeLabel('несуществующий' as never) === 'несуществующий', 'неизвестный режим не роняет подпись');
  }

  console.log('— Переключение режима на живом движке —');
  {
    const { Engine } = await import('../engine');
    const engine = new Engine({
      server: { port: 9596 },
      timing: { tickMs: 50, spinMs: 10, uiFrameMs: 1000 },
      audio: { player: 'none', ffplayPath: '', volumeDb: 0, muted: false },
      universes: [{ id: 1, label: 'В1', outputs: [] }],
      backup: { enabled: false, intervalMin: 60 },
    } as never);
    engine.setProject(project);
    engine.start();
    try {
      await sleep(400);
      check(engine.frameModeChosen() === 'ahead', 'по умолчанию — заранее, в отдельном потоке');
      check(engine.frameModeActive() === 'ahead', 'и он действительно работает');

      // Сцена играет, переключаем режим — воспроизведение обязано остановиться:
      // состояние расчёта через смену потока не переносится, и врать об этом нельзя.
      engine.setScene('s1');
      await sleep(APPLY_MS);
      check(engine.universes[0]!.out[0] === 255, 'сцена играет до переключения');
      // Переключение НЕ останавливает воспроизведение: играющее перекладывается
      // в новый источник. Заказчик справедливо возразил, что останавливать всё
      // незачем — состояние, которое важно человеку, движок знает целиком.
      engine.startSequence('q1');
      await sleep(APPLY_MS);
      check(engine.playbackState().running.length === 1, 'секвенсор идёт до переключения');
      engine.setFrameMode('inline');
      await sleep(400);
      check(engine.frameModeActive() === 'inline', 'переключились на главный поток');
      check(engine.playbackState().activeSceneId === 's1', 'сцена перенесена — воспроизведение не остановлено');
      check(engine.playbackState().running.length === 1, 'и секвенсор продолжает идти');
      check((engine.universes[0]!.out[0] ?? 0) > 0, 'в линии есть картина, а не ноль');
      engine.stopAllPlayback();
      await sleep(200);

      // В главном потоке всё работает как раньше — сцена включается сразу.
      engine.setScene('s1');
      await sleep(200);
      check(engine.universes[0]!.out[0] === 255, 'в главном потоке сцена играет');

      engine.setFrameMode('instant');
      await sleep(500);
      check(engine.frameModeActive() === 'instant', 'вернулись в поток без запаса');
      engine.setScene('s2');
      await sleep(APPLY_MS);
      check(engine.universes[0]!.out[1] === 255, 'и он считает кадры (зелёная сцена)');

      engine.setFrameMode('ahead');
      await sleep(500);
      check(engine.frameModeActive() === 'ahead', 'и обратно на заводской режим');
      // Повторное присвоение того же режима не должно ничего ломать и останавливать.
      engine.setScene('s1');
      await sleep(APPLY_MS);
      engine.setFrameMode('ahead');
      await sleep(150);
      check(engine.playbackState().activeSceneId === 's1', 'тот же режим повторно — воспроизведение не тронуто');
    } finally {
      engine.stop();
    }
  }

  console.log('— Перенос играющего при смене режима —');
  {
    /*
     * Самое важное в переключении: что именно переживает смену места расчёта.
     * «Перенести поток вместе с его памятью» нельзя, поэтому движок
     * перекладывает состояние: сцену, шаг каждого секвенсора, позицию шоу,
     * пункт плейлиста. Если что-то из этого потеряется, на объекте это будет
     * выглядеть как самопроизвольный сброс программы.
     */
    const { Engine } = await import('../engine');
    const engine = new Engine({
      server: { port: 9595 },
      timing: { tickMs: 50, spinMs: 10, uiFrameMs: 1000 },
      audio: { player: 'none', ffplayPath: '', volumeDb: 0, muted: false },
      universes: [{ id: 1, label: 'В1', outputs: [] }],
      backup: { enabled: false, intervalMin: 60 },
    } as never);
    engine.setProject(project);
    engine.start();
    try {
      await sleep(400);

      // Секвенсор доводим до НЕ НУЛЕВОГО шага: именно он и проверяет перенос —
      // сброс на первый шаг был бы виден как прыжок картинки.
      // Медленный секвенсор: шаги по 4 с, поэтому за время переключения он
      // физически не может уйти дальше — проверка однозначна.
      engine.startSequence('q2');
      await sleep(APPLY_MS + 4300);
      const stepBefore = engine.playbackState().running[0]?.stepIndex ?? 0;
      check(stepBefore > 0, `секвенсор ушёл с первого шага (сейчас ${stepBefore})`);
      engine.setFrameMode('instant');
      await sleep(400);
      const stepAfter = engine.playbackState().running[0]?.stepIndex ?? -1;
      check(stepAfter === stepBefore, `шаг секвенсора перенесён (${stepBefore} → ${stepAfter})`);

      // Пауза секвенсора тоже должна пережить переключение.
      engine.pauseSequence('q2');
      await sleep(200);
      check(engine.playbackState().running[0]?.paused === true, 'секвенсор поставлен на паузу');
      engine.setFrameMode('ahead');
      await sleep(400);
      check(engine.playbackState().running[0]?.paused === true, 'пауза секвенсора пережила переключение');
      engine.stopAllPlayback();
      await sleep(200);

      // Сцена.
      engine.setScene('s2');
      await sleep(APPLY_MS);
      engine.setFrameMode('inline');
      await sleep(300);
      check(engine.playbackState().activeSceneId === 's2', 'включённая сцена перенесена');
      check(engine.universes[0]!.out[1] === 255, 'и она действительно в кадре (зелёная)');
      engine.setScene(null);
      await sleep(200);

      // Пауза всего — это состояние движка, а не источника, но новый источник
      // обязан о ней узнать: иначе часы шоу пойдут, пока картина заморожена.
      engine.pauseAll();
      engine.setFrameMode('ahead');
      await sleep(300);
      check(engine.playbackState().pausedAll === true, 'пауза всего пережила переключение');
      engine.resumeAll();
      await sleep(100);
    } finally {
      engine.stop();
    }
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
