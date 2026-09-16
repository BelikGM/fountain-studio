import type { ColorSwatch, Project } from '@fountain-studio/shared';
import { COLOR_PRESETS, hexToRgb, rgbToHex } from '../colorPresets';

/**
 * Образцы цвета: встроенные пресеты плюс СВОИ цвета объекта.
 *
 * Встроенные десять оттенков закрывают «дай красный», но не закрывают
 * фирменный цвет заказчика и подобранный на месте оттенок подсветки. Свои
 * цвета сохраняются в проект, поэтому уезжают вместе с ним на другой
 * компьютер и не теряются при переустановке программы.
 */
export function ColorPalette({
  project,
  updateProject,
  /** Текущий цвет — его и предлагаем сохранить. */
  current,
  onPick,
}: {
  project: Project;
  updateProject: (p: Project) => void;
  current: [number, number, number];
  onPick: (rgb: [number, number, number]) => void;
}) {
  const mine = project.colorPalette ?? [];
  const curHex = rgbToHex(current[0], current[1], current[2]);
  const already = mine.some((s) => s.hex === curHex);

  const save = (): void => {
    if (already) return;
    const swatch: ColorSwatch = { name: curHex, hex: curHex };
    updateProject({ ...project, colorPalette: [...mine, swatch] });
  };
  const remove = (hex: string): void => {
    updateProject({ ...project, colorPalette: mine.filter((s) => s.hex !== hex) });
  };

  return (
    <div className="color-presets">
      {COLOR_PRESETS.map((p) => (
        <button
          key={p.name}
          type="button"
          className="color-swatch"
          style={{ background: p.hex }}
          data-hint={p.name}
          onClick={() => onPick(hexToRgb(p.hex))}
        />
      ))}
      {mine.length > 0 && <span className="color-sep" />}
      {mine.map((s) => (
        <span className="color-swatch-own" key={s.hex}>
          <button
            type="button"
            className="color-swatch"
            style={{ background: s.hex }}
            data-hint={`Свой цвет ${s.hex} — правой кнопкой убрать из палитры`}
            onClick={() => onPick(hexToRgb(s.hex))}
            onContextMenu={(e) => {
              e.preventDefault();
              remove(s.hex);
            }}
          />
        </span>
      ))}
      <button
        type="button"
        className="btn btn-small color-add"
        disabled={already}
        data-hint={
          already
            ? 'Этот цвет уже в палитре объекта'
            : 'Сохранить текущий цвет в палитру объекта — он уедет вместе с файлом проекта'
        }
        onClick={save}
      >
        +
      </button>
    </div>
  );
}
