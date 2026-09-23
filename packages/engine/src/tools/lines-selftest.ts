/**
 * Самопроверка: вселенные и такт меняются НА ХОДУ, не останавливая шоу.
 *
 * Откуда взялось. 22.09.2026 заказчик добавил вторую вселенную и не нашёл её
 * ни на «Потоке», ни в привязке приборов. Правка висела неприменённой: кнопка
 * «Применить» стояла далеко от таблицы и обещала остановить воспроизведение.
 * Теперь применение ничего не останавливает — и это надо держать проверкой,
 * потому что сломать такое легко и незаметно: достаточно, чтобы в линию на
 * миг ушли нули, а отсекатель режет воду почти мгновенно.
 *
 * Выходы — Art-Net на 127.0.0.1 и НЕстандартный порт: в сеть ничего не
 * уходит, рабочий движок на 6454 эти кадры не ловит. Рабочие
 * fountain.config.json и fountain.project.json не трогаются (правило 4).
 *
 * Запуск: npm -w @fountain-studio/engine run lines-test
 */
import {
  describeLinesChange,
  nextUniverse,
  sameOutputs,
  sanitizeProject,
  storedUniverseLabel,
  universeCustomName,
  universeTitle,
  type ConfigUniverse,
} from '@fountain-studio/shared';
import { Engine } from '../engine';
import { createDemoProject } from '../demoproject';
import type { EngineConfig } from '../config';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Порт заведомо мимо Art-Net: кадры никто не ловит. */
const PORT = 16454;
const art = (universe: number, port = PORT): ConfigUniverse['outputs'][number] => ({
  type: 'artnet',
  host: '127.0.0.1',
  port,
  universe,
});

// ══ 1. Названия и новая вселенная — чистые функции ═══════════════════════
console.log('— названия —');
check('без имени — только номер', universeTitle({ id: 2 }) === 'Вселенная 2', universeTitle({ id: 2 }));
check('«Линия 1» у первой — это имя, которое давала программа', universeTitle({ id: 1, label: 'Линия 1' }) === 'Вселенная 1');
check('«Вселенная 3» у третьей — тоже', universeCustomName({ id: 3, label: 'Вселенная 3' }) === null);
check('своё имя показывается рядом с номером', universeTitle({ id: 2, label: 'Северная чаша' }) === 'Вселенная 2 · Северная чаша');
check('«Линия 3» у второй — уже осмысленное имя', universeCustomName({ id: 2, label: 'Линия 3' }) === 'Линия 3');
check('храним пустое вместо автоимени', storedUniverseLabel({ id: 1, label: 'Линия 1' }) === '');
check('своё имя храним как есть', storedUniverseLabel({ id: 1, label: 'Каскад' }) === 'Каскад');

console.log('— новая вселенная —');
const mus = nextUniverse([{ id: 1, outputs: [{ type: 'musidora', universe: 0, path: 'SER1', musidoraOut: 1 }] }]);
check('после FountanPlay — FountanPlay', mus.outputs[0]!.type === 'musidora');
check('следующий разъём', mus.outputs[0]!.musidoraOut === 2, String(mus.outputs[0]!.musidoraOut));
check('тот же интерфейс', mus.outputs[0]!.path === 'SER1');
check('номер следующий', mus.id === 2);
const mus3 = nextUniverse([{ id: 3, outputs: [{ type: 'musidora', universe: 0, musidoraOut: 3 }] }]);
check('разъёмов не больше трёх', mus3.outputs[0]!.musidoraOut === 3);
const an = nextUniverse([{ id: 1, outputs: [{ type: 'artnet', host: '10.0.0.5', universe: 4 }] }]);
check('после Art-Net — Art-Net на тот же узел', an.outputs[0]!.type === 'artnet' && an.outputs[0]!.host === '10.0.0.5');
check('и следующий номер в протоколе', an.outputs[0]!.universe === 5, String(an.outputs[0]!.universe));
const usb = nextUniverse([{ id: 1, outputs: [{ type: 'usb-dmx', universe: 0, path: 'COM5' }] }]);
check('после USB-адаптера порт не угадываем', usb.outputs[0]!.type === 'usb-dmx' && usb.outputs[0]!.path === '');
check('с нуля — FountanPlay, выход 1', nextUniverse([]).outputs[0]!.musidoraOut === 1);
check('мастер может задать номер сам', nextUniverse([], 7).id === 7);

