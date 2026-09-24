import type { ReactNode } from 'react';
import type { FigureDims, LayoutShape } from '@fountain-studio/shared';
import { NumInput } from './NumInput';

/** Метры для подписи: «6», «2,75» — без лишнего «,0». */
export function metersText(x: number): string {
  return x.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}

/**
 * Размеры фигуры — так, как их меряют на объекте (заказчик 24.09.2026): у
 * кольца радиус, у квадрата сторона, у прямоугольника длина и ширина, у
 * треугольника одна сторона (равносторонний) или три, у звезды ребро.
 * Раньше было одно поле «Размер — половина стороны», и что в него вписывать,
 * было непонятно. Одни и те же поля — в «Добавить фигуру фонтана» и в
 * «Расставить фигурой» в 3D, чтобы одна фигура не мерилась по-разному.
 *
 * sidebar — вид боковой панели 3D (подпись слева, поле справа); иначе —
 * строка формы «Подпись: [поле]».
 */
export function FigureDimsFields({
  shape,
  dims,
  onChange,
  clockwise,
  onClockwise,
  sidebar = false,
}: {
  shape: LayoutShape;
  dims: FigureDims;
  onChange: (d: FigureDims) => void;
  clockwise: boolean;
  onClockwise: (v: boolean) => void;
  sidebar?: boolean;
}) {
  const field = (key: string, label: string, hint: string, input: ReactNode): ReactNode =>
    sidebar ? (
      <label className="field" key={key}>
        <span className="field-name has-hint" data-hint={hint}>
          {label}:
        </span>{' '}
        {input}
      </label>
    ) : (
      <label className="field" key={key} data-hint={hint}>
        {label}:{' '}
        {input}
      </label>
    );
  const num = (value: number, set: (v: number) => void): ReactNode => (
    <NumInput className="input input-num" min={0.1} max={500} step={0.5} value={value} onChange={set} />
  );
  const setSide = (i: 0 | 1 | 2, v: number): void => {
    const sides: [number, number, number] = [...dims.sides];
    sides[i] = v;
    onChange({ ...dims, sides });
  };

  const out: ReactNode[] = [];
  switch (shape) {
    case 'ring':
      out.push(
        field('radius', 'Радиус, м', 'От центра кольца до каждой форсунки, м. Кольцо радиусом 3 м — 6 м в поперечнике.', num(dims.radius, (v) => onChange({ ...dims, radius: v }))),
      );
      break;
    case 'square':
      out.push(field('side', 'Сторона, м', 'Длина стороны квадрата, м — от угла до угла.', num(dims.side, (v) => onChange({ ...dims, side: v }))));
      break;
    case 'rect':
      out.push(
        field('length', 'Длина, м', 'Длина прямоугольника вдоль оси X, м — от угла до угла.', num(dims.length, (v) => onChange({ ...dims, length: v }))),
        field('width', 'Ширина, м', 'Ширина прямоугольника вдоль оси Y, м — от угла до угла.', num(dims.width, (v) => onChange({ ...dims, width: v }))),
      );
      break;
    case 'triangle': {
      const hint = 'Все три стороны равны — хватит одной. Снимите галочку, чтобы задать каждую сторону.';
      const box = (
        <input type="checkbox" checked={dims.equilateral} onChange={(e) => onChange({ ...dims, equilateral: e.target.checked })} />
      );
      out.push(
        sidebar ? (
          <label className="field" key="eq">
            {box}{' '}
            <span className="field-name has-hint" data-hint={hint}>
              Равносторонний
            </span>
          </label>
        ) : (
          <label className="field" key="eq" data-hint={hint}>
            {box} равносторонний
          </label>
        ),
      );
      if (dims.equilateral) {
        out.push(field('side', 'Сторона, м', 'Длина стороны треугольника, м — от угла до угла.', num(dims.side, (v) => onChange({ ...dims, side: v }))));
      } else {
        out.push(
          field('a', 'Основание, м', 'Нижняя сторона треугольника, м.', num(dims.sides[0], (v) => setSide(0, v))),
          field('b', 'Правая, м', 'Правая сторона — от правого нижнего угла до верхнего, м.', num(dims.sides[1], (v) => setSide(1, v))),
          field('c', 'Левая, м', 'Левая сторона — от левого нижнего угла до верхнего, м.', num(dims.sides[2], (v) => setSide(2, v))),
        );
      }
      break;
    }
    case 'star':
      out.push(
        field(
          'edge',
          'Ребро, м',
          'Длина одного ребра звезды, м — от конца луча до соседней впадины. У правильной пятиконечной звезды все 10 рёбер равны.',
          num(dims.starEdge, (v) => onChange({ ...dims, starEdge: v })),
        ),
      );
      break;
  }
  out.push(
    field(
      'order',
      'Нумерация',
      'Ф1 — сверху (у квадрата и прямоугольника — верхний правый угол), дальше по часовой стрелке или против. В этом же порядке форсункам раздаются приборы и адреса.',
      <select className={sidebar ? 'input' : undefined} value={clockwise ? 'cw' : 'ccw'} onChange={(e) => onClockwise(e.target.value === 'cw')}>
        <option value="cw">по часовой</option>
        <option value="ccw">против часовой</option>
      </select>,
    ),
  );
  return <>{out}</>;
}
