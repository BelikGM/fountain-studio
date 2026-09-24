import { useMemo, useState } from 'react';
import {
  allProfiles,
  autoFigureShare,
  defaultFigureProfile,
  FIGURE_ROLES,
  figurePoints,
  LAYOUT_SHAPES,
  nozzleDefaults,
  NOZZLE_KINDS,
  planFigure,
  sharesEvenly,
  uid,
  universeShort,
  countOf,
  type FigureDevices,
  type FigureRole,
  type FigureShare,
  type FigureSpec,
  type LayoutShape,
  type NozzleKind,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';
import { requestTab } from '../navigate';
import { ArrowRightIcon } from './Icons';
import { NumInput } from './NumInput';

/**
 * «Добавить фигуру фонтана» — форсунки фигурой вместе с насосами, клапанами и
 * светом, сразу привязанные друг к другу (заказчик 24.09.2026). Логика — в
 * shared/figure.ts, здесь форма, вид сверху и таблица ручной правки.
 *
 * Отличие от «Расставить фигурой» в 3D: там ставятся только форсунки или
 * прожекторы, без приборов, — чтобы дорисовать схему руками. Здесь — вся
 * фигура целиком: приборы с адресами, форсунки и привязки.
 */

/** Какая доля «на что» — чтобы человек видел, как мы поняли раскладку. */
function shareText(n: number, k: number, mode: FigureDevices['mode'], one: string): string {
  if (k === 0) return 'нет';
  if (k === n) return 'по одному на форсунку';
  if (k > n) {
    return k % n === 0 ? `по ${k / n} на форсунку` : `по ${Math.floor(k / n)}–${Math.ceil(k / n)} на форсунку`;
  }
  if (k === 1) return `один на все ${n} форсунок`;
  if (mode === 'alternate') return `чередуются: форсунка 1 — ${one} 1, форсунка 2 — ${one} 2…`;
  return n % k === 0 ? `каждый на ${n / k} соседних форсунок` : `каждый на ${Math.floor(n / k)}–${Math.ceil(n / k)} соседних форсунок`;
}

/** Цвета насосов на виде сверху — различимые и на тёмном, и на светлом фоне. */
const PUMP_COLORS = ['#4aa3ff', '#ff8a3d', '#5fd068', '#e05ad6', '#e6c14a', '#3fd4c8', '#ff5a5a', '#a98bff'];

const SHAPE_NAMES: Record<LayoutShape, string> = {
  ring: 'Кольцо',
  square: 'Квадрат',
  rect: 'Прямоугольник',
  triangle: 'Треугольник',
  star: 'Звезда',
};

export function FigureWizard({ engine }: { engine: EngineConnection }) {
  const { project, universes, updateProject } = engine;
  const profiles = useMemo(() => allProfiles(project!), [project]);
  const firstUniverse = universes[0]?.id ?? 1;
  const devices = (role: FigureRole, count: number): FigureDevices => ({
    count,
    profileId: defaultFigureProfile(project!, role),
    universe: firstUniverse,
    startAddress: null,
    mode: 'blocks',
  });
  const [spec, setSpec] = useState<FigureSpec>(() => ({
    name: 'Кольцо',
    shape: 'ring',
    count: 12,
    size: 3,
    aspect: 0.6,
    cx: 0,
    cy: 0,
    cz: 0,
    rotationDeg: 0,
    nozzleKind: 'straight',
    maxHeightM: nozzleDefaults('straight').maxHeightM,
    widthM: nozzleDefaults('straight').widthM,
    tiltDeg: 0,
    tiltTo: 'center',
    pump: devices('pump', 1),
    valve: devices('valve', 0),
    light: devices('light', 12),
  }));
  /** Раздача, поправленная руками; null — считаем автоматически. */
  const [manual, setManual] = useState<FigureShare | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const n = Math.max(1, Math.round(spec.count));
  const share = manual ?? autoFigureShare(spec);

  /**
   * Поменялось то, от чего зависит раздача (число форсунок или приборов, способ
   * деления), — ручная правка сбрасывается: по старой таблице новые номера уже
   * не сходятся.
   */
  const update = (patch: Partial<FigureSpec>): void => {
    const next = { ...spec, ...patch };
    const key = (s: FigureSpec): string =>
      [s.count, s.pump.count, s.pump.mode, s.valve.count, s.valve.mode, s.light.count, s.light.mode].join('|');
    if (key(next) !== key(spec)) setManual(null);
    setSpec(next);
    setDone(null);
  };
  const updateRole = (role: FigureRole, patch: Partial<FigureDevices>): void => update({ [role]: { ...spec[role], ...patch } });

  const plan = useMemo(() => planFigure(project!, spec, share, () => 'x'), [project, spec, share]);
  const points = useMemo(() => figurePoints(spec), [spec]);

  const create = (): void => {
    const real = planFigure(project!, spec, share, uid);
    if (real.errors.length > 0) return;
    const layout = project!.layout;
    updateProject({
      ...project!,
      devices: [...project!.devices, ...real.devices],
      layout: {
        ...layout,
        nozzles: [...layout.nozzles, ...real.nozzles],
        nozzleGroups: [...layout.nozzleGroups, real.group],
      },
    });
    const parts = FIGURE_ROLES.filter((r) => spec[r.role].count > 0).map((r) => `${r.label.toLowerCase()}: ${spec[r.role].count}`);
    setDone(`✔ Создано: «${real.group.name}» — ${countOf(real.nozzles.length, 'форсунка', 'форсунки', 'форсунок')}${parts.length ? `, ${parts.join(', ')}` : ''}.`);
    // Следующая фигура — с новым именем, чтобы контуры не звались одинаково.
    const base = SHAPE_NAMES[spec.shape];
    const taken = new Set([...layout.nozzleGroups.map((g) => g.name), real.group.name]);
    let k = 2;
    while (taken.has(`${base} ${k}`)) k++;
    setSpec({ ...spec, name: `${base} ${k}` });
    setManual(null);
  };

  const profilesOf = (role: FigureRole) =>
    profiles.filter((p) => (role === 'light' ? p.kind === 'lamp' : p.kind === role));

  /** Правка одной клетки таблицы раздачи. */
  const setCell = (role: FigureRole, nozzle: number, slot: number, device: number | null): void => {
    const next: FigureShare = { pump: share.pump.map((x) => [...x]), valve: share.valve.map((x) => [...x]), light: share.light.map((x) => [...x]) };
    const cell = next[role][nozzle] ?? [];
    if (device === null) cell.splice(slot, 1);
    else cell[slot] = device;
    next[role][nozzle] = cell;
    setManual(next);
    setDone(null);
  };

  const rangeText = plan.ranges
    .map((r) => {
      const label = FIGURE_ROLES.find((x) => x.role === r.role)!.label.toLowerCase();
      return `${label} — вселенная ${r.universe}, ${r.from === r.to ? `адрес ${r.from}` : `адреса ${r.from}–${r.to}`}`;
    })
    .join('; ');

  return (
    <section className="panel">
      <h2>Добавить фигуру фонтана</h2>
      <p className="dim">
        Кольцо, квадрат, звезда… — форсунки вместе с насосами, клапанами и светом, сразу привязанные друг к другу. В
        3D фигура появится контуром: её можно повернуть и сдвинуть целиком. Центральная струя — «Кольцо» из одной
        форсунки: она встанет в центр.
      </p>
      <div className="figure-wizard">
        <div className="figure-form">
          <h3>Фигура</h3>
          <div className="form-row">
            <label className="field">
              Название:{' '}
              <input className="input" style={{ width: 150 }} value={spec.name} onChange={(e) => update({ name: e.target.value })} />
            </label>
            <label className="field">
              Фигура:{' '}
              <select
                value={spec.shape}
                onChange={(e) => {
                  const shape = e.target.value as LayoutShape;
                  // Имя, которое программа дала сама, меняем вместе с фигурой.
                  const auto = Object.values(SHAPE_NAMES).some((s) => spec.name === s || spec.name.startsWith(`${s} `));
                  update({ shape, ...(auto ? { name: SHAPE_NAMES[shape] } : {}) });
                }}
              >
                {LAYOUT_SHAPES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Форсунок:{' '}
              <NumInput integer min={1} max={500} value={spec.count} onChange={(v) => update({ count: v })} />
            </label>
            <span className="shape-presets">
              {[1, ...LAYOUT_SHAPES.find((s) => s.id === spec.shape)!.nice, 36].map((c) => (
                <button
                  key={c}
                  className={c === spec.count ? 'btn btn-small state-on' : 'btn btn-small'}
                  data-hint={c === 1 ? 'Одна форсунка в центре — центральная струя' : 'При таком числе форсунки встают ровно на углы'}
                  onClick={() => update({ count: c })}
                >
                  {c}
                </button>
              ))}
            </span>
          </div>
          <div className="form-row">
            <label className="field" data-hint={spec.shape === 'ring' ? 'Радиус кольца, м' : 'Половина стороны фигуры, м'}>
              {spec.shape === 'ring' ? 'Радиус, м:' : 'Размер, м:'}{' '}
              <NumInput min={0.1} max={500} step={0.5} value={spec.size} onChange={(v) => update({ size: v })} />
            </label>
            {spec.shape === 'rect' && (
              <label className="field" data-hint="Отношение короткой стороны к длинной">
                Пропорция:{' '}
                <NumInput min={0.1} max={5} step={0.1} value={spec.aspect} onChange={(v) => update({ aspect: v })} />
              </label>
            )}
            {(['cx', 'cy', 'cz'] as const).map((k) => (
              <label className="field" key={k} data-hint={k === 'cz' ? 'Высота сопел над водой, м' : 'Где центр фигуры на схеме, м'}>
                {k === 'cx' ? 'Центр X, м:' : k === 'cy' ? 'Y:' : 'Z:'}{' '}
                <NumInput step={0.5} min={-1000} max={1000} value={spec[k]} onChange={(v) => update({ [k]: v })} />
              </label>
            ))}
            <label className="field" data-hint="Повернуть всю фигуру вокруг её центра. Потом поворот меняется в свойствах контура в 3D">
              Поворот, °:{' '}
              <NumInput min={0} max={360} step={5} value={spec.rotationDeg} onChange={(v) => update({ rotationDeg: v })} />
            </label>
          </div>
          <h3>Форсунки</h3>
          <div className="form-row">
            <label className="field">
              Насадка:{' '}
              <select
                value={spec.nozzleKind}
                onChange={(e) => {
                  const kind = e.target.value as NozzleKind;
                  const d = nozzleDefaults(kind);
                  update({ nozzleKind: kind, maxHeightM: d.maxHeightM, widthM: d.widthM });
                }}
              >
                {NOZZLE_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" data-hint="Высота струи при полной мощности насоса, м — как замерено на объекте">
              Высота струи, м:{' '}
              <NumInput min={0.1} max={100} step={0.5} value={spec.maxHeightM} onChange={(v) => update({ maxHeightM: v })} />
            </label>
            <label className="field" data-hint="Диаметр струи у сопла, мм">
              Диаметр струи, мм:{' '}
              <NumInput
                integer
                min={2}
                max={500}
                value={Math.round(spec.widthM * 1000)}
                onChange={(v) => update({ widthM: v / 1000 })}
              />
            </label>
            <label className="field" data-hint="Наклон струи от вертикали, °. 0 — прямо вверх. Наклонное кольцо — например, 15–30°">
              Наклон, °:{' '}
              <NumInput min={0} max={90} step={5} value={spec.tiltDeg} onChange={(v) => update({ tiltDeg: v })} />
            </label>
            {spec.tiltDeg > 0 && (
              <select value={spec.tiltTo} onChange={(e) => update({ tiltTo: e.target.value as FigureSpec['tiltTo'] })}>
                <option value="center">к центру</option>
                <option value="out">наружу</option>
              </select>
            )}
          </div>
          <h3>Приборы</h3>
          <table className="table figure-devices">
            <thead>
              <tr>
                <th></th>
                <th>Сколько</th>
                <th>Тип</th>
                <th>Вселенная</th>
                <th data-hint="Пусто — первые свободные адреса после уже занятых">С адреса</th>
                <th data-hint="Если приборов меньше, чем форсунок: каждому своя часть фигуры подряд или через одну">Делить</th>
                <th>Как поделится</th>
              </tr>
            </thead>
            <tbody>
              {FIGURE_ROLES.map(({ role, label, one }) => {
                const d = spec[role];
                const list = profilesOf(role);
                return (
                  <tr key={role}>
                    <td>{label}</td>
                    <td className="cell-actions">
                      <NumInput integer min={0} max={2000} value={d.count} onChange={(v) => updateRole(role, { count: v })} />{' '}
                      <button
                        className="btn btn-small"
                        data-hint="По одному на каждую форсунку"
                        disabled={d.count === n}
                        onClick={() => updateRole(role, { count: n })}
                      >
                        = {n}
                      </button>
                    </td>
                    <td>
                      <select value={d.profileId} disabled={d.count === 0} onChange={(e) => updateRole(role, { profileId: e.target.value })}>
                        {list.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} — {countOf(p.channels.length, 'адрес', 'адреса', 'адресов')}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select value={d.universe} disabled={d.count === 0} onChange={(e) => updateRole(role, { universe: Number(e.target.value) })}>
                        {universes.map((u) => (
                          <option key={u.id} value={u.id}>
                            {universeShort(u)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="cell-actions">
                      <label className="field" data-hint="Снимите галочку, чтобы задать начальный адрес самому">
                        <input
                          type="checkbox"
                          checked={d.startAddress === null}
                          disabled={d.count === 0}
                          onChange={(e) => updateRole(role, { startAddress: e.target.checked ? null : 1 })}
                        />{' '}
                        {d.startAddress === null ? 'свободные' : ''}
                      </label>
                      {d.startAddress !== null && (
                        <NumInput integer min={1} max={512} value={d.startAddress} onChange={(v) => updateRole(role, { startAddress: v })} />
                      )}
                    </td>
                    <td>
                      <select
                        value={d.mode}
                        disabled={d.count === 0 || d.count >= n}
                        onChange={(e) => updateRole(role, { mode: e.target.value as FigureDevices['mode'] })}
                      >
                        <option value="blocks">частями</option>
                        <option value="alternate">чередуя</option>
                      </select>
                    </td>
                    <td className={sharesEvenly(n, d.count) ? 'dim' : 'warn'}>
                      {shareText(n, d.count, d.mode, one)}
                      {!sharesEvenly(n, d.count) && ' — не делится ровно, проверьте таблицу ниже'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <FigurePreview points={points} share={share} cx={spec.cx} cy={spec.cy} pumps={spec.pump.count} />
      </div>

      <details className="figure-share">
        <summary>
          Какой форсунке что достаётся — поправить вручную{manual ? ' (поправлено)' : ''}
        </summary>
        {manual && (
          <div className="form-row">
            <span className="warn">Раздача поправлена вручную.</span>
            <button className="btn btn-small" onClick={() => setManual(null)}>
              Вернуть автоматическую
            </button>
          </div>
        )}
        <table className="table figure-share-table">
          <thead>
            <tr>
              <th>Форсунка</th>
              {FIGURE_ROLES.filter((r) => spec[r.role].count > 0).map((r) => (
                <th key={r.role}>{r.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {points.map((_, i) => (
              <tr key={i}>
                <td className="dim">Ф{i + 1}</td>
                {FIGURE_ROLES.filter((r) => spec[r.role].count > 0).map(({ role, one }) => {
                  const cell = share[role][i] ?? [];
                  const k = spec[role].count;
                  // Лишний пустой выбор — чтобы можно было добавить прибор форсунке.
                  const slots = [...cell, null];
                  return (
                    <td key={role} className="cell-actions">
                      {slots.map((dev, slot) => (
                        <select
                          key={slot}
                          value={dev ?? ''}
                          className={dev === null ? 'figure-slot-empty' : undefined}
                          onChange={(e) => setCell(role, i, slot, e.target.value === '' ? null : Number(e.target.value))}
                        >
                          <option value="">{dev === null ? (cell.length === 0 ? '—' : '+') : '— убрать'}</option>
                          {Array.from({ length: k }, (_, j) => (
                            <option key={j} value={j}>
                              {one} {j + 1}
                            </option>
                          ))}
                        </select>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {plan.errors.length > 0 ? (
        plan.errors.map((e) => (
          <p key={e} className="error-text">
            {e}
          </p>
        ))
      ) : (
        <p className="dim">
          Будет создано: {countOf(n, 'форсунка', 'форсунки', 'форсунок')} и контур «{spec.name.trim() || 'Фигура'}» в 3D
          {rangeText ? `; ${rangeText}` : ''}.
        </p>
      )}
      <div className="form-row">
        <button className="btn active" disabled={plan.errors.length > 0} onClick={create}>
          Создать фигуру
        </button>
        {done && (
          <>
            <span className="ok-text">{done}</span>
            <button className="btn btn-icon" onClick={() => requestTab('layout')}>
              <ArrowRightIcon />
              Посмотреть в 3D
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Вид сверху: где встанут форсунки и какой насос на какой. Цвет точки —
 * насос: сразу видно, угадала ли программа раскладку («частями» или «чередуя»).
 */
function FigurePreview({
  points,
  share,
  cx,
  cy,
  pumps,
}: {
  points: { x: number; y: number }[];
  share: FigureShare;
  cx: number;
  cy: number;
  pumps: number;
}) {
  const size = 220;
  const pad = 28;
  const span = Math.max(0.5, ...points.map((p) => Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy))));
  const scale = (size / 2 - pad) / span;
  // Y схемы — вверх, у SVG — вниз.
  const px = (x: number): number => size / 2 + (x - cx) * scale;
  const py = (y: number): number => size / 2 - (y - cy) * scale;
  const r = Math.max(2.5, Math.min(7, 60 / Math.sqrt(points.length)));
  return (
    <figure className="figure-preview">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Вид сверху">
        <line x1={size / 2 - 5} y1={size / 2} x2={size / 2 + 5} y2={size / 2} className="figure-preview-center" />
        <line x1={size / 2} y1={size / 2 - 5} x2={size / 2} y2={size / 2 + 5} className="figure-preview-center" />
        {points.map((p, i) => {
          const pump = share.pump[i]?.[0];
          const fill = pump === undefined ? 'var(--fg-dim)' : PUMP_COLORS[pump % PUMP_COLORS.length];
          return (
            <circle key={i} cx={px(p.x)} cy={py(p.y)} r={r} fill={fill}>
              <title>{`Ф${i + 1}${pump === undefined ? ' — без насоса' : ` — насос ${pump + 1}`}`}</title>
            </circle>
          );
        })}
        {points.length > 1 && points.length <= 48 && (() => {
          // Подпись «Ф1» — снаружи фигуры, по лучу от центра: иначе она
          // ложилась на соседние точки.
          const p = points[0]!;
          const d = Math.hypot(p.x - cx, p.y - cy) || 1;
          const lx = px(p.x) + ((p.x - cx) / d) * (r + 9);
          const ly = py(p.y) - ((p.y - cy) / d) * (r + 9) + 3;
          return (
            <text x={lx} y={ly} className="figure-preview-label" textAnchor="middle">
              Ф1
            </text>
          );
        })()}
      </svg>
      <figcaption className="dim">
        Вид сверху. {pumps > 0 ? 'Цвет — насос.' : 'Насосов нет.'}
      </figcaption>
    </figure>
  );
}
