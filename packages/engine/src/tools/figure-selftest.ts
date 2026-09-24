/**
 * Самопроверка «Добавить фигуру фонтана» (shared/figure.ts).
 *
 * Фигура создаёт разом сотню приборов и форсунок с привязками — ошибка в
 * раздаче или в адресах на объекте всплыла бы только тогда, когда
 * тридцать шестая форсунка не загорится. Проверяем на примере заказчика
 * (24.09.2026): кольцо из 36 форсунок, у каждой свой светильник, один насос
 * на всё кольцо; и соседние случаи — 4 насоса, 72 светильника, чередование,
 * занятые адреса, наклон к центру, поворот.
 *
 * Запуск: npm -w @fountain-studio/engine run figure-test
 */
import {
  autoShare,
  autoFigureShare,
  emptyProject,
  figurePoints,
  planFigure,
  profileMap,
  sharesEvenly,
  type FigureSpec,
  type Project,
} from '@fountain-studio/shared';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

let seq = 0;
const newId = (): string => `id${++seq}`;

function spec(patch: Partial<FigureSpec> = {}): FigureSpec {
  const none = { count: 0, profileId: 'pump', universe: 1, startAddress: null, mode: 'blocks' as const };
  return {
    name: 'Кольцо',
    shape: 'ring',
    count: 36,
    size: 3,
    aspect: 0.6,
    cx: 0,
    cy: 0,
    cz: 0,
    rotationDeg: 0,
    nozzleKind: 'straight',
    maxHeightM: 5,
    widthM: 0.02,
    tiltDeg: 0,
    tiltTo: 'center',
    pump: { ...none, count: 1, profileId: 'pump' },
    valve: { ...none, profileId: 'valve' },
    light: { ...none, count: 36, profileId: 'rgb' },
    ...patch,
  };
}

// ── Раздача ──────────────────────────────────────────────────────────────
console.log('— раздача приборов по форсункам —');
check('один насос — на все 36 форсунок', autoShare(36, 1, 'blocks').every((c) => same(c, [0])));
check('36 светильников — по одному, по порядку', autoShare(36, 36, 'blocks').every((c, i) => same(c, [i])));
check('72 светильника — по два подряд', autoShare(36, 72, 'blocks').every((c, i) => same(c, [2 * i, 2 * i + 1])));
{
  const s = autoShare(36, 4, 'blocks');
  check('4 насоса частями — по 9 соседних', s.every((c, i) => same(c, [Math.floor(i / 9)])), JSON.stringify(s.map((c) => c[0])));
}
{
  const s = autoShare(36, 2, 'alternate');
  check('2 насоса чередуя — чётные и нечётные', s.every((c, i) => same(c, [i % 2])));
}
{
  const s = autoShare(10, 3, 'blocks').map((c) => c[0]);
  check('10 на 3 — части 4/3/3, без пропусков', same(s, [0, 0, 0, 0, 1, 1, 1, 2, 2, 2]), JSON.stringify(s));
  check('10 на 3 не делится ровно — человеку показывается предупреждение', !sharesEvenly(10, 3));
}
check('36 на 4 делится ровно', sharesEvenly(36, 4) && sharesEvenly(36, 72) && !sharesEvenly(36, 50));
check('ноль приборов — у форсунок пусто', autoShare(5, 0, 'blocks').every((c) => c.length === 0));

// ── Кольцо заказчика ─────────────────────────────────────────────────────
console.log('— кольцо 36 форсунок, 1 насос, 36 RGB —');
{
  const project = emptyProject();
  const sp = spec();
  const plan = planFigure(project, sp, autoFigureShare(sp), newId);
  const profiles = profileMap(project);
  check('без ошибок', plan.errors.length === 0, plan.errors.join('; '));
  check('37 приборов: 1 насос + 36 светильников', plan.devices.length === 37, String(plan.devices.length));
  const pump = plan.devices.find((d) => d.profileId === 'pump')!;
  const lights = plan.devices.filter((d) => d.profileId === 'rgb');
  check('насос на адресе 1', pump?.address === 1, String(pump?.address));
  check('светильники подряд со 2 по 109', lights[0]?.address === 2 && lights[35]?.address === 2 + 35 * 3, `${lights[0]?.address}…${lights[35]?.address}`);
  check('размер RGB — 3 адреса', profiles.get('rgb')?.channels.length === 3);
  check('36 форсунок', plan.nozzles.length === 36);
  check('у каждой форсунки один и тот же насос', plan.nozzles.every((n) => n.pumpDeviceId === pump.id && n.extraPumpDeviceIds.length === 0));
  check('у каждой свой светильник', new Set(plan.nozzles.map((n) => n.lightDeviceId)).size === 36 && plan.nozzles.every((n) => n.lightDeviceId));
  check('Ф1 — светильник 1, Ф36 — светильник 36', plan.nozzles[0]!.lightDeviceId === lights[0]!.id && plan.nozzles[35]!.lightDeviceId === lights[35]!.id);
  check('клапанов нет — у форсунок пусто', plan.nozzles.every((n) => n.valveDeviceId === null));
  check('контур «Кольцо» со всеми 36 форсунками', plan.group.name === 'Кольцо' && plan.group.nozzleIds.length === 36);
  check('высота и диаметр струи — из формы', plan.nozzles.every((n) => n.maxHeightM === 5 && n.widthM === 0.02));
  check('имена приборов с именем фигуры', pump.name === 'Кольцо · насос 1' && lights[0]!.name === 'Кольцо · свет 1', `${pump.name} / ${lights[0]!.name}`);
  check('диапазоны адресов для сводки', same(plan.ranges.map((r) => [r.role, r.from, r.to]), [['pump', 1, 1], ['light', 2, 109]]), JSON.stringify(plan.ranges));
}

