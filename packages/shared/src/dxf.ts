/**
 * Импорт геометрии из AutoCAD через формат DXF (ASCII).
 * DXF — это пары строк «код группы» / «значение»; сущности лежат в секции
 * ENTITIES. Бинарный DWG сначала конвертируется в DXF (экспорт из AutoCAD
 * или бесплатный ODA File Converter).
 *
 * Точки расстановки форсунок/прожекторов обычно рисуют как POINT, CIRCLE
 * или вставки блоков (INSERT); контуры чаш — CIRCLE или замкнутые полилинии.
 */

import type { Bowl } from './layout';

/** «Точечная» сущность чертежа — кандидат в форсунки/прожекторы. */
export interface DxfPoint {
  x: number;
  y: number;
  layer: string;
  kind: 'point' | 'circle' | 'arc' | 'insert';
  /** Радиус для circle/arc, в единицах чертежа. */
  radius?: number;
  /** Имя блока для insert. */
  blockName?: string;
}

export interface DxfPolyline {
  layer: string;
  closed: boolean;
  points: { x: number; y: number }[];
}

export interface DxfLine {
  layer: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DxfDrawing {
  points: DxfPoint[];
  polylines: DxfPolyline[];
  lines: DxfLine[];
  /** Все встреченные слои (по сущностям). */
  layers: string[];
  /**
   * Единицы чертежа из заголовка $INSUNITS (0 — не указаны):
   * 1 дюймы, 4 мм, 5 см, 6 м. Прочие значения оставляем как есть.
   */
  insunits: number;
}

/** Множитель перевода единиц чертежа в метры по $INSUNITS (0/неизвестно → 1). */
export function insunitsToMeters(insunits: number): number {
  switch (insunits) {
    case 1:
      return 0.0254; // дюймы
    case 2:
      return 0.3048; // футы
    case 4:
      return 0.001; // мм
    case 5:
      return 0.01; // см
    case 6:
      return 1; // м
    default:
      return 1;
  }
}

interface Tag {
  code: number;
  value: string;
}

function tokenize(text: string): Tag[] {
  // Строки в DXF идут парами: код группы, затем значение.
  const lines = text.split(/\r\n|\n|\r/);
  const tags: Tag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    if (!Number.isFinite(code)) continue;
    tags.push({ code, value: lines[i + 1]!.trim() });
  }
  return tags;
}

/** Разбирает текст DXF-файла в плоский список точек/полилиний/отрезков. */
export function parseDxf(text: string): DxfDrawing {
  const tags = tokenize(text);
  const drawing: DxfDrawing = { points: [], polylines: [], lines: [], layers: [], insunits: 0 };
  const layers = new Set<string>();

  // Заголовок: $INSUNITS → код 70 следом.
  for (let i = 0; i < tags.length - 1; i++) {
    if (tags[i]!.code === 9 && tags[i]!.value === '$INSUNITS') {
      for (let j = i + 1; j < Math.min(i + 4, tags.length); j++) {
        if (tags[j]!.code === 70) {
          drawing.insunits = parseInt(tags[j]!.value, 10) || 0;
          break;
        }
      }
      break;
    }
  }

  // Секция ENTITIES: от (0, SECTION)(2, ENTITIES) до (0, ENDSEC).
  let start = -1;
  for (let i = 0; i < tags.length - 1; i++) {
    if (tags[i]!.code === 0 && tags[i]!.value === 'SECTION' && tags[i + 1]!.code === 2 && tags[i + 1]!.value === 'ENTITIES') {
      start = i + 2;
      break;
    }
  }
  if (start < 0) return drawing;

  // Сущности начинаются с тега (0, <TYPE>); собираем теги каждой сущности.
  let i = start;
  let current: { type: string; tags: Tag[] } | null = null;
  /** Незакрытая легаси-POLYLINE, ждущая VERTEX/SEQEND. */
  let legacyPolyline: DxfPolyline | null = null;

  const flush = (): void => {
    if (!current) return;
    const t = current.tags;
    const get = (code: number): string | undefined => t.find((x) => x.code === code)?.value;
    const getNum = (code: number): number => {
      const v = parseFloat(get(code) ?? '');
      return Number.isFinite(v) ? v : 0;
    };
    const layer = get(8) ?? '0';
    layers.add(layer);
    switch (current.type) {
      case 'POINT':
        drawing.points.push({ x: getNum(10), y: getNum(20), layer, kind: 'point' });
        break;
      case 'CIRCLE':
        drawing.points.push({ x: getNum(10), y: getNum(20), layer, kind: 'circle', radius: getNum(40) });
        break;
      case 'ARC':
        drawing.points.push({ x: getNum(10), y: getNum(20), layer, kind: 'arc', radius: getNum(40) });
        break;
      case 'INSERT':
        drawing.points.push({ x: getNum(10), y: getNum(20), layer, kind: 'insert', blockName: get(2) });
        break;
      case 'LINE':
        drawing.lines.push({ layer, x1: getNum(10), y1: getNum(20), x2: getNum(11), y2: getNum(21) });
        break;
      case 'LWPOLYLINE': {
        // Пары 10/20 повторяются по числу вершин; бит 1 кода 70 — замкнута.
        const pts: { x: number; y: number }[] = [];
        let x: number | null = null;
        for (const tag of t) {
          if (tag.code === 10) x = parseFloat(tag.value);
          else if (tag.code === 20 && x !== null && Number.isFinite(x)) {
            const y = parseFloat(tag.value);
            if (Number.isFinite(y)) pts.push({ x, y });
            x = null;
          }
        }
        const closed = ((parseInt(get(70) ?? '0', 10) || 0) & 1) === 1;
        if (pts.length >= 2) drawing.polylines.push({ layer, closed, points: pts });
        break;
      }
      case 'POLYLINE':
        legacyPolyline = { layer, closed: ((parseInt(get(70) ?? '0', 10) || 0) & 1) === 1, points: [] };
        break;
      case 'VERTEX':
        if (legacyPolyline) legacyPolyline.points.push({ x: getNum(10), y: getNum(20) });
        break;
      case 'SEQEND':
        if (legacyPolyline) {
          if (legacyPolyline.points.length >= 2) drawing.polylines.push(legacyPolyline);
          legacyPolyline = null;
        }
        break;
    }
    current = null;
  };

  for (; i < tags.length; i++) {
    const tag = tags[i]!;
    if (tag.code === 0) {
      flush();
      if (tag.value === 'ENDSEC') break;
      current = { type: tag.value, tags: [] };
    } else if (current) {
      current.tags.push(tag);
    }
  }
  flush();

  drawing.layers = [...layers].sort();
  return drawing;
}

