import { useEffect, useState } from 'react';
import { DMX_UNIVERSE_SIZE, type ClientMessage, type NetworkState, type RdmAction } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/**
 * Вкладка «Сеть»: Art-Net ноды и RDM-приборы на линиях — «жив/потерян»,
 * журнал появлений и пропаж. Данные собирает движок (ArtPoll + ArtTodRequest).
 */
export function NetworkView({ engine }: { engine: EngineConnection }) {
  const { network, send } = engine;
  const [selectedUid, setSelectedUid] = useState<string | null>(null);

  if (!network) {
    return (
      <main className="view">
        <section className="panel">
          <h2>Сеть</h2>
          <p className="dim">
            Мониторинг не активен: в конфиге движка нет Art-Net-выходов, либо движок ещё не
            прислал состояние.
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
            Нод не найдено. Нода отвечает на ArtPoll по адресам выходов из fountain.config.json —
            проверьте, что она включена и адрес верный. Виртуальной проверкой служит
            «npm run monitor» — он ноду не заменяет (не отвечает на опрос), но показывает поток DMX.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Статус</th>
                <th>Имя</th>
                <th>IP</th>
                <th>Выходные вселенные</th>
                <th>Последний ответ</th>
              </tr>
            </thead>
            <tbody>
              {network.nodes.map((n) => (
                <tr key={n.ip} className={n.lost ? 'row-error' : undefined}>
                  <td>{n.lost ? '✖ потеряна' : '✔ на связи'}</td>
                  <td title={n.longName}>{n.shortName}</td>
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
            Приборы не обнаружены. Нужна нода с RDM (список приборов приходит из её TOD);
            дешёвые ноды без RDM этот раздел не заполняют — DMX-выход при этом работает.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Статус</th>
                <th>UID</th>
                <th>Вселенная</th>
                <th>Нода</th>
                <th>Последний ответ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {network.rdmDevices.map((d) => (
                <tr key={d.uid} className={d.lost ? 'row-error' : undefined}>
                  <td>{d.lost ? '✖ пропал' : '✔ на линии'}</td>
                  <td>{d.uid}</td>
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
      <h2>Сырой DMX-поток</h2>
      <div className="form-row">
        <div className="group">
          <button className={mode === 'out' ? 'btn active' : 'btn'} onClick={() => setMode('out')}>
            Выход
          </button>
          <button
            className={mode === 'in' ? 'btn active' : 'btn'}
            onClick={() => setMode('in')}
            disabled={!hasInputCapture}
            title={hasInputCapture ? 'Снято на линии Art-Net извне' : 'Нужен хотя бы один настроенный Art-Net-выход'}
          >
            Вход
          </button>
        </div>
        <div className="group">
          {universes.map((u) => (
            <button
              key={u.id}
              className={u.id === universeId ? 'btn btn-small active' : 'btn btn-small'}
              onClick={() => setUniverseId(u.id)}
            >
              {u.label}
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
        <p className="dim">{mode === 'in' ? 'Ждём кадр с линии…' : 'Нет данных по этой вселенной.'}</p>
      ) : (
        <div className="dmx-stream-grid" style={{ gridTemplateColumns: `repeat(${DMX_GRID_COLS}, 1fr)` }}>
          {Array.from({ length: DMX_UNIVERSE_SIZE }, (_, i) => {
            const v = data[i] ?? 0;
            return (
              <div
                key={i}
                className="dmx-stream-cell"
                title={`Адрес ${i + 1}: ${v}`}
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
      <h2>Джиттер тика {stats && <span className="dim">(тик {stats.intervalMs} мс)</span>}</h2>
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
        сейчас {last.jitterMs.toFixed(2)} мс · среднее за окно {avg.toFixed(2)} мс · пик {max.toFixed(2)} мс · окно ~
        {spanMin < 1 ? `${Math.round(spanMin * 60)} с` : `${spanMin.toFixed(1)} мин`}
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
                {s}
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
                <span className="log-source">[{e.source}]</span>
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
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trim-editor">
      <div className="form-row">
        <span className="dim">Прибор {uid} — параметры, одинаковые по спеке E1.20 для любой марки:</span>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('deviceInfo')}>
          DEVICE_INFO
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('labels')}>
          Ярлыки
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('getIdentify')}>
          Опросить IDENTIFY
        </button>
        <button className="btn btn-small" disabled={busy} onClick={() => void run('getAddress')}>
          Опросить адрес
        </button>
      </div>
      {error && <div className="error-text">Ошибка: {error}</div>}
      {labels && (
        <div className="dim">
          Производитель: {labels.manufacturer || '—'} · Модель: {labels.model || '—'} · ПО:{' '}
          {labels.softwareVersion || '—'}
        </div>
      )}
      {deviceInfo && (
        <div className="dim">
          Протокол RDM {deviceInfo.protocolVersion} · DMX-футпринт {deviceInfo.dmxFootprint} кан. · адрес по
          прибору {deviceInfo.dmxStartAddress} · саб-устройств {deviceInfo.subDeviceCount} · сенсоров{' '}
          {deviceInfo.sensorCount}
        </div>
      )}
      <div className="form-row">
        <button
          className={identify ? 'btn active' : 'btn'}
          disabled={busy}
          onClick={() => void run('setIdentify', { on: !identify })}
        >
          {identify ? '✦ IDENTIFY включён — выключить' : 'Мигнуть (IDENTIFY)'}
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
