/**
 * Самопроверка «Добавить фигуру фонтана» (shared/figure.ts).
 *
 * Фигура создаёт разом сотню приборов и форсунок с привязками — ошибка в
 * раздаче или в адресах на объекте всплыла бы только тогда, когда
 * тридцать шестая форсунка не загорится. Проверяем на примере заказчика
 * (24.09.2026): кольцо из 36 форсунок, у каждой свой светильник, один насос
 * на всё кольцо; и соседние случаи — 4 насоса, 72 светильника, чередование,
 * занятые адреса, наклон к центру, поворот. Со второго захода того же дня:
 * размеры как на объекте (радиус, сторона, длина × ширина, стороны
 * треугольника, ребро звезды), нумерация сверху по часовой, клапан — штучный,
 * адреса приборов, поправленные руками.
 *
 * Запуск: npm -w @fountain-studio/engine run figure-test
 */
import {
  autoShare,
  autoShareSingle,
  autoFigureShare,
  contourOverlaps,
  contourOwnDevices,
  DEFAULT_FIGURE_DIMS,
  emptyProject,
  figureDimsError,
  figureExtent,
  figureOutline,
  figurePoints,
  figureVertices,
  planFigure,
  profileMap,
  devicesDependents,
  removeContour,
  removeDevices,
  sharesEvenly,
  type FigureDims,
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
    dims: { ...DEFAULT_FIGURE_DIMS, radius: 3 },
    clockwise: true,
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
const dims = (patch: Partial<FigureDims>): FigureDims => ({ ...DEFAULT_FIGURE_DIMS, ...patch });
const near = (p: { x: number; y: number } | undefined, x: number, y: number): boolean =>
  !!p && Math.abs(p.x - x) < 1e-3 && Math.abs(p.y - y) < 1e-3;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

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

// Клапан штучный (заказчик 24.09.2026): «один клапан на все 10 форсунок» не бывает.
console.log('— клапаны: по одному —');
{
  const spread = autoShareSingle(10, 4, 'alternate');
  check('4 клапана на 10 — равномерно: Ф1, Ф3, Ф6, Ф8', same(spread.map((c) => c.length), [1, 0, 1, 0, 0, 1, 0, 1, 0, 0]), JSON.stringify(spread));
  check('каждый клапан — ровно одной форсунке', spread.flat().length === 4 && new Set(spread.flat()).size === 4);
  const first = autoShareSingle(10, 4, 'blocks');
  check('4 клапана на 10 «с Ф1 подряд» — Ф1…Ф4', same(first, [[0], [1], [2], [3], [], [], [], [], [], []]), JSON.stringify(first));
  check('10 на 10 — у каждой свой', autoShareSingle(10, 10, 'alternate').every((c, i) => same(c, [i])));
  const more = autoShareSingle(4, 6, 'alternate');
  check('6 клапанов на 4 — каждый клапан ровно одной форсунке', same(more.flat().sort(), [0, 1, 2, 3, 4, 5]), JSON.stringify(more));
  check('клапаны «ровно» — только поровну', sharesEvenly(10, 10, 'valve') && !sharesEvenly(10, 4, 'valve') && !sharesEvenly(10, 20, 'valve'));
  const one = autoFigureShare(spec({ valve: { count: 1, profileId: 'valve', universe: 1, startAddress: null, mode: 'alternate' } }));
  check('один клапан на 36 форсунок — одной форсунке, а не всем', one.valve.filter((c) => c.length > 0).length === 1);
}

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
    valve: { count: 36, profileId: 'valve', universe: 1, startAddress: null, mode: 'alternate' },
    light: { count: 72, profileId: 'rgb', universe: 2, startAddress: null, mode: 'blocks' },
  });
  const plan = planFigure(project, sp, autoFigureShare(sp), newId);
  const pumps = plan.devices.filter((d) => d.profileId === 'pump');
  const valves = plan.devices.filter((d) => d.profileId === 'valve');
  const lights = plan.devices.filter((d) => d.profileId === 'rgb');
  check('без ошибок', plan.errors.length === 0, plan.errors.join('; '));
  check('Ф1…Ф9 на насосе 1, Ф10 — на насосе 2', plan.nozzles.slice(0, 9).every((n) => n.pumpDeviceId === pumps[0]!.id) && plan.nozzles[9]!.pumpDeviceId === pumps[1]!.id);
  check('у Ф1 два светильника: 1 и 2', plan.nozzles[0]!.lightDeviceId === lights[0]!.id && same(plan.nozzles[0]!.extraLightDeviceIds, [lights[1]!.id]));
  check('светильники — во второй вселенной с адреса 1', lights.every((l) => l.universe === 2) && lights[0]!.address === 1);
  check('клапаны после насосов: 5…40', valves[0]?.address === 5 && valves[35]?.address === 40);
  check('у каждой форсунки свой клапан', plan.nozzles.every((n, i) => n.valveDeviceId === valves[i]!.id && n.extraValveDeviceIds.length === 0));
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

