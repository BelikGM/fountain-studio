/**
 * Самопроверка аварийного отключения (см. shared/failsafe.ts) без железа.
 *
 * Поднимает настоящий движок с выходом на заведомо несуществующий COM-порт:
 * драйвер честно отвечает, что доставки нет, и через заданный таймаут движок
 * обязан принудительно положить насосы и клапаны в 0. Затем выход подменяется
 * на «исправный», и движок обязан сам снять аварию и вернуть обычные значения.
 *
 * Запуск: npm -w @fountain-studio/engine run failsafe-test
 */
import { profileMap, sanitizeProject } from '@fountain-studio/shared';
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

const TIMEOUT_SEC = 3;

const config: EngineConfig = {
  server: { port: 0 },
  timing: { tickMs: 50, spinMs: 10, uiFrameMs: 100 },
  audio: { player: 'none', ffplayPath: 'ffplay', volumeDb: 0, muted: false, bassDb: 0, trebleDb: 0 },
  // Порт заведомо не существует — открыть его не удастся, и healthy() вернёт false.
  universes: [{ id: 1, label: 'Линия 1', outputs: [{ type: 'open-dmx', universe: 0, path: 'COM_NOPE' }] }],
  backup: { enabled: false, intervalMin: 10 },
};

const project = sanitizeProject({
  ...createDemoProject(),
  failsafe: { enabled: true, timeoutSec: TIMEOUT_SEC, lights: true },
});

/** Индексы каналов насосов и ламп первой вселенной — по ним и проверяем гашение. */
function channelsOfKind(kind: string): number[] {
  const profiles = profileMap(project);
  const out: number[] = [];
  for (const d of project.devices) {
    if (d.universe !== 1) continue;
    const p = profiles.get(d.profileId);
    if (!p || p.kind !== kind) continue;
    for (let k = 0; k < p.channels.length; k++) out.push(d.address - 1 + k);
  }
  return out;
}

