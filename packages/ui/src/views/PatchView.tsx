import { useMemo, useState } from 'react';
import {
  DMX_UNIVERSE_SIZE,
  allProfiles,
  deviceDependents,
  deviceRange,
  findPatchIssues,
  nextFreeAddress,
  profileMap,
  shiftDeviceAddresses,
  swapDeviceAddresses,
  uid,
  type ChannelRole,
  type ChannelTrim,
  type DeviceKind,
  type DeviceProfile,
  type ModbusConnection,
  type ModbusPumpConfig,
  type PatchedDevice,
  type PumpModbusStatus,
} from '@fountain-studio/shared';
import { confirmDelete } from '../confirmDelete';
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shiftBy, setShiftBy] = useState(1);
  const [trimOpenId, setTrimOpenId] = useState<string | null>(null);
  const [modbusOpenId, setModbusOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const patchDevice = (id: string, patch: Partial<PatchedDevice>): void => {
    updateProject({
      ...project!,
      devices: project!.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    });
  };

  const toggleSelect = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectedIds = [...selected].filter((id) => project!.devices.some((d) => d.id === id));

  const doSwap = (): void => {
    if (selectedIds.length !== 2) return;
    updateProject(swapDeviceAddresses(project!, selectedIds[0]!, selectedIds[1]!));
  };

  const doShift = (): void => {
    if (selectedIds.length === 0 || shiftBy === 0) return;
    updateProject(shiftDeviceAddresses(project!, selectedIds, shiftBy));
  };

  const removeDevice = (id: string): void => {
    const device = project!.devices.find((d) => d.id === id);
    if (device && !confirmDelete('прибора', device.name, deviceDependents(project!, id))) return;
    const scenes = project!.scenes.map((s) => {
      if (!(id in s.values)) return s;
      const values = { ...s.values };
      delete values[id];
      return { ...s, values };
    });
    updateProject({ ...project!, devices: project!.devices.filter((d) => d.id !== id), scenes });
  };

  const sorted = [...project!.devices]
    .sort((a, b) => a.universe - b.universe || a.address - b.address)
    .filter((d) => d.name.toLowerCase().includes(filter.trim().toLowerCase()));

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
      {project!.devices.length > 5 && (
        <div className="form-row">
          <input
            className="input"
            style={{ width: 220 }}
            placeholder="Поиск по имени…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      {project!.devices.length === 0 ? (
        <div className="dim">Пока пусто — добавьте устройства выше.</div>
      ) : sorted.length === 0 ? (
        <div className="dim">Ничего не найдено по «{filter}».</div>
      ) : (
        <>
          <div className="form-row">
            <span className="dim">Переадресация (физически перепутаны/заменены приборы): отметьте устройства →</span>
            <button
              className="btn"
              disabled={selectedIds.length !== 2}
              title="Обменять адреса и вселенные двух отмеченных устройств"
              onClick={doSwap}
            >
              ⇄ Обменять адреса{selectedIds.length === 2 ? '' : ' (нужно 2)'}
            </button>
            <label className="field">
              Сдвинуть на{' '}
              <input
                className="input input-num"
                type="number"
                value={shiftBy}
                onChange={(e) => setShiftBy(Math.round(Number(e.target.value)) || 0)}
              />
            </label>
            <button className="btn" disabled={selectedIds.length === 0 || shiftBy === 0} onClick={doShift}>
              Сдвинуть адреса ({selectedIds.length} выбр.)
            </button>
            {selectedIds.length > 0 && (
              <button className="btn btn-small" onClick={() => setSelected(new Set())}>
                снять выбор
              </button>
            )}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th></th>
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
                const profile = profiles.get(d.profileId);
                const trimOpen = trimOpenId === d.id;
                const modbusOpen = modbusOpenId === d.id;
                return [
                  <tr key={d.id} className={bad ? 'row-error' : ''}>
                    <td>
                      <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggleSelect(d.id)} />
                    </td>
                    <td>
                      <input
                        className="input"
                        value={d.name}
                        onChange={(e) => patchDevice(d.id, { name: e.target.value })}
                      />
                    </td>
                    <td>{profile?.name ?? d.profileId}</td>
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
                      <button
                        className={d.trim ? 'btn btn-small active' : 'btn btn-small'}
                        title="Калибровка min/max по каналам"
                        onClick={() => setTrimOpenId(trimOpen ? null : d.id)}
                      >
                        ⚙
                      </button>{' '}
                      {profile?.kind === 'pump' && (
                        <button
                          className={d.modbus ? 'btn btn-small active' : 'btn btn-small'}
                          title="Прямое управление через Modbus (ПЧ), в обход DMX→аналог"
                          onClick={() => setModbusOpenId(modbusOpen ? null : d.id)}
                        >
                          ПЧ
                        </button>
                      )}{' '}
                      <button className="btn btn-small" onClick={() => removeDevice(d.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>,
                  trimOpen && profile ? (
                    <tr key={`${d.id}-trim`}>
                      <td colSpan={7}>
                        <TrimEditor
                          device={d}
                          profile={profile}
                          onChange={(trim) => patchDevice(d.id, { trim })}
                        />
                      </td>
                    </tr>
                  ) : null,
                  modbusOpen ? (
                    <tr key={`${d.id}-modbus`}>
                      <td colSpan={7}>
                        <ModbusEditor
                          device={d}
                          status={engine.modbus?.pumps.find((p) => p.deviceId === d.id) ?? null}
                          onChange={(modbus) => patchDevice(d.id, { modbus })}
                        />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** Калибровка рабочего диапазона: 0 остаётся 0, значения 1–255 растягиваются в min–max. */
function TrimEditor({
  device,
  profile,
  onChange,
}: {
  device: PatchedDevice;
  profile: DeviceProfile;
  onChange: (trim: ChannelTrim[] | undefined) => void;
}) {
  const trim: ChannelTrim[] = profile.channels.map((_, k) => device.trim?.[k] ?? { min: 0, max: 255 });

  const set = (k: number, patch: Partial<ChannelTrim>): void => {
    const next = trim.map((t, i) => (i === k ? { ...t, ...patch } : { ...t }));
    const t = next[k]!;
    t.min = Math.max(0, Math.min(255, Math.round(t.min)));
    t.max = Math.max(t.min, Math.min(255, Math.round(t.max)));
    onChange(next.every((x) => x.min === 0 && x.max === 255) ? undefined : next);
  };

  return (
    <div className="trim-editor">
      <span className="dim">
        Калибровка «{device.name}»: 0 остаётся 0 (выключено), 1–255 растягиваются в min–max выхода.
      </span>
      {profile.channels.map((c, k) => (
        <label className="field" key={k}>
          {c.name}: min{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={255}
            value={trim[k]!.min}
            onChange={(e) => set(k, { min: Number(e.target.value) })}
          />{' '}
          max{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={255}
            value={trim[k]!.max}
            onChange={(e) => set(k, { max: Number(e.target.value) })}
          />
        </label>
      ))}
      {device.trim && (
        <button className="btn btn-small" onClick={() => onChange(undefined)}>
          Сбросить (0–255)
        </button>
      )}
    </div>
  );
}

/** Дефолты — карта регистров Elhart EMD-PUMP (github.com/BelikGM/Modbus); для другого ПЧ сверить с его картой. */
function defaultModbusConfig(): ModbusPumpConfig {
  return {
    connection: { kind: 'tcp', host: '192.168.0.', port: 502 },
    unitId: 1,
    freqRegister: 8193,
    freqRegScale: 100,
    freqScaleHz: 50,
    cmdRegister: 8192,
    faultRegister: 10,
  };
}

/**
 * Прямое управление насосом через Modbus (ПЧ), в обход DMX→аналог (§12 п.9) —
 * простое включение/уставка частоты от сцен/шоу, не конфигуратор параметров ПЧ
 * (для тонкой настройки самого привода — отдельный проект github.com/BelikGM/Modbus).
 */
function ModbusEditor({
  device,
  status,
  onChange,
}: {
  device: PatchedDevice;
  status: PumpModbusStatus | null;
  onChange: (modbus: ModbusPumpConfig | undefined) => void;
}) {
  const enabled = device.modbus !== undefined;
  const config = device.modbus ?? defaultModbusConfig();

  const set = (patch: Partial<ModbusPumpConfig>): void => onChange({ ...config, ...patch });
  const setTcp = (patch: Partial<Extract<ModbusConnection, { kind: 'tcp' }>>): void => {
    if (config.connection.kind !== 'tcp') return;
    onChange({ ...config, connection: { ...config.connection, ...patch } });
  };
  const setRtu = (patch: Partial<Extract<ModbusConnection, { kind: 'rtu' }>>): void => {
    if (config.connection.kind !== 'rtu') return;
    onChange({ ...config, connection: { ...config.connection, ...patch } });
  };

  return (
    <div className="trim-editor">
      <label className="field">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? config : undefined)}
        />{' '}
        Управлять «{device.name}» напрямую по Modbus (ПЧ), в обход DMX→аналог
      </label>
      {enabled && (
        <>
          {status && (
            <div className={status.faultCode ? 'error-text' : 'dim'}>
              {status.connected ? '✔ на связи' : '✖ нет связи'} · уставка {status.lastFreqHz.toFixed(1)} Гц
              {status.faultCode ? ` · АВАРИЯ, код ${status.faultCode}` : ''}
              {status.lastError ? ` · ${status.lastError}` : ''}
            </div>
          )}
          <div className="form-row">
            <label className="field">
              Подключение:{' '}
              <select
                value={config.connection.kind}
                onChange={(e) =>
                  set({
                    connection:
                      e.target.value === 'tcp'
                        ? { kind: 'tcp', host: '192.168.0.', port: 502 }
                        : { kind: 'rtu', serialPort: 'COM5', baudRate: 9600 },
                  })
                }
              >
                <option value="tcp">TCP (шлюз RTU↔TCP по сети)</option>
                <option value="rtu">RS-485 (USB-адаптер, COM-порт)</option>
              </select>
            </label>
            <label className="field">
              Адрес прибора (unitId):{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                max={255}
                value={config.unitId ?? 1}
                onChange={(e) => set({ unitId: Number(e.target.value) })}
              />
            </label>
          </div>
          {config.connection.kind === 'tcp' ? (
            <div className="form-row">
              <label className="field">
                IP шлюза:{' '}
                <input className="input" value={config.connection.host} onChange={(e) => setTcp({ host: e.target.value })} />
              </label>
              <label className="field">
                Порт:{' '}
                <input
                  className="input input-num"
                  type="number"
                  value={config.connection.port ?? 502}
                  onChange={(e) => setTcp({ port: Number(e.target.value) })}
                />
              </label>
            </div>
          ) : (
            <div className="form-row">
              <label className="field">
                COM-порт:{' '}
                <input
                  className="input"
                  placeholder="COM5"
                  value={config.connection.serialPort}
                  onChange={(e) => setRtu({ serialPort: e.target.value })}
                />
              </label>
              <label className="field">
                Скорость:{' '}
                <input
                  className="input input-num"
                  type="number"
                  value={config.connection.baudRate ?? 9600}
                  onChange={(e) => setRtu({ baudRate: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
          <div className="form-row">
            <label className="field">
              Регистр уставки частоты:{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                value={config.freqRegister}
                onChange={(e) => set({ freqRegister: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Частота при 255 (Гц):{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                value={config.freqScaleHz}
                onChange={(e) => set({ freqScaleHz: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Единиц регистра/Гц:{' '}
              <input
                className="input input-num"
                type="number"
                min={1}
                value={config.freqRegScale ?? 100}
                onChange={(e) => set({ freqRegScale: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              Регистр команд пуск/стоп:{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                value={config.cmdRegister ?? ''}
                placeholder="не задан — без команды"
                onChange={(e) => set({ cmdRegister: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Регистр кода аварии:{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                value={config.faultRegister ?? ''}
                placeholder="не задан — без опроса"
                onChange={(e) => set({ faultRegister: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
          </div>
          <span className="dim">
            Дефолты полей — карта регистров Elhart EMD-PUMP: 8193 = уставка частоты (сотые Гц), 8192 = команда
            (2=пуск, 1=стоп), 10 = код последней аварии. Для другой модели ПЧ сверьте с её картой регистров.
          </span>
        </>
      )}
    </div>
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
