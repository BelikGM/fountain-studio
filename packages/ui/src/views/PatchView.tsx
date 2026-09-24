import { Fragment, useMemo, useRef, useState } from 'react';
import { useCollapsiblePanels } from '../collapsiblePanels';
import { ReaddressPanel } from '../components/ReaddressPanel';
import { FigureWizard } from '../components/FigureWizard';
import { BulkDeleteDialog } from '../components/BulkDeleteDialog';
import { ArrowRightIcon, PlusIcon, CloseIcon, SwapIcon, GearIcon, CopyIcon } from '../components/Icons';
import { NumInput } from '../components/NumInput';
import { RemapDialog } from '../components/RemapDialog';
import {
  DMX_UNIVERSE_SIZE,
  allProfiles,
  VFD_PRESETS,
  vfdPreset,
  type SearchRecord,
  deviceDependents,
  deviceRange,
  findPatchIssues,
  nextFreeAddress,
  nozzleLightIds,
  nozzlePumpIds,
  nozzleValveIds,
  planDeviceWizard,
  profileMap,
  removeDevices,
  shiftDeviceAddresses,
  swapDeviceAddresses,
  uid,
  type ChannelRole,
  type ChannelTrim,
  type ConfigUniverse,
  type DeviceKind,
  type DeviceProfile,
  type ModbusConnection,
  type ModbusPumpConfig,
  type PatchedDevice,
  type PumpModbusStatus,
  type WizardRow,
  universeShort,
  nextUniverse,
  countOf,
  num,
} from '@fountain-studio/shared';
import { SmartSearch } from '../components/SmartSearch';
/** Подписи видов оборудования — ими же ищем по типу. */
const DEVICE_KIND_NAMES: Record<string, string> = {
  pump: 'Насос',
  valve: 'Клапан',
  lamp: 'Свет',
  other: 'Прочее',
};
import { clipboardHasKind, copyToClipboard, pasteFromClipboard } from '../clipboard';
import { askConfirm } from '../components/ConfirmDialog';
import { confirmDelete } from '../confirmDelete';
import { requestTab } from '../navigate';
import { applySettingsDraft, keepSettingsDraft, takeSettingsDraft } from '../settingsDraft';
import type { EngineConnection } from '../useEngine';
import { ComPortPicker } from '../components/ComPortPicker';

const KIND_LABEL: Record<DeviceKind, string> = {
  pump: 'Насос',
  valve: 'Клапан',
  lamp: 'Свет',
  other: 'Прочее',
};

const ROLE_LABEL: Record<ChannelRole, string> = {
  intensity: 'Уровень (яркость, скорость насоса)',
  red: 'Красный',
  green: 'Зелёный',
  blue: 'Синий',
  white: 'Белый',
  open: 'Открыт/закрыт',
  custom: 'Свой',
};