console.log('— что изменилось —');
check(
  'одинаковые выходы с другим порядком полей — одинаковые',
  sameOutputs([{ universe: 0, type: 'artnet', host: 'a' }], [{ type: 'artnet', host: 'a', universe: 0 }]),
);
const before = { tickMs: 50, universes: [{ id: 1, label: 'Линия 1', outputs: [art(0)] }, { id: 3, outputs: [art(2)] }] };
const after = {
  tickMs: 40,
  universes: [{ id: 1, label: '', outputs: [art(0, 7000)] }, { id: 2, label: 'Каскад', outputs: [art(1)] }],
};
const diff = describeLinesChange(before, after);
check('добавленная видна', diff.some((d) => d.startsWith('добавлена вселенная 2 «Каскад»')), diff.join(' / '));
check('убранная видна', diff.includes('убрана вселенная 3'), diff.join(' / '));
check('сменённый выход виден', diff.some((d) => d.startsWith('вселенная 1: выход')), diff.join(' / '));
check('смена такта видна', diff.includes('такт 50 → 40 мс'), diff.join(' / '));
check('«Линия 1» → пусто — не считается переименованием', !diff.some((d) => d.includes('имя')), diff.join(' / '));
check('без изменений — пусто', describeLinesChange(before, before).length === 0);

// ══ 2. Движок: применение на ходу ════════════════════════════════════════
const project = sanitizeProject(createDemoProject());
const maxScene = project.scenes.find((s) => s.name === 'Всё на полную')!;
const show = project.shows[0]!;