// ── 72 светильника, 4 насоса, клапаны ────────────────────────────────────
console.log('— 72 светильника, 4 насоса, 36 клапанов —');
{
  const project = emptyProject();
  const sp = spec({
    pump: { count: 4, profileId: 'pump', universe: 1, startAddress: null, mode: 'blocks' },
    valve: { count: 36, profileId: 'valve', universe: 1, startAddress: null, mode: 'blocks' },
    light: { count: 72, profileId: 'rgb', universe: 2, startAddress: null, mode: 'blocks' },
  });
  const plan = planFigure(project, sp, autoFigureShare(sp), newId);
  const pumps = plan.devices.filter((d) => d.profileId === 'pump');
  const lights = plan.devices.filter((d) => d.profileId === 'rgb');
  check('без ошибок', plan.errors.length === 0, plan.errors.join('; '));
  check('Ф1…Ф9 на насосе 1, Ф10 — на насосе 2', plan.nozzles.slice(0, 9).every((n) => n.pumpDeviceId === pumps[0]!.id) && plan.nozzles[9]!.pumpDeviceId === pumps[1]!.id);
  check('у Ф1 два светильника: 1 и 2', plan.nozzles[0]!.lightDeviceId === lights[0]!.id && same(plan.nozzles[0]!.extraLightDeviceIds, [lights[1]!.id]));
  check('светильники — во второй вселенной с адреса 1', lights.every((l) => l.universe === 2) && lights[0]!.address === 1);
  check('клапаны после насосов: 5…40', plan.devices.filter((d) => d.profileId === 'valve')[0]?.address === 5);
}

// ── Занятые адреса ───────────────────────────────────────────────────────
console.log('— адреса учитывают уже занятые —');
{
  const project: Project = {
    ...emptyProject(),
    devices: [{ id: 'old', name: 'Старый прожектор', profileId: 'rgb', universe: 1, address: 1 }],
  };
  const sp = spec({ count: 4, light: { count: 4, profileId: 'rgb', universe: 1, startAddress: null, mode: 'blocks' } });
  const plan = planFigure(project, sp, autoFigureShare(sp), newId);
  check('насос встал после занятых 1–3', plan.devices[0]?.address === 4, String(plan.devices[0]?.address));
  const bad = planFigure(project, { ...sp, pump: { ...sp.pump, startAddress: 2 } }, autoFigureShare(sp), newId);
  check('свой начальный адрес на занятом — ошибка с именем прибора', bad.errors.some((e) => e.includes('Старый прожектор')), bad.errors.join('; '));
  const over = planFigure(emptyProject(), spec({ light: { count: 200, profileId: 'rgb', universe: 1, startAddress: null, mode: 'blocks' } }), autoFigureShare(spec()), newId);
  check('не влезает в 512 — ошибка, а не молча обрезано', over.errors.some((e) => e.includes('не хватает')), over.errors.join('; '));
}

// ── Геометрия ────────────────────────────────────────────────────────────
console.log('— геометрия: центр, поворот, наклон —');
{
  const one = figurePoints(spec({ count: 1, cx: 2, cy: -1 }));
  check('одна форсунка — в центре фигуры', same(one, [{ x: 2, y: -1 }]), JSON.stringify(one));
  const rot = figurePoints(spec({ count: 4, rotationDeg: 90 }));
  check('поворот 90° — первая форсунка на оси Y', Math.abs(rot[0]!.x) < 1e-6 && Math.abs(rot[0]!.y - 3) < 1e-6, JSON.stringify(rot[0]));
  const sp = spec({ count: 4, tiltDeg: 20, tiltTo: 'center' });
  const plan = planFigure(emptyProject(), sp, autoFigureShare(sp), newId);
  check('наклон к центру: форсунка справа смотрит влево (180°)', plan.nozzles[0]!.headingDeg === 180 && plan.nozzles[0]!.tiltDeg === 20, String(plan.nozzles[0]!.headingDeg));
  const out = planFigure(emptyProject(), { ...sp, tiltTo: 'out' }, autoFigureShare(sp), newId);
  check('наклон наружу: та же форсунка смотрит вправо (0°)', out.nozzles[0]!.headingDeg === 0, String(out.nozzles[0]!.headingDeg));
  check('поворот фигуры записан в контур', planFigure(emptyProject(), spec({ rotationDeg: 400 }), autoFigureShare(spec()), newId).group.rotationDeg === 40);
  const sq = figurePoints(spec({ shape: 'square', count: 8, size: 2 }));
  check('квадрат 8 — углы и середины сторон', sq.length === 8 && sq.some((p) => Math.abs(p.x + 2) < 1e-6 && Math.abs(p.y + 2) < 1e-6));
}

// ── Ручная правка раздачи ────────────────────────────────────────────────
console.log('— ручная правка таблицы —');
{
  const sp = spec({ count: 3, pump: { count: 2, profileId: 'pump', universe: 1, startAddress: null, mode: 'blocks' }, light: { count: 0, profileId: 'rgb', universe: 1, startAddress: null, mode: 'blocks' } });
  const share = autoFigureShare(sp);
  share.pump[2] = [0];
  const plan = planFigure(emptyProject(), sp, share, newId);
  const pumps = plan.devices.filter((d) => d.profileId === 'pump');
  check('Ф3 переставлена на насос 1 — так и создано', plan.nozzles[2]!.pumpDeviceId === pumps[0]!.id);
  share.pump[1] = [];
  const plan2 = planFigure(emptyProject(), sp, share, newId);
  check('убранный насос — у форсунки его нет', plan2.nozzles[1]!.pumpDeviceId === null);
}

console.log(`фигура фонтана: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
