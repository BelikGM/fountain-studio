import { useEffect, useMemo, useRef, useState } from 'react';
import { DMX_UNIVERSE_SIZE, profileMap, type Project,
  universeShort,
  universeTitle,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/**
 * Поток DMX/RDM — что именно уходит в линию и что приходит обратно.
 *
 * Зачем нужна отдельная вкладка. Пока всё работает, кадры никого не волнуют.
 * Но на пусконаладке главный вопрос всегда один: «прибор не реагирует — это
 * мы не шлём или он не принимает?» Ответить на него можно, только увидев сам
 * поток: какие адреса заняты, какие значения там стоят, и совпадает ли то,
 * что задумано, с тем, что физически уходит в кабель.
 *
 * Поэтому кадр показывается на РАЗНЫХ УЧАСТКАХ пути:
 *  · «Выход» — что насчитал движок (шоу ⊕ ручные фейдеры, калибровка, ветер);
 *  · «В кабель» — то же самое ПОСЛЕ переадресации, то есть буквально байты,
 *    которые уходят в провод. Если переадресация настроена, эти два столбца
 *    расходятся — и это первое, что надо проверять при «прибор не тот»;
 *  · «Вход» — чужой Art-Net, пришедший на этот компьютер (сторонний пульт, вторая
 *    программа, «кто-то ещё шлёт в ту же вселенную»).
 *
 * И в разных разрезах: по вселенным, по видам приборов (насосы, клапаны,
 * свет), с цветом по виду — так сразу видно, куда ушло значение.
 */

type Stage = 'out' | 'wire' | 'in';
type RoleFilter = 'all' | 'pump' | 'valve' | 'lamp' | 'other';
type ViewMode = 'bars' | 'grid' | 'list';

const STAGES: { id: Stage; label: string; hint: string }[] = [
  { id: 'out', label: 'Выход', hint: 'Что насчитал движок: воспроизведение и ручные ползунки «Отладки», потом калибровка, ветер и служебный свет' },
  { id: 'wire', label: 'В кабель', hint: 'Те же данные ПОСЛЕ переадресации — буквально байты, уходящие в провод. Расходятся с «Выходом» только если настроена переадресация' },
  { id: 'in', label: 'Вход', hint: 'Чужой Art-Net, пришедший на этот компьютер: сторонний пульт, вторая программа, дублирующий источник' },
];

/**
 * Вид прибора берётся из его профиля. «Прочее» — это НЕ свободные адреса:
 * это приборы, которым в профиле выбран вид «прочее», потому что они не
 * насос, не клапан и не свет: дым-машина, вентилятор, реле, пламя. Свободные
 * адреса не относятся ни к какому виду и видны только под фильтром «Все».
 */
const ROLES: { id: RoleFilter; label: string; color: string; hint: string }[] = [
  { id: 'all', label: 'Все', color: '#9aa3ad', hint: 'Все 512 адресов вселенной, включая свободные' },
  { id: 'pump', label: 'Насосы', color: '#4fa3ff', hint: 'Адреса насосов — высота струй' },
  { id: 'valve', label: 'Клапаны', color: '#ff6b6b', hint: 'Адреса клапанов — вода есть или нет' },
  { id: 'lamp', label: 'Свет', color: '#ffd166', hint: 'Адреса светильников — цвет и яркость' },
  {
    id: 'other',
    label: 'Прочее',
    color: '#8f9aa6',
    hint: 'Приборы, которым в типе выбран вид «прочее»: не насос, не клапан и не свет — дым, вентилятор, реле, пламя. Свободные адреса сюда НЕ попадают, они только под «Все»',
  },
];

/** Какому виду прибора принадлежит каждый адрес вселенной. */
function addressKinds(project: Project | null, universe: number): (RoleFilter | null)[] {
  const map: (RoleFilter | null)[] = new Array(DMX_UNIVERSE_SIZE).fill(null);
  if (!project) return map;
  const profiles = profileMap(project);
  for (const d of project.devices) {
    if (d.universe !== universe) continue;
    const p = profiles.get(d.profileId);
    if (!p) continue;
    const kind: RoleFilter =
      p.kind === 'pump' ? 'pump' : p.kind === 'valve' ? 'valve' : p.kind === 'lamp' ? 'lamp' : 'other';
    for (let k = 0; k < p.channels.length; k++) {
      const idx = d.address - 1 + k;
      if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) map[idx] = kind;
    }
  }
  return map;
}

