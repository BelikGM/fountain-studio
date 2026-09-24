/**
 * Фигура фонтана одним заходом: форсунки по кольцу (квадрату, звезде…) вместе
 * с насосами, клапанами и светом — и сразу привязанные друг к другу.
 *
 * ── Зачем ────────────────────────────────────────────────────────────────
 * Заказчик 24.09.2026: кольцо из 36 форсунок, у каждой свой светильник, на всё
 * кольцо один насос. Раньше это было три отдельных шага: завести приборы на
 * «Оборудовании», расставить форсунки в 3D, а потом КАЖДОЙ из 36 форсунок
 * руками выбрать насос и светильник. На объекте с сотнями приборов так
 * работать нельзя.
 *
 * ── Как делятся приборы между форсунками ─────────────────────────────────
 * Насосы и свет — по кратности, как это обычно монтируют:
 *  · приборов столько же, сколько форсунок, — по одному на форсунку;
 *  · больше и кратно (72 светильника на 36) — по нескольку на форсунку, подряд;
 *  · меньше (4 насоса на 36) — каждый насос на свою часть фигуры
 *    («частями»: 9 соседних форсунок) или через одну («чередуя»: так часто
 *    ставят два насоса на кольцо — чётные и нечётные форсунки).
 * Клапан — вещь штучная (заказчик 24.09.2026): один клапан на несколько
 * форсунок не делится. Клапанов меньше — они достаются части форсунок
 * (через равные промежутки или подряд с Ф1 — выбирает человек), остальные без
 * клапана; больше — у некоторых форсунок по два, и человеку говорится
 * сверить таблицу.
 * Не угадали — человек правит таблицу «форсунка → насос, клапан, свет»;
 * planFigure берёт уже поправленную раздачу.
 *
 * ── Размеры и нумерация (заказчик 24.09.2026) ───────────────────────────
 * Размеры — как их меряют на объекте: радиус кольца, сторона квадрата, длина
 * и ширина прямоугольника, стороны треугольника (у равностороннего — одна),
 * ребро звезды (у правильной звезды все десять рёбер равны). Раньше было одно
 * поле «размер — половина стороны», и что оно значит, было непонятно.
 * Нумерация у всех фигур одна: Ф1 сверху — у кольца, треугольника и звезды
 * верхняя точка, у квадрата и прямоугольника верхний правый угол, — дальше по
 * часовой стрелке (можно против). Раньше у каждой фигуры было своё начало:
 * у кольца на «трёх часах», у квадрата в нижнем левом углу, и обход — против
 * часовой.
 */

import { nozzleDefaults, type LayoutShape, type Nozzle, type NozzleGroup, type NozzleKind } from './layout';
import { DMX_UNIVERSE_SIZE } from './dmx';
import { allProfiles, deviceRange, nextFreeAddress, profileMap, type PatchedDevice, type Project } from './project';

/**
 * Как делить приборы, которых меньше, чем форсунок: «частями» (подряд) или
 * «чередуя» (вперемешку). У клапанов то же поле значит «подряд с Ф1» или
 * «через равные промежутки по фигуре».
 */
export type ShareMode = 'blocks' | 'alternate';

export type FigureRole = 'pump' | 'valve' | 'light';

export const FIGURE_ROLES: { role: FigureRole; label: string; one: string }[] = [
  { role: 'pump', label: 'Насосы', one: 'насос' },
  { role: 'valve', label: 'Клапаны', one: 'клапан' },
  { role: 'light', label: 'Светильники', one: 'свет' },
];

/** Приборы одного вида для фигуры. */
export interface FigureDevices {
  /** Сколько приборов; 0 — этого вида у фигуры нет. */
  count: number;
  profileId: string;
  universe: number;
  /** С какого адреса; null — с первого свободного. */
  startAddress: number | null;
  mode: ShareMode;
  /**
   * Адреса, поправленные руками: номер прибора (с 0) → адрес. Остальные
   * приборы получают адреса как обычно, в обход поправленных.
   */
  fixed?: Record<number, number>;
}

/**
 * Размеры фигуры, м. Хранятся все сразу: переключили кольцо на квадрат и
 * обратно — введённое не пропадает. Работают только поля своей фигуры.
 */
