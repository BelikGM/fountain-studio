/**
 * 3D-схема фонтана: чаши, форсунки и прожекторы с координатами в метрах.
 * Элементы схемы привязываются к устройствам патча — визуализатор берёт их
 * значения из живых DMX-кадров движка, поэтому превью честное.
 * Ось X — вправо, Y — «вглубь» (план как на чертеже), Z — вверх.
 */

export type BowlShape = 'circle' | 'rect';

export interface Bowl {
  id: string;
  name: string;
  shape: BowlShape;
  /** Центр чаши в плане, м. */
  x: number;
  y: number;
  /** Радиус для circle, м. */
  radius: number;
  /** Размеры для rect: width по X, length по Y, м. */
  width: number;
  length: number;
  /** Высота борта над водой, м (только визуализация). */
  height: number;
}

/** Тип форсунки — задаёт форму струи и умолчания физики. */
export type NozzleKind =
  | 'straight' // прямая струя
  | 'fan' // веер
  | 'canopy' // шатёр
  | 'flower' // цветок
  | 'veil' // вуаль (плёнка)
  | 'mist' // туман / рассеивающая
  | 'foam' // пенная
  | 'laminar' // ламинарная
  | 'rotating' // вращающаяся
  | 'variable'; // вариативная: конус раскрывается/собирается, два насоса

export const NOZZLE_KINDS: { id: NozzleKind; label: string }[] = [
  { id: 'straight', label: 'Прямая струя' },
  { id: 'fan', label: 'Веер' },
  { id: 'canopy', label: 'Шатёр' },
  { id: 'flower', label: 'Цветок' },
  { id: 'veil', label: 'Вуаль' },
  { id: 'mist', label: 'Туман' },
  { id: 'foam', label: 'Пенная' },
  { id: 'laminar', label: 'Ламинарная' },
  { id: 'rotating', label: 'Вращающаяся' },
  { id: 'variable', label: 'Вариативная (2 насоса)' },
];

export interface Nozzle {
  id: string;
  name: string;
  kind: NozzleKind;
  /** Позиция сопла, м (z — над уровнем воды). */
  x: number;
  y: number;
  z: number;
  /** Наклон от вертикали, градусы (0 — вверх). */
  tiltDeg: number;
  /** Азимут наклона, градусы (0 — вдоль +X, против часовой). */
  headingDeg: number;
  /** Высота струи при значении 255, м. */
  maxHeightM: number;
  /** Диаметр струи у сопла, м — толщина у основания (§27 доработки, п.12). */
  widthM: number;
  /** Угол раскрытия конуса, ° — только kind='variable' (двухнасосная). */
  coneAngleDeg: number;
  /** Скорость вращения направления, °/с — только kind='rotating'. */
  rotationSpeedDegPerSec: number;
  /** Инерция давления: время разгона и спада (фильтр 1-го порядка), мс. */
  riseMs: number;
  fallMs: number;
  /** Насос (канал intensity) — производительность струи. null — не привязан. */
  pumpDeviceId: string | null;
  /** Второй насос — только kind='variable' (раскрытие конуса своим напором). null — не привязан. */
  pump2DeviceId: string | null;
  /** Клапан (0/255) — отсечение струи. null — клапана нет. */
  valveDeviceId: string | null;
  /**
   * Клапан следует за насосом (§27 доработки, «Influence: Valve by Pump») —
   * движок сам держит клапан открытым, пока канал насоса > 0, без ручной
   * записи значения клапана в каждой сцене. Действует только когда заданы
   * оба устройства; переопределяет любое другое значение клапана на тике.
   */
  valveFollowsPump: boolean;
  /** Прожектор, подсвечивающий эту струю (цвет частиц). */
  lightDeviceId: string | null;
}

/** Прожектор на схеме (сам светильник; цвет — из устройства патча). */
export interface LayoutLight {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  deviceId: string | null;
}

export interface FountainLayout {
  bowls: Bowl[];
  nozzles: Nozzle[];
  lights: LayoutLight[];
}

export function emptyLayout(): FountainLayout {
  return { bowls: [], nozzles: [], lights: [] };
}

/** Умолчания физики струи по типу форсунки. */
export function nozzleDefaults(
  kind: NozzleKind,
): { maxHeightM: number; riseMs: number; fallMs: number; widthM: number; coneAngleDeg: number; rotationSpeedDegPerSec: number } {
  const extra = { widthM: 0.03, coneAngleDeg: 25, rotationSpeedDegPerSec: 60 };
  switch (kind) {
    case 'foam':
      return { maxHeightM: 2, riseMs: 500, fallMs: 700, ...extra, widthM: 0.08 };
    case 'mist':
      return { maxHeightM: 1.5, riseMs: 300, fallMs: 400, ...extra, widthM: 0.05 };
    case 'veil':
    case 'fan':
      return { maxHeightM: 2.5, riseMs: 600, fallMs: 800, ...extra, widthM: 0.06 };
    case 'laminar':
      return { maxHeightM: 4, riseMs: 400, fallMs: 500, ...extra, widthM: 0.02 };
    case 'canopy':
    case 'flower':
      return { maxHeightM: 3, riseMs: 700, fallMs: 900, ...extra };
    case 'variable':
      return { maxHeightM: 4, riseMs: 500, fallMs: 700, ...extra, widthM: 0.04 };
    default:
      return { maxHeightM: 5, riseMs: 800, fallMs: 1100, ...extra };
  }
}