/** Что делать со слоем при импорте. */
export type DxfLayerRole = 'skip' | 'nozzle' | 'light' | 'bowl';

export interface DxfImportOptions {
  /** Множитель координат чертежа → метры (подсказка: insunitsToMeters). */
  unitScale: number;
  /** Роль каждого слоя; отсутствующие слои пропускаются. */
  layerRoles: Record<string, DxfLayerRole>;
  /** Сместить схему так, чтобы центр всех точек оказался в (0,0). */
  center: boolean;
}

export interface DxfImportResult {
  nozzles: { x: number; y: number }[];
  lights: { x: number; y: number }[];
  /** Чаши без id — id присваивает вызывающая сторона. */
  bowls: Omit<Bowl, 'id'>[];
}

/** Преобразует чертёж в позиции элементов схемы по ролям слоёв. */
export function layoutFromDxf(drawing: DxfDrawing, options: DxfImportOptions): DxfImportResult {
  const s = options.unitScale;
  const role = (layer: string): DxfLayerRole => options.layerRoles[layer] ?? 'skip';
  const result: DxfImportResult = { nozzles: [], lights: [], bowls: [] };

  for (const p of drawing.points) {
    const r = role(p.layer);
    if (r === 'nozzle') result.nozzles.push({ x: p.x * s, y: p.y * s });
    else if (r === 'light') result.lights.push({ x: p.x * s, y: p.y * s });
    else if (r === 'bowl' && (p.kind === 'circle' || p.kind === 'arc') && p.radius) {
      result.bowls.push({
        name: `Чаша (${p.layer})`,
        shape: 'circle',
        x: p.x * s,
        y: p.y * s,
        radius: p.radius * s,
        width: p.radius * 2 * s,
        length: p.radius * 2 * s,
        height: 0.3,
      });
    }
  }
  for (const pl of drawing.polylines) {
    if (role(pl.layer) !== 'bowl' || !pl.closed) continue;
    // Замкнутый контур приближаем прямоугольником по габаритам.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pl.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    result.bowls.push({
      name: `Чаша (${pl.layer})`,
      shape: 'rect',
      x: ((minX + maxX) / 2) * s,
      y: ((minY + maxY) / 2) * s,
      radius: (Math.max(maxX - minX, maxY - minY) / 2) * s,
      width: (maxX - minX) * s,
      length: (maxY - minY) * s,
      height: 0.3,
    });
  }

  if (options.center) {
    const all = [
      ...result.nozzles,
      ...result.lights,
      ...result.bowls.map((b) => ({ x: b.x, y: b.y })),
    ];
    if (all.length > 0) {
      const cx = all.reduce((sum, p) => sum + p.x, 0) / all.length;
      const cy = all.reduce((sum, p) => sum + p.y, 0) / all.length;
      for (const p of result.nozzles) {
        p.x -= cx;
        p.y -= cy;
      }
      for (const p of result.lights) {
        p.x -= cx;
        p.y -= cy;
      }
      for (const b of result.bowls) {
        b.x -= cx;
        b.y -= cy;
      }
    }
  }
  return result;
}
