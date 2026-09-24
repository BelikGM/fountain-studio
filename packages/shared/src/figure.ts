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
 * Угадываем по кратности, как это обычно монтируют:
 *  · приборов столько же, сколько форсунок, — по одному на форсунку;
 *  · больше и кратно (72 светильника на 36) — по нескольку на форсунку, подряд;
 *  · меньше (4 насоса на 36) — каждый насос на свою часть фигуры
 *    («частями»: 9 соседних форсунок) или через одну («чередуя»: так часто
 *    ставят два насоса на кольцо — чётные и нечётные форсунки).
 * Не угадали — человек правит таблицу «форсунка → насос, клапан, свет»;
 * planFigure берёт уже поправленную раздачу.
 */

import { nozzleDefaults, shapePositions, type LayoutShape, type Nozzle, type NozzleGroup, type NozzleKind } from './layout';
import { DMX_UNIVERSE_SIZE } from './dmx';
import { allProfiles, deviceRange, nextFreeAddress, profileMap, type PatchedDevice, type Project } from './project';

/** Как делить приборы, которых меньше, чем форсунок. */
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
}

export interface FigureSpec {
  /** Имя фигуры: им называется контур в 3D и начинаются имена приборов. */
  name: string;
  shape: LayoutShape;
  /** Сколько форсунок. Одна — ставится в центр (центральная струя). */
  count: number;
  /** Радиус кольца или половина стороны, м. */
  size: number;
  /** Прямоугольник: отношение сторон. */
  aspect: number;
  cx: number;
  cy: number;
  cz: number;
  /** Поворот фигуры вокруг центра, °. */
  rotationDeg: number;
  nozzleKind: NozzleKind;
  maxHeightM: number;
  /** Диаметр струи у сопла, м. */
  widthM: number;
  /** Наклон от вертикали, °: 0 — вверх. */
  tiltDeg: number;
  /** Куда наклонены: к центру фигуры или наружу. */
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

/** Делится ли ровно: иначе раздачу стоит проверить глазами. */
export function sharesEvenly(n: number, k: number): boolean {
  if (n <= 0 || k <= 0) return true;
  return k >= n ? k % n === 0 : n % k === 0;
}

/** Раздача по умолчанию для всей фигуры. */
export function autoFigureShare(spec: FigureSpec): FigureShare {
  const n = Math.max(1, Math.round(spec.count));
  return {
    pump: autoShare(n, spec.pump.count, spec.pump.mode),
    valve: autoShare(n, spec.valve.count, spec.valve.mode),
    light: autoShare(n, spec.light.count, spec.light.mode),
  };
}

/** Координаты форсунок фигуры (без форсунок — только точки). */
export function figurePoints(spec: FigureSpec): { x: number; y: number }[] {
  const n = Math.max(1, Math.round(spec.count));
  // Одна форсунка — в центр: так заводят центральную струю.
  if (n === 1) return [{ x: spec.cx, y: spec.cy }];
  return shapePositions(spec.shape, n, spec.size, spec.cx, spec.cy, spec.rotationDeg, spec.aspect).map((p) => ({
    x: Math.round(p.x * 1000) / 1000,
    y: Math.round(p.y * 1000) / 1000,
  }));
}

export interface FigurePlan {
  devices: PatchedDevice[];
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
  const created: Record<FigureRole, PatchedDevice[]> = { pump: [], valve: [], light: [] };
  const ranges: FigurePlan['ranges'] = [];

  for (const { role, one, label } of FIGURE_ROLES) {
    const d = spec[role];
    if (d.count <= 0) continue;
    const profile = profiles.get(d.profileId);
    if (!profile) {
      errors.push(`${label}: тип прибора не найден`);
      continue;
    }
    const size = profile.channels.length;
    let cursor = d.startAddress ?? 1;
    for (let i = 0; i < d.count; i++) {
      let address: number;
      if (d.startAddress === null) {
        const free = nextFreeAddress(draft, d.universe, size, cursor);
        if (free === null) {
          errors.push(`${label}: во вселенной ${d.universe} не хватает свободных адресов — поместилось ${i} из ${d.count}`);
          break;
        }
        address = free;
      } else {
        address = cursor;
        if (address + size - 1 > DMX_UNIVERSE_SIZE) {
          errors.push(`${label}: с адреса ${d.startAddress} помещается ${i} из ${d.count} — дальше адрес выходит за 512`);
          break;
        }
        const busy = occupiedBy(draft, d.universe, address, address + size - 1);
        if (busy) {
          errors.push(`${label}: адрес ${address} во вселенной ${d.universe} уже занят («${busy}»). Уберите начальный адрес — возьмутся первые свободные`);
          break;
        }
      }
      cursor = address + size;
      const dev: PatchedDevice = { id: newId(), name: `${name} · ${one} ${i + 1}`, profileId: profile.id, universe: d.universe, address };
      draft.devices.push(dev);
      created[role].push(dev);
    }
    if (created[role].length > 0) {
      const first = created[role][0]!;
      const last = created[role][created[role].length - 1]!;
      ranges.push({ role, universe: d.universe, from: first.address, to: last.address + size - 1 });
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
      headingDeg: Math.round(((heading % 360) + 360) % 360 * 10) / 10,
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
  return { devices: [...created.pump, ...created.valve, ...created.light], nozzles, group, errors, ranges };
}

/** Чей прибор занимает хотя бы один адрес из [from, to]; null — свободно. */
function occupiedBy(project: Project, universe: number, from: number, to: number): string | null {
  const profiles = profileMap(project);
  for (const d of project.devices) {
    if (d.universe !== universe) continue;
    const r = deviceRange(d, profiles);
    if (r.start <= to && r.end >= from) return d.name;
  }
  return null;
}

/** Первый тип прибора нужного вида: насос, клапан, RGB-светильник. */
export function defaultFigureProfile(project: Project, role: FigureRole): string {
  const list = allProfiles(project);
  if (role === 'light') return (list.find((p) => p.id === 'rgb') ?? list.find((p) => p.kind === 'lamp'))?.id ?? 'rgb';
  return list.find((p) => p.kind === role)?.id ?? role;
}
