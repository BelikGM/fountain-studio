import { useMemo, useState } from 'react';
import {
  DMX_MAX_VALUE,
  profileMap,
  type DeviceKind,
  type DeviceProfile,
  type Project,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';
import { noteManual } from '../manualActivity';
import { hexToRgb } from '../colorPresets';

/**
 * Массовое управление по типу прибора (§27 доработки, по примеру прежнего
 * приложения — «все насосы/клапаны/светильники разом», для пусконаладки).
 *
 * Стоит на двух вкладках: на «Отладке» и в «3D». В 3D она нужна не меньше:
 * там видно, что получилось, и гонять человека на другую вкладку ради «поднять
 * все насосы» незачем.
 */

/** Только чистые цвета — по требованию §27 доработки: R/G/B, их полные комбинации, белый и чёрный. */
const PURE_COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: 'Красный', hex: '#ff0000' },
  { name: 'Зелёный', hex: '#00ff00' },
  { name: 'Синий', hex: '#0000ff' },
  { name: 'Жёлтый', hex: '#ffff00' },
  { name: 'Пурпурный', hex: '#ff00ff' },
  { name: 'Голубой', hex: '#00ffff' },
  { name: 'Белый', hex: '#ffffff' },
  { name: 'Чёрный', hex: '#000000' },
];

export function QuickAll({
  project,
  send,
  where,
}: {
  project: Project | null;
  send: EngineConnection['send'];
  /** Откуда трогают приборы — для строки состояния внизу. */
  where: 'console' | 'layout';
}) {
  const [customColor, setCustomColor] = useState<string | null>(null);
  /** Что сделает следующее нажатие по клапанам. Это НЕ состояние линии (см. ниже). */
  const [valveNextOpen, setValveNextOpen] = useState(true);
  /** Положение общего ползунка насосов: держим сами, чтобы он не прыгал от кадров. */
  const [pumpLevel, setPumpLevel] = useState(0);

  const profiles = useMemo(
    () => (project ? profileMap(project) : new Map<string, DeviceProfile>()),
    [project],
  );

  // Пишет во все подходящие адреса каналами setChannel — тот же путь, что и
  // обычный фейдер, просто циклом по устройствам нужного вида.
  //
  // noteManual — ОДИН раз на нажатие, а не на каждый прибор: отметку слушает
  // строка состояния внизу, и на пятидесяти форсунках полсотни отметок за одно
  // движение мыши перерисовывали всё приложение (см. manualActivity.ts).
  const setAllOfKind = (kind: DeviceKind, roles: Partial<Record<string, number>>, what: string): void => {
    if (!project) return;
    let touched = 0;
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      if (!profile || profile.kind !== kind) continue;
      profile.channels.forEach((c, i) => {
        const v = roles[c.role];
        if (v !== undefined) {
          send({ type: 'setChannel', universe: d.universe, channel: d.address + i, value: v });
          touched++;
        }
      });
    }
    if (touched > 0) noteManual(where, what);
  };

  // Есть ли в патче клапаны вообще — только чтобы не показывать мёртвую кнопку.
  // Раньше здесь ещё считалось «все ли клапаны сейчас открыты» по живым кадрам,
  // и подпись кнопки прыгала ОТКРЫТЫ/ЗАКРЫТЫ на каждом кадре тест-генератора:
  // кнопка выглядела индикатором, хотя это команда. Состояние линии показывают
  // сами фейдеры, кнопке оно не нужно.
  const hasValves = useMemo(() => {
    if (!project) return false;
    return project.devices.some((d) => {
      const profile = profiles.get(d.profileId);
      return !!profile && profile.kind === 'valve' && profile.channels.some((c) => c.role === 'open');
    });
  }, [project, profiles]);

  return (
    <div className="quick-controls">
      <div className="quick-controls-title" data-hint="Одно значение сразу всем приборам этого вида — для пусконаладки">
        Сразу все приборы одного вида
      </div>

      <div className="quick-row">
        <span className="quick-row-label">Свет:</span>
        <div className="color-presets">
          {PURE_COLOR_PRESETS.map((p) => (
            <button
              key={p.hex}
              type="button"
              className="color-swatch"
              style={{ background: p.hex }}
              data-hint={p.name}
              onClick={() => {
                const [r, g, b] = hexToRgb(p.hex);
                setAllOfKind('lamp', { red: r, green: g, blue: b }, `свет — ${p.name.toLowerCase()}`);
              }}
            />
          ))}
          <label
            className="color-swatch color-swatch-custom"
            style={customColor ? { background: customColor } : undefined}
            data-hint="Свой цвет — нажмите, чтобы выбрать"
          >
            <input
              type="color"
              value={customColor ?? '#000000'}
              onChange={(e) => {
                setCustomColor(e.target.value);
                const [r, g, b] = hexToRgb(e.target.value);
                setAllOfKind('lamp', { red: r, green: g, blue: b }, 'свет — свой цвет');
              }}
            />
          </label>
        </div>
      </div>

      <hr className="quick-divider" />

      <div className="quick-row">
        <span className="quick-row-label">Насосы:</span>
        <input
          type="range"
          min={0}
          max={DMX_MAX_VALUE}
          value={pumpLevel}
          onChange={(e) => {
            const v = Number(e.target.value);
            setPumpLevel(v);
            setAllOfKind('pump', { intensity: v }, `все насосы ${v}`);
          }}
        />
        <span className="dim">{pumpLevel}</span>
      </div>

      <hr className="quick-divider" />

      <div className="quick-row">
        <span className="quick-row-label">Клапаны:</span>
        <button
          className={valveNextOpen ? 'btn toggle-open' : 'btn toggle-closed'}
          disabled={!hasValves}
          data-hint="Команда сразу всем клапанам. На кнопке — что произойдёт по нажатию; текущее положение каждого видно на его ползунке"
          onClick={() => {
            setAllOfKind(
              'valve',
              { open: valveNextOpen ? DMX_MAX_VALUE : 0 },
              valveNextOpen ? 'все клапаны открыты' : 'все клапаны закрыты',
            );
            setValveNextOpen(!valveNextOpen);
          }}
        >
          {valveNextOpen ? 'Открыть' : 'Закрыть'}
        </button>
      </div>
    </div>
  );
}