export interface FigureDims {
  /** Кольцо: радиус — от центра до каждой форсунки. */
  radius: number;
  /** Квадрат и равносторонний треугольник: сторона. */
  side: number;
  /** Прямоугольник: длина (вдоль X) и ширина (вдоль Y). */
  length: number;
  width: number;
  /** Треугольник равносторонний — одна сторона; иначе три. */
  equilateral: boolean;
  /** Треугольник: основание, правая сторона, левая сторона. */
  sides: [number, number, number];
  /** Звезда: ребро — от конца луча до соседней впадины. */
  starEdge: number;
}

export const DEFAULT_FIGURE_DIMS: FigureDims = {
  radius: 3,
  side: 4,
  length: 6,
  width: 3,
  equilateral: true,
  sides: [4, 4, 4],
  starEdge: 2,
};

export interface FigureSpec {
  /** Имя фигуры: им называется контур в 3D и начинаются имена приборов. */
  name: string;
  shape: LayoutShape;
  /** Сколько форсунок. Одна — ставится в центр (центральная струя). */
  count: number;
  dims: FigureDims;
  /** Нумерация от верха по часовой стрелке (false — против). */
  clockwise: boolean;
  cx: number;
  cy: number;
  cz: number;
  /** Поворот фигуры вокруг центра, ° (как у контура в 3D). */
  rotationDeg: number;
  nozzleKind: NozzleKind;
  maxHeightM: number;
  /** Диаметр струи у сопла, м. */
  widthM: number;
  /** Наклон от вертикали, °: 0 — вверх. */
  tiltDeg: number;
  /** Куда наклонены: к центру фигуры или наружу. Азимут каждой форсунки считается сам. */
  tiltTo: 'center' | 'out';
  pump: FigureDevices;
  valve: FigureDevices;
  light: FigureDevices;
}

/** Раздача: для каждой форсунки — номера приборов вида (с 0). */
export type FigureShare = Record<FigureRole, number[][]>;

/**
 * Разделить k приборов на n форсунок.
 * Возвращает для каждой форсунки список номеров приборов (0…k−1).
 */
export function autoShare(n: number, k: number, mode: ShareMode): number[][] {
  const out: number[][] = Array.from({ length: Math.max(0, n) }, () => []);
  if (n <= 0 || k <= 0) return out;
  if (k >= n) {
    // Больше или столько же — подряд: форсунке 1 приборы 1 и 2, форсунке 2 — 3 и 4.
    // Так их и подключают — по порядку адресов вдоль фигуры.
    for (let i = 0; i < n; i++) {
      const from = Math.floor((i * k) / n);
      const to = Math.floor(((i + 1) * k) / n);
      for (let d = from; d < to; d++) out[i]!.push(d);
    }
    return out;
  }
  for (let i = 0; i < n; i++) out[i]!.push(mode === 'alternate' ? i % k : Math.floor((i * k) / n));
  return out;
}

/**
 * Клапаны — штучные: клапан одной форсунке. Меньше, чем форсунок, — через
 * равные промежутки по фигуре ('alternate') или подряд с Ф1 ('blocks'), у
 * остальных клапана нет. Больше — у некоторых по два, как у autoShare.
 */
export function autoShareSingle(n: number, k: number, mode: ShareMode): number[][] {
  if (k >= n) return autoShare(n, k, 'blocks');
  const out: number[][] = Array.from({ length: Math.max(0, n) }, () => []);
  for (let j = 0; j < k; j++) out[mode === 'blocks' ? j : Math.floor((j * n) / k)]!.push(j);
  return out;
}

/** Делится ли ровно: иначе раздачу стоит проверить глазами. */
export function sharesEvenly(n: number, k: number, role: FigureRole = 'pump'): boolean {
  if (n <= 0 || k <= 0) return true;
  // Клапан на форсунку — ровно, только когда их поровну.
  if (role === 'valve') return k === n;
  return k >= n ? k % n === 0 : n % k === 0;
}

/** Раздача по умолчанию для всей фигуры. */
export function autoFigureShare(spec: FigureSpec): FigureShare {
  const n = Math.max(1, Math.round(spec.count));
  return {
    pump: autoShare(n, spec.pump.count, spec.pump.mode),
    valve: autoShareSingle(n, spec.valve.count, spec.valve.mode),
    light: autoShare(n, spec.light.count, spec.light.mode),
  };
}

// ── Геометрия ────────────────────────────────────────────────────────────

type Pt = { x: number; y: number };

