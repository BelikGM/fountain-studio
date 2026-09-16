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
  audio: { player: 'none', ffplayPath: 'ffplay' },
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

  engine.stop();
  console.log(`failsafe: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
}

await main();