/** Позиции по кольцу (генератор расстановки): count точек радиуса radius вокруг центра. */
export function ringPositions(
  count: number,
  radius: number,
  centerX = 0,
  centerY = 0,
  startDeg = 0,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const a = ((startDeg + (360 * i) / count) * Math.PI) / 180;
    out.push({ x: centerX + radius * Math.cos(a), y: centerY + radius * Math.sin(a) });
  }
  return out;
}

/** Позиции по отрезку от (x1,y1) до (x2,y2) включительно. */
export function linePositions(
  count: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    out.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  }
  return out;
}

const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Ссылка на устройство: сохраняется, только если устройство существует в патче. */
const devRef = (v: unknown, deviceIds: Set<string>): string | null =>
  typeof v === 'string' && deviceIds.has(v) ? v : null;

/** Приводит произвольный JSON к корректной схеме (битые элементы отбрасываются). */
export function sanitizeLayout(raw: unknown, deviceIds: Set<string>): FountainLayout {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const layout = emptyLayout();
  if (Array.isArray(r.bowls)) {
    for (const b of r.bowls as Bowl[]) {
      if (!b || typeof b.id !== 'string') continue;
      layout.bowls.push({
        id: b.id,
        name: typeof b.name === 'string' ? b.name : 'Чаша',
        shape: b.shape === 'rect' ? 'rect' : 'circle',
        x: round3(num(b.x, 0, -1000, 1000)),
        y: round3(num(b.y, 0, -1000, 1000)),
        radius: round3(num(b.radius, 5, 0.1, 500)),
        width: round3(num(b.width, 10, 0.1, 1000)),
        length: round3(num(b.length, 6, 0.1, 1000)),
        height: round3(num(b.height, 0.3, 0, 5)),
      });
    }
  }
  const kinds = new Set(NOZZLE_KINDS.map((k) => k.id));
  if (Array.isArray(r.nozzles)) {
    for (const n of r.nozzles as Nozzle[]) {
      if (!n || typeof n.id !== 'string') continue;
      const kind = kinds.has(n.kind) ? n.kind : 'straight';
      const def = nozzleDefaults(kind);
      layout.nozzles.push({
        id: n.id,
        name: typeof n.name === 'string' ? n.name : 'Форсунка',
        kind,
        x: round3(num(n.x, 0, -1000, 1000)),
        y: round3(num(n.y, 0, -1000, 1000)),
        z: round3(num(n.z, 0, -10, 50)),
        tiltDeg: round3(num(n.tiltDeg, 0, 0, 85)),
        headingDeg: round3(num(n.headingDeg, 0, 0, 360)),
        maxHeightM: round3(num(n.maxHeightM, def.maxHeightM, 0.1, 100)),
        widthM: round3(num(n.widthM, def.widthM, 0.005, 2)),
        coneAngleDeg: round3(num(n.coneAngleDeg, def.coneAngleDeg, 1, 90)),
        rotationSpeedDegPerSec: round3(num(n.rotationSpeedDegPerSec, def.rotationSpeedDegPerSec, -720, 720)),
        riseMs: Math.round(num(n.riseMs, def.riseMs, 0, 60000)),
        fallMs: Math.round(num(n.fallMs, def.fallMs, 0, 60000)),
        pumpDeviceId: devRef(n.pumpDeviceId, deviceIds),
        pump2DeviceId: devRef(n.pump2DeviceId, deviceIds),
        valveDeviceId: devRef(n.valveDeviceId, deviceIds),
        valveFollowsPump: n.valveFollowsPump === true,
        lightDeviceId: devRef(n.lightDeviceId, deviceIds),
      });
    }
  }
  if (Array.isArray(r.lights)) {
    for (const l of r.lights as LayoutLight[]) {
      if (!l || typeof l.id !== 'string') continue;
      layout.lights.push({
        id: l.id,
        name: typeof l.name === 'string' ? l.name : 'Прожектор',
        x: round3(num(l.x, 0, -1000, 1000)),
        y: round3(num(l.y, 0, -1000, 1000)),
        z: round3(num(l.z, 0, -10, 50)),
        deviceId: devRef(l.deviceId, deviceIds),
      });
    }
  }
  return layout;
}