// ── Адреса приборов: видно каждый, можно поправить ───────────────────────
console.log('— адреса приборов по видам и правка руками —');
{
  const sp = spec({ count: 12, light: { count: 12, profileId: 'rgb', universe: 1, startAddress: null, mode: 'blocks' } });
  const plan = planFigure(emptyProject(), sp, autoFigureShare(sp), newId);
  check('по видам: насос 1 на 1, свет 3 на 8 (RGB по 3 адреса)', plan.byRole.pump[0]?.address === 1 && plan.byRole.light[2]?.address === 8 && plan.span.light === 3);
  const fixed = planFigure(emptyProject(), { ...sp, light: { ...sp.light, fixed: { 0: 200 } } }, autoFigureShare(sp), newId);
  check(
    'свет 1 вписан руками на 200 — там и стоит, свет 2 — на первом свободном (2)',
    fixed.errors.length === 0 && fixed.byRole.light[0]?.address === 200 && fixed.byRole.light[1]?.address === 2,
    fixed.errors.join('; '),
  );
  check('поправленный прибор привязан к своей форсунке', fixed.nozzles[0]!.lightDeviceId === fixed.byRole.light[0]!.id);
  const clash = planFigure(emptyProject(), { ...sp, light: { ...sp.light, fixed: { 0: 1 } } }, autoFigureShare(sp), newId);
  check('вписан адрес насоса — ошибка «занят» с именем прибора', clash.errors.some((e) => e.includes('занят') && e.includes('насос 1')), clash.errors.join('; '));
  const tail = planFigure(emptyProject(), { ...sp, light: { ...sp.light, fixed: { 0: 511 } } }, autoFigureShare(sp), newId);
  check('RGB на 511 не помещается в 512 — ошибка', tail.errors.some((e) => e.includes('не помещается')), tail.errors.join('; '));
  const from = planFigure(emptyProject(), { ...sp, light: { ...sp.light, startAddress: 10, fixed: { 1: 13 } } }, autoFigureShare(sp), newId);
  check(
    'с адреса 10, свет 2 на 13: свет 1 — 10, свет 3 — 16 (свой поправленный перешагнули)',
    from.errors.length === 0 && from.byRole.light[0]?.address === 10 && from.byRole.light[1]?.address === 13 && from.byRole.light[2]?.address === 16,
    from.errors.join('; ') + ' ' + from.byRole.light.slice(0, 3).map((d) => d?.address).join(','),
  );
}

