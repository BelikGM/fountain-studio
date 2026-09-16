import type { DxfDrawing, DxfPoint, DxfPolyline } from './dxf';

/**
 * Чтение плана из SVG — вторым форматом рядом с DXF.
 *
 * Зачем. AutoCAD по-настоящему читается только в DXF: DWG — закрытый двоичный
 * формат, разбирать его без сторонней библиотеки нельзя. Но план площадки
 * приходит и из другого софта, и почти всё умеет сохранять SVG: Illustrator,
 * Inkscape, QGIS, экспорт из того же AutoCAD. Поэтому вместо попыток осилить
 * DWG добавлен ещё один ОТКРЫТЫЙ формат.
 *
 * Результат сразу приводится к DxfDrawing, чтобы дальше работал тот же
 * конвейер: слои → роли → элементы схемы. Слоем считается имя группы
 * (inkscape:label, id или class ближайшего <g>) — в редакторах это и есть слой.
 *
 * Система координат SVG считает Y вниз, наша — вверх, поэтому Y переворачивается.
 */

/** Единицы SVG — пиксели-пользовательские единицы; масштаб задаёт человек. */
const SVG_INSUNITS = 0;

function layerOf(el: Element): string {
  let node: Element | null = el;
  while (node) {
    if (node.tagName.toLowerCase() === 'g') {
      const label =
        node.getAttribute('inkscape:label') ??
        node.getAttribute('data-name') ??
        node.getAttribute('id') ??
        node.getAttribute('class');
      if (label) return label;
    }
    node = node.parentElement;
  }
  return '0';
}

const num = (v: string | null, def = 0): number => {
  const n = Number.parseFloat(v ?? '');
  return Number.isFinite(n) ? n : def;
};

/** Точки из строки вида "x,y x,y" или "x y x y". */
function parsePoints(raw: string | null): { x: number; y: number }[] {
  if (!raw) return [];
  const nums = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i]!, y: -nums[i + 1]! });
  return out;
}

/**
 * Разбирает SVG в тот же вид, что и DXF.
 *
 * Берём только то, что однозначно ложится на схему фонтана:
 *  · circle/ellipse — точка с радиусом (форсунка, прожектор, круглая чаша);
 *  · rect — замкнутый контур из четырёх углов;
 *  · polyline/polygon — контур как есть;
 *  · path — только опорные точки команд M/L/H/V, кривые не аппроксимируем:
 *    для плана достаточно, а врать сглаживанием ни к чему.
 */
export function parseSvgPlan(text: string): DxfDrawing {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || !doc.querySelector('svg')) {
    throw new Error('не похоже на SVG');
  }
  const points: DxfPoint[] = [];
  const polylines: DxfPolyline[] = [];
  const layers = new Set<string>();
  const add = (layer: string): void => {
    layers.add(layer);
  };

  for (const el of Array.from(doc.querySelectorAll('circle, ellipse'))) {
    const layer = layerOf(el);
    add(layer);
    const rx = el.tagName.toLowerCase() === 'circle' ? num(el.getAttribute('r')) : num(el.getAttribute('rx'));
    // Окружность — тот же вид сущности, что circle в DXF: дальше по радиусу
    // решается, форсунка это, прожектор или чаша.
    const pt: DxfPoint = {
      layer,
      kind: rx > 0 ? 'circle' : 'point',
      x: num(el.getAttribute('cx')),
      y: -num(el.getAttribute('cy')),
    };
    if (rx > 0) pt.radius = rx;
    points.push(pt);
  }

  for (const el of Array.from(doc.querySelectorAll('rect'))) {
    const layer = layerOf(el);
    add(layer);
    const x = num(el.getAttribute('x'));
    const y = -num(el.getAttribute('y'));
    const w = num(el.getAttribute('width'));
    const h = num(el.getAttribute('height'));
    if (w <= 0 || h <= 0) continue;
    polylines.push({
      layer,
      closed: true,
      points: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y - h },
        { x, y: y - h },
      ],
    });
  }

  for (const el of Array.from(doc.querySelectorAll('polyline, polygon'))) {
    const layer = layerOf(el);
    add(layer);
    const pts = parsePoints(el.getAttribute('points'));
    if (pts.length >= 2) polylines.push({ layer, closed: el.tagName.toLowerCase() === 'polygon', points: pts });
  }

  for (const el of Array.from(doc.querySelectorAll('path'))) {
    const layer = layerOf(el);
    const d = el.getAttribute('d') ?? '';
    // Только абсолютные и относительные M/L/H/V — опорные точки контура.
    const pts: { x: number; y: number }[] = [];
    let cx = 0;
    let cy = 0;
    const re = /([MmLlHhVvZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
    let m: RegExpExecArray | null;
    let closed = false;
    while ((m = re.exec(d)) !== null) {
      const cmd = m[1]!;
      const args = (m[2] ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n));
      if (cmd === 'Z' || cmd === 'z') {
        closed = true;
        continue;
      }
      if (cmd === 'H' || cmd === 'h') {
        for (const a of args) {
          cx = cmd === 'H' ? a : cx + a;
          pts.push({ x: cx, y: -cy });
        }
        continue;
      }
      if (cmd === 'V' || cmd === 'v') {
        for (const a of args) {
          cy = cmd === 'V' ? a : cy + a;
          pts.push({ x: cx, y: -cy });
        }
        continue;
      }
      for (let i = 0; i + 1 < args.length; i += 2) {
        const ax = args[i]!;
        const ay = args[i + 1]!;
        cx = cmd === cmd.toUpperCase() ? ax : cx + ax;
        cy = cmd === cmd.toUpperCase() ? ay : cy + ay;
        pts.push({ x: cx, y: -cy });
      }
    }
    if (pts.length >= 2) {
      add(layer);
      polylines.push({ layer, closed, points: pts });
    }
  }

  return {
    points,
    polylines,
    lines: [],
    layers: [...layers].sort(),
    insunits: SVG_INSUNITS,
  };
}

/**
 * Что за файл нам дали. Нужен, чтобы вместо «не удалось разобрать» сказать
 * человеку по делу: DWG и двоичный DXF мы не читаем, и это не поправить
 * настройками — файл надо пересохранить.
 */
export function sniffPlanFormat(head: string, name: string): 'dxf' | 'svg' | 'dwg' | 'dxf-binary' | 'unknown' {
  if (/^AutoCAD Binary DXF/.test(head)) return 'dxf-binary';
  // Сигнатура DWG — «AC» и версия: AC1015, AC1024, AC1032 и т. д.
  if (/^AC10\d\d/.test(head)) return 'dwg';
  if (/<svg[\s>]/i.test(head) || /\.svg$/i.test(name)) return 'svg';
  if (/\bSECTION\b/.test(head) || /\.dxf$/i.test(name)) return 'dxf';
  return 'unknown';
}
