import { useState } from 'react';
import { allProfiles, profileMap, type PatchedDevice, type Project,
  universeShort,
  universeTitle,
} from '@fountain-studio/shared';
import { askConfirm } from './ConfirmDialog';

/**
 * Перенумерация DMX-адресов с группировкой по видам приборов.
 *
 * Зачем. Адреса выдавались по мере добавления приборов, поэтому свет, насосы и
 * клапаны оказывались вперемешку, а после удалений между ними оставались дыры.
 * Разбираться в такой карте на объекте тяжело: непонятно, где кончается одна
 * группа и начинается другая, и нельзя сказать монтажнику «свет — до 280-го».
 *
 * Что делает. Складывает приборы по видам в заданном порядке (по умолчанию
 * сначала весь свет, потом насосы, потом клапаны, потом остальное), внутри вида
 * сохраняет прежний порядок адресов и раскладывает подряд без пропусков.
 *
 * Что НЕ ломает. Сцены, шоу и 3D-привязки ссылаются на приборы по id, а не по
 * адресу, — они переживают перенумерацию без изменений. Меняются только адреса
 * в патче, то есть то, что надо выставить на самих приборах.
 *
 * Обязательности в этом нет: после перенумерации любой адрес правится руками,
 * хоть свет посреди клапанов.
 */

/**
 * Виды, которые можно расставить в своём порядке.
 *
 * Раньше порядок был жёстко зашит (свет → насосы → клапаны), хотя на объекте
 * его выбирают под монтаж: где-то удобнее пустить первыми насосы, где-то
 * клапаны. Комбинаций всего шесть, и навязывать одну из них не за что —
 * пусть переставляет кнопками.
 */
const KINDS: { kind: string; label: string }[] = [
  { kind: 'lamp', label: 'Свет' },
  { kind: 'pump', label: 'Насосы' },
  { kind: 'valve', label: 'Клапаны' },
];
/** Порядок по умолчанию — тот же, что был раньше. */
const DEFAULT_ORDER = KINDS.map((k) => k.kind);

interface Plan {
  devices: PatchedDevice[];
  moved: number;
  /** Строки отчёта: вид, диапазон адресов, сколько приборов. */
  ranges: string[];
  overflow: string[];
}

/** Считает новую раскладку, ничего не меняя. */
export function planReaddress(
  project: Project,
  universeId: number,
  gap: number,
  start: number,
  /** Порядок видов; не перечисленные идут следом в исходном порядке. */
  kindOrder: string[] = DEFAULT_ORDER,
): Plan {
  const profiles = profileMap(project);
  const kindOf = (d: PatchedDevice): string => profiles.get(d.profileId)?.kind ?? 'прочее';
  const sizeOf = (d: PatchedDevice): number => profiles.get(d.profileId)?.channels.length ?? 1;

  const inUniverse = project.devices
    .filter((d) => d.universe === universeId)
    .sort((a, b) => a.address - b.address);

  const order = [...kindOrder, ...new Set(inUniverse.map(kindOf))];
  const seen = new Set<string>();
  const kinds = order.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));

  const next = new Map<string, number>();
  const ranges: string[] = [];
  const overflow: string[] = [];
  let cursor = Math.max(1, Math.round(start));

  for (const kind of kinds) {
    const list = inUniverse.filter((d) => kindOf(d) === kind);
    if (list.length === 0) continue;
    const from = cursor;
    for (const d of list) {
      const size = sizeOf(d);
      if (cursor + size - 1 > 512) {
        overflow.push(`${d.name}: не помещается, нужен адрес ${cursor}`);
        continue;
      }
      next.set(d.id, cursor);
      cursor += size;
    }
    const to = cursor - 1;
    const label = KINDS.find((k) => k.kind === kind)?.label ?? kind;
    ranges.push(`${label}: ${from}–${to} (${list.length} шт.)`);
    // Зазор между видами — чтобы потом было куда добавить прибор, не сдвигая всё.
    cursor += Math.max(0, Math.round(gap));
  }

  const devices = project.devices.map((d) => {
    const addr = next.get(d.id);
    return addr !== undefined && addr !== d.address ? { ...d, address: addr } : d;
  });
  const moved = devices.filter((d, i) => d.address !== project.devices[i]!.address).length;
  return { devices, moved, ranges, overflow };
}

