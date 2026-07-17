import { useEffect, useState } from 'react';
import {
  profileMap,
  uid,
  type DeviceProfile,
  type PatchedDevice,
  type Scene,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/** Сцены: статические картины. Значения задаются контролами по типу устройства. */
export function ScenesView({ engine }: { engine: EngineConnection }) {
  const { project, playback, frames, send, updateProject } = engine;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scenes = project?.scenes ?? [];
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
        <ul className="list">
          {scenes.map((s) => (
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
                Снять значения с консоли
              </button>
            </div>
            {project.devices.length === 0 ? (
              <div className="dim">В патче нет устройств — добавьте их на вкладке «Патч».</div>
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