// ── Геометрия ────────────────────────────────────────────────────────────
// Заказчик 24.09.2026: размеры — как меряют на объекте; нумерация у всех фигур
// с одной точки (сверху; у квадрата и прямоугольника — верхний правый угол) и
// по часовой стрелке. «Сверху» — это +Y: так на виде сверху и в 3D.
console.log('— геометрия: размеры, нумерация, центр, поворот, наклон —');
{
  const one = figurePoints(spec({ count: 1, cx: 2, cy: -1 }));
  check('одна форсунка — в центре фигуры', same(one, [{ x: 2, y: -1 }]), JSON.stringify(one));

  const ring = figurePoints(spec({ count: 10 }));
  check(
    'кольцо радиусом 3 м: все 10 форсунок в 3 м от центра',
    ring.every((p) => Math.abs(Math.hypot(p.x, p.y) - 3) < 1e-3),
    ring.map((p) => Math.hypot(p.x, p.y).toFixed(3)).join(' '),
  );
  check('кольцо: Ф1 сверху (0; 3), Ф6 снизу (0; −3)', near(ring[0], 0, 3) && near(ring[5], 0, -3), JSON.stringify([ring[0], ring[5]]));
  check('кольцо: по часовой — Ф2 правее Ф1', ring[1]!.x > 0.5, JSON.stringify(ring[1]));
  const ext = figureExtent(figurePoints(spec({ count: 12 })));
  check('кольцо радиусом 3 м: размах 6 × 6 м', Math.abs(ext.x - 6) < 1e-3 && Math.abs(ext.y - 6) < 1e-3, JSON.stringify(ext));
  const ccw = figurePoints(spec({ count: 10, clockwise: false }));
  check('кольцо против часовой — Ф1 сверху, Ф2 левее', near(ccw[0], 0, 3) && ccw[1]!.x < -0.5, JSON.stringify(ccw.slice(0, 2)));
  const rot = figurePoints(spec({ count: 4, rotationDeg: 90 }));
  check('поворот 90° (против часовой) — Ф1 уходит с верха влево', near(rot[0], -3, 0), JSON.stringify(rot[0]));

  const sp = spec({ count: 4, tiltDeg: 20, tiltTo: 'center' });
  const plan = planFigure(emptyProject(), sp, autoFigureShare(sp), newId);
  check('наклон к центру: верхняя форсунка смотрит вниз (270°)', plan.nozzles[0]!.headingDeg === 270 && plan.nozzles[0]!.tiltDeg === 20, String(plan.nozzles[0]!.headingDeg));
  check('наклон к центру: правая форсунка (Ф2) смотрит влево (180°)', plan.nozzles[1]!.headingDeg === 180, String(plan.nozzles[1]!.headingDeg));
  const out = planFigure(emptyProject(), { ...sp, tiltTo: 'out' }, autoFigureShare(sp), newId);
  check('наклон наружу: верхняя форсунка смотрит вверх (90°)', out.nozzles[0]!.headingDeg === 90, String(out.nozzles[0]!.headingDeg));
  check('поворот фигуры записан в контур', planFigure(emptyProject(), spec({ rotationDeg: 400 }), autoFigureShare(spec()), newId).group.rotationDeg === 40);

  const sq = figurePoints(spec({ shape: 'square', count: 8, dims: dims({ side: 4 }) }));
  check('квадрат со стороной 4 м из 8: Ф1 — верхний правый угол (2; 2)', near(sq[0], 2, 2), JSON.stringify(sq[0]));
  check('квадрат по часовой: Ф2 — середина правой стороны, Ф3 — нижний правый угол', near(sq[1], 2, 0) && near(sq[2], 2, -2), JSON.stringify(sq.slice(1, 3)));
  check('квадрат: Ф5 — нижний левый, Ф7 — верхний левый', near(sq[4], -2, -2) && near(sq[6], -2, 2));
  const sqCcw = figurePoints(spec({ shape: 'square', count: 8, dims: dims({ side: 4 }), clockwise: false }));
  check('квадрат против часовой: Ф1 тот же угол, Ф2 — середина верхней стороны', near(sqCcw[0], 2, 2) && near(sqCcw[1], 0, 2), JSON.stringify(sqCcw.slice(0, 2)));

  const rect = figurePoints(spec({ shape: 'rect', count: 36, dims: dims({ length: 6, width: 3.6 }) }));
  check('прямоугольник 6 × 3,6 м: Ф1 — верхний правый угол (3; 1,8)', near(rect[0], 3, 1.8), JSON.stringify(rect[0]));
  check('прямоугольник: Ф2 идёт вниз по правой стороне', Math.abs(rect[1]!.x - 3) < 1e-3 && rect[1]!.y < 1.8, JSON.stringify(rect[1]));
  const rectV = figureVertices('rect', dims({ length: 6, width: 3.6 }));
  check('прямоугольник из 36: все 4 угла заняты', rect.length === 36 && rectV.every((v) => rect.some((p) => near(p, v.x, v.y))));
  const onSide = (y: number): number => rect.filter((p) => Math.abs(p.y - y) < 1e-3).length;
  check('прямоугольник из 36: по 12 на длинных сторонах (с углами), 8 на коротких', onSide(-1.8) === 12 && onSide(1.8) === 12, `${onSide(-1.8)} / ${onSide(1.8)}`);
  const e = figureExtent(rect);
  check('прямоугольник: размах ровно 6 × 3,6 м', Math.abs(e.x - 6) < 1e-3 && Math.abs(e.y - 3.6) < 1e-3, JSON.stringify(e));

  const tri = figurePoints(spec({ shape: 'triangle', count: 3, dims: dims({ equilateral: true, side: 4 }) }));
  check('равносторонний треугольник со стороной 4 м: Ф1 сверху', near(tri[0], 0, 4 / Math.sqrt(3)), JSON.stringify(tri[0]));
  check(
    'равносторонний: все стороны по 4 м, Ф2 — нижний правый угол',
    [dist(tri[0]!, tri[1]!), dist(tri[1]!, tri[2]!), dist(tri[2]!, tri[0]!)].every((l) => Math.abs(l - 4) < 1e-3) && tri[1]!.x > 0,
  );
  const scal = figureVertices('triangle', dims({ equilateral: false, sides: [6, 5, 4] }));
  check(
    'треугольник 6 / 5 / 4: основание 6, правая 5, левая 4',
    Math.abs(dist(scal[1]!, scal[2]!) - 6) < 1e-9 && Math.abs(dist(scal[0]!, scal[1]!) - 5) < 1e-9 && Math.abs(dist(scal[2]!, scal[0]!) - 4) < 1e-9,
  );
  check(
    'треугольник 6 / 5 / 4: центр фигуры — центр тяжести',
    Math.abs(scal[0]!.x + scal[1]!.x + scal[2]!.x) < 1e-9 && Math.abs(scal[0]!.y + scal[1]!.y + scal[2]!.y) < 1e-9,
  );
  check('треугольник 5 / 1 / 1 не строится — понятная ошибка', figureDimsError('triangle', dims({ equilateral: false, sides: [5, 1, 1] }))?.includes('короче суммы') === true);
  const badSpec = spec({ shape: 'triangle', count: 6, dims: dims({ equilateral: false, sides: [5, 1, 1] }) });
  const bad = planFigure(emptyProject(), badSpec, autoFigureShare(badSpec), newId);
  check('с невозможными размерами фигура не создаётся', bad.errors.length > 0 && bad.nozzles.length === 0, bad.errors.join('; '));
}