export function StreamView({ engine }: { engine: EngineConnection }) {
  const { project, frames, wireFrames, universes, network, requestDmxCapture } = engine;
  /**
   * Входящий Art-Net движок отдаёт не потоком, а по запросу: держать его в
   * общей рассылке дорого, а нужен он редко. Поэтому опрашиваем сами и только
   * пока на экране выбран участок «Вход».
   */
  const [capture, setCapture] = useState<Record<number, { data: Uint8Array; ageMs: number; fromIp: string; frames: number }>>({});
  const [universe, setUniverse] = useState<number | 'all'>(universes[0]?.id ?? 1);
  const [stage, setStage] = useState<Stage>('out');
  const [role, setRole] = useState<RoleFilter>('all');
  const [mode, setMode] = useState<ViewMode>('bars');
  const [hover, setHover] = useState<{ ch: number; value: number } | null>(null);

  const shown = useMemo(
    () => (universe === 'all' ? universes.map((u) => u.id) : [universe]),
    [universe, universes],
  );

  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    if (stage !== 'in') return;
    let live = true;
    const poll = async (): Promise<void> => {
      for (const u of shownRef.current) {
        const got = await requestDmxCapture(u);
        if (!live) return;
        setCapture((prev) => (got ? { ...prev, [u]: got } : prev));
      }
    };
    void poll();
    const t = window.setInterval(() => void poll(), 500);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [stage, requestDmxCapture]);

  return (
    <main className="view">
      <section className="panel">
        <h2>Поток DMX</h2>
        <p className="dim">
          Что уходит приборам и что приходит обратно. Три участка одного пути:{' '}
          <b>Выход</b> — что насчитал движок; <b>В кабель</b> — то же самое после переадресации, буквально
          байты в проводе; <b>Вход</b> — чужой Art-Net, пришедший на этот компьютер (сторонний пульт, вторая
          программа).
        </p>
        <p className="dim">
          Главное на пусконаладке: сравнить «Выход» и «В кабель». Совпадают — переадресация ни при чём,
          искать в расчёте; расходятся — виновата переадресация. Без настроенной переадресации они
          всегда одинаковы.
        </p>
        <div className="form-row">
          <span className="quick-row-label">Участок:</span>
          {STAGES.map((s) => (
            <button
              key={s.id}
              className={s.id === stage ? 'btn btn-small state-on' : 'btn btn-small'}
              data-hint={s.hint}
              onClick={() => setStage(s.id)}
            >
              {s.label}
            </button>
          ))}
          <span className="spacer" />
          <span className="quick-row-label">Вселенная:</span>
          {universes.map((u) => (
            <button
              key={u.id}
              className={u.id === universe ? 'btn btn-small state-on' : 'btn btn-small'}
              data-hint={[universeTitle(u), ...u.outputs].join('\n')}
              onClick={() => setUniverse(u.id)}
            >
              {universeShort(u)}
            </button>
          ))}
          <button
            className={universe === 'all' ? 'btn btn-small state-on' : 'btn btn-small'}
            data-hint="Показать все вселенные подряд, одна под другой"
            onClick={() => setUniverse('all')}
          >
            Все
          </button>
        </div>
        <div className="form-row">
          <span className="quick-row-label">Вид приборов:</span>
          {ROLES.map((r) => (
            <button
              key={r.id}
              className={r.id === role ? 'btn btn-small state-on' : 'btn btn-small'}
              data-hint={r.hint}
              onClick={() => setRole(r.id)}
            >
              <span className="stream-dot" style={{ background: r.color }} /> {r.label}
            </button>
          ))}
          <span className="spacer" />
          <span className="quick-row-label">Показ:</span>
          <button className={mode === 'bars' ? 'btn btn-small state-on' : 'btn btn-small'} onClick={() => setMode('bars')} data-hint="Столбики по всем 512 адресам">
            Столбики
          </button>
          <button className={mode === 'grid' ? 'btn btn-small state-on' : 'btn btn-small'} onClick={() => setMode('grid')} data-hint="Числа по всем адресам — таблицей 16 в строке">
            Числа
          </button>
          <button className={mode === 'list' ? 'btn btn-small state-on' : 'btn btn-small'} onClick={() => setMode('list')} data-hint="Только занятые адреса, с именами приборов">
            Только ненулевые
          </button>
        </div>
        {hover && (
          <p className="dim stream-readout">
            адрес <b>{hover.ch}</b> · значение <b>{hover.value}</b> ({Math.round((hover.value / 255) * 100)} %)
          </p>
        )}
        {shown.map((u) => (
          <UniverseStream
            key={u}
            project={project}
            universe={u}
            stage={stage}
            role={role}
            mode={mode}
            frames={frames}
            wireFrames={wireFrames}
            capture={capture}
            onHover={setHover}
            showTitle={universe === 'all'}
          />
        ))}
      </section>
      <RdmStream network={network} />
    </main>
  );
}