/** Внутренний радиус правильной пятиконечной звезды к внешнему: 1/φ² = (3 − √5)/2. */
export const STAR_INNER = (3 - Math.sqrt(5)) / 2;
/** Ребро правильной звезды к её внешнему радиусу (луч и впадина через 36°). */
const STAR_EDGE_PER_R = Math.sqrt(1 + STAR_INNER * STAR_INNER - 2 * STAR_INNER * Math.cos(Math.PI / 5));

/** Почему фигуру с такими размерами построить нельзя; null — можно. */
export function figureDimsError(shape: LayoutShape, d: FigureDims): string | null {
  const pos = (v: number): boolean => Number.isFinite(v) && v > 0;
  switch (shape) {
    case 'ring':
      return pos(d.radius) ? null : 'Радиус должен быть больше нуля';
    case 'square':
      return pos(d.side) ? null : 'Сторона должна быть больше нуля';
    case 'rect':
      return pos(d.length) && pos(d.width) ? null : 'Длина и ширина должны быть больше нуля';
    case 'star':
      return pos(d.starEdge) ? null : 'Ребро должно быть больше нуля';
    case 'triangle': {
      if (d.equilateral) return pos(d.side) ? null : 'Сторона должна быть больше нуля';
      const [a, b, c] = d.sides;
      if (!pos(a) || !pos(b) || !pos(c)) return 'Все три стороны должны быть больше нуля';
      if (a >= b + c || b >= a + c || c >= a + b) {
        return 'Такого треугольника нет: каждая сторона должна быть короче суммы двух других';
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Вершины фигуры в порядке нумерации: первая — сверху (у квадрата и
 * прямоугольника — верхний правый угол), дальше по часовой стрелке
 * (clockwise = false — против). Центр фигуры в (0, 0), без поворота.
 * У кольца вершин нет — пусто. Y смотрит вверх — как на виде сверху и в 3D.
 */
export function figureVertices(shape: LayoutShape, d: FigureDims, clockwise = true): Pt[] {
  const pt = (deg: number, r: number): Pt => ({ x: r * Math.cos((deg * Math.PI) / 180), y: r * Math.sin((deg * Math.PI) / 180) });
  let v: Pt[];
  switch (shape) {
    case 'square': {
      const h = d.side / 2;
      v = [{ x: h, y: h }, { x: h, y: -h }, { x: -h, y: -h }, { x: -h, y: h }];
      break;
    }
    case 'rect': {
      const a = d.length / 2;
      const b = d.width / 2;
      v = [{ x: a, y: b }, { x: a, y: -b }, { x: -a, y: -b }, { x: -a, y: b }];
      break;
    }
    case 'triangle': {
      if (d.equilateral) {
        const R = d.side / Math.sqrt(3);
        v = [pt(90, R), pt(-30, R), pt(210, R)];
        break;
      }
      // Основание a — внизу, правая сторона b, левая c. Центр фигуры — центр
      // тяжести треугольника: вокруг него фигура и поворачивается.
      const [a, b, c] = d.sides;
      const tx = -a / 2 + (a * a + c * c - b * b) / (2 * a);
      const ty = Math.sqrt(Math.max(0, c * c - (tx + a / 2) ** 2));
      const raw: Pt[] = [{ x: tx, y: ty }, { x: a / 2, y: 0 }, { x: -a / 2, y: 0 }];
      const gx = (raw[0]!.x + raw[1]!.x + raw[2]!.x) / 3;
      const gy = (raw[0]!.y + raw[1]!.y + raw[2]!.y) / 3;
      v = raw.map((p) => ({ x: p.x - gx, y: p.y - gy }));
      break;
    }
    case 'star': {
      const R = d.starEdge / STAR_EDGE_PER_R;
      // Лучи и впадины чередуются через 36°: первая — верхний луч.
      v = Array.from({ length: 10 }, (_, i) => pt(90 - 36 * i, i % 2 === 0 ? R : R * STAR_INNER));
      break;
    }
    default:
      return [];
  }
  // Против часовой — тот же старт, обход в другую сторону.
  return clockwise ? v : [v[0]!, ...v.slice(1).reverse()];
}

/**
 * Точки на многоугольнике по порядку обхода.
 *
 * ВЕРШИНЫ ЗАНЯТЫ ВСЕГДА (заказчик 24.09.2026: «прямоугольник кривой, звезда
 * ужасная»): иначе у прямоугольника срезаются углы, у звезды пропадают лучи.
 * Остальные форсунки делятся между сторонами по их длине; у правильной фигуры
 * лишние разносятся по сторонам равномерно, а не скапливаются в одном месте.
 * Меньше форсунок, чем вершин: у звезды из пяти — концы лучей, иначе —
 * равномерно по периметру.
 */
function pointsOnPolygon(v: Pt[], n: number, star: boolean): Pt[] {
  const V = v.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < V; i++) {
    const a = v[i]!;
    const b = v[(i + 1) % V]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    seg.push(len);
    total += len;
  }
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  if (n >= V) {
    const m = n - V;
    const quota = seg.map((len) => (m * len) / total);
    const per = quota.map((q) => Math.floor(q + 1e-9));
    const left = m - per.reduce((s, x) => s + x, 0);
    const rema = quota.map((q, i) => q - per[i]!);
    const regular = rema.every((r) => Math.abs(r - rema[0]!) < 1e-6);
    if (regular) {
      for (let k = 0; k < left; k++) per[Math.floor(((k + 0.5) * V) / left) % V]!++;
    } else {
      const order = rema.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i);
      for (let k = 0; k < left; k++) per[order[k]!.i]!++;
    }
    const out: Pt[] = [];
    for (let i = 0; i < V; i++) {
      out.push(v[i]!);
      for (let j = 1; j <= per[i]!; j++) out.push(lerp(v[i]!, v[(i + 1) % V]!, j / (per[i]! + 1)));
    }
    return out;
  }
  if (star && n === 5) return v.filter((_, i) => i % 2 === 0);
  const out: Pt[] = [];
  for (let k = 0; k < n; k++) {
    let dd = (total * k) / n;
    let i = 0;
    while (i < V - 1 && dd > seg[i]!) {
      dd -= seg[i]!;
      i++;
    }
    out.push(lerp(v[i]!, v[(i + 1) % V]!, seg[i]! > 1e-9 ? dd / seg[i]! : 0));
  }
  return out;
}

/** Поворот (против часовой, °) и перенос в центр фигуры. */
function place(p: Pt, spec: Pick<FigureSpec, 'cx' | 'cy' | 'rotationDeg'>): Pt {
  const a = (spec.rotationDeg * Math.PI) / 180;
  const x = spec.cx + p.x * Math.cos(a) - p.y * Math.sin(a);
  const y = spec.cy + p.x * Math.sin(a) + p.y * Math.cos(a);
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
}

/** Контур фигуры на месте (с поворотом и центром) — для вида сверху. У кольца — пусто. */
export function figureOutline(spec: FigureSpec): Pt[] {
  if (figureDimsError(spec.shape, spec.dims)) return [];
  return figureVertices(spec.shape, spec.dims, spec.clockwise).map((p) => place(p, spec));
}

/** Координаты форсунок фигуры в порядке нумерации: Ф1, Ф2, … */
export function figurePoints(spec: FigureSpec): Pt[] {
  const n = Math.max(1, Math.round(spec.count));
  // Одна форсунка — в центр: так заводят центральную струю.
  if (n === 1) return [{ x: spec.cx, y: spec.cy }];
  if (figureDimsError(spec.shape, spec.dims)) return [];
  if (spec.shape === 'ring') {
    const r = spec.dims.radius;
    const dir = spec.clockwise ? -1 : 1;
    return Array.from({ length: n }, (_, i) => {
      const a = ((90 + (dir * 360 * i) / n) * Math.PI) / 180;
      return place({ x: r * Math.cos(a), y: r * Math.sin(a) }, spec);
    });
  }
  const v = figureVertices(spec.shape, spec.dims, spec.clockwise);
  return pointsOnPolygon(v, n, spec.shape === 'star').map((p) => place(p, spec));
}

/** Сколько места занимает фигура, м: по X и по Y. */
export function figureExtent(points: Pt[]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Сколько форсунок нужно, чтобы на каждой стороне их было поровну: у звезды —
 * 10 (5 лучей и 5 впадин), у квадрата — 4, у равностороннего треугольника —
 * 3. 1 — любое число (стороны разные, делим по длине).
 */
export function figureEvenStep(shape: LayoutShape, d: FigureDims): number {
  if (shape === 'star') return 10;
  if (shape === 'square') return 4;
  if (shape === 'triangle' && d.equilateral) return 3;
  return 1;
}

// ── Приборы ──────────────────────────────────────────────────────────────

export interface FigurePlan {
  devices: PatchedDevice[];
  /**
   * Те же приборы по видам, в порядке номеров: byRole.light[2] — «свет 3».
   * null — этому прибору адреса не нашлось (причина — в errors).
   */
  byRole: Record<FigureRole, (PatchedDevice | null)[]>;
  /** Сколько адресов занимает один прибор вида. */
  span: Record<FigureRole, number>;
  nozzles: Nozzle[];
  group: NozzleGroup;
  /** Почему создавать нельзя (адресов не хватает, адреса заняты). Пусто — можно. */
  errors: string[];
  /** Адреса по видам — показать человеку до создания: «насос: 1, клапаны: 2–37». */
  ranges: { role: FigureRole; universe: number; from: number; to: number }[];
}

/**
 * Посчитать всё, что создаст фигура: приборы с адресами, форсунки с
 * привязками и контур. Проект не меняется — план применяет вызывающий.
 * newId — генератор id (в интерфейсе свой uid, в тесте — счётчик).
 */
export function planFigure(project: Project, spec: FigureSpec, share: FigureShare, newId: () => string): FigurePlan {
  const errors: string[] = [];
  const profiles = profileMap(project);
  const name = spec.name.trim() || 'Фигура';
  const draft: Project = { ...project, devices: [...project.devices] };
  const created: Record<FigureRole, (PatchedDevice | null)[]> = { pump: [], valve: [], light: [] };
  const span: Record<FigureRole, number> = { pump: 1, valve: 1, light: 1 };
  const ranges: FigurePlan['ranges'] = [];

  const dimsError = figureDimsError(spec.shape, spec.dims);
  if (dimsError && Math.round(spec.count) > 1) errors.push(dimsError);

  for (const { role, one, label } of FIGURE_ROLES) {
    const d = spec[role];
    if (d.count <= 0) continue;
    const profile = profiles.get(d.profileId);
    if (!profile) {
      errors.push(`${label}: тип прибора не найден`);
      continue;
    }
    const size = profile.channels.length;
    span[role] = size;
    const devs: (PatchedDevice | null)[] = Array.from({ length: d.count }, () => null);
    const make = (i: number, address: number): PatchedDevice => ({
      id: newId(),
      name: `${name} · ${one} ${i + 1}`,
      profileId: profile.id,
      universe: d.universe,
      address,
    });

    // Сначала адреса, поправленные руками: остальные обходят их, а не наоборот.
    const own = new Set<string>();
    for (const [key, address] of Object.entries(d.fixed ?? {})) {
      const i = Number(key);
      if (!(Number.isInteger(i) && i >= 0 && i < d.count)) continue;
      if (address < 1 || address + size - 1 > DMX_UNIVERSE_SIZE) {
        errors.push(`${one} ${i + 1}: с адреса ${address} прибор не помещается в 1–${DMX_UNIVERSE_SIZE}`);
        continue;
      }
      const busy = occupant(draft, d.universe, address, address + size - 1);
      if (busy) {
        errors.push(`${one} ${i + 1}: адрес ${address} во вселенной ${d.universe} уже занят («${busy.name}»)`);
        continue;
      }
      const dev = make(i, address);
      devs[i] = dev;
      own.add(dev.id);
      draft.devices.push(dev);
    }

    let cursor = d.startAddress ?? 1;
    const placed = (): number => devs.filter(Boolean).length;
    for (let i = 0; i < d.count; i++) {
      if (devs[i] || d.fixed?.[i] !== undefined) continue;
      let address: number;
      if (d.startAddress === null) {
        const free = nextFreeAddress(draft, d.universe, size, cursor);
        if (free === null) {
          errors.push(`${label}: во вселенной ${d.universe} не хватает свободных адресов — поместилось ${placed()} из ${d.count}`);
          break;
        }
        address = free;
      } else {
        // С начального адреса подряд, перешагивая приборы этой же фигуры,
        // поставленные руками. Чужой прибор на пути — ошибка: молча
        // перепрыгнуть его значило бы разъехаться с тем, что вписал человек.
        address = cursor;
        let busy = occupant(draft, d.universe, address, address + size - 1);
        while (busy && own.has(busy.id)) {
          address = deviceRange(busy, profiles).end + 1;
          busy = occupant(draft, d.universe, address, address + size - 1);
        }
        if (address + size - 1 > DMX_UNIVERSE_SIZE) {
          errors.push(`${label}: с адреса ${d.startAddress} помещается ${placed()} из ${d.count} — дальше адрес выходит за ${DMX_UNIVERSE_SIZE}`);
          break;
        }
        if (busy) {
          errors.push(`${label}: адрес ${address} во вселенной ${d.universe} уже занят («${busy.name}»). Уберите начальный адрес — возьмутся первые свободные`);
          break;
        }
      }
      cursor = address + size;
      const dev = make(i, address);
      devs[i] = dev;
      draft.devices.push(dev);
    }
    created[role] = devs;
    const real = devs.filter((x): x is PatchedDevice => x !== null);
    if (real.length > 0) {
      const from = Math.min(...real.map((x) => x.address));
      const to = Math.max(...real.map((x) => x.address)) + size - 1;
      ranges.push({ role, universe: d.universe, from, to });
    }
  }

  const points = figurePoints(spec);
  const defaults = nozzleDefaults(spec.nozzleKind);
  const pick = (role: FigureRole, i: number): string[] =>
    (share[role][i] ?? []).map((k) => created[role][k]?.id).filter((id): id is string => !!id);
  const nozzles: Nozzle[] = points.map((p, i) => {
    const pumps = pick('pump', i);
    const valves = pick('valve', i);
    const lights = pick('light', i);
    // Наклон «к центру» — азимут от форсунки на центр фигуры (0° — вдоль +X).
    const toCenter = (Math.atan2(spec.cy - p.y, spec.cx - p.x) * 180) / Math.PI;
    const atCenter = Math.hypot(spec.cx - p.x, spec.cy - p.y) < 1e-6;
    const heading = atCenter ? 0 : spec.tiltTo === 'center' ? toCenter : toCenter + 180;
    return {
      id: newId(),
      name: points.length === 1 ? name : `${name} · Ф${i + 1}`,
      kind: spec.nozzleKind,
      x: p.x,
      y: p.y,
      z: spec.cz,
      tiltDeg: spec.tiltDeg,
      headingDeg: Math.round((((heading % 360) + 360) % 360) * 10) / 10,
      ...defaults,
      maxHeightM: spec.maxHeightM,
      widthM: spec.widthM,
      sprayFactor: 0.3,
      modelFile: null,
      modelScale: 1,
      pumpDeviceId: pumps[0] ?? null,
      extraPumpDeviceIds: pumps.slice(1),
      pump2DeviceId: null,
      extraPump2DeviceIds: [],
      valveDeviceId: valves[0] ?? null,
      extraValveDeviceIds: valves.slice(1),
      lightDeviceId: lights[0] ?? null,
      extraLightDeviceIds: lights.slice(1),
    };
  });

  const group: NozzleGroup = {
    id: newId(),
    name,
    nozzleIds: nozzles.map((n) => n.id),
    lightIds: [],
    // Фигура уже построена повёрнутой — поле «Поворот» контура показывает этот угол.
    rotationDeg: ((spec.rotationDeg % 360) + 360) % 360,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
  };
  const real = (role: FigureRole): PatchedDevice[] => created[role].filter((x): x is PatchedDevice => x !== null);
  return {
    devices: [...real('pump'), ...real('valve'), ...real('light')],
    byRole: created,
    span,
    nozzles,
    group,
    errors,
    ranges,
  };
}

/** Какой прибор занимает хотя бы один адрес из [from, to]; null — свободно. */
function occupant(project: Project, universe: number, from: number, to: number): PatchedDevice | null {
  const profiles = profileMap(project);
  for (const d of project.devices) {
    if (d.universe !== universe) continue;
    const r = deviceRange(d, profiles);
    if (r.start <= to && r.end >= from) return d;
  }
  return null;
}

/** Первый тип прибора нужного вида: насос, клапан, RGB-светильник. */
export function defaultFigureProfile(project: Project, role: FigureRole): string {
  const list = allProfiles(project);
  if (role === 'light') return (list.find((p) => p.id === 'rgb') ?? list.find((p) => p.kind === 'lamp'))?.id ?? 'rgb';
  return list.find((p) => p.kind === role)?.id ?? role;
}