// ── Правильная звезда: вершины заняты, стороны ровные ───────────────────
// Заказчик 24.09.2026: «звезда ужасная». Звезда должна быть правильной: все
// рёбра одной длины, все углы лучей равны между собой и все впадины — тоже.
console.log('— правильная звезда по ребру —');
{
  const V = figureVertices('star', dims({ starEdge: 2 }));
  const len = V.map((p, i) => dist(p, V[(i + 1) % 10]!));
  check('звезда с ребром 2 м: все 10 рёбер по 2 м', len.every((l) => Math.abs(l - 2) < 1e-9), len.map((l) => l.toFixed(4)).join(' '));
  const angle = (i: number): number => {
    const p = V[i]!;
    const a = V[(i + 9) % 10]!;
    const b = V[(i + 1) % 10]!;
    const u = { x: a.x - p.x, y: a.y - p.y };
    const v = { x: b.x - p.x, y: b.y - p.y };
    return (Math.acos((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y))) * 180) / Math.PI;
  };
  const tips = [0, 2, 4, 6, 8].map(angle);
  const inner = [1, 3, 5, 7, 9].map(angle);
  check('звезда: углы лучей все по 36°', tips.every((a) => Math.abs(a - 36) < 1e-6), tips.map((a) => a.toFixed(3)).join(' '));
  check('звезда: углы впадин все равны (108° снаружи)', inner.every((a) => Math.abs(a - 108) < 1e-6), inner.map((a) => a.toFixed(3)).join(' '));
  check('звезда: Ф1 — верхний луч, Ф2 — впадина справа от него', Math.abs(V[0]!.x) < 1e-9 && V[0]!.y > 0 && V[1]!.x > 0);

  const at = (count: number) => figurePoints(spec({ shape: 'star', count, dims: dims({ starEdge: 2 }) }));
  const onVertex = (pts: { x: number; y: number }[], v: { x: number; y: number }[]): boolean => v.every((q) => pts.some((p) => near(p, q.x, q.y)));
  const star36 = at(36);
  check('звезда из 36: форсунки во всех 10 вершинах', star36.length === 36 && onVertex(star36, V));
  const star5 = at(5);
  check('звезда из 5: концы лучей', star5.length === 5 && onVertex(star5, [0, 2, 4, 6, 8].map((i) => V[i]!)));
  const star30 = at(30);
  const gaps = star30.map((p, i) => dist(p, star30[(i + 1) % 30]!));
  check('звезда из 30: шаг между форсунками везде одинаковый', gaps.every((g) => Math.abs(g - gaps[0]!) < 2e-3), gaps.map((g) => g.toFixed(3)).join(' '));
  const rotSpec = spec({ shape: 'star', count: 10, dims: dims({ starEdge: 2 }), cx: 1, cy: 1, rotationDeg: 30 });
  check('поворот и центр — форсунки в вершинах повёрнутой звезды', onVertex(figurePoints(rotSpec), figureOutline(rotSpec)));
  const tri7 = figurePoints(spec({ shape: 'triangle', count: 7, dims: dims({ side: 4 }) }));
  check('треугольник из 7: три вершины заняты', tri7.length === 7 && onVertex(tri7, figureVertices('triangle', dims({ side: 4 }))));
}