/** Патч: профили устройств и расстановка по адресам с авто-адресацией и контролем коллизий. */
export function PatchView({ engine }: { engine: EngineConnection }) {
  const { project, universes, updateProject, frames } = engine;
  // Переадресация живёт в окне поверх вкладки, а не отдельным разделом:
  // лезть туда каждый день не надо, и случайно перепутать адреса всему объекту
  // не должно быть просто.
  const [remapOpen, setRemapOpen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  useCollapsiblePanels(rootRef, 'patch');

  if (!project) return <main className="view">Жду данные проекта от движка…</main>;

  const remapped = Object.values(project.addressRemap ?? {}).reduce((s, t) => s + Object.keys(t).length, 0);

  /*
   * Порядок панелей — как идёт работа (заказчик 24.09.2026): назвали проект →
   * завели приборы (по одному, несколькими типами, фигурой) → проверили
   * список → и только потом, если монтаж не совпал, переадресация и
   * перенумерация. Свой тип прибора — в самом низу: нужен редко. Раньше
   * переадресация стояла первой, хотя без приборов ей нечего делать.
   */
  return (
    <main className="view" ref={rootRef}>
      <ProjectHeader engine={engine} />
      <AddDevices engine={engine} />
      <DeviceWizard engine={engine} />
      <FigureWizard engine={engine} />
      <DevicesTable engine={engine} />
      <section className="panel">
        <h2>Переадресация каналов</h2>
        <p className="dim">
          Если монтаж не совпал со схемой — не правьте схему. Здесь задаётся, откуда каждый адрес DMX
          берёт значение; схема объекта, сцены и 3D-вид остаются как есть.
        </p>
        <div className="form-row">
          <button className="btn btn-small" onClick={() => setRemapOpen(true)}>
            Открыть переадресацию
          </button>
          {remapped > 0 ? (
            <span className="warn">переадресовано адресов: {remapped}</span>
          ) : (
            <span className="dim">переадресация не используется</span>
          )}
        </div>
      </section>
      {remapOpen && (
        <RemapDialog
          project={project}
          frames={frames}
          onClose={() => setRemapOpen(false)}
          onApply={(remap) => {
            updateProject({ ...project, addressRemap: remap });
            setRemapOpen(false);
          }}
        />
      )}
      <ReaddressPanel project={project} universes={universes} updateProject={updateProject} />
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
          setError(`Добавлено ${i} из ${count}: во вселенной нет ${size} свободных адресов подряд`);
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
      <h2>Добавить приборы</h2>
      <div className="form-row">
        <label className="field">
          Тип:{' '}
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {countOf(p.channels.length, 'адрес', 'адреса', 'адресов')}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Вселенная:{' '}
          <select value={universeId} onChange={(e) => setUniverse(Number(e.target.value))}>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                {universeShort(u)}
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
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> адреса подряд с первого свободного
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

interface WizardRowState {
  key: string;
  profileId: string;
  count: number;
  namePrefix: string;
  customStart: boolean;
  startUniverse: number;
  startAddress: number;
}

/**
 * «Добавить несколько типов сразу» — бывший «Мастер нового объекта» (§27
 * доработки, УХ п.11). Переименован и стал обычной панелью (заказчик
 * 24.09.2026): «мастер» ничем не отличался от добавления приборов, кроме того,
 * что берёт несколько типов за раз, — так и называем. Несколько типов приборов
 * одним заходом, с общим порядком адресации между строками. Не хватает
 * вселенных под перелив — создаём их сами (шлём updateConfig с
 * заглушкой Art-Net/127.0.0.1, как кнопка «+ Вселенная» в Настройках) и
 * предупреждаем, что это на секунду остановит воспроизведение.
 */
function DeviceWizard({ engine }: { engine: EngineConnection }) {
  const { project, universes, engineConfig, updateProject, send } = engine;
  const profiles = allProfiles(project!);
  const [rows, setRows] = useState<WizardRowState[]>(() => [
    {
      key: uid(),
      profileId: profiles[0]?.id ?? 'pump',
      count: 10,
      namePrefix: '',
      customStart: false,
      startUniverse: universes[0]?.id ?? 1,
      startAddress: 1,
    },
  ]);
  const [result, setResult] = useState<{ added: number; newUniverses: number; appliedNow: boolean } | null>(null);

  const newRow = (): WizardRowState => ({
    key: uid(),
    profileId: profiles[0]?.id ?? 'pump',
    count: 10,
    namePrefix: '',
    customStart: false,
    startUniverse: universes[0]?.id ?? 1,
    startAddress: 1,
  });

  const patchRow = (key: string, patch: Partial<WizardRowState>): void => {
    setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const place = (): void => {
    if (!project || !engineConfig) return;
    const wizardRows: WizardRow[] = rows
      .filter((r) => r.count > 0)
      .map((r) => {
        const profile = profiles.find((p) => p.id === r.profileId);
        return {
          profileId: r.profileId,
          count: r.count,
          namePrefix: r.namePrefix.trim() !== '' ? r.namePrefix.trim() : KIND_LABEL[profile?.kind ?? 'other'],
          startUniverse: r.customStart ? r.startUniverse : null,
          startAddress: r.customStart ? r.startAddress : null,
        };
      });
    if (wizardRows.length === 0) return;

    /*
     * Вселенные считаем от ЧЕРНОВИКА, если он есть: человек мог уже добавить
     * вселенную в «Настройках» и не применить её — мастер должен её видеть, а
     * не заводить второй раз под тем же номером.
     */
    const draft = takeSettingsDraft();
    const base = draft ?? { tickMs: engineConfig.tickMs, universes: engineConfig.universes };
    const plan = planDeviceWizard(project, base.universes.map((u) => u.id), wizardRows);
    let appliedNow = false;
    if (plan.newUniverseIds.length > 0) {
      /*
       * Новые вселенные — по тому же рецепту, что и «+ Вселенная» в настройках
       * (nextUniverse): такие же, как последняя. Раньше мастер всегда заводил
       * Art-Net на 127.0.0.1, то есть в никуда — на объекте с интерфейсом
       * FountanPlay приборы на новой вселенной молчали.
       *
       * И применяются они через тот же черновик, что и правки в «Настройках»:
       * отказ движка (например, у USB-адаптера не задан порт) виден в плашке на
       * любой вкладке, а не теряется молча. Если в черновике уже были чужие
       * неприменённые правки — сами их не применяем, только дописываем: пусть
       * человек увидит в плашке всё вместе и применит сам.
       */
      const all: ConfigUniverse[] = [...base.universes];
      for (const id of plan.newUniverseIds) all.push(nextUniverse(all, id));
      keepSettingsDraft({ tickMs: base.tickMs, universes: all });
      if (!draft) {
        applySettingsDraft(send, engine.connected);
        appliedNow = true;
      }
    }
    const devices: PatchedDevice[] = plan.placements.map((p) => ({
      id: uid(),
      name: p.name,
      profileId: p.profileId,
      universe: p.universe,
      address: p.address,
    }));
    updateProject({ ...project, devices: [...project.devices, ...devices] });
    setResult({ added: devices.length, newUniverses: plan.newUniverseIds.length, appliedNow });
    setRows([newRow()]);
  };

  return (
    <section className="panel">
      <h2>Добавить несколько типов сразу</h2>
      <p className="dim">
        Например, 10 насосов, 20 клапанов и 30 светильников одним заходом. Каждая следующая строка продолжает
        адреса с того места, где остановилась предыдущая (в том числе переходя в следующую вселенную), если не
        задан свой начальный адрес. Форсунки в 3D этим не создаются — для этого «Добавить фигуру фонтана» ниже.
      </p>

      {result ? (
        <div className="form-row">
          <span className="ok-text">
            ✔ добавлено приборов: {result.added}
            {result.newUniverses > 0 &&
              (result.appliedNow
                ? ` (новых вселенных: ${result.newUniverses})`
                : ` (новых вселенных: ${result.newUniverses} — ждут применения вместе с другими правками, см. плашку вверху)`)}
          </span>
          <button className="btn btn-icon" onClick={() => requestTab('layout')}>
            <ArrowRightIcon />
            Перейти в 3D и расставить фигурой
          </button>
          <button className="btn btn-small" onClick={() => setResult(null)}>
            Добавить ещё
          </button>
        </div>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>Тип</th>
                <th>Кол-во</th>
                <th data-hint="К имени добавится номер: «Насос» → «Насос 1», «Насос 2»…">Имя</th>
                <th data-hint="Начать с заданной вселенной и адреса, а не с первого свободного">С адреса</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const profile = profiles.find((p) => p.id === r.profileId);
                return (
                  <tr key={r.key}>
                    <td>
                      <select value={r.profileId} onChange={(e) => patchRow(r.key, { profileId: e.target.value })}>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} — {countOf(p.channels.length, 'адрес', 'адреса', 'адресов')}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="input input-num"
                        type="number"
                        min={1}
                        value={r.count}
                        onChange={(e) => patchRow(r.key, { count: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        placeholder={KIND_LABEL[profile?.kind ?? 'other']}
                        value={r.namePrefix}
                        onChange={(e) => patchRow(r.key, { namePrefix: e.target.value })}
                      />
                    </td>
                    <td>
                      <label className="field">
                        <input
                          type="checkbox"
                          checked={r.customStart}
                          onChange={(e) => patchRow(r.key, { customStart: e.target.checked })}
                        />
                        {r.customStart && (
                          <>
                            {' вселенная '}
                            <select
                              value={r.startUniverse}
                              onChange={(e) => patchRow(r.key, { startUniverse: Number(e.target.value) })}
                            >
                              {universes.map((u) => (
                                <option key={u.id} value={u.id}>
                                  {universeShort(u)}
                                </option>
                              ))}
                            </select>
                            {' адрес '}
                            <input
                              className="input input-num"
                              type="number"
                              min={1}
                              max={DMX_UNIVERSE_SIZE}
                              value={r.startAddress}
                              onChange={(e) => patchRow(r.key, { startAddress: Math.max(1, Number(e.target.value)) })}
                            />
                          </>
                        )}
                      </label>
                    </td>
                    <td>
                      <button className="btn btn-small btn-icon btn-glyph" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                        <CloseIcon />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="form-row" style={{ marginTop: 10 }}>
            <button className="btn btn-small btn-icon" onClick={() => setRows([...rows, newRow()])}>
              <PlusIcon />
              Строка
            </button>
            <button className="btn active" disabled={rows.length === 0} onClick={place}>
              Добавить
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function DevicesTable({ engine }: { engine: EngineConnection }) {
  const { project, universes, updateProject } = engine;
  const profiles = useMemo(() => profileMap(project!), [project]);
  const issues = useMemo(() => findPatchIssues(project!), [project]);
  /*
   * Вселенные, которые реально работают в движке. Прибор на номере, которого
   * тут нет, никуда не выводится — такое бывает, если вселенную добавили, но
   * не применили, или убрали, забыв перенести приборы.
   */
  const knownUniverses = useMemo(() => new Set(universes.map((u) => u.id)), [universes]);
  const orphans = project!.devices.filter((d) => !knownUniverses.has(d.universe)).length;
  /**
   * Сколько элементов 3D-схемы использует каждый прибор. Один и тот же прибор
   * можно осознанно привязать в нескольких местах — например, посадить кольцо
   * светильников на общий адрес, когда 512 адресов на объект не хватает. Само
   * по себе это не ошибка, но раньше об этом нигде не сообщалось: привязал в
   * одном месте, забыл, что он уже занят в другом, и получил неожиданную
   * засветку. Считаем по каждой роли, включая дополнительные привязки.
   */
  const layoutUses = useMemo(() => {
    const map = new Map<string, number>();
    const bump = (id: string | null): void => {
      if (id) map.set(id, (map.get(id) ?? 0) + 1);
    };
    const layout = project!.layout;
    for (const n of layout.nozzles) {
      for (const id of nozzlePumpIds(n)) bump(id);
      for (const id of nozzleValveIds(n)) bump(id);
      for (const id of nozzleLightIds(n)) bump(id);
      bump(n.pump2DeviceId);
    }
    for (const l of layout.lights) bump(l.deviceId);
    return map;
  }, [project]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shiftBy, setShiftBy] = useState(1);
  const [trimOpenId, setTrimOpenId] = useState<string | null>(null);
  const [modbusOpenId, setModbusOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [hasDeviceClip, setHasDeviceClip] = useState(() => clipboardHasKind('device'));
  /**
   * Порядок строк, замороженный на время правки адреса. Таблица сортируется по
   * адресу, и раньше при наборе «109» строка переезжала уже на «10», а курсор
   * из поля пропадал (заказчик 24.09.2026). Пока поле адреса в фокусе, строки
   * стоят на месте; вышли из поля — таблица пересортировывается.
   */
  const [frozenOrder, setFrozenOrder] = useState<string[] | null>(null);
  /**
   * Адрес, который набирается прямо сейчас. В прибор он уходит только при
   * выходе из поля или Enter (commitOnBlur): раньше каждое промежуточное
   * число сразу ставило прибор на новый адрес, и, набирая «513» поверх «51»,
   * прибор на миг вставал на 51 — соседний прибор на 51 краснел
   * «пересечением» (заказчик 24–25.09.2026). Теперь проверка набранного —
   * только в своей строке, как предпросмотр; остальные строки не трогаются.
   */
  const [addrDraft, setAddrDraft] = useState<{ id: string; v: number } | null>(null);
  /** Окно «Удалить приборы» (несколько сразу). */
  const [bulkOpen, setBulkOpen] = useState(false);

  // Copy/paste прибора (§27 доработки, УХ п.13) — вставка ищет свободный адрес
  // в той же вселенной, откуда скопирован (авто-адресация, как «Добавить устройства»).
  const pasteDevice = (): void => {
    const src = pasteFromClipboard<PatchedDevice>('device');
    if (!src) return;
    const size = profiles.get(src.profileId)?.channels.length ?? 1;
    const address = nextFreeAddress(project!, src.universe, size, 1);
    if (address === null) {
      window.alert('Во вселенной нет свободного блока адресов под этот прибор.');
      return;
    }
    const m = src.name.match(/^(.*?)(\d+)$/);
    const name = m ? `${m[1]}${Number(m[2]) + 1}` : `${src.name} (копия)`;
    const device: PatchedDevice = { ...src, id: uid(), name, address };
    updateProject({ ...project!, devices: [...project!.devices, device] });
  };

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

  // Сдвиг адресов — «с разрешения» (обсуждение мастера объекта, §27 п.11):
  // сам сдвиг не запрещаем, но если он создаёт пересечение адресов, которого
  // не было — сначала явное подтверждение с именами пострадавших приборов.
  const doShift = async (): Promise<void> => {
    if (selectedIds.length === 0 || shiftBy === 0) return;
    const shifted = shiftDeviceAddresses(project!, selectedIds, shiftBy);
    const before = findPatchIssues(project!).collisions;
    const after = findPatchIssues(shifted).collisions;
    const newlyColliding = [...after].filter((id) => !before.has(id));
    if (newlyColliding.length > 0) {
      const names = newlyColliding.map((id) => shifted.devices.find((d) => d.id === id)?.name ?? id).join(', ');
      const ok = await askConfirm('Сдвинуть адреса с пересечением?', {
        detail: `После сдвига пересекутся адреса: ${names}. Приборы на пересечении будут получать чужие значения.`,
        okLabel: 'Сдвинуть',
      });
      if (!ok) return;
    }
    updateProject(shifted);
  };

  const removeDevice = async (id: string): Promise<void> => {
    const device = project!.devices.find((d) => d.id === id);
    if (device && !(await confirmDelete('прибора', device.name, deviceDependents(project!, id)))) return;
    const scenes = project!.scenes.map((s) => {
      if (!(id in s.values)) return s;
      const values = { ...s.values };
      delete values[id];
      return { ...s, values };
    });
    updateProject({ ...project!, devices: project!.devices.filter((d) => d.id !== id), scenes });
  };

  /**
   * Записи для поиска: всё, чем прибор вообще может быть найден.
   *
   * Раньше фильтр смотрел только на имя, да и поле показывалось лишь когда
   * приборов больше пяти — на маленьком объекте поиска просто не было видно.
   * Теперь ищется и по типу, и по профилю, и по адресу со вселенной.
   */
  const searchRecords: SearchRecord[] = project!.devices.map((d) => {
    const p = profiles.get(d.profileId);
    return {
      id: d.id,
      kind: p?.name ?? 'Прибор',
      label: d.name,
      fields: [
        { field: 'Имя', value: d.name },
        { field: 'Вид', value: DEVICE_KIND_NAMES[p?.kind ?? 'other'] ?? 'Прочее' },
        { field: 'Тип', value: p?.name ?? '' },
        { field: 'Адрес', value: String(d.address) },
        { field: 'Вселенная', value: String(d.universe) },
      ],
    };
  });
  const q = filter.trim().toLowerCase();
  const byAddress = (a: PatchedDevice, b: PatchedDevice): number => a.universe - b.universe || a.address - b.address;
  const frozenAt = (id: string): number => {
    const i = frozenOrder?.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = [...project!.devices]
    .sort(frozenOrder ? (a, b) => frozenAt(a.id) - frozenAt(b.id) || byAddress(a, b) : byAddress)
    .filter((d) => {
      if (q === '') return true;
      const rec = searchRecords.find((r) => r.id === d.id);
      return rec ? rec.fields.some((f) => f.value.toLowerCase().includes(q)) : false;
    });

  return (
    <section className="panel">
      <h2 className="panel-head-row" data-title="Приборы">
        Приборы <span className="dim">({project!.devices.length})</span>
        {issues.collisions.size > 0 && (
          <span className="error-text"> ⚠ пересечения адресов: {issues.collisions.size}</span>
        )}
        {issues.outOfRange.size > 0 && (
          <span className="error-text"> ⚠ за пределами 1–512: {issues.outOfRange.size}</span>
        )}
        {orphans > 0 && (
          <span className="error-text" data-hint="Эти приборы стоят на вселенной, которой нет в движке, и никуда не выводятся">
            {' '}⚠ на незаведённой вселенной: {orphans}
          </span>
        )}
      </h2>
      {project!.devices.length > 0 && (
        <span className="panel-head-search">
          <SmartSearch
            records={searchRecords}
            value={filter}
            onValue={setFilter}
            hint="Поиск по всем свойствам прибора: имя, вид, тип, адрес, вселенная. Находки разложены по тому полю, в котором совпало."
            onPick={(id) => {
              const d = project!.devices.find((x) => x.id === id);
              if (d) setFilter(d.name);
            }}
          />
        </span>
      )}
      {project!.devices.length === 0 ? (
        <div className="dim">Пока пусто — добавьте приборы выше.</div>
      ) : sorted.length === 0 ? (
        <div className="dim">Ничего не найдено по «{filter}».</div>
      ) : (
        <>
          <div className="form-row">
            <span className="dim" data-hint="Меняет адреса в самой схеме объекта. Если схема верна, а перепутан монтаж — это не сюда, а в «Переадресацию каналов» выше">
              Перепутаны или заменены приборы — обменять и сдвинуть адреса в схеме: отметьте приборы →
            </span>
            <button
              className="btn btn-icon"
              disabled={selectedIds.length !== 2}
              data-hint="Обменять адреса и вселенные двух отмеченных устройств"
              onClick={doSwap}
            >
              <SwapIcon />
              Обменять адреса{selectedIds.length === 2 ? '' : ' (нужно 2)'}
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
            <button className="btn" disabled={selectedIds.length === 0 || shiftBy === 0} onClick={() => void doShift()}>
              Сдвинуть адреса (выбрано {selectedIds.length})
            </button>
            {selectedIds.length > 0 && (
              <button className="btn btn-small" onClick={() => setSelected(new Set())}>
                снять выбор
              </button>
            )}
            <button
              className="btn btn-danger"
              data-hint="Удалить несколько приборов сразу: отмеченные, все насосы, все клапаны, все светильники, приборы одной фигуры или все. Перед удалением покажет, что именно и где эти приборы используются"
              onClick={() => setBulkOpen(true)}
            >
              Удалить приборы…
            </button>
            {hasDeviceClip && (
              <button className="btn btn-small" onClick={pasteDevice}>
                Вставить прибор
              </button>
            )}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>
                  {/* Отметить все видимые строки — для обмена, сдвига и группового удаления. */}
                  <input
                    type="checkbox"
                    data-hint={sorted.every((d) => selected.has(d.id)) ? 'Снять отметку со всех' : 'Отметить все приборы в списке'}
                    checked={sorted.length > 0 && sorted.every((d) => selected.has(d.id))}
                    onChange={(e) => setSelected(e.target.checked ? new Set(sorted.map((d) => d.id)) : new Set())}
                  />
                </th>
                <th>Имя</th>
                <th data-hint="Тип прибора — он задаёт, сколько у прибора каналов и что каждый из них значит">
                  Тип
                </th>
                <th>Вселенная</th>
                <th>Адрес</th>
                <th>Диапазон</th>
                <th data-hint="Сколько элементов 3D-схемы (форсунок и прожекторов) используют этот прибор. Больше одного — прибор работает сразу в нескольких местах: так бывает намеренно, когда группу светильников сажают на общий адрес, но об этом лучше знать">
                  Привязок
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const range = deviceRange(d, profiles);
                const typedRaw = addrDraft?.id === d.id ? addrDraft.v : null;
                // Набирается другое число — показываем, что будет с ним, а не с прошлым.
                const typed = typedRaw !== null && typedRaw !== d.address ? typedRaw : null;
                const size = range.end - range.start + 1;
                const typedOut = typed !== null && (typed < 1 || typed + size - 1 > DMX_UNIVERSE_SIZE);
                const typedClash =
                  typed !== null && !typedOut
                    ? sorted.find((o) => {
                        if (o.id === d.id || o.universe !== d.universe) return false;
                        const r = deviceRange(o, profiles);
                        return r.start <= typed + size - 1 && r.end >= typed;
                      }) ?? null
                    : null;
                const bad = typed !== null ? typedOut || typedClash !== null : issues.collisions.has(d.id) || issues.outOfRange.has(d.id);
                const profile = profiles.get(d.profileId);
                const trimOpen = trimOpenId === d.id;
                const modbusOpen = modbusOpenId === d.id;
                // Строка прибора и раскрытые под ней панели — одним куском с ключом прибора:
                // иначе при пересортировке React пересоздавал строку по месту, и поле
                // адреса пропадало прямо во время набора.
                return (
                  <Fragment key={d.id}>
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
                      <RdmBadge device={d} engine={engine} />
                    </td>
                    <td>{profile?.name ?? d.profileId}</td>
                    <td>
                      <select
                        value={d.universe}
                        className={knownUniverses.has(d.universe) ? undefined : 'input-error'}
                        data-hint={
                          knownUniverses.has(d.universe)
                            ? undefined
                            : `Вселенной ${d.universe} в движке нет — прибор никуда не выводится. Заведите её в «Настройках» или перенесите прибор на другую.`
                        }
                        onChange={(e) => patchDevice(d.id, { universe: Number(e.target.value) })}
                      >
                        {/*
                          Прибор на вселенной, которой нет, показываем как есть. Иначе
                          список молча показал бы первую вселенную, и человек думал бы, что
                          прибор на ней.
                        */}
                        {!knownUniverses.has(d.universe) && (
                          <option value={d.universe}>{d.universe} — не заведена</option>
                        )}
                        {universes.map((u) => (
                          <option key={u.id} value={u.id}>
                            {universeShort(u)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <NumInput
                        integer
                        min={1}
                        max={DMX_UNIVERSE_SIZE}
                        value={d.address}
                        onFocus={() => setFrozenOrder(sorted.map((x) => x.id))}
                        onBlur={() => setFrozenOrder(null)}
                        onDraft={(v) => setAddrDraft(v === null ? null : { id: d.id, v })}
                        onChange={(v) => patchDevice(d.id, { address: v })}
                        commitOnBlur
                        hint="Адрес первого канала. Меняется, когда выйдете из поля или нажмёте Enter; Esc — оставить как было"
                      />
                    </td>
                    {typed !== null ? (
                      <td
                        className="dim"
                        data-hint={
                          typedOut
                            ? `Адрес прибора — от 1 до ${DMX_UNIVERSE_SIZE}: во вселенной DMX всего ${DMX_UNIVERSE_SIZE} адресов. Выйдете из поля — адрес подрежется до ближайшего допустимого.`
                            : 'Так будет, когда выйдете из поля или нажмёте Enter'
                        }
                      >
                        {typed}–{typed + size - 1}
                        {typedOut && <span className="error-text"> вне 1–{DMX_UNIVERSE_SIZE}</span>}
                        {typedClash && <span className="error-text"> пересечение с «{typedClash.name}»</span>}
                      </td>
                    ) : (
                      <td className="dim">
                        {range.start}–{range.end}
                        {issues.collisions.has(d.id) && <span className="error-text"> пересечение</span>}
                        {issues.outOfRange.has(d.id) && <span className="error-text"> вне 1–{DMX_UNIVERSE_SIZE}</span>}
                      </td>
                    )}
                    <td
                      className={(layoutUses.get(d.id) ?? 0) > 1 ? 'warn' : 'dim'}
                      data-hint={
                        (layoutUses.get(d.id) ?? 0) > 1
                          ? 'Прибор привязан к нескольким элементам схемы — он работает сразу во всех'
                          : (layoutUses.get(d.id) ?? 0) === 0
                            ? 'Прибор не привязан ни к одному элементу 3D-схемы'
                            : 'Прибор привязан к одному элементу схемы'
                      }
                    >
                      {layoutUses.get(d.id) ?? 0}
                    </td>
                    <td className="cell-actions">
                      <button
                        className={d.trim ? 'btn btn-small active btn-icon btn-glyph' : 'btn btn-small btn-icon btn-glyph'}
                        data-hint="Калибровка: нижняя и верхняя граница каждого канала"
                        onClick={() => setTrimOpenId(trimOpen ? null : d.id)}
                      >
                        <GearIcon />
                      </button>{' '}
                      {profile?.kind === 'pump' && (
                        <button
                          className={d.modbus ? 'btn btn-small active' : 'btn btn-small'}
                          data-hint="Управлять частотником (ПЧ) насоса напрямую по Modbus, минуя DMX"
                          onClick={() => setModbusOpenId(modbusOpen ? null : d.id)}
                        >
                          ПЧ
                        </button>
                      )}{' '}
                      <button
                        className="btn btn-small btn-icon btn-glyph"
                        data-hint="Копировать прибор"
                        onClick={() => {
                          copyToClipboard('device', d);
                          setHasDeviceClip(true);
                        }}
                      >
                        <CopyIcon />
                      </button>{' '}
                      <button className="btn btn-small btn-icon btn-glyph" onClick={() => void removeDevice(d.id)}>
                        <CloseIcon />
                      </button>
                    </td>
                  </tr>
                  {trimOpen && profile ? (
                    <tr key={`${d.id}-trim`}>
                      <td colSpan={7}>
                        <TrimEditor
                          device={d}
                          profile={profile}
                          onChange={(trim) => patchDevice(d.id, { trim })}
                        />
                      </td>
                    </tr>
                  ) : null}
                  {modbusOpen ? (
                    <tr key={`${d.id}-modbus`}>
                      <td colSpan={7}>
                        <ModbusEditor
                          engine={engine}
                          device={d}
                          status={engine.modbus?.pumps.find((p) => p.deviceId === d.id) ?? null}
                          onChange={(modbus) => patchDevice(d.id, { modbus })}
                        />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {bulkOpen && (
        <BulkDeleteDialog
          project={project!}
          selectedIds={selectedIds}
          onClose={() => setBulkOpen(false)}
          onDelete={(ids) => {
            updateProject(removeDevices(project!, ids));
            setSelected(new Set());
          }}
        />
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
        Калибровка «{device.name}»: 0 так и остаётся нулём (выключено), а 1–255 укладываются между нижней и верхней границей ниже.
      </span>
      {profile.channels.map((c, k) => (
        <label className="field" key={k}>
          {c.name}: от{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={255}
            value={trim[k]!.min}
            onChange={(e) => set(k, { min: Number(e.target.value) })}
          />{' '}
          до{' '}
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

/**
 * Отвечает ли прибор по RDM — прямо в строке «Оборудования».
 *
 * RDM показывал связь только на «Диагностике», отдельным списком по UID, и
 * чтобы понять «жив ли вот этот светильник», приходилось сличать номера
 * глазами. Теперь у привязанного прибора стоит «✔», а если нода его не видит
 * — жёлтый «⚠» и в подсказке написано, что именно проверять на объекте.
 *
 * У приборов БЕЗ привязки к RDM значка нет вовсе: их состояние по кабелю
 * узнать нечем, и зелёная галочка там была бы обманом.
 */
function RdmBadge({ device, engine }: { device: PatchedDevice; engine: EngineConnection }) {
  const uid = device.rdmUid;
  if (!uid) return null;
  const found = engine.network?.rdmDevices.find((x) => x.uid.toLowerCase() === uid.toLowerCase());
  if (found && !found.lost) {
    return (
      <span className="rdm-ok" data-hint={`Прибор отвечает по RDM (UID ${found.uid}, узел ${found.nodeIp}). Связь по кабелю есть.`}>
        {' '}
        ✔
      </span>
    );
  }
  const hint = found
    ? `Прибор отвечал по RDM, но перестал (UID ${found.uid}, узел ${found.nodeIp}). Проверьте: питание прибора, кабель DMX до него и терминатор на конце линии; не отключилась ли нода.`
    : `Прибор привязан к RDM (UID ${uid}), но нода его не видит. Проверьте: включено ли питание прибора, целость кабеля DMX и разъёмов, умеет ли нода RDM и включён ли у неё опрос, не сменился ли UID после замены прибора (привязка — «Диагностика» → «RDM-приборы»).`;
  return (
    <span className="rdm-bad" data-hint={hint}>
      {' '}
      ⚠
    </span>
  );
}

/** Дефолты — карта регистров Elhart EMD-PUMP (github.com/BelikGM/Modbus); для другого ПЧ сверить с его картой. */
function defaultModbusConfig(): ModbusPumpConfig {
  return {
    connection: { kind: 'tcp', host: '', port: 502 },
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
  engine,
  device,
  status,
  onChange,
}: {
  engine: EngineConnection;
  device: PatchedDevice;
  status: PumpModbusStatus | null;
  onChange: (modbus: ModbusPumpConfig | undefined) => void;
}) {
  const enabled = device.modbus !== undefined;
  const config = device.modbus ?? defaultModbusConfig();
  const [presetId, setPresetId] = useState('custom');
  const preset = vfdPreset(presetId);

  const set = (patch: Partial<ModbusPumpConfig>): void => onChange({ ...config, ...patch });
  const setTcp = (patch: Partial<Extract<ModbusConnection, { kind: 'tcp' }>>): void => {
    if (config.connection.kind !== 'tcp') return;
    onChange({ ...config, connection: { ...config.connection, ...patch } });
  };
  const setRtu = (patch: Partial<Extract<ModbusConnection, { kind: 'rtu' }>>): void => {
    if (config.connection.kind !== 'rtu') return;
    onChange({ ...config, connection: { ...config.connection, ...patch } });
  };

  /**
   * Пресет заполняет адреса регистров разом. Подключение (порт, скорость,
   * адрес прибора) при этом не трогаем — оно про монтаж, а не про модель ПЧ.
   */
  const applyPreset = (id: string): void => {
    const p = vfdPreset(id);
    if (!p) return;
    setPresetId(id);
    if (id === 'custom') return;
    onChange({ ...config, ...p.map });
  };

  return (
    <div className="trim-editor">
      <label className="field">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? config : undefined)}
        />{' '}
        Управлять частотником (ПЧ) «{device.name}» напрямую по Modbus, минуя DMX
      </label>
      {enabled && (
        <>
          <div className="form-row">
            <label className="field" data-hint="Заполняет адреса регистров под выбранную серию. Любое поле потом правится руками — список не закрытый.">
              Модель ПЧ:{' '}
              <select className="input" value={presetId} onChange={(e) => applyPreset(e.target.value)}>
                {VFD_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {preset && <span className="dim">{preset.note}</span>}
          </div>
          {status && (
            <p className="dim">
              Здоровье насоса:{' '}
              <b className={status.connected ? '' : 'error-text'}>{status.connected ? 'на связи' : 'нет связи'}</b>
              {' · '}уставка {status.lastFreqHz} Гц
              {status.currentA !== null && ` · ток ${num(status.currentA, 1)} А`}
              {status.speedRpm !== null && ` · ${Math.round(status.speedRpm)} об/мин`}
              {status.tempC !== null && ` · ${num(status.tempC, 1)} °C`}
              {status.faultCode !== null && status.faultCode !== 0 && (
                <span className="error-text"> · авария, код {status.faultCode}</span>
              )}
              {status.lastError && <span className="warn"> · {status.lastError}</span>}
            </p>
          )}
        </>
      )}
      {enabled && (
        <>
          {/* Строка здоровья насоса — одна, выше, у выбора модели ПЧ. Здесь была
              её копия, и в одной из двух обороты были подписаны герцами. */}
          <div className="form-row">
            <label className="field">
              Подключение:{' '}
              <select
                value={config.connection.kind}
                onChange={(e) =>
                  set({
                    connection:
                      e.target.value === 'tcp'
                        ? { kind: 'tcp', host: '', port: 502 }
                        : { kind: 'rtu', serialPort: 'COM5', baudRate: 9600 },
                  })
                }
              >
                <option value="tcp">TCP (шлюз RTU↔TCP по сети)</option>
                <option value="rtu">RS-485 (USB-адаптер, COM-порт)</option>
              </select>
            </label>
            <label className="field">
              Адрес ПЧ в сети Modbus:{' '}
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
                <input className="input" value={config.connection.host} placeholder="192.168.0.10" onChange={(e) => setTcp({ host: e.target.value })} />
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
                <ComPortPicker engine={engine} value={config.connection.serialPort} onChange={(v) => setRtu({ serialPort: v })} />
              </label>
              <label className="field">
                Скорость порта, бод:{' '}
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
              Единиц регистра на 1 Гц:{' '}
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
                placeholder="—"
                data-hint="Пусто — пуск и стоп не посылаются, насос управляется только уставкой частоты"
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
                placeholder="—"
                data-hint="Пусто — код аварии не опрашивается"
                onChange={(e) => set({ faultRegister: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="dim" style={{ marginTop: 4 }}>
            Телеметрия — что показывать в строке «Здоровье насоса». Пустое поле — этот регистр не опрашивается.
            Опрос раз в 3 с, вместе с кодом аварии.
          </p>
          <div className="form-row">
            <label className="field">
              Регистр тока:{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                value={config.currentRegister ?? ''}
                placeholder="—"
                data-hint="Пусто — этот регистр не опрашивается"
                onChange={(e) => set({ currentRegister: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Единиц регистра на 1 А:{' '}
              <input
                className="input input-num"
                type="number"
                min={1}
                disabled={config.currentRegister === undefined}
                value={config.currentScale ?? 100}
                onChange={(e) => set({ currentScale: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              Регистр оборотов:{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                value={config.speedRegister ?? ''}
                placeholder="—"
                data-hint="Пусто — этот регистр не опрашивается"
                onChange={(e) => set({ speedRegister: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Единиц регистра на 1 об/мин:{' '}
              <input
                className="input input-num"
                type="number"
                min={1}
                disabled={config.speedRegister === undefined}
                value={config.speedScale ?? 1}
                onChange={(e) => set({ speedScale: Number(e.target.value) })}
              />
            </label>
          </div>
          <div className="form-row">
            <label className="field">
              Регистр температуры:{' '}
              <input
                className="input input-num"
                type="number"
                min={0}
                value={config.tempRegister ?? ''}
                placeholder="—"
                data-hint="Пусто — этот регистр не опрашивается"
                onChange={(e) => set({ tempRegister: e.target.value === '' ? undefined : Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Единиц регистра на 1 °C:{' '}
              <input
                className="input input-num"
                type="number"
                min={1}
                disabled={config.tempRegister === undefined}
                value={config.tempScale ?? 10}
                onChange={(e) => set({ tempScale: Number(e.target.value) })}
              />
            </label>
          </div>
          <span className="dim">
            Значения по умолчанию — карта регистров Elhart EMD-PUMP: 8193 = уставка частоты (сотые Гц), 8192 = команда
            (2=пуск, 1=стоп), 10 = код последней аварии. Для другой модели ПЧ (и телеметрии) сверьте с её картой
            регистров.
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

  /*
   * Панель называлась «Типы приборов» и начиналась со списка — было непонятно,
   * что здесь можно завести СВОЙ тип (заказчик 24.09.2026). Теперь название
   * говорит, зачем панель, форма сверху, список всех типов — под ней.
   */
  return (
    <section className="panel">
      <h2>Создать свой тип прибора</h2>
      <p className="dim">
        Нужного прибора нет в списке «Тип» — заведите свой: название, вид и каналы по порядку адресов. Ниже — все
        типы, которые уже есть.
      </p>
      <ProfileForm
        name={name}
        setName={setName}
        kind={kind}
        setKind={setKind}
        twoState={twoState}
        setTwoState={setTwoState}
        channels={channels}
        setChannels={setChannels}
        onCreate={createProfile}
      />
      <h3>Все типы приборов</h3>
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
                  {p.twoState && <span className="badge" data-hint="Только два положения: 0 или 255 — как у клапана">2 положения</span>}
                </td>
                <td>{KIND_LABEL[p.kind]}</td>
                <td className="dim">{p.channels.map((c) => c.name).join(', ')}</td>
                <td>
                  {!p.builtin && (
                    <button
                      className="btn btn-small btn-icon btn-glyph"
                      disabled={used}
                      data-hint={used ? 'Этот тип стоит у приборов — сначала смените им тип' : 'Удалить'}
                      onClick={() => removeProfile(p.id)}
                    >
                      <CloseIcon />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Форма нового типа прибора (вынесена, чтобы стоять над списком типов). */
function ProfileForm({
  name,
  setName,
  kind,
  setKind,
  twoState,
  setTwoState,
  channels,
  setChannels,
  onCreate,
}: {
  name: string;
  setName: (v: string) => void;
  kind: DeviceKind;
  setKind: (v: DeviceKind) => void;
  twoState: boolean;
  setTwoState: (v: boolean) => void;
  channels: { name: string; role: ChannelRole }[];
  setChannels: (v: { name: string; role: ChannelRole }[]) => void;
  onCreate: () => void;
}) {
  const createProfile = onCreate;
  return (
    <>
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
          только два положения: 0 или 255 (как клапан)
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
              className="btn btn-small btn-icon btn-glyph"
              disabled={channels.length <= 1}
              onClick={() => setChannels(channels.filter((_, j) => j !== i))}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
        <div className="form-row">
          <button
            className="btn btn-icon"
            onClick={() => setChannels([...channels, { name: `Канал ${channels.length + 1}`, role: 'custom' }])}
          >
            <PlusIcon />
            канал
          </button>
          <button className="btn active" onClick={createProfile} disabled={name.trim() === ''}>
            Создать тип
          </button>
        </div>
      </div>
    </>
  );
}
