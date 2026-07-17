import { useMemo, useState } from 'react';
import {
  DMX_UNIVERSE_SIZE,
  allProfiles,
  deviceRange,
  findPatchIssues,
  nextFreeAddress,
  profileMap,
  uid,
  type ChannelRole,
  type DeviceKind,
  type DeviceProfile,
  type PatchedDevice,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

const KIND_LABEL: Record<DeviceKind, string> = {
  pump: 'Насос',
  valve: 'Клапан',
  lamp: 'Свет',
  other: 'Другое',
};

const ROLE_LABEL: Record<ChannelRole, string> = {
  intensity: 'Яркость/мощность',
  red: 'Красный',
  green: 'Зелёный',
  blue: 'Синий',
  white: 'Белый',
  open: 'Открыт/закрыт',
  custom: 'Свой',
};

/** Патч: профили устройств и расстановка по адресам с авто-адресацией и контролем коллизий. */
export function PatchView({ engine }: { engine: EngineConnection }) {
  const { project, universes, updateProject } = engine;

  if (!project) return <main className="view">Ожидание проекта от движка…</main>;

  return (
    <main className="view">
      <ProjectHeader engine={engine} />
      <AddDevices engine={engine} />
      <DevicesTable engine={engine} />
      <Profiles project={project} updateProject={updateProject} universesCount={universes.length} />
    </main>
  );
}

function ProjectHeader({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  return (
    <section className="panel">
      <h2>Проект</h2>
      <label className="field">
        Название:{' '}
        <input
          className="input"
          value={project!.name}
          onChange={(e) => updateProject({ ...project!, name: e.target.value })}
        />
      </label>
    </section>
  );
}

function AddDevices({ engine }: { engine: EngineConnection }) {
  const { project, universes, updateProject } = engine;
  const profiles = allProfiles(project!);
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? 'pump');
  const [universe, setUniverse] = useState<number | null>(null);
  const [count, setCount] = useState(1);
  const [auto, setAuto] = useState(true);
  const [startAddress, setStartAddress] = useState(1);
  const [namePrefix, setNamePrefix] = useState('');
  const [error, setError] = useState<string | null>(null);

  const universeId = universe ?? universes[0]?.id ?? 1;
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0]!;

  const add = (): void => {
    setError(null);
    const size = profile.channels.length;
    const prefix = namePrefix.trim() !== '' ? namePrefix.trim() : KIND_LABEL[profile.kind];
    // Нумерация продолжается: ищем наибольший суффикс « N» у устройств с тем же префиксом.
    let n = 0;
    for (const d of project!.devices) {
      const m = d.name.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`));
      if (m) n = Math.max(n, Number(m[1]));
    }
    const draft = { ...project!, devices: [...project!.devices] };
    let cursor = auto ? 1 : startAddress;
    for (let i = 0; i < count; i++) {
      let address: number;
      if (auto) {
        const free = nextFreeAddress(draft, universeId, size, cursor);
        if (free === null) {
          setError(`Добавлено ${i} из ${count}: во вселенной нет свободного блока из ${size} адрес(ов)`);
          break;
        }
        address = free;
        cursor = free + size;
      } else {
        address = startAddress + i * size;
        if (address + size - 1 > DMX_UNIVERSE_SIZE) {
          setError(`Добавлено ${i} из ${count}: адрес ${address} выходит за предел 512`);
          break;
        }
      }
      const device: PatchedDevice = {
        id: uid(),
        name: `${prefix} ${n + i + 1}`,
        profileId: profile.id,
        universe: universeId,
        address,
      };
      draft.devices.push(device);
    }
    updateProject(draft);
  };

  return (
    <section className="panel">
      <h2>Добавить устройства</h2>
      <div className="form-row">
        <label className="field">
          Профиль:{' '}
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.channels.length} адр.)
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Вселенная:{' '}
          <select value={universeId} onChange={(e) => setUniverse(Number(e.target.value))}>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Кол-во:{' '}
          <input
            className="input input-num"
            type="number"
            min={1}
            max={DMX_UNIVERSE_SIZE}
            value={count}
            onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
          />
        </label>
        <label className="field">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> авто-адрес
        </label>
        {!auto && (
          <label className="field">
            С адреса:{' '}
            <input
              className="input input-num"
              type="number"
              min={1}
              max={DMX_UNIVERSE_SIZE}
              value={startAddress}
              onChange={(e) => setStartAddress(Math.max(1, Math.min(DMX_UNIVERSE_SIZE, Number(e.target.value))))}
            />
          </label>
        )}
        <label className="field">
          Имя:{' '}
          <input
            className="input"
            placeholder={KIND_LABEL[profile.kind]}
            value={namePrefix}
            onChange={(e) => setNamePrefix(e.target.value)}
          />
        </label>
        <button className="btn active" onClick={add}>
          Добавить
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
    </section>
  );
}

function DevicesTable({ engine }: { engine: EngineConnection }) {
  const { project, universes, updateProject } = engine;
  const profiles = useMemo(() => profileMap(project!), [project]);
  const issues = useMemo(() => findPatchIssues(project!), [project]);

  const patchDevice = (id: string, patch: Partial<PatchedDevice>): void => {
    updateProject({
      ...project!,
      devices: project!.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    });
  };

  const removeDevice = (id: string): void => {
    const scenes = project!.scenes.map((s) => {
      if (!(id in s.values)) return s;
      const values = { ...s.values };
      delete values[id];
      return { ...s, values };
    });
    updateProject({ ...project!, devices: project!.devices.filter((d) => d.id !== id), scenes });
  };

  const sorted = [...project!.devices].sort((a, b) => a.universe - b.universe || a.address - b.address);

  return (
    <section className="panel">
      <h2>
        Устройства <span className="dim">({project!.devices.length})</span>
        {issues.collisions.size > 0 && (
          <span className="error-text"> ⚠ пересечения адресов: {issues.collisions.size}</span>
        )}
        {issues.outOfRange.size > 0 && (
          <span className="error-text"> ⚠ за пределами 1–512: {issues.outOfRange.size}</span>
        )}
      </h2>
      {sorted.length === 0 ? (
        <div className="dim">Пока пусто — добавьте устройства выше.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Профиль</th>
              <th>Вселенная</th>
              <th>Адрес</th>
              <th>Диапазон</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => {
              const range = deviceRange(d, profiles);
              const bad = issues.collisions.has(d.id) || issues.outOfRange.has(d.id);
              return (
                <tr key={d.id} className={bad ? 'row-error' : ''}>
                  <td>
                    <input
                      className="input"
                      value={d.name}
                      onChange={(e) => patchDevice(d.id, { name: e.target.value })}
                    />
                  </td>
                  <td>{profiles.get(d.profileId)?.name ?? d.profileId}</td>
                  <td>
                    <select
                      value={d.universe}
                      onChange={(e) => patchDevice(d.id, { universe: Number(e.target.value) })}
                    >
                      {universes.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input input-num"
                      type="number"
                      min={1}
                      max={DMX_UNIVERSE_SIZE}
                      value={d.address}
                      onChange={(e) => patchDevice(d.id, { address: Number(e.target.value) })}
                    />
                  </td>
                  <td className="dim">
                    {range.start}–{range.end}
                    {issues.collisions.has(d.id) && <span className="error-text"> пересечение</span>}
                    {issues.outOfRange.has(d.id) && <span className="error-text"> вне 1–512</span>}
                  </td>
                  <td>
                    <button className="btn btn-small" onClick={() => removeDevice(d.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Profiles({
  project,
  updateProject,
  universesCount,
}: {
  project: NonNullable<EngineConnection['project']>;
  updateProject: EngineConnection['updateProject'];
  universesCount: number;
}) {
  void universesCount;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DeviceKind>('lamp');
  const [channels, setChannels] = useState<{ name: string; role: ChannelRole }[]>([
    { name: 'Канал 1', role: 'intensity' },
  ]);
  const [twoState, setTwoState] = useState(false);

  const createProfile = (): void => {
    if (name.trim() === '' || channels.length === 0) return;
    const profile: DeviceProfile = {
      id: uid(),
      name: name.trim(),
      kind,
      channels,
      twoState: twoState || undefined,
    };
    updateProject({ ...project, profiles: [...project.profiles, profile] });
    setName('');
    setChannels([{ name: 'Канал 1', role: 'intensity' }]);
    setTwoState(false);
  };

  const removeProfile = (id: string): void => {
    if (project.devices.some((d) => d.profileId === id)) return; // используется — не удаляем
    updateProject({ ...project, profiles: project.profiles.filter((p) => p.id !== id) });
  };

  return (
    <section className="panel">
      <h2>Профили устройств</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Название</th>
            <th>Вид</th>
            <th>Каналы</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {allProfiles(project).map((p) => {
            const used = project.devices.some((d) => d.profileId === p.id);
            return (
              <tr key={p.id}>
                <td>
                  {p.name} {p.builtin && <span className="badge">встроенный</span>}
                  {p.twoState && <span className="badge">2-позиц.</span>}
                </td>
                <td>{KIND_LABEL[p.kind]}</td>
                <td className="dim">{p.channels.map((c) => c.name).join(', ')}</td>
                <td>
                  {!p.builtin && (
                    <button
                      className="btn btn-small"
                      disabled={used}
                      title={used ? 'Профиль используется устройствами' : 'Удалить'}
                      onClick={() => removeProfile(p.id)}
                    >
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Новый профиль</h3>
      <div className="form-row">
        <label className="field">
          Название:{' '}
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Напр. Прожектор RGBWA" />
        </label>
        <label className="field">
          Вид:{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as DeviceKind)}>
            {(Object.keys(KIND_LABEL) as DeviceKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <input type="checkbox" checked={twoState} onChange={(e) => setTwoState(e.target.checked)} />{' '}
          двухпозиционный (0/255)
        </label>
      </div>
      <div className="channels-editor">
        {channels.map((c, i) => (
          <div className="form-row" key={i}>
            <span className="dim">Канал {i + 1} (адрес +{i}):</span>
            <input
              className="input"
              value={c.name}
              onChange={(e) =>
                setChannels(channels.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
            />
            <select
              value={c.role}
              onChange={(e) =>
                setChannels(channels.map((x, j) => (j === i ? { ...x, role: e.target.value as ChannelRole } : x)))
              }
            >
              {(Object.keys(ROLE_LABEL) as ChannelRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <button
              className="btn btn-small"
              disabled={channels.length <= 1}
              onClick={() => setChannels(channels.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="form-row">
          <button
            className="btn"
            onClick={() => setChannels([...channels, { name: `Канал ${channels.length + 1}`, role: 'custom' }])}
          >
            + канал
          </button>
          <button className="btn active" onClick={createProfile} disabled={name.trim() === ''}>
            Создать профиль
          </button>
        </div>
      </div>
    </section>
  );
}
