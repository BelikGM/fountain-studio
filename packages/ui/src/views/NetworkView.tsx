import { useEffect, useState } from 'react';
import { DMX_UNIVERSE_SIZE, type ClientMessage, type NetworkState, type RdmAction, type RdmSensorReading,
  universeTitle,
  num,
} from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/**
 * Вкладка «Сеть»: Art-Net ноды и RDM-приборы на линиях — «жив/потерян»,
 * журнал появлений и пропаж. Данные собирает движок (ArtPoll + ArtTodRequest).
 */
export function NetworkView({ engine }: { engine: EngineConnection }) {
  const { network, send } = engine;
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  /**
   * Привязать найденный на линии RDM-прибор к прибору из патча. Нужно ровно для
   * одного: чтобы в уведомлениях и отчётах вместо «4950:00001234» стояло
   * понятное имя. На сам RDM-обмен привязка не влияет.
   */
  const bindRdm = (uid: string, deviceId: string): void => {
    const project = engine.project;
    if (!project) return;
    const key = uid.toLowerCase();
    engine.updateProject({
      ...project,
      devices: project.devices.map((d) => {
        // Один UID — один прибор: со всех остальных привязку снимаем.
        if (d.id === deviceId) return { ...d, rdmUid: key };
        if (d.rdmUid === key) {
          const { rdmUid: _drop, ...rest } = d;
          return rest;
        }
        return d;
      }),
    });
  };

  if (!network) {
    return (
      <main className="view">
        <section className="panel">
          <h2>Art-Net ноды</h2>
          <p className="dim">
            Опрос сети выключен: у объекта нет вселенных на Art-Net (интерфейсу FountanPlay он не нужен) —
            или движок ещё не прислал данные.
          </p>
        </section>
        <DmxStreamPanel engine={engine} hasInputCapture={false} />
        <JitterPanel engine={engine} />
        <EventLogPanel engine={engine} />
      </main>
    );
  }

  return (
    <main className="view">
      <section className="panel">
        <h2>
          Art-Net ноды ({network.nodes.length}){' '}
          <button className="btn btn-small" onClick={() => send({ type: 'refreshNetwork' })}>
            Обновить сейчас
          </button>
        </h2>
        {network.nodes.length === 0 ? (
          <p className="dim">
            Нод не найдено. Программа опрашивает адреса, указанные у вселенных в «Настройках», —
            проверьте, что нода включена, подключена к той же сети и адрес вписан верно.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Статус</th>
                <th>Имя</th>
                <th>IP</th>
                <th>Вселенные ноды</th>
                <th>Последний ответ</th>
              </tr>
            </thead>
            <tbody>
              {network.nodes.map((n) => (
                <tr key={n.ip} className={n.lost ? 'row-error' : undefined}>
                  <td>{n.lost ? '✖ потеряна' : '✔ на связи'}</td>
                  <td data-hint={n.longName}>{n.shortName}</td>
                  <td>{n.ip}</td>
                  <td>{n.outputUniverses.join(', ') || '—'}</td>
                  <td>{formatAge(n.ageMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>RDM-приборы ({network.rdmDevices.length})</h2>
        {network.rdmDevices.length === 0 ? (
          <p className="dim">
            Приборы не обнаружены. Нужна Art-Net нода с поддержкой RDM; ноды без RDM этот раздел не
            заполняют — вывод DMX при этом работает.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Статус</th>
                <th>UID</th>
                <th data-hint="Какой прибор из «Оборудования» это на самом деле. Нужно только для понятных уведомлений: в сообщениях и отчётах вместо UID встанет имя прибора.">
                  Прибор
                </th>
                <th>Вселенная</th>
                <th>Узел</th>
                <th>Последний ответ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {network.rdmDevices.map((d) => (
                <tr key={d.uid} className={d.lost ? 'row-error' : undefined}>
                  <td>{d.lost ? '✖ пропал' : '✔ на связи'}</td>
                  <td>{d.uid}</td>
                  <td>
                    <select
                      value={engine.project?.devices.find((x) => x.rdmUid === d.uid.toLowerCase())?.id ?? ''}
                      onChange={(e) => bindRdm(d.uid, e.target.value)}
                    >
                      <option value="">— не привязан —</option>
                      {(engine.project?.devices ?? []).map((dev) => (
                        <option key={dev.id} value={dev.id}>
                          {dev.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{d.universe}</td>
                  <td>{d.nodeIp}</td>
                  <td>{formatAge(d.ageMs)}</td>
                  <td>
                    <button
                      className={selectedUid === d.uid ? 'btn btn-small active' : 'btn btn-small'}
                      onClick={() => setSelectedUid(selectedUid === d.uid ? null : d.uid)}
                    >
                      Опросить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {selectedUid && <RdmDetailPanel engine={engine} uid={selectedUid} key={selectedUid} />}
      </section>

      <section className="panel">
        <h2>Журнал сети</h2>
        {network.log.length === 0 ? (
          <p className="dim">Событий пока нет.</p>
        ) : (
          <ul className="list">
            {network.log.map((e, i) => (
              <li key={`${e.atMs}-${i}`} className="list-item">
                <span className="dim">{new Date(e.atMs).toLocaleTimeString('ru-RU')}</span> {e.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <DmxStreamPanel engine={engine} hasInputCapture={true} />
      <JitterPanel engine={engine} />
      <EventLogPanel engine={engine} />
    </main>
  );
}

const DMX_GRID_COLS = 32; // 32×16 = 512 адресов сразу, без страниц — «чистый поток» целиком

/**
 * Сырой DMX-поток на входе/выходе (§27 доработки, по запросу — «на 3D круто,
 * но тяжелее какие-то ошибки заметить»): плотная сетка 1..512 без страниц и
 * без интерактива фейдеров, только числа 0–255 — залипшие каналы, дыры,
 * посторонний паттерн видно с одного взгляда.
 *
 * «Выход» — то, что сам движок реально шлёт в этом тике (engine.frames,
 * тот же поток, что уходит на все настроенные выходы вселенной разом —
 * Art-Net/usb-dmx/sACN). «Вход» — то, что движок ловит на линии Art-Net
 * снаружи (getDmxCapture): если направить на этот ПК Art-Net с настоящего
 * пульта/контроллера, здесь будет видно ровно то, что он реально шлёт.
 */
function DmxStreamPanel({ engine, hasInputCapture }: { engine: EngineConnection; hasInputCapture: boolean }) {
  const { universes, frames, requestDmxCapture } = engine;
  const [mode, setMode] = useState<'out' | 'in'>('out');
  const [universeId, setUniverseId] = useState<number | null>(universes[0]?.id ?? null);
  const [inSnapshot, setInSnapshot] = useState<{ data: Uint8Array; ageMs: number; fromIp: string; frames: number } | null>(
    null,
  );

  useEffect(() => {
    if (universeId === null && universes.length > 0) setUniverseId(universes[0]!.id);
  }, [universes, universeId]);

  useEffect(() => {
    if (mode !== 'in' || universeId === null || !hasInputCapture) return;
    let cancelled = false;
    const poll = (): void => {
      void requestDmxCapture(universeId).then((snap) => {
        if (!cancelled) setInSnapshot(snap);
      });
    };
    poll();
    const t = setInterval(poll, 400);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [mode, universeId, hasInputCapture, requestDmxCapture]);

  const outData = universeId !== null ? frames[universeId] : undefined;
  const data = mode === 'out' ? outData : inSnapshot?.data;

  return (
    <section className="panel">
      <h2>Значения DMX по адресам</h2>
      <div className="form-row">
        <div className="group">
          <button className={mode === 'out' ? 'btn active' : 'btn'} onClick={() => setMode('out')}>
            Выход
          </button>
          <button
            className={mode === 'in' ? 'btn active' : 'btn'}
            onClick={() => setMode('in')}
            disabled={!hasInputCapture}
            data-hint={hasInputCapture ? 'Что приходит на этот компьютер по Art-Net от стороннего пульта или программы' : 'Вход доступен, когда у объекта есть хотя бы одна вселенная на Art-Net'}
          >
            Вход
          </button>
        </div>
        <div className="group">
          {universes.map((u) => (
            <button
              key={u.id}
              className={u.id === universeId ? 'btn btn-small active' : 'btn btn-small'}
              data-hint={u.outputs.join('\n')}
              onClick={() => setUniverseId(u.id)}
            >
              {universeTitle(u)}
            </button>
          ))}
        </div>
        {mode === 'in' && (
          <span className="dim">
            {inSnapshot
              ? `от ${inSnapshot.fromIp}, ${formatAge(inSnapshot.ageMs)}, кадров поймано ${inSnapshot.frames}`
              : 'сигнала пока не было'}
          </span>
        )}
      </div>
      {!data ? (
        <p className="dim">{mode === 'in' ? 'Ждём кадр со входа Art-Net…' : 'Нет данных по этой вселенной.'}</p>
      ) : (
        <div className="dmx-stream-grid" style={{ gridTemplateColumns: `repeat(${DMX_GRID_COLS}, 1fr)` }}>
          {Array.from({ length: DMX_UNIVERSE_SIZE }, (_, i) => {
            const v = data[i] ?? 0;
            return (
              <div
                key={i}
                className="dmx-stream-cell"
                data-hint={`Адрес ${i + 1}: ${v}`}
                style={{ background: `rgba(46, 157, 247, ${v / 255})` }}
              >
                <span className="dmx-stream-addr">{i + 1}</span>
                <span className="dmx-stream-val">{v}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * Искровая линия джиттера тика (§27 доработки, §3 п.5) — до часа истории вместо
 * голых чисел в статус-баре. Свой SVG-polyline, без графических библиотек —
 * по тому же принципу, что и остальной проект (см. hsvToRgb в scenegen.ts).
 */
function JitterPanel({ engine }: { engine: EngineConnection }) {
  const samples = engine.jitterHistory;
  const stats = engine.stats;
  return (
    <section className="panel">
      <h2>Ровность такта {stats && <span className="dim">(такт {stats.intervalMs} мс)</span>}</h2>
      {samples.length < 2 ? (
        <p className="dim">Собираю историю — обновляется раз в секунду, подождите немного.</p>
      ) : (
        <JitterSparkline samples={samples} />
      )}
    </section>
  );
}

function JitterSparkline({ samples }: { samples: { tsMs: number; jitterMs: number }[] }) {
  const W = 600;
  const H = 60;
  const PAD = 4;
  const max = Math.max(1, ...samples.map((s) => s.jitterMs));
  const xOf = (i: number): number => (i / (samples.length - 1)) * (W - PAD * 2) + PAD;
  const yOf = (v: number): number => H - PAD - (v / max) * (H - PAD * 2);
  const points = samples.map((s, i) => `${xOf(i).toFixed(1)},${yOf(s.jitterMs).toFixed(1)}`).join(' ');
  const last = samples[samples.length - 1]!;
  const avg = samples.reduce((sum, s) => sum + s.jitterMs, 0) / samples.length;
  const spanMin = (samples[samples.length - 1]!.tsMs - samples[0]!.tsMs) / 60000;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="jitter-spark" preserveAspectRatio="none">
        <polyline points={points} className="jitter-line" />
        <circle cx={xOf(samples.length - 1)} cy={yOf(last.jitterMs)} r={2.5} className="jitter-dot" />
      </svg>
      <div className="dim">
        отклонение сейчас {num(last.jitterMs, 2)} мс · в среднем {num(avg, 2)} мс · наибольшее {num(max, 2)} мс · за последние{' '}
        {spanMin < 1 ? `${Math.round(spanMin * 60)} с` : `${num(spanMin, 1)} мин`}
      </div>
    </div>
  );
}

/**
 * Общий журнал событий движка (§27 доработки, §3 п.1): расписание, пульты
 * OSC/MQTT, клавиатурные привязки, аварии ПЧ, потери на линии — раньше было
 * видно только в консоли процесса движка. Источник и уровень (инфо/предупреждение/
 * ошибка) — из общего eventLog движка, см. packages/engine/src/eventlog.ts.
 */
/**
 * Как источник события называется на экране. Ключи — внутренние (по ним
 * фильтруют Telegram и проверки), поэтому переводим только показ: в журнале
 * рядом стояли «[engine]» и «[проект]».
 */
const SOURCE_LABEL: Record<string, string> = {
  engine: 'движок',
  server: 'редактор',
  telegram: 'Telegram',
  osc: 'OSC',
  mqtt: 'MQTT',
  modbus: 'Modbus',
  проект: 'объект',
  wind: 'ветер',
  schedule: 'расписание',
  net: 'сеть',
  'dmx-in': 'вход DMX',
  audio: 'музыка',
};
const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s;

function EventLogPanel({ engine }: { engine: EngineConnection }) {
  const [sourceFilter, setSourceFilter] = useState('');
  const events = engine.logEvents;
  const sources = [...new Set(events.map((e) => e.source))].sort();
  const visible = (sourceFilter ? events.filter((e) => e.source === sourceFilter) : events)
    .slice()
    .reverse()
    .slice(0, 200);

  return (
    <section className="panel">
      <h2>
        Журнал событий
        {sources.length > 1 && (
          <select
            className="input-mini"
            style={{ marginLeft: 10 }}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="">все источники</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
        )}
      </h2>
      {visible.length === 0 ? (
        <p className="dim">Событий пока нет: расписание, OSC/MQTT-пульты, клавиши, аварии ПЧ появятся здесь.</p>
      ) : (
        <ul className="list log-list">
          {visible.map((e) => (
            <li key={e.id} className={`list-item log-level-${e.level}`}>
              <span className="list-item-label">
                <span className="dim">{new Date(e.tsMs).toLocaleTimeString('ru-RU')}</span>
                <span className="log-source">[{sourceLabel(e.source)}]</span>
                <span>{e.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatAge(ageMs: number): string {
  if (ageMs < 2000) return 'только что';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)} с назад`;
  return `${Math.round(ageMs / 60_000)} мин назад`;
}

/**
 * Универсальные RDM-параметры (§3 доработки): одинаковы по спецификации
 * E1.20 для любой марки прибора, в отличие от сенсоров/статус-сообщений
 * (те — опциональные, формат зависит от производителя, сюда сознательно
 * не включены — см. docs/ARCHITECTURE.md §22, §25).
 */
function RdmDetailPanel({ engine, uid }: { engine: EngineConnection; uid: string }) {
  const [deviceInfo, setDeviceInfo] = useState<{
    protocolVersion: string;
    deviceModelId: number;
    productCategory: number;
    softwareVersionId: number;
    dmxFootprint: number;
    dmxStartAddress: number;
    subDeviceCount: number;
    sensorCount: number;
  } | null>(null);
  const [labels, setLabels] = useState<{ manufacturer: string; model: string; softwareVersion: string } | null>(null);
  const [identify, setIdentify] = useState<boolean | null>(null);
  const [address, setAddress] = useState<number | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [sensors, setSensors] = useState<RdmSensorReading[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    action: RdmAction,
    extra?: { on?: boolean; address?: number },
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const req = { type: 'rdmRequest', uid, action, ...extra } as Extract<ClientMessage, { type: 'rdmRequest' }>;
      const resp = await engine.requestRdm(req);
      if (!resp.ok) {
        setError(resp.error);
        return;
      }
      if (resp.action === 'deviceInfo') setDeviceInfo(resp.deviceInfo);
      else if (resp.action === 'labels') {
        setLabels({ manufacturer: resp.manufacturer, model: resp.model, softwareVersion: resp.softwareVersion });
      } else if (resp.action === 'getIdentify' || resp.action === 'setIdentify') setIdentify(resp.identify);
      else if (resp.action === 'getAddress' || resp.action === 'setAddress') {
        setAddress(resp.address);
        setAddressInput(String(resp.address));
      } else if (resp.action === 'sensors') setSensors(resp.sensors);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trim-editor">
      <div className="form-row">
        <span className="dim">Прибор {uid} — сведения, которые по стандарту RDM отдаёт прибор любой марки:</span>
        <button
          className="btn btn-small"
          disabled={busy}
          data-hint="Опрос датчиков прибора по стандарту RDM: температура, напряжение, наработка — сколько их, прибор сообщает сам. Работает с любой маркой: чего прибор не поддерживает, то он честно отклоняет, а остальное отдаёт."
          onClick={() => void run('sensors')}
        >
          Датчики
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('deviceInfo')}>
          Сведения
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('labels')}>
          Марка и модель
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('getIdentify')}>
          Мигает ли сейчас
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('getAddress')}>
          Какой адрес на приборе
        </button>
      </div>
      {error && <div className="error-text">Ошибка: {error}</div>}
      {labels && (
        <div className="dim">
          Производитель: {labels.manufacturer || '—'} · Модель: {labels.model || '—'} · ПО:{' '}
          {labels.softwareVersion || '—'}
        </div>
      )}
      {sensors !== null &&
        (sensors.length === 0 ? (
          <p className="dim">Датчиков у прибора нет (или он их не отдаёт).</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>№</th>
                <th>Что меряет</th>
                <th>Название прибора</th>
                <th>Сейчас</th>
                <th>Минимум</th>
                <th>Максимум</th>
              </tr>
            </thead>
            <tbody>
              {sensors.map((s) => (
                <tr key={s.index}>
                  <td>{s.index}</td>
                  <td>{s.typeName}</td>
                  <td className="dim">{s.description || '—'}</td>
                  <td>
                    {s.value} {s.unit}
                  </td>
                  <td className="dim">
                    {s.lowest} {s.unit}
                  </td>
                  <td className="dim">
                    {s.highest} {s.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {deviceInfo && (
        <div className="dim">
          Версия RDM {deviceInfo.protocolVersion} · занимает каналов DMX: {deviceInfo.dmxFootprint} · адрес на
          приборе: {deviceInfo.dmxStartAddress} · вложенных устройств: {deviceInfo.subDeviceCount} · датчиков:{' '}
          {deviceInfo.sensorCount}
        </div>
      )}
      <div className="form-row">
        <button
          className={identify ? 'btn active' : 'btn'}
          disabled={busy}
          onClick={() => void run('setIdentify', { on: !identify })}
        >
          {identify ? '✦ Прибор мигает — остановить' : 'Мигнуть, чтобы найти прибор'}
        </button>
        <label className="field">
          DMX-адрес:{' '}
          <input
            className="input input-num"
            type="number"
            min={1}
            max={512}
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
          />
        </label>
        <button
          className="btn"
          disabled={busy || addressInput === ''}
          onClick={() => void run('setAddress', { address: Number(addressInput) })}
        >
          Переставить адрес на приборе
        </button>
        {address !== null && <span className="dim">сейчас: {address}</span>}
      </div>
    </div>
  );
}

export type { NetworkState };
