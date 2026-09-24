import { useMemo, useState } from 'react';
import {
  allProfiles,
  autoFigureShare,
  DEFAULT_FIGURE_DIMS,
  defaultFigureProfile,
  FIGURE_ROLES,
  figureEvenStep,
  figureExtent,
  figureOutline,
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
  type FigurePlan,
  type FigureRole,
  type FigureShare,
  type FigureSpec,
  type LayoutShape,
  type NozzleKind,
  type PatchedDevice,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';
import { requestTab } from '../navigate';
import { ArrowRightIcon } from './Icons';
import { NumInput } from './NumInput';
import { FigureDimsFields, metersText } from './FigureDimsFields';

/**
 * «Добавить фигуру фонтана» — форсунки фигурой вместе с насосами, клапанами и
 * светом, сразу привязанные друг к другу (заказчик 24.09.2026). Логика — в
 * shared/figure.ts, здесь форма, вид сверху и таблица ручной правки.
 *
 * Отличие от «Расставить фигурой» в 3D: там ставятся только форсунки или
 * прожекторы, без приборов, — чтобы дорисовать схему руками. Здесь — вся
 * фигура целиком: приборы с адресами, форсунки и привязки.
 */

/**
 * Как поделятся приборы — словами, чтобы человек видел, как мы поняли
 * раскладку. Клапан штучный (заказчик 24.09.2026): «один клапан на все
 * форсунки» не бывает, поэтому у клапанов свои фразы.
 */
function shareText(role: FigureRole, n: number, k: number, mode: FigureDevices['mode'], one: string): string {
  if (k === 0) return 'нет';
  if (role === 'valve') {
    if (k === n) return 'у каждой форсунки свой клапан';
    if (k < n) {
      return `клапанов меньше, чем форсунок: у ${countOf(n - k, 'форсунки', 'форсунок', 'форсунок')} клапана не будет — каким достанутся клапаны, видно и правится в таблице ниже`;
    }
    return 'клапанов больше, чем форсунок: у части форсунок по два — сверьтесь с таблицей ниже';
  }
  if (k === n) return 'по одному на форсунку';
  if (k > n) {
    return k % n === 0 ? `по ${k / n} на форсунку` : `по ${Math.floor(k / n)}–${Math.ceil(k / n)} на форсунку`;
  }
  if (k === 1) return `один на все ${n} форсунок`;
  if (mode === 'alternate') return `чередуются: форсунка 1 — ${one} 1, форсунка 2 — ${one} 2…`;
  return n % k === 0 ? `каждый на ${n / k} соседних форсунок` : `каждый на ${Math.floor(n / k)}–${Math.ceil(n / k)} соседних форсунок`;
}

/** Адрес прибора словами: «адр. 11» или «адр. 18–20», если прибор занимает несколько. */
function addrText(dev: PatchedDevice | null | undefined, span: number): string {
  if (!dev) return 'нет адреса';
  return span > 1 ? `адр. ${dev.address}–${dev.address + span - 1}` : `адр. ${dev.address}`;
}

/** Цвета насосов на виде сверху — различимые и на тёмном, и на светлом фоне. */
const PUMP_COLORS = ['#4aa3ff', '#ff8a3d', '#5fd068', '#e05ad6', '#e6c14a', '#3fd4c8', '#ff5a5a', '#a98bff'];

/** Свой оттенок каждому светильнику — по кругу цветов, чтобы соседние различались. */
function lightColor(j: number, k: number): string {
  return `hsl(${Math.round((j * 360) / Math.max(1, k))} 75% 60%)`;
}

const SHAPE_NAMES: Record<LayoutShape, string> = {
  ring: 'Кольцо',
  square: 'Квадрат',
  rect: 'Прямоугольник',
  triangle: 'Треугольник',
  star: 'Звезда',
};

const SHAPE_WHAT: Record<LayoutShape, string> = {
  ring: 'кольцо',
  square: 'квадрат',
  rect: 'прямоугольник',
  triangle: 'треугольник',
  star: 'звезда',
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
    // Клапанов меньше, чем форсунок, — по умолчанию разносим по фигуре равномерно.
    mode: role === 'valve' ? 'alternate' : 'blocks',
  });
  const [spec, setSpec] = useState<FigureSpec>(() => ({
    name: 'Кольцо',
    shape: 'ring',
    count: 12,
    dims: DEFAULT_FIGURE_DIMS,
    clockwise: true,
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
  /** Правка приборов вида. Сменились число, тип, вселенная или начало — адреса, вписанные руками, уже не к месту. */
  const updateRole = (role: FigureRole, patch: Partial<FigureDevices>): void => {
    const reset = ['count', 'profileId', 'universe', 'startAddress'].some((k) => k in patch);
    update({ [role]: { ...spec[role], ...patch, ...(reset ? { fixed: undefined } : {}) } });
  };
  /** Адрес одного прибора руками; null — вернуть автоматический. */
  const setFixed = (role: FigureRole, i: number, address: number | null): void => {
    const fixed = { ...(spec[role].fixed ?? {}) };
    if (address === null) delete fixed[i];
    else fixed[i] = address;
    update({ [role]: { ...spec[role], fixed: Object.keys(fixed).length ? fixed : undefined } });
  };

  const plan = useMemo(() => planFigure(project!, spec, share, () => 'x'), [project, spec, share]);
  const points = useMemo(() => figurePoints(spec), [spec]);
  const extent = figureExtent(points);

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
    setSpec({ ...spec, name: `${base} ${k}`, pump: { ...spec.pump, fixed: undefined }, valve: { ...spec.valve, fixed: undefined }, light: { ...spec.light, fixed: undefined } });
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
  const activeRoles = FIGURE_ROLES.filter((r) => spec[r.role].count > 0);

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
          {(() => {
            // У правильной фигуры стороны ровные, когда форсунок кратно числу
            // вершин: у звезды — 10 (5 лучей + 5 впадин), квадрата — 4,
            // треугольника — 3. Вершины заняты при любом числе, но остальные
            // иначе лягут на стороны неровно (заказчик 24.09.2026).
            const step = figureEvenStep(spec.shape, spec.dims);
            if (step <= 1 || n < step || n % step === 0) return null;
            const lo = Math.floor(n / step) * step;
            const hi = lo + step;
            return (
              <p className="warn figure-hint">
                Ровно по сторонам {SHAPE_WHAT[spec.shape]} ляжет при числе, кратном {step}:{' '}
                <button className="link-btn" onClick={() => update({ count: lo })}>
                  {lo}
                </button>{' '}
                или{' '}
                <button className="link-btn" onClick={() => update({ count: hi })}>
                  {hi}
                </button>
                . Сейчас вершины заняты, а на сторонах форсунок поровну не выйдет.
              </p>
            );
          })()}
          <div className="form-row">
            {n > 1 && (
              <FigureDimsFields
                shape={spec.shape}
                dims={spec.dims}
                onChange={(dims) => update({ dims })}
                clockwise={spec.clockwise}
                onClockwise={(clockwise) => update({ clockwise })}
              />
            )}
          </div>
          <div className="form-row">
            {(['cx', 'cy', 'cz'] as const).map((k) => (
              <label className="field" key={k} data-hint={k === 'cz' ? 'Высота сопел над водой, м' : 'Где центр фигуры на схеме, м'}>
                {k === 'cx' ? 'Центр X, м:' : k === 'cy' ? 'Y:' : 'Z:'}{' '}
                <NumInput step={0.5} min={-1000} max={1000} value={spec[k]} onChange={(v) => update({ [k]: v })} />
              </label>
            ))}
            <label className="field" data-hint="Повернуть всю фигуру вокруг её центра, против часовой стрелки. Потом поворот меняется в свойствах контура в 3D">
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
              <label
                className="field"
                data-hint="Азимут каждой форсунки программа считает сама: к центру фигуры или от него. Отдельно задавать не нужно — поправить одну форсунку можно потом в её свойствах в 3D"
              >
                куда:{' '}
                <select value={spec.tiltTo} onChange={(e) => update({ tiltTo: e.target.value as FigureSpec['tiltTo'] })}>
                  <option value="center">к центру</option>
                  <option value="out">наружу</option>
                </select>
              </label>
            )}
          </div>
          <h3>Приборы</h3>
          {/* На узком окне таблица прокручивается вбок сама, а не растягивает страницу. */}
          <div className="table-scroll">
          <table className="table figure-devices">
            <thead>
              <tr>
                <th></th>
                <th>Сколько</th>
                <th>Тип</th>
                <th>Вселенная</th>
                <th data-hint="Пусто — первые свободные адреса после уже занятых">С адреса</th>
                <th data-hint="Если приборов меньше, чем форсунок: насосы и свет — каждому своя часть фигуры подряд или через одну; клапаны — через равные промежутки или подряд с Ф1">
                  Делить
                </th>
                <th>Как поделится</th>
              </tr>
            </thead>
            <tbody>
              {FIGURE_ROLES.map(({ role, label, one }) => {
                const d = spec[role];
                const list = profilesOf(role);
                const even = sharesEvenly(n, d.count, role);
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
                        {role === 'valve' ? (
                          <>
                            <option value="alternate">равномерно</option>
                            <option value="blocks">с Ф1 подряд</option>
                          </>
                        ) : (
                          <>
                            <option value="blocks">частями</option>
                            <option value="alternate">чередуя</option>
                          </>
                        )}
                      </select>
                    </td>
                    <td className={even ? 'dim' : 'warn'}>
                      {shareText(role, n, d.count, d.mode, one)}
                      {!even && role !== 'valve' && ' — не делится ровно, проверьте таблицу ниже'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
        <FigurePreview spec={spec} points={points} share={share} plan={plan} extent={extent} />
      </div>

      {activeRoles.length > 0 && (
        <details className="figure-share">
          <summary>
            Раздача и адреса — посмотреть и поправить
            {manual || activeRoles.some((r) => spec[r.role].fixed) ? ' (поправлено)' : ''}
          </summary>
          {manual && (
            <div className="form-row">
              <span className="warn">Раздача поправлена вручную.</span>
              <button className="btn btn-small" onClick={() => setManual(null)}>
                Вернуть автоматическую
              </button>
            </div>
          )}
          <div className="figure-share-tables">
            <table className="table figure-share-table">
              <thead>
                <tr>
                  <th>Форсунка</th>
                  {activeRoles.map((r) => (
                    <th key={r.role}>{r.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {points.map((_, i) => (
                  <tr key={i}>
                    <td className="dim">Ф{i + 1}</td>
                    {activeRoles.map(({ role, one }) => {
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
                                  {one} {j + 1} · {addrText(plan.byRole[role][j], plan.span[role])}
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
            <DeviceAddresses spec={spec} plan={plan} share={share} n={points.length} onFix={setFixed} />
          </div>
        </details>
      )}

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
 * Адрес каждого прибора фигуры — и поправить руками (заказчик 24.09.2026:
 * «показывать адреса каждого насоса, клапана и светильника, с возможностью
 * поменять»). Поправленный адрес остаётся, остальные раздаются в обход него.
 */
function DeviceAddresses({
  spec,
  plan,
  share,
  n,
  onFix,
}: {
  spec: FigureSpec;
  plan: FigurePlan;
  share: FigureShare;
  n: number;
  onFix: (role: FigureRole, i: number, address: number | null) => void;
}) {
  return (
    <table className="table figure-share-table">
      <thead>
        <tr>
          <th>Прибор</th>
          <th data-hint="Адрес первого канала прибора. Поменяйте — остальные приборы фигуры раздадутся в обход него">Адрес</th>
          <th>Форсунки</th>
        </tr>
      </thead>
      <tbody>
        {FIGURE_ROLES.filter((r) => spec[r.role].count > 0).map(({ role, one }) =>
          Array.from({ length: spec[role].count }, (_, j) => {
            const dev = plan.byRole[role][j];
            const fixed = spec[role].fixed?.[j];
            const where = Array.from({ length: n }, (_, i) => i).filter((i) => share[role][i]?.includes(j));
            const span = plan.span[role];
            return (
              <tr key={`${role}-${j}`}>
                <td>
                  {one} {j + 1}
                </td>
                <td className="cell-actions">
                  <NumInput
                    integer
                    min={1}
                    max={512}
                    value={fixed ?? dev?.address ?? 1}
                    onChange={(v) => onFix(role, j, v)}
                  />
                  {span > 1 && dev && <span className="dim"> –{dev.address + span - 1}</span>}
                  {fixed !== undefined && (
                    <>
                      {' '}
                      <button className="link-btn" data-hint="Вернуть адрес, который программа выбрала сама" onClick={() => onFix(role, j, null)}>
                        авто
                      </button>
                    </>
                  )}
                </td>
                <td className={where.length === 0 ? 'warn' : 'dim'}>
                  {where.length === 0 ? 'ни одной' : where.map((i) => `Ф${i + 1}`).join(', ')}
                </td>
              </tr>
            );
          }),
        )}
      </tbody>
    </table>
  );
}

/**
 * Вид сверху: где встанут форсунки и что у каждой. Обводка — насос (свой
 * цвет у каждого), заливка — светильник (свой оттенок), квадратик снаружи —
 * клапан. Подписи Ф1 и Ф2 показывают, откуда и куда идёт нумерация.
 */
function FigurePreview({
  spec,
  points,
  share,
  plan,
  extent,
}: {
  spec: FigureSpec;
  points: { x: number; y: number }[];
  share: FigureShare;
  plan: FigurePlan;
  extent: { x: number; y: number };
}) {
  const size = 240;
  // Поле по краю — под подписи Ф1/Ф2 и значок осей в углу, чтобы он не
  // ложился на угловую форсунку.
  const pad = 34;
  const { cx, cy } = spec;
  const outline = spec.shape === 'ring' ? [] : figureOutline(spec);
  const ringRadius = spec.shape === 'ring' && points.length > 1 ? spec.dims.radius : 0;
  const span = Math.max(0.5, ringRadius, ...[...points, ...outline].map((p) => Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy))));
  const scale = (size / 2 - pad) / span;
  // Y схемы — вверх, у SVG — вниз.
  const px = (x: number): number => size / 2 + (x - cx) * scale;
  const py = (y: number): number => size / 2 - (y - cy) * scale;
  // Кружок — от расстояния между ближайшими форсунками: при 30+ форсунках на
  // треугольнике кружки больше не налезают друг на друга.
  const minGap = useMemo(() => {
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        best = Math.min(best, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y));
      }
    }
    return best;
  }, [points]);
  const r = Math.max(1.6, Math.min(7, Number.isFinite(minGap) ? minGap * scale * 0.32 : 7));
  const valveSize = Math.max(2.5, r * 0.8);
  const hasPump = spec.pump.count > 0;
  const hasValve = spec.valve.count > 0;
  const hasLight = spec.light.count > 0;

  /** Смещение наружу от центра фигуры на d пикселей (у точки в центре — вправо). */
  const outward = (p: { x: number; y: number }, d: number): { x: number; y: number } => {
    const len = Math.hypot(p.x - cx, p.y - cy);
    if (len < 1e-6) return { x: px(p.x) + d, y: py(p.y) };
    return { x: px(p.x) + ((p.x - cx) / len) * d, y: py(p.y) - ((p.y - cy) / len) * d };
  };
  const tip = (i: number): string =>
    [
      `Ф${i + 1}`,
      ...FIGURE_ROLES.flatMap(({ role, one }) =>
        spec[role].count > 0
          ? (share[role][i] ?? []).length === 0
            ? [`${one}: нет`]
            : (share[role][i] ?? []).map((j) => `${one} ${j + 1} · ${addrText(plan.byRole[role][j], plan.span[role])}`)
          : [],
      ),
    ].join('\n');

  /*
   * Подписи Ф1 и Ф2 — снаружи фигуры, поперёк её стороны (по перпендикуляру
   * к хорде между соседями). По лучу из центра не годится: у вершины
   * треугольника из 33 форсунок Ф1 и Ф2 лежат почти на одном луче, и подписи
   * слипались в «ФФ2». Сошлись бы всё равно — Ф2 отодвигается дальше.
   */
  const labelGap = r + (hasValve ? valveSize + 4 : 0) + 9;
  const labelAt = (i: number, d: number): { x: number; y: number } => {
    const p = points[i]!;
    const a = points[(i - 1 + points.length) % points.length]!;
    const b = points[(i + 1) % points.length]!;
    // В координатах экрана (y вниз).
    const tx = px(b.x) - px(a.x);
    const ty = py(b.y) - py(a.y);
    const len = Math.hypot(tx, ty);
    if (len < 1e-6) return outward(p, d);
    let nx = ty / len;
    let ny = -tx / len;
    if (nx * (px(p.x) - px(cx)) + ny * (py(p.y) - py(cy)) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: px(p.x) + nx * d, y: py(p.y) + ny * d };
  };
  const labels: { text: string; x: number; y: number }[] = [];
  if (points.length > 1) {
    const l1 = labelAt(0, labelGap);
    let l2 = labelAt(1, labelGap);
    if (Math.hypot(l2.x - l1.x, l2.y - l1.y) < 22) l2 = labelAt(1, labelGap + 13);
    labels.push({ text: 'Ф1', x: l1.x, y: l1.y + 3.5 }, { text: 'Ф2', x: l2.x, y: l2.y + 3.5 });
  }

  return (
    <figure className="figure-preview">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Вид сверху">
        <line x1={size / 2 - 5} y1={size / 2} x2={size / 2 + 5} y2={size / 2} className="figure-preview-center" />
        <line x1={size / 2} y1={size / 2 - 5} x2={size / 2} y2={size / 2 + 5} className="figure-preview-center" />
        {/* Оси — как в 3D: X красная вправо, Y зелёная вверх. «Сверху» у фигуры — это +Y. */}
        <g className="figure-preview-axes">
          <line x1={7} y1={size - 7} x2={21} y2={size - 7} className="axis-x" />
          <line x1={7} y1={size - 7} x2={7} y2={size - 21} className="axis-y" />
          <text x={23} y={size - 4} className="axis-x-label">X</text>
          <text x={4} y={size - 23} className="axis-y-label">Y</text>
        </g>
        {outline.length > 1 && (
          <polygon points={outline.map((p) => `${px(p.x)},${py(p.y)}`).join(' ')} className="figure-preview-outline" />
        )}
        {ringRadius > 0 && <circle cx={px(cx)} cy={py(cy)} r={ringRadius * scale} className="figure-preview-outline" />}
        {points.map((p, i) => {
          const pump = share.pump[i]?.[0];
          const light = share.light[i]?.[0];
          const valve = (share.valve[i] ?? []).length > 0;
          const stroke = pump === undefined ? 'var(--fg-dim)' : PUMP_COLORS[pump % PUMP_COLORS.length];
          const fill = light === undefined ? 'var(--bg-panel)' : lightColor(light, spec.light.count);
          const v = outward(p, r + 2 + valveSize / 2);
          return (
            <g key={i}>
              <title>{tip(i)}</title>
              <circle
                cx={px(p.x)}
                cy={py(p.y)}
                r={r}
                fill={fill}
                stroke={stroke}
                strokeWidth={Math.max(1, Math.min(2, r * 0.35))}
                strokeDasharray={pump === undefined && hasPump ? '2 1.5' : undefined}
              />
              {valve && (
                <rect x={v.x - valveSize / 2} y={v.y - valveSize / 2} width={valveSize} height={valveSize} className="figure-preview-valve" />
              )}
            </g>
          );
        })}
        {labels.map((l) => (
          <text key={l.text} x={l.x} y={l.y} className="figure-preview-label" textAnchor="middle">
            {l.text}
          </text>
        ))}
      </svg>
      <figcaption className="figure-preview-caption">
        <span className="dim">
          Вид сверху. {points.length > 1 ? `Ф1 → Ф2 — ${spec.clockwise ? 'по часовой' : 'против часовой'}.` : 'Форсунка в центре.'}
        </span>
        {/* Кольцо — диаметр: по нему сразу видно, что радиус 3 м дал кольцо в 6 м. */}
        {points.length > 1 &&
          (ringRadius > 0 ? (
            <span className="dim" data-hint="Диаметр кольца — дважды радиус: от форсунки до противоположной через центр">
              Диаметр: {metersText(2 * ringRadius)} м
            </span>
          ) : (
            <span className="dim" data-hint="Сколько места займёт фигура по осям X и Y — от крайней форсунки до крайней">
              Размах: {metersText(extent.x)} × {metersText(extent.y)} м
            </span>
          ))}
        {(hasPump || hasValve || hasLight) && (
          <span className="figure-legend">
            {hasPump && (
              <span>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <circle cx="6" cy="6" r="4.2" fill="none" stroke={PUMP_COLORS[0]} strokeWidth="2" />
                </svg>
                насос
              </span>
            )}
            {hasLight && (
              <span>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <circle cx="6" cy="6" r="5" fill={lightColor(0, 3)} />
                </svg>
                свет
              </span>
            )}
            {hasValve && (
              <span>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect x="2.5" y="2.5" width="7" height="7" className="figure-preview-valve" />
                </svg>
                клапан
              </span>
            )}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