// ── Групповое удаление приборов ──────────────────────────────────────────
console.log('— групповое удаление —');
{
  const base = emptyProject();
  const sp = spec({ count: 4, light: { count: 4, profileId: 'rgb', universe: 1, startAddress: null, mode: 'blocks' } });
  const plan = planFigure(base, sp, autoFigureShare(sp), newId);
  const pump = plan.devices.find((d) => d.profileId === 'pump')!;
  const lights = plan.devices.filter((d) => d.profileId === 'rgb');
  const project: Project = {
    ...base,
    devices: [...base.devices, ...plan.devices],
    layout: { ...base.layout, nozzles: plan.nozzles, nozzleGroups: [plan.group] },
    scenes: [{ id: 's1', name: 'Сцена', values: { [pump.id]: [200], [lights[0]!.id]: [255, 0, 0] } } as Project['scenes'][number]],
  };
  const deps = devicesDependents(project, lights.map((l) => l.id));
  check('перед удалением видно, где используются', deps.some((d) => d.startsWith('сцены (1)')) && deps.some((d) => d.startsWith('форсунки на 3D-схеме (4)')), deps.join('; '));
  const after = removeDevices(project, lights.map((l) => l.id));
  check('светильники удалены, насос остался', after.devices.length === 1 && after.devices[0]!.id === pump.id);
  check('у форсунок светильники отвязаны, насос на месте', after.layout.nozzles.every((n) => n.lightDeviceId === null && n.pumpDeviceId === pump.id));
  check('из сцены значения светильника ушли, насоса — остались', !(lights[0]!.id in after.scenes[0]!.values) && pump.id in after.scenes[0]!.values);
  check('контур и форсунки не тронуты', after.layout.nozzles.length === 4 && after.layout.nozzleGroups.length === 1);
}