function UniverseStream({
  project,
  universe,
  stage,
  role,
  mode,
  frames,
  wireFrames,
  capture,
  onHover,
  showTitle,
}: {
  project: Project | null;
  universe: number;
  stage: Stage;
  role: RoleFilter;
  mode: ViewMode;
  frames: Record<number, Uint8Array>;
  wireFrames: Record<number, Uint8Array>;
  capture: Record<number, { data: Uint8Array; ageMs: number; fromIp: string; frames: number }>;
  onHover: (h: { ch: number; value: number } | null) => void;
  showTitle: boolean;
}) {
  const kinds = useMemo(() => addressKinds(project, universe), [project, universe]);
  const cap = capture[universe];
  const data =
    stage === 'in' ? (cap?.data ?? new Uint8Array(DMX_UNIVERSE_SIZE)) : stage === 'wire' ? (wireFrames[universe] ?? frames[universe] ?? new Uint8Array(DMX_UNIVERSE_SIZE)) : (frames[universe] ?? new Uint8Array(DMX_UNIVERSE_SIZE));
  const colorOf = (i: number): string => {
    const k = kinds[i];
    return ROLES.find((r) => r.id === (k ?? 'other'))?.color ?? '#8f9aa6';
  };
  const visible = (i: number): boolean => role === 'all' || kinds[i] === role;

  if (stage === 'in' && !cap) {
    return (
      <p className="dim">
        {showTitle ? `Вселенная ${universe}: ` : ''}входящего Art-Net на этой вселенной нет — никто посторонний
        в неё не шлёт.
      </p>
    );
  }

  return (
    <div className="stream-block">
      {showTitle && (
        <h3>
          Вселенная {universe}
          {stage === 'in' && cap && (
            <span className="dim">
              {' '}
              · от {cap.fromIp} · {cap.frames} кадров · {Math.round(cap.ageMs)} мс назад
            </span>
          )}
        </h3>
      )}
      {mode === 'bars' && (
        <div className="stream-bars" onMouseLeave={() => onHover(null)}>
          {Array.from({ length: DMX_UNIVERSE_SIZE }, (_, i) => {
            const v = data[i] ?? 0;
            const on = visible(i);
            return (
              <span
                key={i}
                className="stream-bar"
                style={{
                  height: `${Math.max(1, (v / 255) * 100)}%`,
                  background: on ? colorOf(i) : '#2a2f36',
                  opacity: on ? (v > 0 ? 1 : 0.35) : 0.18,
                }}
                onMouseEnter={() => onHover({ ch: i + 1, value: v })}
              />
            );
          })}
        </div>
      )}
      {mode === 'grid' && (
        <div className="stream-grid">
          {Array.from({ length: DMX_UNIVERSE_SIZE }, (_, i) => {
            const v = data[i] ?? 0;
            const on = visible(i);
            return (
              <span
                key={i}
                className={v > 0 ? 'stream-cell on' : 'stream-cell'}
                style={{ color: on ? colorOf(i) : '#4a525b' }}
                data-hint={`адрес ${i + 1}`}
                onMouseEnter={() => onHover({ ch: i + 1, value: v })}
              >
                {v}
              </span>
            );
          })}
        </div>
      )}
      {mode === 'list' && <NonZeroList project={project} universe={universe} data={data} kinds={kinds} role={role} />}
    </div>
  );
}