export function ReaddressPanel({
  project,
  universes,
  updateProject,
}: {
  project: Project;
  universes: { id: number; label?: string; outputs: string[] }[];
  updateProject: (p: Project) => void;
}) {
  const [universeId, setUniverseId] = useState(universes[0]?.id ?? 1);
  const [gap, setGap] = useState(0);
  const [start, setStart] = useState(1);
  const [order, setOrder] = useState<string[]>(DEFAULT_ORDER);
  const plan = planReaddress(project, universeId, gap, start, order);
  /** Поменять вид местами с соседом — так набирается любой из шести порядков. */
  const swap = (i: number, dir: -1 | 1): void => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    const a = next[i];
    const b = next[j];
    if (a === undefined || b === undefined) return;
    next[i] = b;
    next[j] = a;
    setOrder(next);
  };
  const labelOf = (kind: string): string => KINDS.find((k) => k.kind === kind)?.label ?? kind;
  const kindsPresent = new Set(
    project.devices
      .filter((d) => d.universe === universeId)
      .map((d) => profileMap(project).get(d.profileId)?.kind ?? 'прочее'),
  );
  void allProfiles;

  const apply = async (): Promise<void> => {
    const ok = await askConfirm(`Перенумеровать адреса вселенной ${universeId}?`, {
      detail:
        `Сменят адрес приборов: ${plan.moved}. ` +
        `Сцены, шоу и 3D-привязки не пострадают — они ссылаются на приборы, а не на адреса. ` +
        `Но адреса придётся переставить и на самих приборах.`,
      okLabel: 'Перенумеровать',
    });
    if (!ok) return;
    updateProject({ ...project, devices: plan.devices });
  };

  return (
    <section className="panel">
      <h2>Перенумеровать адреса по видам</h2>
      <p className="dim">
        Раскладывает приборы вселенной подряд, без дыр, видами в заданном ниже порядке. Внутри вида
        порядок сохраняется. Нужна, когда адреса выдавались вперемешку или после удалений остались
        пропуски. Сцены и 3D не пострадают — они привязаны к приборам, а не к адресам. Любой адрес
        потом правится руками.
      </p>
      <div className="form-row">
        <span className="quick-row-label" data-hint="В этом порядке виды и лягут на адреса. Стрелками переставьте под свой монтаж.">
          Порядок видов:
        </span>
        {order.map((kind, i) => (
          <span className="readdress-kind" key={kind}>
            <span className="readdress-kind-name">
              {i + 1}. {labelOf(kind)}
            </span>
            {i < order.length - 1 && (
              <button
                className="btn btn-small readdress-swap"
                data-hint="Поменять эти два вида местами"
                onClick={() => swap(i, 1)}
              >
                <span>⇄</span>
              </button>
            )}
          </span>
        ))}
        <button className="btn btn-small" onClick={() => setOrder(DEFAULT_ORDER)} data-hint="Свет, насосы, клапаны">
          Сбросить
        </button>
      </div>
      <div className="form-row">
        <span className="quick-row-label">Вселенная:</span>
        {universes.map((u) => (
          <button
            key={u.id}
            className={u.id === universeId ? 'btn btn-small state-on' : 'btn btn-small'}
            data-hint={[universeTitle(u), ...u.outputs].join('\n')}
            onClick={() => setUniverseId(u.id)}
          >
            {universeShort(u)}
          </button>
        ))}
        <label className="field">
          С адреса:{' '}
          <input
            className="input input-num"
            type="number"
            min={1}
            max={512}
            value={start}
            onChange={(e) => setStart(Math.min(512, Math.max(1, Math.round(Number(e.target.value) || 1))))}
          />
        </label>
        <label className="field" data-hint="Свободные адреса между видами — чтобы потом было куда добавить прибор">
          Зазор:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={64}
            value={gap}
            onChange={(e) => setGap(Math.min(64, Math.max(0, Math.round(Number(e.target.value) || 0))))}
          />
        </label>
      </div>
      {kindsPresent.size === 0 ? (
        <p className="dim">Во вселенной нет приборов.</p>
      ) : (
        <>
          <p className="dim">Получится так: {plan.ranges.join(' · ')}</p>
          {plan.overflow.length > 0 && <p className="warn">Не помещается: {plan.overflow.join('; ')}</p>}
          <div className="form-row">
            <button className="btn btn-small" disabled={plan.moved === 0} onClick={() => void apply()}>
              Перенумеровать
            </button>
            <span className="dim">
              {plan.moved === 0 ? 'адреса уже разложены так' : `сменят адрес: ${plan.moved}`}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