async function live(mode: 'worker' | 'inline'): Promise<void> {
  console.log(`— применение на ходу (${mode === 'worker' ? 'отдельный поток с предрасчётом' : 'один поток'}) —`);
  const config: EngineConfig = {
    server: { port: 0 },
    timing: { tickMs: 50, spinMs: 10, uiFrameMs: 1000 },
    audio: { player: 'none', ffplayPath: '', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 },
    universes: [{ id: 1, label: 'Линия 1', outputs: [art(0)] }],
    backup: { enabled: false, intervalMin: 60 },
    playbackWorker: mode === 'worker',
    playbackLookaheadMs: 100,
  };
  const engine = new Engine(config);
  engine.setProject(project);
  engine.start();
  try {
    engine.setScene(maxScene.id);
    engine.setChannel(1, 100, 77); // ручной фейдер на свободном адресе
    await sleep(700);
    const u1 = engine.universes[0]!;
    const out1 = u1.outputs[0]!;
    check('до применения насос на максимуме', u1.out[0] === 255, String(u1.out[0]));

    // Что уходит в линию первой вселенной, пока применяем.
    const sent1: Uint8Array[] = [];
    const real1 = out1.send.bind(out1);
    out1.send = (f: Uint8Array): void => {
      sent1.push(Uint8Array.from(f));
      real1(f);
    };
    const samples: number[] = [];
    const sampler = setInterval(() => samples.push(engine.universes[0]!.out[0]!), 5);

    // ── добавить вселенную ───────────────────────────────────────────────
    const two: EngineConfig['universes'] = [
      { id: 1, label: '', outputs: [art(0)] },
      { id: 2, label: '', outputs: [art(1)] },
    ];
    const changes = engine.applyConfig(two, 50);
    /*
     * Сразу, без ожидания: новый поток расчёта своё состояние присылает не
     * мгновенно, и раньше движок в этот миг отвечал «ничего не играет».
     * Сквозная проверка 22.09.2026 это поймала: редактор мигал остановкой.
     */
    check(
      'сразу после применения движок не говорит «ничего не играет»',
      engine.playbackState().activeSceneId === maxScene.id,
      String(engine.playbackState().activeSceneId),
    );
    engine.setProject(project);
    await sleep(500);
    check('вселенных стало две', engine.universes.length === 2, String(engine.universes.length));
    check('в отчёте — добавленная вселенная', changes.some((c) => c.startsWith('добавлена вселенная 2')), changes.join(' / '));
    check('сцена продолжает играть', engine.playbackState().activeSceneId === maxScene.id);
    check('у первой вселенной тот же выход — порт не переоткрывали', engine.universes[0]!.outputs[0] === out1);
    check('ручной фейдер остался на месте', engine.universes[0]!.out[99] === 77, String(engine.universes[0]!.out[99]));
    check('в редактор уходит номер без автоимени', engine.universeInfos()[1]!.label === '');

    // ── два применения подряд, без паузы ────────────────────────────────
    // Второе раньше брало за правду пустое «ничего не играет» от только что
    // поднятого потока — и теряло сцену.
    engine.applyConfig([{ id: 1, label: '', outputs: [art(0)] }], 50);
    engine.applyConfig(two, 50);
    engine.setProject(project);
    await sleep(400);
    check('два применения подряд — сцена на месте', engine.playbackState().activeSceneId === maxScene.id);

    // ── сменить выход второй, не трогая первую ──────────────────────────
    const u2out = engine.universes[1]!.outputs[0]!;
    const sent2: Uint8Array[] = [];
    let closed2 = false;
    const real2 = u2out.send.bind(u2out);
    u2out.send = (f: Uint8Array): void => {
      sent2.push(Uint8Array.from(f));
      real2(f);
    };
    const realClose2 = u2out.close.bind(u2out);
    u2out.close = (): void => {
      closed2 = true;
      realClose2();
    };
    engine.applyConfig(
      [
        { id: 1, label: '', outputs: [art(0)] },
        { id: 2, label: '', outputs: [art(1, PORT + 1)] },
      ],
      50,
    );
    engine.setProject(project);
    await sleep(300);
    check('старый выход второй вселенной закрыт', closed2);
    check('и перед закрытием получил безопасный кадр', sent2.length > 0 && sent2[sent2.length - 1]!.every((v) => v === 0));
    check('у второй теперь новый выход', engine.universes[1]!.outputs[0] !== u2out);
    check('первую при этом не тронули', engine.universes[0]!.outputs[0] === out1);

    // ── ошибка в новой конфигурации ─────────────────────────────────────
    let error = '';
    try {
      engine.applyConfig(
        [
          { id: 1, label: '', outputs: [art(0)] },
          { id: 2, label: '', outputs: [art(1, PORT + 1)] },
          { id: 3, label: '', outputs: [{ type: 'artnet', universe: 2 }] }, // нет адреса
        ],
        50,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    check('кривой выход — отказ с понятным текстом', /Вселенная 3/.test(error) && /host|адрес|IP/i.test(error), error);
    check('после отказа всё как было', engine.universes.length === 2 && engine.universes[0]!.outputs[0] === out1);

    // ── убрать вселенную ─────────────────────────────────────────────────
    const u2new = engine.universes[1]!.outputs[0]!;
    const sent2b: Uint8Array[] = [];
    const real2b = u2new.send.bind(u2new);
    u2new.send = (f: Uint8Array): void => {
      sent2b.push(Uint8Array.from(f));
      real2b(f);
    };
    const removed = engine.applyConfig([{ id: 1, label: '', outputs: [art(0)] }], 50);
    engine.setProject(project);
    await sleep(300);
    check('убранная вселенная ушла', engine.universes.length === 1);
    check('в отчёте — убранная', removed.includes('убрана вселенная 2'), removed.join(' / '));
    check('убранной отправлен безопасный кадр', sent2b.length > 0 && sent2b[sent2b.length - 1]!.every((v) => v === 0));

    clearInterval(sampler);
    const dips = samples.filter((v) => v !== 255).length;
    check(
      'за все применения насос первой вселенной ни разу не упал',
      dips === 0,
      `выборок ${samples.length}, мимо максимума ${dips}`,
    );
    const zeroFrames = sent1.filter((f) => f[0] === 0).length;
    check('в линию первой вселенной не ушло ни одного кадра с нулём на насосе', zeroFrames === 0, `${zeroFrames} из ${sent1.length}`);
    out1.send = real1;

    // ── такт меняется посреди шоу ────────────────────────────────────────
    engine.setScene(null);
    engine.playShow(show.id, 0);
    await sleep(1200);
    const posBefore = engine.playbackState().show?.positionMs ?? -1;
    engine.applyConfig([{ id: 1, label: '', outputs: [art(0)] }], 40);
    engine.setProject(project);
    await sleep(600);
    const posAfter = engine.playbackState().show?.positionMs ?? -1;
    check('шоу идёт и после смены такта', engine.playbackState().show?.playing === true);
    check(
      'позиция шоу не прыгнула назад',
      posAfter > posBefore && posAfter < posBefore + 1500,
      `${posBefore} → ${posAfter} мс`,
    );
    check('новый такт действует', engine.config.timing.tickMs === 40);
  } finally {
    engine.stop();
  }
}

// ══ 3. Смена режима подготовки кадров — тоже без провала ════════════════
async function frameModeGap(): Promise<void> {
  console.log('— смена режима подготовки кадров —');
  const engine = new Engine({
    server: { port: 0 },
    timing: { tickMs: 50, spinMs: 10, uiFrameMs: 1000 },
    audio: { player: 'none', ffplayPath: '', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 },
    universes: [{ id: 1, label: '', outputs: [] }],
    backup: { enabled: false, intervalMin: 60 },
    playbackWorker: true,
    playbackLookaheadMs: 100,
  });
  engine.setProject(project);
  engine.start();
  try {
    engine.setScene(maxScene.id);
    await sleep(700);
    for (const [to, label] of [
      ['instant', 'предрасчёт → без предрасчёта'],
      ['ahead', 'без предрасчёта → предрасчёт'],
      ['inline', 'предрасчёт → одним потоком'],
      ['ahead', 'одним потоком → предрасчёт'],
    ] as const) {
      const samples: number[] = [];
      const t = setInterval(() => samples.push(engine.universes[0]!.out[0]!), 5);
      await sleep(100);
      engine.setFrameMode(to);
      await sleep(500);
      clearInterval(t);
      const dips = samples.filter((v) => v !== 255).length;
      // Замер 22.09.2026 до исправления: 10–15 выборок в нуле (50–75 мс).
      check(`${label}: воспроизведение не проваливается`, dips === 0, `мимо максимума ${dips} из ${samples.length}`);
    }
  } finally {
    engine.stop();
  }
}

// ══ 4. Монитор сети: перезапуск при «Применить» не роняет движок ═══════
async function netMonitorRestart(): Promise<void> {
  console.log('— монитор сети при применении —');
  /*
   * Найдено 22.09.2026 сквозной проверкой: при «Применить» опрос Art-Net
   * запускался дважды подряд, обработчик первого сокета звал setBroadcast у
   * второго, ещё не привязанного, — исключение вне try, движок падал. Здесь
   * повторяем ровно ту последовательность, что делает сервер.
   */
  const { NetworkMonitor } = await import('../netmonitor');
  const crashes: string[] = [];
  const onCrash = (e: unknown): void => {
    crashes.push(e instanceof Error ? e.message : String(e));
  };
  process.on('uncaughtException', onCrash);
  const net = new NetworkMonitor({ targets: ['127.0.0.1'], universes: [0], port: PORT + 10, pollMs: 60_000 });
  try {
    net.start();
    await sleep(200);
    for (let i = 0; i < 5; i++) {
      net.configure({ targets: ['127.0.0.1'], universes: [0, 1] });
      net.start();
    }
    await sleep(500);
    check('пять перезапусков опроса подряд — движок жив', crashes.length === 0, crashes.join(' / '));
  } finally {
    net.stop();
    process.off('uncaughtException', onCrash);
  }
}

async function main(): Promise<void> {
  await netMonitorRestart();
  await live('worker');
  await live('inline');
  await frameModeGap();
  console.log(`\nвселенные на ходу: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
}

await main();
