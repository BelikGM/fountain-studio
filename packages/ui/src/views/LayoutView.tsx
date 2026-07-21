import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NOZZLE_KINDS,
  insunitsToMeters,
  layoutFromDxf,
  nozzleDefaults,
  nozzleGroupCentroid,
  parseDxf,
  profileMap,
  ringPositions,
  rotateNozzleGroup,
  translateNozzleGroup,
  uid,
  type Bowl,
  type DxfDrawing,
  type DxfLayerRole,
  type FountainLayout,
  type LayoutLight,
  type Nozzle,
  type NozzleGroup,
  type NozzleKind,
  type Project,
} from '@fountain-studio/shared';
import { clipboardHasKind, copyToClipboard, pasteFromClipboard } from '../clipboard';
import { PencilIcon, TrashIcon } from '../components/Icons';
import { comboFromEvent, getCombo } from '../hotkeys';
import type { EngineConnection } from '../useEngine';
import { FountainScene, type SelectedElement } from '../three/FountainScene';
import { buildDeviceIndex, createLiveHooks } from '../three/liveHooks';

type Selected = { type: 'nozzle' | 'light' | 'bowl' | 'group'; id: string } | null;

/** Вкладка «3D»: схема фонтана, живая визуализация струй и света, импорт DXF. */
export function LayoutView({ engine }: { engine: EngineConnection }) {
  const { project, frames, updateProject } = engine;
  const [selected, setSelected] = useState<Selected>(null);

  // Данные для живого кадра сцены — через ref, чтобы rAF-цикл видел свежие
  // кадры без пересоздания сцены.
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const deviceIndex = useMemo(() => (project ? buildDeviceIndex(project) : new Map()), [project]);
  const deviceIndexRef = useRef(deviceIndex);
  deviceIndexRef.current = deviceIndex;

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FountainScene | null>(null);
  const hooksRef = useRef({
    onSelect: (sel: SelectedElement) => setSelected(sel),
    onMoveEnd: (type: 'nozzle' | 'light', id: string, x: number, y: number) => {
      moveElementRef.current(type, id, x, y);
    },
  });

  const moveElementRef = useRef((_t: 'nozzle' | 'light', _id: string, _x: number, _y: number) => {});
  moveElementRef.current = (type, id, x, y) => {
    if (!project) return;
    const layout = project.layout;
    const next: FountainLayout =
      type === 'nozzle'
        ? { ...layout, nozzles: layout.nozzles.map((n) => (n.id === id ? { ...n, x, y } : n)) }
        : { ...layout, lights: layout.lights.map((l) => (l.id === id ? { ...l, x, y } : l)) };
    updateProject({ ...project, layout: next });
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const scene = new FountainScene(containerRef.current, {
      onSelect: (sel) => hooksRef.current.onSelect(sel),
      onMove: () => {},
      onMoveEnd: (t, id, x, y) => hooksRef.current.onMoveEnd(t, id, x, y),
      live: createLiveHooks(deviceIndexRef, framesRef),
    });
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      scene.dispose();
    };
  }, []);

  useEffect(() => {
    if (project) sceneRef.current?.syncLayout(project.layout);
  }, [project?.layout]);

  useEffect(() => {
    sceneRef.current?.setSelected(
      selected && (selected.type === 'nozzle' || selected.type === 'light')
        ? { type: selected.type, id: selected.id }
        : null,
    );
  }, [selected]);

  // Горячие клавиши редактора на выбранном элементе (§27 доработки, УХ п.6,
  // копирование — п.13): дублировать/удалить/снять выделение/сдвинуть
  // стрелками/копировать/вставить. Тот же эффект, что и одноимённые кнопки в
  // панели свойств справа — просто с клавиатуры. Paste не требует выделения
  // (можно вставить, когда ничего не выбрано), остальные действия — требуют.
  const NUDGE_STEP = 0.1;
  useEffect(() => {
    if (!project) return;
    const layout = project.layout;
    const pasteClipboard = (): void => {
      if (clipboardHasKind('nozzle')) {
        const n = pasteFromClipboard<Nozzle>('nozzle');
        if (!n) return;
        const copy: Nozzle = { ...n, id: uid(), name: `${n.name} коп`, x: n.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, nozzles: [...layout.nozzles, copy] } });
        setSelected({ type: 'nozzle', id: copy.id });
      } else if (clipboardHasKind('light')) {
        const l = pasteFromClipboard<LayoutLight>('light');
        if (!l) return;
        const copy: LayoutLight = { ...l, id: uid(), name: `${l.name} коп`, x: l.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, lights: [...layout.lights, copy] } });
        setSelected({ type: 'light', id: copy.id });
      } else if (clipboardHasKind('bowl')) {
        const b = pasteFromClipboard<Bowl>('bowl');
        if (!b) return;
        const copy: Bowl = { ...b, id: uid(), name: `${b.name} коп`, x: b.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, bowls: [...layout.bowls, copy] } });
        setSelected({ type: 'bowl', id: copy.id });
      }
    };
    if (!selected) {
      const onKeyIdle = (e: KeyboardEvent): void => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (comboFromEvent(e) === getCombo('paste')) {
          e.preventDefault();
          pasteClipboard();
        }
      };
      window.addEventListener('keydown', onKeyIdle);
      return () => window.removeEventListener('keydown', onKeyIdle);
    }
    const copySelected = (): void => {
      if (selected.type === 'nozzle') {
        const n = layout.nozzles.find((x) => x.id === selected.id);
        if (n) copyToClipboard('nozzle', n);
      } else if (selected.type === 'light') {
        const l = layout.lights.find((x) => x.id === selected.id);
        if (l) copyToClipboard('light', l);
      } else {
        const b = layout.bowls.find((x) => x.id === selected.id);
        if (b) copyToClipboard('bowl', b);
      }
    };
    const duplicateSelected = (): void => {
      if (selected.type === 'nozzle') {
        const n = layout.nozzles.find((x) => x.id === selected.id);
        if (!n) return;
        const copy: Nozzle = { ...n, id: uid(), name: `${n.name} коп`, x: n.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, nozzles: [...layout.nozzles, copy] } });
        setSelected({ type: 'nozzle', id: copy.id });
      } else if (selected.type === 'light') {
        const l = layout.lights.find((x) => x.id === selected.id);
        if (!l) return;
        const copy: LayoutLight = { ...l, id: uid(), name: `${l.name} коп`, x: l.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, lights: [...layout.lights, copy] } });
        setSelected({ type: 'light', id: copy.id });
      } else {
        const b = layout.bowls.find((x) => x.id === selected.id);
        if (!b) return;
        const copy: Bowl = { ...b, id: uid(), name: `${b.name} коп`, x: b.x + 0.5 };
        updateProject({ ...project, layout: { ...layout, bowls: [...layout.bowls, copy] } });
        setSelected({ type: 'bowl', id: copy.id });
      }
    };
    const deleteSelected = (): void => {
      const next: FountainLayout =
        selected.type === 'nozzle'
          ? { ...layout, nozzles: layout.nozzles.filter((n) => n.id !== selected.id) }
          : selected.type === 'light'
            ? { ...layout, lights: layout.lights.filter((l) => l.id !== selected.id) }
            : { ...layout, bowls: layout.bowls.filter((b) => b.id !== selected.id) };
      updateProject({ ...project, layout: next });
      setSelected(null);
    };
    const nudge = (dx: number, dy: number): void => {
      const next: FountainLayout =
        selected.type === 'nozzle'
          ? { ...layout, nozzles: layout.nozzles.map((n) => (n.id === selected.id ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }
          : selected.type === 'light'
            ? { ...layout, lights: layout.lights.map((l) => (l.id === selected.id ? { ...l, x: l.x + dx, y: l.y + dy } : l)) }
            : { ...layout, bowls: layout.bowls.map((b) => (b.id === selected.id ? { ...b, x: b.x + dx, y: b.y + dy } : b)) };
      updateProject({ ...project, layout: next });
    };
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const combo = comboFromEvent(e);
      if (combo === getCombo('copy')) {
        e.preventDefault();
        copySelected();
      } else if (combo === getCombo('paste')) {
        e.preventDefault();
        pasteClipboard();
      } else if (combo === getCombo('duplicate')) {
        e.preventDefault();
        duplicateSelected();
      } else if (combo === getCombo('delete')) {
        if (e.repeat) return;
        e.preventDefault();
        deleteSelected();
      } else if (combo === getCombo('deselect')) {
        e.preventDefault();
        setSelected(null);
      } else if (combo === getCombo('nudgeUp')) {
        e.preventDefault();
        nudge(0, NUDGE_STEP);
      } else if (combo === getCombo('nudgeDown')) {
        e.preventDefault();
        nudge(0, -NUDGE_STEP);
      } else if (combo === getCombo('nudgeLeft')) {
        e.preventDefault();
        nudge(-NUDGE_STEP, 0);
      } else if (combo === getCombo('nudgeRight')) {
        e.preventDefault();
        nudge(NUDGE_STEP, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, selected, updateProject]);

  if (!project) return <main className="view">Ожидание проекта от движка…</main>;
  const layout = project.layout;
  const setLayout = (next: FountainLayout): void => updateProject({ ...project, layout: next });

  return (
    <main className="view view-split">
      <aside className="sidebar">
        <ElementList layout={layout} selected={selected} onSelect={setSelected} setLayout={setLayout} />
        <AddTools project={project} setLayout={setLayout} onSelect={setSelected} />
        <BindTools project={project} setLayout={setLayout} />
        <DxfImport project={project} setLayout={setLayout} />
      </aside>
      <div className="content content-3d">
        <div className="canvas3d" ref={containerRef} />
        <button
          className="btn btn-small canvas3d-reset"
          title="Вернуть камеру к исходному положению"
          onClick={() => sceneRef.current?.resetCamera()}
        >
          ⟲ Камера
        </button>
        <div className="canvas3d-hint dim">
          ЛКМ по элементу — выбрать и тащить · ЛКМ по пустому — вращение · колесо — зум · ПКМ — панорама
        </div>
      </div>
      <aside className="sidebar sidebar-props">
        {selected?.type === 'nozzle' && (
          <NozzleProps
            project={project}
            nozzle={layout.nozzles.find((n) => n.id === selected.id)}
            setLayout={setLayout}
            onSelect={setSelected}
          />
        )}
        {selected?.type === 'light' && (
          <LightProps
            project={project}
            light={layout.lights.find((l) => l.id === selected.id)}
            setLayout={setLayout}
            onSelect={setSelected}
          />
        )}
        {selected?.type === 'bowl' && (
          <BowlProps
            bowl={layout.bowls.find((b) => b.id === selected.id)}
            layout={layout}
            setLayout={setLayout}
            onSelect={setSelected}
          />
        )}
        {selected?.type === 'group' && (
          <GroupProps
            group={layout.nozzleGroups.find((g) => g.id === selected.id)}
            layout={layout}
            setLayout={setLayout}
            onSelect={setSelected}
          />
        )}
        {!selected && (
          <section className="panel">
            <h2>3D-схема</h2>
            <p className="dim">
              Выберите элемент в списке или кликните по нему в 3D. Струи и свет оживают от текущих
              DMX-кадров движка — включите сцену, секвенсор или шоу.
            </p>
          </section>
        )}
      </aside>
    </main>
  );
}

// ---------- Список элементов ----------

function ElementList({
  layout,
  selected,
  onSelect,
  setLayout,
}: {
  layout: FountainLayout;
  selected: Selected;
  onSelect: (s: Selected) => void;
  setLayout: (l: FountainLayout) => void;
}) {
  const item = (type: 'nozzle' | 'light' | 'bowl' | 'group', id: string, label: string) => (
    <li
      key={id}
      className={selected?.type === type && selected.id === id ? 'list-item selected' : 'list-item'}
      onClick={() => onSelect({ type, id })}
    >
      {label}
    </li>
  );
  // Контуры (§27 доработки, по примеру прежнего приложения) — именованная
  // группа форсунок как живой объект, не разовый штамп: можно вернуться и
  // разом повернуть/сдвинуть/перекрасить весь набор (см. GroupProps).
  const addGroup = (): void => {
    const g: NozzleGroup = { id: uid(), name: `Контур ${layout.nozzleGroups.length + 1}`, nozzleIds: [] };
    setLayout({ ...layout, nozzleGroups: [...layout.nozzleGroups, g] });
    onSelect({ type: 'group', id: g.id });
  };
  return (
    <section className="panel">
      <h2>Схема</h2>
      <h3>Форсунки ({layout.nozzles.length})</h3>
      <ul className="list">{layout.nozzles.map((n) => item('nozzle', n.id, n.name))}</ul>
      <h3>Прожекторы ({layout.lights.length})</h3>
      <ul className="list">{layout.lights.map((l) => item('light', l.id, l.name))}</ul>
      <h3>Чаши ({layout.bowls.length})</h3>
      <ul className="list">{layout.bowls.map((b) => item('bowl', b.id, b.name))}</ul>
      <h3>Контуры ({layout.nozzleGroups.length})</h3>
      <ul className="list">{layout.nozzleGroups.map((g) => item('group', g.id, g.name))}</ul>
      <button className="btn btn-small" onClick={addGroup}>
        + Контур
      </button>
    </section>
  );
}

// ---------- Добавление ----------

let addCursor = 0;

function AddTools({
  project,
  setLayout,
  onSelect,
}: {
  project: Project;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
}) {
  const layout = project.layout;
  const [ringCount, setRingCount] = useState(8);
  const [ringRadius, setRingRadius] = useState(3);
  const [ringKind, setRingKind] = useState<NozzleKind>('straight');

  const newNozzle = (kind: NozzleKind, x: number, y: number, name: string): Nozzle => ({
    id: uid(),
    name,
    kind,
    x,
    y,
    z: 0,
    tiltDeg: 0,
    headingDeg: 0,
    ...nozzleDefaults(kind),
    pumpDeviceId: null,
    pump2DeviceId: null,
    valveDeviceId: null,
    valveFollowsPump: false,
    lightDeviceId: null,
  });

  const addNozzle = (): void => {
    const spot = (addCursor++ % 9) - 4;
    const n = newNozzle('straight', spot, 0, `Ф${layout.nozzles.length + 1}`);
    setLayout({ ...layout, nozzles: [...layout.nozzles, n] });
    onSelect({ type: 'nozzle', id: n.id });
  };
  const addLight = (): void => {
    const spot = (addCursor++ % 9) - 4;
    const l: LayoutLight = { id: uid(), name: `П${layout.lights.length + 1}`, x: spot, y: -0.5, z: -0.1, deviceId: null };
    setLayout({ ...layout, lights: [...layout.lights, l] });
    onSelect({ type: 'light', id: l.id });
  };
  const addBowl = (): void => {
    const b: Bowl = {
      id: uid(),
      name: `Чаша ${layout.bowls.length + 1}`,
      shape: 'circle',
      x: 0,
      y: 0,
      radius: 5,
      width: 10,
      length: 6,
      height: 0.3,
    };
    setLayout({ ...layout, bowls: [...layout.bowls, b] });
    onSelect({ type: 'bowl', id: b.id });
  };
  const addRing = (): void => {
    const base = layout.nozzles.length;
    const nozzles = ringPositions(ringCount, ringRadius).map((p, i) =>
      newNozzle(ringKind, Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, `Ф${base + i + 1}`),
    );
    setLayout({ ...layout, nozzles: [...layout.nozzles, ...nozzles] });
  };

  return (
    <section className="panel">
      <h2>Добавить</h2>
      <div className="sidebar-actions">
        <button className="btn btn-small" onClick={addNozzle}>+ Форсунка</button>
        <button className="btn btn-small" onClick={addLight}>+ Прожектор</button>
        <button className="btn btn-small" onClick={addBowl}>+ Чаша</button>
      </div>
      <h3>Кольцо форсунок</h3>
      <div className="field-grid">
        <label className="field">
          Штук:{' '}
          <input
            className="input input-num"
            type="number"
            min={2}
            max={128}
            value={ringCount}
            onChange={(e) => setRingCount(Math.max(2, Math.min(128, Math.round(Number(e.target.value) || 2))))}
          />
        </label>
        <label className="field">
          Радиус, м:{' '}
          <input
            className="input input-num"
            type="number"
            step={0.5}
            min={0.5}
            value={ringRadius}
            onChange={(e) => setRingRadius(Math.max(0.1, Number(e.target.value) || 3))}
          />
        </label>
        <label className="field">
          Тип:{' '}
          <select className="input" value={ringKind} onChange={(e) => setRingKind(e.target.value as NozzleKind)}>
            {NOZZLE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn btn-small" onClick={addRing}>Расставить кольцо</button>
    </section>
  );
}

// ---------- Массовая привязка к патчу ----------

function BindTools({ project, setLayout }: { project: Project; setLayout: (l: FountainLayout) => void }) {
  const layout = project.layout;
  const profiles = profileMap(project);
  const devicesOfKind = (kind: string): typeof project.devices =>
    project.devices
      .filter((d) => profiles.get(d.profileId)?.kind === kind)
      .sort((a, b) => a.universe - b.universe || a.address - b.address);

  const bind = (field: 'pumpDeviceId' | 'valveDeviceId' | 'lightDeviceId', kind: string): void => {
    const used = new Set(layout.nozzles.map((n) => n[field]).filter(Boolean));
    const avail = devicesOfKind(kind).filter((d) => !used.has(d.id));
    let i = 0;
    setLayout({
      ...layout,
      nozzles: layout.nozzles.map((n) => (n[field] === null && i < avail.length ? { ...n, [field]: avail[i++]!.id } : n)),
    });
  };

  return (
    <section className="panel">
      <h2>Привязка к приборам</h2>
      <p className="dim">Свободные форсунки получают свободные устройства в порядке адресов.</p>
      <div className="sidebar-actions">
        <button className="btn btn-small" onClick={() => bind('pumpDeviceId', 'pump')}>Насосы подряд</button>
        <button className="btn btn-small" onClick={() => bind('valveDeviceId', 'valve')}>Клапаны подряд</button>
        <button className="btn btn-small" onClick={() => bind('lightDeviceId', 'lamp')}>Свет подряд</button>
      </div>
    </section>
  );
}

// ---------- Импорт DXF ----------

interface DxfState {
  fileName: string;
  drawing: DxfDrawing;
  roles: Record<string, DxfLayerRole>;
  scale: number;
  center: boolean;
}

/** Догадка о роли слоя по имени (пользователь всегда может поменять). */
function guessRole(layer: string): DxfLayerRole {
  if (/свет|light|lamp|прожект|led/i.test(layer)) return 'light';
  if (/чаш|bowl|борт|контур|basin|pool/i.test(layer)) return 'bowl';
  if (/форсун|nozzle|jet|насос|pump|фонтан/i.test(layer)) return 'nozzle';
  return 'skip';
}

const ROLE_OPTIONS: { id: DxfLayerRole; label: string }[] = [
  { id: 'skip', label: '— пропустить' },
  { id: 'nozzle', label: 'Форсунки' },
  { id: 'light', label: 'Прожекторы' },
  { id: 'bowl', label: 'Чаши' },
];

function DxfImport({ project, setLayout }: { project: Project; setLayout: (l: FountainLayout) => void }) {
  const [state, setState] = useState<DxfState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File): Promise<void> => {
    setError(null);
    try {
      const drawing = parseDxf(await file.text());
      if (drawing.points.length === 0 && drawing.polylines.length === 0) {
        setError('В файле не найдено сущностей (нужен ASCII DXF; DWG сконвертируйте в DXF).');
        return;
      }
      const roles: Record<string, DxfLayerRole> = {};
      for (const layer of drawing.layers) roles[layer] = guessRole(layer);
      setState({
        fileName: file.name,
        drawing,
        roles,
        scale: insunitsToMeters(drawing.insunits),
        center: true,
      });
    } catch {
      setError('Не удалось разобрать файл как DXF.');
    }
  };

  const doImport = (): void => {
    if (!state) return;
    const res = layoutFromDxf(state.drawing, {
      unitScale: state.scale,
      layerRoles: state.roles,
      center: state.center,
    });
    const layout = project.layout;
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const baseN = layout.nozzles.length;
    const baseL = layout.lights.length;
    const def = nozzleDefaults('straight');
    setLayout({
      bowls: [...layout.bowls, ...res.bowls.map((b) => ({ ...b, id: uid(), x: r2(b.x), y: r2(b.y), radius: r2(b.radius), width: r2(b.width), length: r2(b.length) }))],
      nozzles: [
        ...layout.nozzles,
        ...res.nozzles.map((p, i) => ({
          id: uid(),
          name: `Ф${baseN + i + 1}`,
          kind: 'straight' as NozzleKind,
          x: r2(p.x),
          y: r2(p.y),
          z: 0,
          tiltDeg: 0,
          headingDeg: 0,
          ...def,
          pumpDeviceId: null,
          pump2DeviceId: null,
          valveDeviceId: null,
          valveFollowsPump: false,
          lightDeviceId: null,
        })),
      ],
      lights: [
        ...layout.lights,
        ...res.lights.map((p, i) => ({ id: uid(), name: `П${baseL + i + 1}`, x: r2(p.x), y: r2(p.y), z: -0.1, deviceId: null })),
      ],
      nozzleGroups: layout.nozzleGroups,
    });
    setState(null);
  };

  const layerStats = (layer: string): string => {
    if (!state) return '';
    const pts = state.drawing.points.filter((p) => p.layer === layer).length;
    const pls = state.drawing.polylines.filter((p) => p.layer === layer).length;
    return [pts > 0 ? `${pts} тчк` : '', pls > 0 ? `${pls} конт` : ''].filter(Boolean).join(', ');
  };

  return (
    <section className="panel">
      <h2>Импорт DXF</h2>
      <p className="dim">Чертёж AutoCAD (DWG сначала сохраните как DXF). Точки, окружности и блоки станут элементами схемы.</p>
      <input
        ref={fileRef}
        type="file"
        accept=".dxf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = '';
        }}
      />
      <button className="btn btn-small" onClick={() => fileRef.current?.click()}>Открыть DXF…</button>
      {error && <p className="error-text">{error}</p>}
      {state && (
        <>
          <h3>{state.fileName}</h3>
          {state.drawing.layers.map((layer) => (
            <label key={layer} className="field">
              {layer} <span className="dim">({layerStats(layer)})</span>{' '}
              <select
                className="input"
                value={state.roles[layer]}
                onChange={(e) => setState({ ...state, roles: { ...state.roles, [layer]: e.target.value as DxfLayerRole } })}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
          ))}
          <label className="field">
            Масштаб (ед. чертежа → м):{' '}
            <input
              className="input input-num"
              type="number"
              step={0.001}
              value={state.scale}
              onChange={(e) => setState({ ...state, scale: Number(e.target.value) || 1 })}
            />
          </label>
          <label className="field">
            <input
              type="checkbox"
              checked={state.center}
              onChange={(e) => setState({ ...state, center: e.target.checked })}
            />{' '}
            Центрировать схему
          </label>
          <div className="sidebar-actions">
            <button className="btn btn-small" onClick={doImport}>Импортировать</button>
            <button className="btn btn-small" onClick={() => setState(null)}>Отмена</button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------- Свойства элементов ----------

function NumField({
  label,
  value,
  step = 0.1,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      {label}:{' '}
      <input
        className="input input-num"
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </label>
  );
}

function DeviceSelect({
  project,
  kind,
  value,
  onChange,
}: {
  project: Project;
  kind: 'pump' | 'valve' | 'lamp';
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const profiles = profileMap(project);
  const options = project.devices
    .filter((d) => profiles.get(d.profileId)?.kind === kind)
    .sort((a, b) => a.universe - b.universe || a.address - b.address);
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>
      <option value="">— не привязан</option>
      {options.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name} (U{d.universe}:{d.address})
        </option>
      ))}
    </select>
  );
}