/** Только занятые адреса, с именем прибора и ролью канала — читается как отчёт. */
function NonZeroList({
  project,
  universe,
  data,
  kinds,
  role,
}: {
  project: Project | null;
  universe: number;
  data: Uint8Array;
  kinds: (RoleFilter | null)[];
  role: RoleFilter;
}) {
  const names = useMemo(() => {
    const out: { name: string; role: string }[] = new Array(DMX_UNIVERSE_SIZE).fill(null).map(() => ({ name: '', role: '' }));
    if (!project) return out;
    const profiles = profileMap(project);
    for (const d of project.devices) {
      if (d.universe !== universe) continue;
      const p = profiles.get(d.profileId);
      if (!p) continue;
      for (let k = 0; k < p.channels.length; k++) {
        const idx = d.address - 1 + k;
        if (idx >= 0 && idx < DMX_UNIVERSE_SIZE) out[idx] = { name: d.name, role: p.channels[k]?.name ?? '' };
      }
    }
    return out;
  }, [project, universe]);

  const rows: number[] = [];
  for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
    if ((data[i] ?? 0) === 0) continue;
    if (role !== 'all' && kinds[i] !== role) continue;
    rows.push(i);
  }
  if (rows.length === 0) return <p className="dim">Ненулевых адресов нет.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Адрес</th>
          <th>Значение</th>
          <th>Прибор</th>
          <th>Канал</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i}>
            <td>{i + 1}</td>
            <td>{data[i]}</td>
            <td>{names[i]?.name || <span className="dim">не занят</span>}</td>
            <td className="dim">{names[i]?.role}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Поток RDM — обмен в ОБЕ стороны.
 *
 * DMX идёт только от нас к приборам, а RDM — разговор: мы спрашиваем, прибор
 * отвечает. Поэтому здесь не картина значений, а журнал обмена: кто, что
 * спросил и что ответили. По нему видно и молчащие приборы, и те, что отвечают
 * ошибкой на нормальный запрос.
 */
function RdmStream({ network }: { network: EngineConnection['network'] }) {
  if (!network) {
    return (
      <section className="panel">
        <h2>Поток RDM</h2>
        <p className="dim">Сеть ещё не опрошена — движок не прислал состояние.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>Поток RDM</h2>
      <p className="dim">
        RDM — двусторонний: мы спрашиваем, прибор отвечает. Здесь видно сам обмен, а не значения каналов:
        кому ушёл запрос и что вернулось. Молчащий прибор и прибор, отвечающий ошибкой, — это разные
        неисправности, и различить их можно только так.
      </p>
      {network.rdmDevices.length === 0 ? (
        <p className="dim">Приборов RDM не найдено.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>UID</th>
              <th data-hint="Через какой узел Art-Net (преобразователь «сеть → кабель DMX») пришёл ответ прибора">Узел Art-Net</th>
              <th>Вселенная</th>
              <th>Ответ</th>
              <th>Состояние</th>
            </tr>
          </thead>
          <tbody>
            {network.rdmDevices.map((d) => (
              <tr key={d.uid} className={d.lost ? 'row-lost' : undefined}>
                <td>{d.uid}</td>
                <td className="dim">{d.nodeIp}</td>
                <td>{d.universe}</td>
                <td className="dim">{Math.round(d.ageMs / 1000)} с назад</td>
                <td className={d.lost ? 'error-text' : 'dim'}>{d.lost ? 'пропал' : 'отвечает'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Журнал обмена</h3>
      {network.log.length === 0 ? (
        <p className="dim">Пока пусто.</p>
      ) : (
        <ul className="list stream-log">
          {network.log.slice(0, 80).map((e, i) => (
            <li key={i} className="list-item">
              <span className="dim">{new Date(e.atMs).toLocaleTimeString('ru-RU')}</span> {e.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