// ── Удаление контура с выбором (заказчик 25.09.2026) ─────────────────────
console.log('— удаление контура: только контур / с элементами / с приборами —');
{
  const base = emptyProject();
  // Два кольца; насос общий для обоих (его удалять нельзя — он нужен второму).
  const a = spec({ name: 'Кольцо', count: 4, light: { count: 4, profileId: 'rgb', universe: 1, startAddress: null, mode: 'blocks' } });
  const pa = planFigure(base, a, autoFigureShare(a), newId);
  const withA: Project = { ...base, devices: pa.devices, layout: { ...base.layout, nozzles: pa.nozzles, nozzleGroups: [pa.group] } };
  const b = spec({ name: 'Кольцо 2', count: 3, pump: { count: 0, profileId: 'pump', universe: 1, startAddress: null, mode: 'blocks' }, light: { count: 3, profileId: 'rgb', universe: 1, startAddress: null, mode: 'blocks' } });
  const pb = planFigure(withA, b, autoFigureShare(b), newId);
  const sharedPump = pa.devices.find((d) => d.profileId === 'pump')!;
  const nozzlesB = pb.nozzles.map((n) => ({ ...n, pumpDeviceId: sharedPump.id }));
  const project: Project = {
    ...withA,
    devices: [...withA.devices, ...pb.devices],
    layout: { ...withA.layout, nozzles: [...withA.layout.nozzles, ...nozzlesB], nozzleGroups: [...withA.layout.nozzleGroups, pb.group] },
  };
  const own = contourOwnDevices(project, pb.group.id);
  check('свои приборы второго кольца — 3 светильника, общий насос не свой', own.length === 3 && !own.includes(sharedPump.id), own.length + '');
  const g = removeContour(project, pb.group.id, 'group');
  check('«только контур»: группировки нет, форсунки и приборы на месте', g.layout.nozzleGroups.length === 1 && g.layout.nozzles.length === 7 && g.devices.length === project.devices.length);
  const e = removeContour(project, pb.group.id, 'elements');
  check('«с элементами»: 3 форсунки ушли со схемы, приборы на месте', e.layout.nozzles.length === 4 && e.devices.length === project.devices.length && e.layout.nozzleGroups.length === 1);
  const all = removeContour(project, pb.group.id, 'all');
  check('«с приборами»: ушли и 3 светильника, общий насос остался', all.devices.length === project.devices.length - 3 && all.devices.some((d) => d.id === sharedPump.id));
  check('у первого кольца всё на месте', all.layout.nozzles.filter((n) => n.pumpDeviceId === sharedPump.id).length === 4 && all.layout.nozzleGroups[0]!.nozzleIds.length === 4);
  const overlapProject: Project = {
    ...project,
    layout: { ...project.layout, nozzleGroups: [...project.layout.nozzleGroups, { ...pb.group, id: 'x', name: 'Общий', nozzleIds: [nozzlesB[0]!.id] }] },
  };
  check('элемент в двух контурах — видно, из какого ещё он пропадёт', same(contourOverlaps(overlapProject, pb.group.id), ['Общий']));
  const cleaned = removeContour(overlapProject, pb.group.id, 'elements');
  check('…и из того контура он вычищен', cleaned.layout.nozzleGroups.find((x) => x.id === 'x')!.nozzleIds.length === 0);
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