async function main(): Promise<void> {
  const pumpIdx = channelsOfKind('pump');
  const lampIdx = channelsOfKind('lamp');
  check('в демо-проекте есть насосы', pumpIdx.length > 0, String(pumpIdx.length));
  check('в демо-проекте есть свет', lampIdx.length > 0, String(lampIdx.length));

  const engine = new Engine(config);
  engine.setProject(project);
  engine.start();
  const u = engine.universes[0]!;
  const out = engine.universes[0]!.outputs[0]!;
  check('драйвер умеет сообщать о доставке', typeof out.healthy === 'function');

  // Ставим воду и свет руками — как будто идёт шоу.
  for (const i of pumpIdx) engine.setChannel(1, i + 1, 200);
  for (const i of lampIdx) engine.setChannel(1, i + 1, 180);
  await sleep(200);
  check('до аварии насосы работают', pumpIdx.every((i) => u.out[i] === 200), `${u.out[pumpIdx[0]!]}`);
  check('до аварии авария не взведена', !engine.failsafeState().active);

  // Ждём таймаут: выход всё это время не доставляет.
  await sleep(TIMEOUT_SEC * 1000 + 700);
  const st = engine.failsafeState();
  check('авария сработала по недоставке', st.active && /не доставляет/.test(st.reason), JSON.stringify(st));
  check('насосы принудительно в 0', pumpIdx.every((i) => u.out[i] === 0), `${u.out[pumpIdx[0]!]}`);
  check('клапаны/свет тоже погашены', lampIdx.every((i) => u.out[i] === 0), `${u.out[lampIdx[0]!]}`);
  check('срабатывание посчитано', st.trips === 1, String(st.trips));

  // «Починили» связь — подменяем ответ драйвера о доставке.
  (out as { healthy?: () => boolean }).healthy = () => true;
  await sleep(600);
  const st2 = engine.failsafeState();
  check('авария снялась сама', !st2.active, JSON.stringify(st2));
  check('насосы вернулись к своим значениям', pumpIdx.every((i) => u.out[i] === 200), `${u.out[pumpIdx[0]!]}`);
  check('свет вернулся', lampIdx.every((i) => u.out[i] === 180), `${u.out[lampIdx[0]!]}`);

  // Выключенная настройка ничего не гасит.
  engine.setProject(sanitizeProject({ ...project, failsafe: { enabled: false, timeoutSec: TIMEOUT_SEC, lights: true } }));
  (out as { healthy?: () => boolean }).healthy = () => false;
  await sleep(TIMEOUT_SEC * 1000 + 700);
  check('с выключенной настройкой авария не срабатывает', !engine.failsafeState().active);
  check('вода продолжает работать', pumpIdx.every((i) => u.out[i] === 200), `${u.out[pumpIdx[0]!]}`);

  /*
   * Гашение при закрытии. Заказчик описал это с натуры: программу закрыли —
   * светильники застыли в случайном состоянии. Приёмник DMX держит последний
   * кадр, поэтому движок обязан перед закрытием порта сам прислать безопасный.
   * Перехватываем send и смотрим, что именно ушло в линию последним.
   */
  (out as { healthy?: () => boolean }).healthy = () => true;
  engine.setProject(sanitizeProject({ ...project, failsafe: { enabled: true, timeoutSec: TIMEOUT_SEC, lights: true } }));
  for (const i of pumpIdx) engine.setChannel(1, i + 1, 200);
  for (const i of lampIdx) engine.setChannel(1, i + 1, 180);
  await sleep(300);
  check('перед закрытием вода идёт', pumpIdx.every((i) => u.out[i] === 200), `${u.out[pumpIdx[0]!]}`);

  const sent: Uint8Array[] = [];
  const realSend = out.send.bind(out);
  out.send = (frame: Uint8Array): void => {
    sent.push(Uint8Array.from(frame));
    realSend(frame);
  };
  engine.stop();
  const last = sent[sent.length - 1];
  check('при закрытии кадр в линию ушёл', sent.length > 0, String(sent.length));
  check('повторён несколько раз (DMX без подтверждений)', sent.length >= 3, String(sent.length));
  check('насосы в закрывающем кадре в 0', !!last && pumpIdx.every((i) => last[i] === 0), last ? String(last[pumpIdx[0]!]) : 'нет кадра');
  check('свет в закрывающем кадре погашен', !!last && lampIdx.every((i) => last[i] === 0), last ? String(last[lampIdx[0]!]) : 'нет кадра');

  /*
   * С выключенным гашением света вода всё равно падает, а прожекторы остаются:
   * на части объектов их держат дежурной подсветкой.
   */
  const engine2 = new Engine(config);
  engine2.setProject(sanitizeProject({ ...project, failsafe: { enabled: true, timeoutSec: TIMEOUT_SEC, lights: false } }));
  engine2.start();
  const u2 = engine2.universes[0]!;
  const out2 = engine2.universes[0]!.outputs[0]!;
  for (const i of pumpIdx) engine2.setChannel(1, i + 1, 200);
  for (const i of lampIdx) engine2.setChannel(1, i + 1, 180);
  await sleep(300);
  check('второй движок: вода идёт', pumpIdx.every((i) => u2.out[i] === 200), `${u2.out[pumpIdx[0]!]}`);
  const sent2: Uint8Array[] = [];
  const realSend2 = out2.send.bind(out2);
  out2.send = (frame: Uint8Array): void => {
    sent2.push(Uint8Array.from(frame));
    realSend2(frame);
  };
  engine2.stop();
  const last2 = sent2[sent2.length - 1];
  check('вода падает и при выключенном гашении света', !!last2 && pumpIdx.every((i) => last2[i] === 0), last2 ? String(last2[pumpIdx[0]!]) : 'нет кадра');
  check('свет при этом остался гореть', !!last2 && lampIdx.every((i) => last2[i] === 180), last2 ? String(last2[lampIdx[0]!]) : 'нет кадра');

  /*
   * Режим отладки (см. messages.ts, setBenchMode). На столе интерфейса DMX нет
   * вовсе, выход «не доставляет» всегда — и гашение каждые timeoutSec роняло
   * воду и свет в 0: проверить форсунки было нельзя. В режиме отладки гашение
   * не срабатывает, но ПРИЧИНА (linkBad) по-прежнему видна: интерфейс должен
   * честно писать, что кадры в линию не уходят.
   */
  const engine3 = new Engine({ ...config, benchMode: true });
  engine3.setProject(sanitizeProject({ ...project, failsafe: { enabled: true, timeoutSec: TIMEOUT_SEC, lights: true } }));
  engine3.start();
  const u3 = engine3.universes[0]!;
  check('режим отладки включён из настроек программы', engine3.benchModeOn());
  for (const i of pumpIdx) engine3.setChannel(1, i + 1, 200);
  for (const i of lampIdx) engine3.setChannel(1, i + 1, 180);
  await sleep(TIMEOUT_SEC * 1000 + 700);
  const st3 = engine3.failsafeState();
  check('в режиме отладки гашение не срабатывает', !st3.active, JSON.stringify(st3));
  check('в режиме отладки вода держится', pumpIdx.every((i) => u3.out[i] === 200), `${u3.out[pumpIdx[0]!]}`);
  check('в режиме отладки свет держится', lampIdx.every((i) => u3.out[i] === 180), `${u3.out[lampIdx[0]!]}`);
  check('причина всё равно видна: выход не доставляет', st3.linkBad, JSON.stringify(st3));
  check('состояние говорит, что режим отладки включён', st3.benchMode);

  // Выключили режим отладки на ходу — гашение обязано сработать снова.
  engine3.setBenchMode(false);
  await sleep(TIMEOUT_SEC * 1000 + 700);
  const st4 = engine3.failsafeState();
  check('после выключения режима отладки гашение сработало', st4.active, JSON.stringify(st4));
  check('вода ушла в 0', pumpIdx.every((i) => u3.out[i] === 0), `${u3.out[pumpIdx[0]!]}`);
  // И обратно: включили режим отладки — гашение снимается сразу, не дожидаясь таймаута.
  engine3.setBenchMode(true);
  await sleep(300);
  check('включили режим отладки — гашение снялось сразу', !engine3.failsafeState().active);
  check('вода вернулась к своим значениям', pumpIdx.every((i) => u3.out[i] === 200), `${u3.out[pumpIdx[0]!]}`);
  engine3.stop();

  /*
   * Признак «выход не доставляет» держится всё время, пока оборудования нет, —
   * именно по нему интерфейс рисует полосу отладки. Раньше полоса висела на
   * мгновенном active: гашение то срабатывало, то снималось, и кнопка
   * «включить режим отладки» исчезала из-под мыши.
   */
  const engine4 = new Engine({ ...config, benchMode: true });
  engine4.setProject(project);
  engine4.start();
  await sleep(400);
  const bad1 = engine4.failsafeState().linkBad;
  await sleep(600);
  const bad2 = engine4.failsafeState().linkBad;
  check('признак недоставки не мигает', bad1 && bad2, `${bad1} → ${bad2}`);
  (engine4.universes[0]!.outputs[0]! as { healthy?: () => boolean }).healthy = () => true;
  await sleep(400);
  check('починили выход — признак снялся', !engine4.failsafeState().linkBad);
  engine4.stop();

  /*
   * Что гасить — три отдельные галочки (заказчик 23.09.2026). Гасим только
   * насосы: клапаны остаются открытыми, свет горит.
   */
  const valveIdx = channelsOfKind('valve');
  check('в демо-проекте есть клапаны', valveIdx.length > 0, String(valveIdx.length));
  const engine5 = new Engine(config);
  engine5.setProject(sanitizeProject({ ...project, failsafe: { enabled: true, timeoutSec: TIMEOUT_SEC, pumps: true, valves: false, lights: false } }));
  engine5.start();
  const u5 = engine5.universes[0]!;
  for (const i of pumpIdx) engine5.setChannel(1, i + 1, 200);
  for (const i of valveIdx) engine5.setChannel(1, i + 1, 255);
  for (const i of lampIdx) engine5.setChannel(1, i + 1, 180);
  await sleep(TIMEOUT_SEC * 1000 + 700);
  check('гашение сработало', engine5.failsafeState().active);
  check('насосы в 0', pumpIdx.every((i) => u5.out[i] === 0), `${u5.out[pumpIdx[0]!]}`);
  check('клапаны без галочки остались открыты', valveIdx.every((i) => u5.out[i] === 255), `${u5.out[valveIdx[0]!]}`);
  check('свет без галочки остался гореть', lampIdx.every((i) => u5.out[i] === 180), `${u5.out[lampIdx[0]!]}`);
  engine5.stop();

  console.log(`failsafe: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
}

await main();