function NozzleProps({
  project,
  nozzle,
  setLayout,
  onSelect,
}: {
  project: Project;
  nozzle: Nozzle | undefined;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
}) {
  if (!nozzle) return null;
  const layout = project.layout;
  const patch = (p: Partial<Nozzle>): void =>
    setLayout({ ...layout, nozzles: layout.nozzles.map((n) => (n.id === nozzle.id ? { ...n, ...p } : n)) });
  const duplicate = (): void => {
    const copy: Nozzle = { ...nozzle, id: uid(), name: `${nozzle.name} коп`, x: nozzle.x + 0.5 };
    setLayout({ ...layout, nozzles: [...layout.nozzles, copy] });
    onSelect({ type: 'nozzle', id: copy.id });
  };
  const remove = (): void => {
    setLayout({ ...layout, nozzles: layout.nozzles.filter((n) => n.id !== nozzle.id) });
    onSelect(null);
  };
  return (
    <section className="panel">
      <h2>Форсунка</h2>
      <div className="field-grid">
        <label className="field">
          Имя: <input className="input" value={nozzle.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="field">
          Тип:{' '}
          <select
            className="input"
            value={nozzle.kind}
            onChange={(e) => {
              const kind = e.target.value as NozzleKind;
              patch({ kind, ...nozzleDefaults(kind) });
            }}
          >
            {NOZZLE_KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
        </label>
        <NumField label="X, м" value={nozzle.x} onChange={(x) => patch({ x })} />
        <NumField label="Y, м" value={nozzle.y} onChange={(y) => patch({ y })} />
        <NumField label="Высота сопла, м" value={nozzle.z} onChange={(z) => patch({ z })} />
        <NumField label="Наклон, °" value={nozzle.tiltDeg} step={1} onChange={(v) => patch({ tiltDeg: Math.max(0, Math.min(85, v)) })} />
        <NumField label="Азимут, °" value={nozzle.headingDeg} step={5} onChange={(v) => patch({ headingDeg: ((v % 360) + 360) % 360 })} />
        <NumField label="Высота струи, м" value={nozzle.maxHeightM} step={0.5} onChange={(v) => patch({ maxHeightM: Math.max(0.1, v) })} />
        <NumField label="Диаметр струи, м" value={nozzle.widthM} step={0.01} onChange={(v) => patch({ widthM: Math.max(0.005, v) })} />
        {nozzle.kind === 'variable' && (
          <NumField
            label="Угол раскрытия конуса, °"
            value={nozzle.coneAngleDeg}
            step={1}
            onChange={(v) => patch({ coneAngleDeg: Math.max(1, Math.min(90, v)) })}
          />
        )}
        {nozzle.kind === 'rotating' && (
          <NumField
            label="Скорость вращения, °/с"
            value={nozzle.rotationSpeedDegPerSec}
            step={10}
            onChange={(v) => patch({ rotationSpeedDegPerSec: v })}
          />
        )}
        <NumField label="Разгон, мс" value={nozzle.riseMs} step={100} onChange={(v) => patch({ riseMs: Math.max(0, Math.round(v)) })} />
        <NumField label="Спад, мс" value={nozzle.fallMs} step={100} onChange={(v) => patch({ fallMs: Math.max(0, Math.round(v)) })} />
        <h3>Привязка</h3>
        <label className="field">
          Насос: <DeviceSelect project={project} kind="pump" value={nozzle.pumpDeviceId} onChange={(id) => patch({ pumpDeviceId: id })} />
        </label>
        {nozzle.kind === 'variable' && (
          <label className="field">
            Насос 2 (раскрытие):{' '}
            <DeviceSelect project={project} kind="pump" value={nozzle.pump2DeviceId} onChange={(id) => patch({ pump2DeviceId: id })} />
          </label>
        )}
        <label className="field">
          Клапан: <DeviceSelect project={project} kind="valve" value={nozzle.valveDeviceId} onChange={(id) => patch({ valveDeviceId: id })} />
        </label>
        {nozzle.pumpDeviceId && nozzle.valveDeviceId && (
          <label
            className="field"
            title="Движок сам держит клапан открытым, пока насос > 0 — не нужно вручную задавать клапан в каждой сцене"
          >
            <input
              type="checkbox"
              checked={nozzle.valveFollowsPump}
              onChange={(e) => patch({ valveFollowsPump: e.target.checked })}
            />{' '}
            Клапан следует за насосом
          </label>
        )}
        <label className="field">
          Подсветка: <DeviceSelect project={project} kind="lamp" value={nozzle.lightDeviceId} onChange={(id) => patch({ lightDeviceId: id })} />
        </label>
      </div>
      <div className="sidebar-actions">
        <button className="btn btn-small" onClick={duplicate}>Дублировать</button>
        <button className="btn btn-small btn-danger" onClick={remove}>Удалить</button>
      </div>
    </section>
  );
}

function LightProps({
  project,
  light,
  setLayout,
  onSelect,
}: {
  project: Project;
  light: LayoutLight | undefined;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
}) {
  if (!light) return null;
  const layout = project.layout;
  const patch = (p: Partial<LayoutLight>): void =>
    setLayout({ ...layout, lights: layout.lights.map((l) => (l.id === light.id ? { ...l, ...p } : l)) });
  return (
    <section className="panel">
      <h2>Прожектор</h2>
      <div className="field-grid">
        <label className="field">
          Имя: <input className="input" value={light.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <NumField label="X, м" value={light.x} onChange={(x) => patch({ x })} />
        <NumField label="Y, м" value={light.y} onChange={(y) => patch({ y })} />
        <NumField label="Z, м" value={light.z} onChange={(z) => patch({ z })} />
        <label className="field">
          Устройство: <DeviceSelect project={project} kind="lamp" value={light.deviceId} onChange={(id) => patch({ deviceId: id })} />
        </label>
      </div>
      <div className="sidebar-actions">
        <button
          className="btn btn-small"
          onClick={() => {
            const copy: LayoutLight = { ...light, id: uid(), name: `${light.name} коп`, x: light.x + 0.5 };
            setLayout({ ...layout, lights: [...layout.lights, copy] });
            onSelect({ type: 'light', id: copy.id });
          }}
        >
          Дублировать
        </button>
        <button
          className="btn btn-small btn-danger"
          onClick={() => {
            setLayout({ ...layout, lights: layout.lights.filter((l) => l.id !== light.id) });
            onSelect(null);
          }}
        >
          Удалить
        </button>
      </div>
    </section>
  );
}

function BowlProps({
  bowl,
  layout,
  setLayout,
  onSelect,
}: {
  bowl: Bowl | undefined;
  layout: FountainLayout;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
}) {
  if (!bowl) return null;
  const patch = (p: Partial<Bowl>): void =>
    setLayout({ ...layout, bowls: layout.bowls.map((b) => (b.id === bowl.id ? { ...b, ...p } : b)) });
  return (
    <section className="panel">
      <h2>Чаша</h2>
      <div className="field-grid">
        <label className="field">
          Имя: <input className="input" value={bowl.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="field">
          Форма:{' '}
          <select className="input" value={bowl.shape} onChange={(e) => patch({ shape: e.target.value as Bowl['shape'] })}>
            <option value="circle">Круглая</option>
            <option value="rect">Прямоугольная</option>
          </select>
        </label>
        <NumField label="X, м" value={bowl.x} onChange={(x) => patch({ x })} />
        <NumField label="Y, м" value={bowl.y} onChange={(y) => patch({ y })} />
        {bowl.shape === 'circle' ? (
          <NumField label="Радиус, м" value={bowl.radius} step={0.5} onChange={(v) => patch({ radius: Math.max(0.1, v) })} />
        ) : (
          <>
            <NumField label="Ширина (X), м" value={bowl.width} step={0.5} onChange={(v) => patch({ width: Math.max(0.1, v) })} />
            <NumField label="Длина (Y), м" value={bowl.length} step={0.5} onChange={(v) => patch({ length: Math.max(0.1, v) })} />
          </>
        )}
        <NumField label="Борт, м" value={bowl.height} step={0.1} onChange={(v) => patch({ height: Math.max(0, v) })} />
      </div>
      <div className="sidebar-actions">
        <button
          className="btn btn-small"
          onClick={() => {
            const copy: Bowl = { ...bowl, id: uid(), name: `${bowl.name} коп`, x: bowl.x + 0.5 };
            setLayout({ ...layout, bowls: [...layout.bowls, copy] });
            onSelect({ type: 'bowl', id: copy.id });
          }}
        >
          Дублировать
        </button>
        <button
          className="btn btn-small btn-danger"
          onClick={() => {
            setLayout({ ...layout, bowls: layout.bowls.filter((b) => b.id !== bowl.id) });
            onSelect(null);
          }}
        >
          Удалить
        </button>
      </div>
    </section>
  );
}

/**
 * Контур (§27 доработки) — панель массового редактирования группы форсунок:
 * общий тип/высота/диаметр, поворот и сдвиг всей группы разом. В отличие от
 * Мастера нового объекта (одноразовый штамп при создании), группа сохраняется
 * и позволяет вернуться к ней позже.
 */
function GroupProps({
  group,
  layout,
  setLayout,
  onSelect,
}: {
  group: NozzleGroup | undefined;
  layout: FountainLayout;
  setLayout: (l: FountainLayout) => void;
  onSelect: (s: Selected) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [bulkKind, setBulkKind] = useState<NozzleKind>('straight');
  const [bulkHeight, setBulkHeight] = useState(3);
  const [bulkWidth, setBulkWidth] = useState(0.03);
  const [rotateBy, setRotateBy] = useState(15);
  const [moveBy, setMoveBy] = useState({ dx: 0, dy: 0 });

  if (!group) return null;
  const patch = (p: Partial<NozzleGroup>): void =>
    setLayout({ ...layout, nozzleGroups: layout.nozzleGroups.map((g) => (g.id === group.id ? { ...g, ...p } : g)) });
  const toggleMember = (nozzleId: string): void => {
    const has = group.nozzleIds.includes(nozzleId);
    patch({ nozzleIds: has ? group.nozzleIds.filter((id) => id !== nozzleId) : [...group.nozzleIds, nozzleId] });
  };
  const centroid = nozzleGroupCentroid(layout.nozzles, group.nozzleIds);

  return (
    <section className="panel">
      <h2>Контур</h2>
      <div className="field-grid">
        <label className="field">
          Имя:{' '}
          {renaming ? (
            <input
              className="input"
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                if (nameDraft.trim()) patch({ name: nameDraft.trim() });
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <span className="input-title">{group.name}</span>
          )}
          <button
            className="icon-btn"
            title="Переименовать"
            onClick={() => {
              setNameDraft(group.name);
              setRenaming(true);
            }}
          >
            <PencilIcon />
          </button>
        </label>
        <span className="dim">
          Участников: {group.nozzleIds.length}, центр: {centroid.x.toFixed(2)}, {centroid.y.toFixed(2)} м
        </span>
      </div>

      <h3>Участники</h3>
      <div className="utility-device-list">
        {layout.nozzles.map((n) => (
          <label key={n.id} className="field">
            <input type="checkbox" checked={group.nozzleIds.includes(n.id)} onChange={() => toggleMember(n.id)} />{' '}
            {n.name}
          </label>
        ))}
      </div>

      <h3>Массовое редактирование</h3>
      <div className="form-row">
        <select className="input" value={bulkKind} onChange={(e) => setBulkKind(e.target.value as NozzleKind)}>
          {NOZZLE_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
        <button
          className="btn btn-small"
          disabled={group.nozzleIds.length === 0}
          onClick={() =>
            setLayout({
              ...layout,
              nozzles: layout.nozzles.map((n) =>
                group.nozzleIds.includes(n.id) ? { ...n, kind: bulkKind, ...nozzleDefaults(bulkKind) } : n,
              ),
            })
          }
        >
          Тип — всем
        </button>
      </div>
      <div className="form-row">
        <input
          className="input input-num"
          type="number"
          step={0.5}
          value={bulkHeight}
          onChange={(e) => setBulkHeight(Number(e.target.value))}
        />
        <span className="dim">высота струи, м</span>
        <button
          className="btn btn-small"
          disabled={group.nozzleIds.length === 0}
          onClick={() =>
            setLayout({
              ...layout,
              nozzles: layout.nozzles.map((n) =>
                group.nozzleIds.includes(n.id) ? { ...n, maxHeightM: Math.max(0.1, bulkHeight) } : n,
              ),
            })
          }
        >
          — всем
        </button>
      </div>
      <div className="form-row">
        <input
          className="input input-num"
          type="number"
          step={0.01}
          value={bulkWidth}
          onChange={(e) => setBulkWidth(Number(e.target.value))}
        />
        <span className="dim">диаметр струи, м</span>
        <button
          className="btn btn-small"
          disabled={group.nozzleIds.length === 0}
          onClick={() =>
            setLayout({
              ...layout,
              nozzles: layout.nozzles.map((n) =>
                group.nozzleIds.includes(n.id) ? { ...n, widthM: Math.max(0.005, bulkWidth) } : n,
              ),
            })
          }
        >
          — всем
        </button>
      </div>
      <div className="form-row">
        <input
          className="input input-num"
          type="number"
          step={5}
          value={rotateBy}
          onChange={(e) => setRotateBy(Number(e.target.value))}
        />
        <span className="dim">° поворот вокруг центра группы</span>
        <button
          className="btn btn-small"
          disabled={group.nozzleIds.length === 0}
          onClick={() => setLayout({ ...layout, nozzles: rotateNozzleGroup(layout.nozzles, group.nozzleIds, rotateBy) })}
        >
          Повернуть
        </button>
      </div>
      <div className="form-row">
        <input
          className="input input-num"
          type="number"
          step={0.1}
          value={moveBy.dx}
          onChange={(e) => setMoveBy({ ...moveBy, dx: Number(e.target.value) })}
        />
        <input
          className="input input-num"
          type="number"
          step={0.1}
          value={moveBy.dy}
          onChange={(e) => setMoveBy({ ...moveBy, dy: Number(e.target.value) })}
        />
        <span className="dim">сдвиг X/Y, м</span>
        <button
          className="btn btn-small"
          disabled={group.nozzleIds.length === 0}
          onClick={() =>
            setLayout({ ...layout, nozzles: translateNozzleGroup(layout.nozzles, group.nozzleIds, moveBy.dx, moveBy.dy) })
          }
        >
          Сдвинуть
        </button>
      </div>

      <div className="sidebar-actions">
        <button
          className="icon-btn icon-btn-danger"
          title="Удалить контур (форсунки останутся)"
          onClick={() => {
            setLayout({ ...layout, nozzleGroups: layout.nozzleGroups.filter((g) => g.id !== group.id) });
            onSelect(null);
          }}
        >
          <TrashIcon />
        </button>
        <span className="dim">Удаление контура не трогает сами форсунки.</span>
      </div>
    </section>
  );
}
