import { useEffect, useMemo, useState } from 'react';
import {
  DMX_UNIVERSE_SIZE,
  invertScene,
  layoutActors,
  mirrorScene,
  profileMap,
  radialWaveScene,
  radialWaveSequenceScenes,
  sceneDependents,
  uid,
  type ActorRole,
  type DeviceProfile,
  type PatchedDevice,
  type Project,
  type Scene,
  type Sequence,
  type WaveSceneOptions,
} from '@fountain-studio/shared';
import { ListFilter } from '../components/ListFilter';
import { confirmDelete } from '../confirmDelete';
import type { EngineConnection } from '../useEngine';

const PAGE_SIZE = 32;

/** Сцены: статические картины. Значения задаются контролами по типу устройства. */
export function ScenesView({ engine }: { engine: EngineConnection }) {
  const { project, playback, frames, send, updateProject } = engine;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'devices' | 'addresses'>('devices');
  const [showGenerator, setShowGenerator] = useState(false);
  const [filter, setFilter] = useState('');

  // scenes — полный список (логика выбора/наименования не должна зависеть от
  // текста поиска); visibleScenes — то, что реально рисуем в списке слева.
  const scenes = project?.scenes ?? [];
  const visibleScenes = scenes.filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const selected = scenes.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null && scenes.length > 0) setSelectedId(scenes[0]!.id);
    if (selectedId !== null && !scenes.some((s) => s.id === selectedId)) {
      setSelectedId(scenes[0]?.id ?? null);
    }
  }, [scenes, selectedId]);

  if (!project) return <main className="view">Ожидание проекта от движка…</main>;

  const addScene = (): void => {
    const scene: Scene = { id: uid(), name: `Сцена ${project.scenes.length + 1}`, values: {} };
    updateProject({ ...project, scenes: [...project.scenes, scene] });
    setSelectedId(scene.id);
  };

  const duplicateScene = (): void => {
    if (!selected) return;
    const copy: Scene = {
      id: uid(),
      name: `${selected.name} (копия)`,
      values: Object.fromEntries(Object.entries(selected.values).map(([k, v]) => [k, [...v]])),
    };
    updateProject({ ...project, scenes: [...project.scenes, copy] });
    setSelectedId(copy.id);
  };

  const removeScene = (): void => {
    if (!selected) return;
    if (!confirmDelete('сцены', selected.name, sceneDependents(project, selected.id))) return;
    updateProject({
      ...project,
      scenes: project.scenes.filter((s) => s.id !== selected.id),
      // Шаги секвенсоров, ссылавшиеся на сцену, удаляем.
      sequences: project.sequences.map((q) => ({
        ...q,
        steps: q.steps.filter((st) => st.sceneId !== selected.id),
      })),
    });
  };

  const updateScene = (scene: Scene): void => {
    updateProject({ ...project, scenes: project.scenes.map((s) => (s.id === scene.id ? scene : s)) });
  };

  const captureFromConsole = (): void => {
    if (!selected) return;
    const profiles = profileMap(project);
    const values: Record<string, number[]> = {};
    for (const d of project.devices) {
      const profile = profiles.get(d.profileId);
      const frame = frames[d.universe];
      if (!profile || !frame) continue;
      values[d.id] = profile.channels.map((_, k) => frame[d.address - 1 + k] ?? 0);
    }
    updateScene({ ...selected, values });
  };

  const previewActive = selected !== null && playback.activeSceneId === selected.id;

  return (
    <main className="view view-split">
      <aside className="sidebar">
        <div className="sidebar-actions">
          <button className="btn" onClick={addScene}>
            + Сцена
          </button>
          <button className="btn" onClick={duplicateScene} disabled={!selected}>
            Дублировать
          </button>
          <button className="btn" onClick={removeScene} disabled={!selected}>
            Удалить
          </button>
        </div>
        {scenes.length > 5 && <ListFilter value={filter} onChange={setFilter} />}
        <ul className="list">
          {visibleScenes.map((s) => (
            <li
              key={s.id}
              className={
                (s.id === selectedId ? 'list-item selected' : 'list-item') +
                (playback.activeSceneId === s.id ? ' playing' : '')
              }
              onClick={() => setSelectedId(s.id)}
            >
              {s.name}
              {playback.activeSceneId === s.id && <span className="badge badge-live">в эфире</span>}
            </li>
          ))}
        </ul>
      </aside>

      <section className="content">
        {selected === null ? (
          <div className="dim">Создайте сцену слева.</div>
        ) : (
          <>
            <div className="form-row">
              <input
                className="input input-title"
                value={selected.name}
                onChange={(e) => updateScene({ ...selected, name: e.target.value })}
              />
              <button
                className={previewActive ? 'btn active' : 'btn'}
                onClick={() => send({ type: 'setScene', sceneId: previewActive ? null : selected.id })}
              >
                {previewActive ? '■ Снять с выхода' : '▶ Просмотр на выходе'}
              </button>
              <button className="btn" onClick={captureFromConsole} title="Записать в сцену текущие значения консоли">
                Снять значения с пульта
              </button>
              <button
                className={showGenerator ? 'btn btn-small active' : 'btn btn-small'}
                onClick={() => setShowGenerator(!showGenerator)}
                title="Генерация сцен от геометрии схемы: инверсия, зеркало, волна по кольцу"
              >
                ⚡ Генератор
              </button>
              <span className="spacer" />
              <button
                className={mode === 'devices' ? 'btn btn-small active' : 'btn btn-small'}
                onClick={() => setMode('devices')}
              >
                Устройства
              </button>
              <button
                className={mode === 'addresses' ? 'btn btn-small active' : 'btn btn-small'}
                onClick={() => setMode('addresses')}
              >
                Адреса
              </button>
            </div>
            {showGenerator && (
              <GeneratorPanel
                engine={engine}
                project={project}
                selected={selected}
                updateProject={updateProject}
                setSelectedId={setSelectedId}
              />
            )}
            {project.devices.length === 0 ? (
              <div className="dim">В патче нет устройств — добавьте их на вкладке «Приборы».</div>
            ) : mode === 'addresses' ? (
              <AddressPages engine={engine} project={project} scene={selected} onChange={updateScene} />
            ) : (
              <div className="device-grid">
                {[...project.devices]
                  .sort((a, b) => a.universe - b.universe || a.address - b.address)
                  .map((d) => (
                    <DeviceCard
                      key={d.id}
                      device={d}
                      profile={profileMap(project).get(d.profileId)!}
                      values={selected.values[d.id] ?? []}
                      onChange={(vals) =>
                        updateScene({ ...selected, values: { ...selected.values, [d.id]: vals } })
                      }
                    />
                  ))}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

const ROLE_LABEL: Record<ActorRole, string> = {
  pump: 'Насосы (с форсунок схемы)',
  valve: 'Клапаны (с форсунок схемы)',
  light: 'Прожекторы (со схемы)',
};

/**
 * Генератор сцен от геометрии схемы (§17 п.2–3): инверсия/зеркало существующей
 * сцены и волна по кольцу форсунок/прожекторов из вкладки «3D». Волна работает
 * только с одноканальными устройствами (насос/клапан/диммер) — для RGB генератор
 * ничего не пишет, чтобы не гадать раскладку по цвету. Секвенсор «бегущая волна»
 * — набор сцен с фазовым сдвигом плюс обычный секвенсор в режиме «по кругу»,
 * ничего нового в движке для этого не требуется.
 */
function GeneratorPanel({
  engine,
  project,
  selected,
  updateProject,
  setSelectedId,
}: {
  engine: EngineConnection;
  project: Project;
  selected: Scene | null;
  updateProject: (p: Project) => void;
  setSelectedId: (id: string) => void;
}) {
  const [role, setRole] = useState<ActorRole>('pump');
  const [waveMode, setWaveMode] = useState<NonNullable<WaveSceneOptions['mode']>>('angle');
  const [cycles, setCycles] = useState(1);
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(255);
  const [steps, setSteps] = useState(12);
  const [holdMs, setHoldMs] = useState(150);
  const [fadeMs, setFadeMs] = useState(100);
  const [captureUniverse, setCaptureUniverse] = useState(engine.universes[0]?.id ?? 1);
  const [captureStatus, setCaptureStatus] = useState<string | null>(null);

  const actors = useMemo(() => layoutActors(project.layout, role), [project.layout, role]);
  const profiles = useMemo(() => profileMap(project), [project]);

  const addScenes = (scenes: Scene[]): void => {
    updateProject({ ...project, scenes: [...project.scenes, ...scenes] });
    if (scenes[0]) setSelectedId(scenes[0].id);
  };

  const doInvert = (): void => {
    if (selected) addScenes([invertScene(selected)]);
  };
  const doMirror = (axis: 'x' | 'y'): void => {
    if (selected) addScenes([mirrorScene(selected, actors, axis)]);
  };
  const doWave = (): void => {
    addScenes([radialWaveScene(actors, project.devices, profiles, { cycles, min, max, mode: waveMode })]);
  };
  const doWaveSequence = (): void => {
    const scenes = radialWaveSequenceScenes(actors, project.devices, profiles, steps, { cycles, min, max, mode: waveMode });
    const sequence: Sequence = {
      id: uid(),
      name: `Волна (${steps} шаг.)`,
      mode: 'loop',
      steps: scenes.map((s) => ({ sceneId: s.id, holdMs, fadeMs })),
    };
    updateProject({
      ...project,
      scenes: [...project.scenes, ...scenes],
      sequences: [...project.sequences, sequence],
    });
  };

  // Импорт с линии (§17 п.1): кадр внешнего ArtDMX → значения устройств этой вселенной.
  const doCaptureScene = async (): Promise<void> => {
    setCaptureStatus(null);
    const snap = await engine.requestDmxCapture(captureUniverse);
    if (!snap) {
      setCaptureStatus(
        'Захвата нет: внешний источник должен слать Art-Net на этот ПК (порт 6454 занят движком — мониторинг сети активен?).',
      );
      return;
    }
    const values: Record<string, number[]> = {};
    let devicesCovered = 0;
    for (const d of project.devices) {
      if (d.universe !== captureUniverse) continue;
      const profile = profiles.get(d.profileId);
      if (!profile) continue;
      values[d.id] = profile.channels.map((_, k) => snap.data[d.address - 1 + k] ?? 0);
      devicesCovered++;
    }
    if (devicesCovered === 0) {
      setCaptureStatus('В патче нет устройств этой вселенной — значения снимать некуда.');
      return;
    }
    const scene: Scene = { id: uid(), name: `С линии (всел. ${captureUniverse})`, values };
    updateProject({ ...project, scenes: [...project.scenes, scene] });
    setSelectedId(scene.id);
    setCaptureStatus(
      `Снята сцена с линии: ${devicesCovered} устройств, источник ${snap.fromIp}, кадру ${Math.round(snap.ageMs / 1000)} с (записано кадров: ${snap.frames}).`,
    );
  };

  const doMeasureCycle = async (): Promise<void> => {
    setCaptureStatus('Измерение цикла…');
    const m = await engine.requestDmxCycle(captureUniverse);
    if (m.periodMs === null) {
      setCaptureStatus(
        m.analyzedMs < 2000
          ? `Мало данных для измерения (записано ${(m.analyzedMs / 1000).toFixed(1)} с) — дайте источнику повещать подольше.`
          : `Период не найден (запись ${(m.analyzedMs / 1000).toFixed(1)} с): поток не повторяется или цикл длиннее половины записи.`,
      );
      return;
    }
    setCaptureStatus(
      `Период цикла T ≈ ${(m.periodMs / 1000).toFixed(1)} с (уверенность ${(m.confidence * 100).toFixed(0)}%, запись ${(m.analyzedMs / 1000).toFixed(0)} с).`,
    );
  };

  return (
    <div className="trim-editor">
      <div className="form-row">
        <label className="field">
          Геометрия по роли:{' '}
          <select value={role} onChange={(e) => setRole(e.target.value as ActorRole)}>
            {(Object.keys(ROLE_LABEL) as ActorRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <span className="dim">
          {actors.length === 0
            ? 'нет устройств с координатами — расставьте их на вкладке «3D»'
            : `${actors.length} устройств с координатами в схеме`}
        </span>
      </div>

      <div className="form-row">
        <span className="dim">Из выбранной сцены («{selected?.name ?? '—'}»):</span>
        <button className="btn" disabled={!selected} onClick={doInvert}>
          Инвертировать → новая сцена
        </button>
        <button className="btn" disabled={!selected || actors.length === 0} onClick={() => doMirror('x')}>
          Зеркало лево-право → новая сцена
        </button>
        <button className="btn" disabled={!selected || actors.length === 0} onClick={() => doMirror('y')}>
          Зеркало верх-низ → новая сцена
        </button>
      </div>

      <div className="form-row">
        <span className="dim">Волна по фигуре (только насосы/клапаны/диммеры — одноканальные):</span>
        <label className="field">
          Раскладка:{' '}
          <select value={waveMode} onChange={(e) => setWaveMode(e.target.value as typeof waveMode)}>
            <option value="angle">По углу (круг/кольцо)</option>
            <option value="path">По контуру (звезда/ромб/прямоугольник — равномерно по периметру)</option>
            <option value="line">Вдоль линии (линейный фонтан)</option>
          </select>
        </label>
        <label className="field">
          Волн:{' '}
          <input
            className="input input-num"
            type="number"
            min={1}
            max={8}
            value={cycles}
            onChange={(e) => setCycles(Math.max(1, Number(e.target.value)))}
          />
        </label>
        <label className="field">
          Мин:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={255}
            value={min}
            onChange={(e) => setMin(Number(e.target.value))}
          />
        </label>
        <label className="field">
          Макс:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={255}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
          />
        </label>
        <button className="btn" disabled={actors.length === 0} onClick={doWave}>
          Создать сцену-волну
        </button>
      </div>

      <div className="form-row">
        <span className="dim">Бегущая волна/погоня — секвенсор из шагов со сдвигом фазы:</span>
        <label className="field">
          Шагов:{' '}
          <input
            className="input input-num"
            type="number"
            min={2}
            max={64}
            value={steps}
            onChange={(e) => setSteps(Math.max(2, Number(e.target.value)))}
          />
        </label>
        <label className="field">
          Держать, мс:{' '}
          <input
            className="input input-num"
            type="number"
            min={20}
            value={holdMs}
            onChange={(e) => setHoldMs(Math.max(20, Number(e.target.value)))}
          />
        </label>
        <label className="field">
          Фейд, мс:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            value={fadeMs}
            onChange={(e) => setFadeMs(Math.max(0, Number(e.target.value)))}
          />
        </label>
        <button className="btn active" disabled={actors.length === 0} onClick={doWaveSequence}>
          Создать секвенсор «бегущая волна»
        </button>
      </div>

      <div className="form-row">
        <span className="dim">
          Импорт с линии — внешний Art-Net источник (старый контроллер) шлёт на этот ПК:
        </span>
        <label className="field">
          Вселенная:{' '}
          <select value={captureUniverse} onChange={(e) => setCaptureUniverse(Number(e.target.value))}>
            {engine.universes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={() => void doCaptureScene()}>
          Снять сцену с линии
        </button>
        <button className="btn" onClick={() => void doMeasureCycle()} title="Период повторения T захваченного потока">
          Измерить период цикла
        </button>
      </div>
      {captureStatus && <div className="dim">{captureStatus}</div>}
    </div>
  );
}

/**
 * Страницы адресов (как в FontanPlay): вселенная → страницы по 32 адреса,
 * значение сцены правится прямо в ячейке адреса. Адрес принадлежит каналу
 * устройства из патча; свободные адреса пусты (сцена хранит значения по
 * устройствам, поэтому переадресация не ломает картины).
 */
function AddressPages({
  engine,
  project,
  scene,
  onChange,
}: {
  engine: EngineConnection;
  project: Project;
  scene: Scene;
  onChange: (scene: Scene) => void;
}) {
  const { universes } = engine;
  const [universeId, setUniverseId] = useState(universes[0]?.id ?? 1);
  const [page, setPage] = useState(0);

  /** адрес-1 → устройство и индекс канала. */
  const slots = useMemo(() => {
    const profiles = profileMap(project);
    const map = new Map<number, { device: PatchedDevice; channel: number; channelName: string }>();
    for (const d of project.devices) {
      if (d.universe !== universeId) continue;
      const profile = profiles.get(d.profileId);
      if (!profile) continue;
      for (let k = 0; k < profile.channels.length; k++) {
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) {
          map.set(idx, { device: d, channel: k, channelName: profile.channels[k]!.name });
        }
      }
    }
    return map;
  }, [project, universeId]);

  const valueAt = (idx: number): number => {
    const slot = slots.get(idx);
    if (!slot) return 0;
    return scene.values[slot.device.id]?.[slot.channel] ?? 0;
  };

  const setValueAt = (idx: number, v: number): void => {
    const slot = slots.get(idx);
    if (!slot) return;
    const profiles = profileMap(project);
    const count = profiles.get(slot.device.profileId)?.channels.length ?? 0;
    const vals = Array.from({ length: count }, (_, k) => scene.values[slot.device.id]?.[k] ?? 0);
    vals[slot.channel] = Math.max(0, Math.min(255, Math.round(v)));
    onChange({ ...scene, values: { ...scene.values, [slot.device.id]: vals } });
  };

  const pages = DMX_UNIVERSE_SIZE / PAGE_SIZE;
  const start = page * PAGE_SIZE;

  return (
    <div>
      <div className="form-row">
        <label className="field">
          Вселенная:{' '}
          <select value={universeId} onChange={(e) => setUniverseId(Number(e.target.value))}>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <div className="days">
          {Array.from({ length: pages }, (_, p) => (
            <button
              key={p}
              className={p === page ? 'btn btn-small active' : 'btn btn-small'}
              onClick={() => setPage(p)}
            >
              {p * PAGE_SIZE + 1}
            </button>
          ))}
        </div>
      </div>
      <div className="addr-grid">
        {Array.from({ length: PAGE_SIZE }, (_, i) => {
          const idx = start + i;
          const slot = slots.get(idx);
          const v = valueAt(idx);
          return (
            <div
              key={idx}
              className={slot ? (v > 0 ? 'addr-cell addr-set' : 'addr-cell') : 'addr-cell addr-free'}
              title={slot ? `${slot.device.name} · ${slot.channelName}` : 'адрес свободен'}
            >
              <span className="addr-num">{idx + 1}</span>
              <span className="addr-owner">{slot ? `${slot.device.name}·${slot.channelName}` : '—'}</span>
              <input
                className="input input-mini addr-value"
                type="number"
                min={0}
                max={255}
                disabled={!slot}
                value={slot ? v : ''}
                onChange={(e) => setValueAt(idx, Number(e.target.value))}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  profile,
  values,
  onChange,
}: {
  device: PatchedDevice;
  profile: DeviceProfile;
  values: number[];
  onChange: (values: number[]) => void;
}) {
  const val = (i: number): number => values[i] ?? 0;
  const setVal = (i: number, v: number): void => {
    const next = profile.channels.map((_, k) => val(k));
    next[i] = Math.max(0, Math.min(255, Math.round(v)));
    onChange(next);
  };

  const rgbIdx = {
    r: profile.channels.findIndex((c) => c.role === 'red'),
    g: profile.channels.findIndex((c) => c.role === 'green'),
    b: profile.channels.findIndex((c) => c.role === 'blue'),
  };
  const hasColor = rgbIdx.r >= 0 && rgbIdx.g >= 0 && rgbIdx.b >= 0;

  return (
    <div className="device-card">
      <div className="device-card-head">
        <span className="device-name">{device.name}</span>
        <span className="dim">
          U{device.universe}:{device.address}
        </span>
      </div>

      {profile.twoState ? (
        profile.channels.map((c, i) => (
          <button
            key={i}
            className={val(i) >= 128 ? 'btn toggle-open' : 'btn toggle-closed'}
            onClick={() => setVal(i, val(i) >= 128 ? 0 : 255)}
          >
            {c.name}: {val(i) >= 128 ? 'ОТКРЫТ' : 'ЗАКРЫТ'}
          </button>
        ))
      ) : (
        <>
          {hasColor && (
            <input
              type="color"
              className="color-input"
              value={rgbToHex(val(rgbIdx.r), val(rgbIdx.g), val(rgbIdx.b))}
              onChange={(e) => {
                const [r, g, b] = hexToRgb(e.target.value);
                const next = profile.channels.map((_, k) => val(k));
                next[rgbIdx.r] = r;
                next[rgbIdx.g] = g;
                next[rgbIdx.b] = b;
                onChange(next);
              }}
            />
          )}
          {profile.channels.map((c, i) => (
            <label className="channel-row" key={i}>
              <span className="channel-name">{c.name}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={val(i)}
                onChange={(e) => setVal(i, Number(e.target.value))}
              />
              <input
                className="input input-num"
                type="number"
                min={0}
                max={255}
                value={val(i)}
                onChange={(e) => setVal(i, Number(e.target.value))}
              />
            </label>
          ))}
        </>
      )}
    </div>
  );
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) || 0,
    parseInt(hex.slice(3, 5), 16) || 0,
    parseInt(hex.slice(5, 7), 16) || 0,
  ];
}
