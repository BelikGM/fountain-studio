import { PlusIcon, CloseIcon } from '../components/Icons';
import { useRef, useState } from 'react';
import { useCollapsiblePanels } from '../collapsiblePanels';
import {
  uid,
  type DmxTrigger,
  type MqttBinding,
  type OscBinding,
  type RemoteAction,
  type RemoteSettings,
  universeShort,
} from '@fountain-studio/shared';
import type { EngineConnection, RemoteStatus } from '../useEngine';

const ACTION_LABEL: Record<RemoteAction['type'], string> = {
  scene: 'Включить сцену',
  sequence: 'Запустить секвенсор',
  show: 'Запустить шоу',
  playlist: 'Запустить плейлист',
  stopAll: 'Стоп всё',
  blackout: 'Blackout — погасить всё',
};

/**
 * Удалённое управление: OSC-пульты (TouchOSC и т.п.) и MQTT (телеметрия +
 * команды). Включение, порт и брокер — панель «Подключение» наверху: это
 * настройки программы (app-config.json), они не переезжают с объектом.
 * Привязки «адрес/топик → действие» ниже — часть объекта.
 */
export function RemoteView({ engine }: { engine: EngineConnection }) {
  const { project, remote, universes, updateProject } = engine;
  const rootRef = useRef<HTMLElement>(null);
  useCollapsiblePanels(rootRef, 'remote');
  if (!project) return <main className="view">Жду данные проекта от движка…</main>;

  const refOptions = (type: RemoteAction['type']): { id: string; name: string }[] => {
    switch (type) {
      case 'scene':
        return project.scenes;
      case 'sequence':
        return project.sequences;
      case 'show':
        return project.shows;
      case 'playlist':
        return project.playlists;
      default:
        return [];
    }
  };

  const defaultAction = (): RemoteAction =>
    project.scenes.length > 0 ? { type: 'scene', refId: project.scenes[0]!.id } : { type: 'stopAll' };

  return (
    <main className="view" ref={rootRef}>
      {!remote ? (
        <section className="panel">
          <h2>Подключение</h2>
          <p className="dim">Жду данные от движка…</p>
        </section>
      ) : (
        <ConnectionPanel remote={remote} send={engine.send} />
      )}

      <OscPanel project={project} updateProject={updateProject} refOptions={refOptions} defaultAction={defaultAction} />
      <MqttPanel project={project} updateProject={updateProject} refOptions={refOptions} defaultAction={defaultAction} />
      <DmxTriggerPanel
        project={project}
        universes={engine.universes}
        updateProject={updateProject}
        refOptions={refOptions}
        defaultAction={defaultAction}
      />
    </main>
  );
}

/** Что сейчас с OSC — словами, как человеку на объекте. */
function oscStatus(r: RemoteStatus): JSX.Element {
  if (!r.osc.enabled) return <span className="dim">выключен</span>;
  if (r.osc.error) return <span className="error-text">✖ {r.osc.error}</span>;
  if (r.osc.listening) return <span className="ok-text status-note">✔ принимает команды на порт {r.settings.osc.port}</span>;
  return <span className="dim">открываю порт {r.settings.osc.port}…</span>;
}

function mqttStatus(r: RemoteStatus): JSX.Element {
  if (!r.mqtt.enabled) return <span className="dim">выключен</span>;
  if (r.mqtt.error) return <span className="error-text">✖ {r.mqtt.error}</span>;
  if (r.mqtt.connected) return <span className="ok-text status-note">✔ на связи с брокером</span>;
  return (
    <span className="error-text">
      ✖ нет связи с брокером {r.settings.mqtt.host}:{r.settings.mqtt.port}
    </span>
  );
}

/**
 * Включение OSC и MQTT — прямо здесь. До 22.09.2026 это делалось только правкой
 * файла настроек программы, а вкладка лишь писала «выключен — включает
 * наладчик в файле»: фонтанщик в файл не полезет. Правки копятся и уходят по
 * «Применить» — чтобы недописанный адрес брокера не пытался подключаться на
 * каждую букву. Движок применяет на ходу, шоу не останавливается.
 */
function ConnectionPanel({ remote, send }: { remote: RemoteStatus; send: EngineConnection['send'] }) {
  const [draft, setDraft] = useState<RemoteSettings | null>(null);
  /** Новый пароль брокера; '' — не менять. */
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const d = draft ?? remote.settings;
  const dirty = JSON.stringify(d) !== JSON.stringify(remote.settings) || password !== '' || clearPassword;

  const patchOsc = (p: Partial<RemoteSettings['osc']>): void => setDraft({ ...d, osc: { ...d.osc, ...p } });
  const patchMqtt = (p: Partial<RemoteSettings['mqtt']>): void => setDraft({ ...d, mqtt: { ...d.mqtt, ...p } });
  const reset = (): void => {
    setDraft(null);
    setPassword('');
    setClearPassword(false);
  };
  const apply = (): void => {
    send({
      type: 'setRemoteSettings',
      settings: d,
      ...(clearPassword ? { mqttPassword: '' } : password !== '' ? { mqttPassword: password } : {}),
    });
    reset();
  };

  return (
    <section className="panel">
      <h2>Подключение</h2>
      <p className="dim">
        Откуда фонтан принимает команды, кроме редактора и клавиатуры. Применяется сразу, шоу не
        останавливается.
      </p>

      <div className="form-row">
        <label
          className="field"
          data-hint="Планшет или телефон с приложением TouchOSC (или похожим) шлёт команды по Wi-Fi на этот компьютер. В приложении укажите IP этого компьютера и тот же порт."
        >
          <input type="checkbox" checked={d.osc.enabled} onChange={(e) => patchOsc({ enabled: e.target.checked })} />{' '}
          <b>OSC</b> — планшет (TouchOSC)
        </label>
        <label className="field" data-hint="UDP-порт, на который приложение шлёт команды. У TouchOSC по умолчанию 8000.">
          Порт:{' '}
          <input
            className="input"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={65535}
            value={d.osc.port}
            onChange={(e) => patchOsc({ port: Number(e.target.value) })}
          />
        </label>
        {oscStatus(remote)}
      </div>

      <div className="form-row">
        <label
          className="field"
          data-hint="Умный дом (Home Assistant и т. п.) или диспетчерская: команды фонтану и его состояние раз в 5 секунд — через MQTT-брокер в сети объекта."
        >
          <input type="checkbox" checked={d.mqtt.enabled} onChange={(e) => patchMqtt({ enabled: e.target.checked })} />{' '}
          <b>MQTT</b> — умный дом, диспетчерская
        </label>
        {mqttStatus(remote)}
      </div>
      <div className="form-row">
        <label className="field" data-hint="IP-адрес или имя компьютера, на котором работает MQTT-брокер (например, Mosquitto)">
          Брокер:{' '}
          <input
            className="input"
            style={{ width: 150 }}
            value={d.mqtt.host}
            placeholder="192.168.0.10"
            onChange={(e) => patchMqtt({ host: e.target.value })}
          />
        </label>
        <label className="field" data-hint="Порт брокера. Обычно 1883.">
          Порт:{' '}
          <input
            className="input"
            style={{ width: 80 }}
            type="number"
            min={1}
            max={65535}
            value={d.mqtt.port}
            onChange={(e) => patchMqtt({ port: Number(e.target.value) })}
          />
        </label>
        <label
          className="field"
          data-hint="Начало всех топиков этого фонтана: команды — «префикс/cmd/…», состояние — «префикс/status». Если фонтанов несколько — у каждого свой."
        >
          Префикс:{' '}
          <input
            className="input"
            style={{ width: 130 }}
            value={d.mqtt.topicPrefix}
            placeholder="fountain-studio"
            onChange={(e) => patchMqtt({ topicPrefix: e.target.value })}
          />
        </label>
        <label className="field" data-hint="Если брокер пускает только по логину. Пусто — без логина.">
          Логин:{' '}
          <input
            className="input"
            style={{ width: 100 }}
            value={d.mqtt.username}
            onChange={(e) => patchMqtt({ username: e.target.value })}
          />
        </label>
        <label
          className="field"
          data-hint="Пароль хранится на этом компьютере и в редактор не возвращается — видно только, задан он или нет. Оставьте пустым, чтобы не менять."
        >
          Пароль:{' '}
          <input
            className="input"
            style={{ width: 100 }}
            type="password"
            value={password}
            disabled={clearPassword}
            placeholder={clearPassword ? 'убран' : remote.mqttHasPassword ? 'задан' : 'нет'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {remote.mqttHasPassword && !clearPassword && (
          <button className="btn btn-small" onClick={() => setClearPassword(true)}>
            Убрать пароль
          </button>
        )}
      </div>

      <div className="form-row">
        <button className="btn active" disabled={!dirty} onClick={apply}>
          Применить
        </button>
        <button className="btn" disabled={!dirty} onClick={reset}>
          Отменить правки
        </button>
        {dirty && <span className="warn">Не применено — работает то, что было.</span>}
      </div>
    </section>
  );
}

function ActionCells<T extends { id: string; action: RemoteAction }>({
  binding,
  refOptions,
  onChange,
}: {
  binding: T;
  refOptions: (type: RemoteAction['type']) => { id: string; name: string }[];
  onChange: (action: RemoteAction) => void;
}) {
  return (
    <>
      <td>
        <select
          value={binding.action.type}
          onChange={(e) => {
            const type = e.target.value as RemoteAction['type'];
            if (type === 'stopAll' || type === 'blackout') onChange({ type });
            else {
              const first = refOptions(type)[0];
              if (first) onChange({ type, refId: first.id });
            }
          }}
        >
          {(Object.keys(ACTION_LABEL) as RemoteAction['type'][]).map((t) => (
            <option key={t} value={t}>
              {ACTION_LABEL[t]}
            </option>
          ))}
        </select>
      </td>
      <td>
        {binding.action.type !== 'stopAll' && binding.action.type !== 'blackout' && (
          <select
            value={binding.action.refId}
            onChange={(e) => onChange({ type: binding.action.type, refId: e.target.value } as RemoteAction)}
          >
            {refOptions(binding.action.type).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
      </td>
    </>
  );
}

function OscPanel({
  project,
  updateProject,
  refOptions,
  defaultAction,
}: {
  project: NonNullable<EngineConnection['project']>;
  updateProject: EngineConnection['updateProject'];
  refOptions: (type: RemoteAction['type']) => { id: string; name: string }[];
  defaultAction: () => RemoteAction;
}) {
  const update = (oscBindings: OscBinding[]): void => updateProject({ ...project, oscBindings });

  return (
    <section className="panel">
      <h2>OSC-привязки</h2>
      <p className="dim">
        Адрес — точная строка вида «/scene/1» (без масок). Пульт вроде TouchOSC на кнопку шлёт нажатие (1) и
        отпускание (0) — срабатывает только нажатие.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>OSC-адрес</th>
            <th>Действие</th>
            <th>Цель</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {project.oscBindings.map((b) => (
            <tr key={b.id}>
              <td>
                <input
                  className="input"
                  value={b.address}
                  placeholder="/scene/1"
                  onChange={(e) =>
                    update(project.oscBindings.map((x) => (x.id === b.id ? { ...x, address: e.target.value } : x)))
                  }
                />
              </td>
              <ActionCells
                binding={b}
                refOptions={refOptions}
                onChange={(action) => update(project.oscBindings.map((x) => (x.id === b.id ? { ...x, action } : x)))}
              />
              <td>
                <button className="btn btn-small btn-icon btn-glyph" onClick={() => update(project.oscBindings.filter((x) => x.id !== b.id))}>
                  <CloseIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button
          className="btn btn-icon"
          onClick={() => update([...project.oscBindings, { id: uid(), address: '/', action: defaultAction() }])}
        >
          <PlusIcon />
          Привязка OSC
        </button>
      </div>
    </section>
  );
}

function MqttPanel({
  project,
  updateProject,
  refOptions,
  defaultAction,
}: {
  project: NonNullable<EngineConnection['project']>;
  updateProject: EngineConnection['updateProject'];
  refOptions: (type: RemoteAction['type']) => { id: string; name: string }[];
  defaultAction: () => RemoteAction;
}) {
  const update = (mqttBindings: MqttBinding[]): void => updateProject({ ...project, mqttBindings });

  return (
    <section className="panel">
      <h2>MQTT-привязки</h2>
      <p className="dim">
        Полный топик команды — «&lt;префикс&gt;/cmd/&lt;окончание&gt;» (префикс — в «Подключении» выше);
        здесь пишется только окончание. Состояние фонтана уходит в «&lt;префикс&gt;/status» раз в 5 с.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th data-hint="Только последняя часть топика — то, что идёт после «/cmd/»">Топик</th>
            <th>Действие</th>
            <th>Цель</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {project.mqttBindings.map((b) => (
            <tr key={b.id}>
              <td>
                <input
                  className="input"
                  value={b.topic}
                  placeholder="scene-a"
                  onChange={(e) =>
                    update(project.mqttBindings.map((x) => (x.id === b.id ? { ...x, topic: e.target.value } : x)))
                  }
                />
              </td>
              <ActionCells
                binding={b}
                refOptions={refOptions}
                onChange={(action) => update(project.mqttBindings.map((x) => (x.id === b.id ? { ...x, action } : x)))}
              />
              <td>
                <button className="btn btn-small btn-icon btn-glyph" onClick={() => update(project.mqttBindings.filter((x) => x.id !== b.id))}>
                  <CloseIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button
          className="btn btn-icon"
          onClick={() => update([...project.mqttBindings, { id: uid(), topic: '', action: defaultAction() }])}
        >
          <PlusIcon />
          Привязка MQTT
        </button>
      </div>
    </section>
  );
}

/**
 * DMX-in как триггер (§27 доработки, §4 п.4) — внешний DMX-пульт/консоль
 * шлёт Art-Net на этот ПК (тот же захват, что «Снять сцену с линии» в
 * «Сценах»), значение канала в диапазоне запускает действие. Срабатывает по
 * фронту — держащийся на значении фейдер/кнопка не спамит действие.
 */
function DmxTriggerPanel({
  project,
  universes,
  updateProject,
  refOptions,
  defaultAction,
}: {
  project: NonNullable<EngineConnection['project']>;
  universes: EngineConnection['universes'];
  updateProject: EngineConnection['updateProject'];
  refOptions: (type: RemoteAction['type']) => { id: string; name: string }[];
  defaultAction: () => RemoteAction;
}) {
  const update = (dmxTriggers: DmxTrigger[]): void => updateProject({ ...project, dmxTriggers });
  const firstUniverse = universes[0]?.id ?? 1;

  return (
    <section className="panel">
      <h2>Команды со стороннего DMX-пульта</h2>
      <p className="dim">
        Сторонний DMX-пульт шлёт Art-Net на этот компьютер: когда значение канала входит в диапазон, запускается
        действие. Срабатывает один раз при входе в диапазон — если значение держится, действие не повторяется.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Вселенная</th>
            <th>Канал</th>
            <th>Диапазон</th>
            <th>Действие</th>
            <th>Цель</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {project.dmxTriggers.map((t) => (
            <tr key={t.id}>
              <td>
                <select
                  value={t.universe}
                  onChange={(e) =>
                    update(
                      project.dmxTriggers.map((x) => (x.id === t.id ? { ...x, universe: Number(e.target.value) } : x)),
                    )
                  }
                >
                  {universes.map((u) => (
                    <option key={u.id} value={u.id}>
                      {universeShort(u)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  className="input input-num"
                  type="number"
                  min={1}
                  max={512}
                  value={t.address}
                  onChange={(e) =>
                    update(
                      project.dmxTriggers.map((x) =>
                        x.id === t.id
                          ? { ...x, address: Math.max(1, Math.min(512, Math.round(Number(e.target.value)) || 1)) }
                          : x,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <input
                  className="input input-num"
                  type="number"
                  min={0}
                  max={255}
                  value={t.valueMin}
                  onChange={(e) =>
                    update(
                      project.dmxTriggers.map((x) =>
                        x.id === t.id
                          ? { ...x, valueMin: Math.max(0, Math.min(x.valueMax, Math.round(Number(e.target.value)))) }
                          : x,
                      ),
                    )
                  }
                />
                {' – '}
                <input
                  className="input input-num"
                  type="number"
                  min={0}
                  max={255}
                  value={t.valueMax}
                  onChange={(e) =>
                    update(
                      project.dmxTriggers.map((x) =>
                        x.id === t.id
                          ? { ...x, valueMax: Math.max(x.valueMin, Math.min(255, Math.round(Number(e.target.value)))) }
                          : x,
                      ),
                    )
                  }
                />
              </td>
              <ActionCells
                binding={t}
                refOptions={refOptions}
                onChange={(action) => update(project.dmxTriggers.map((x) => (x.id === t.id ? { ...x, action } : x)))}
              />
              <td>
                <button className="btn btn-small btn-icon btn-glyph" onClick={() => update(project.dmxTriggers.filter((x) => x.id !== t.id))}>
                  <CloseIcon />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button
          className="btn btn-icon"
          onClick={() =>
            update([
              ...project.dmxTriggers,
              { id: uid(), universe: firstUniverse, address: 1, valueMin: 200, valueMax: 255, action: defaultAction() },
            ])
          }
          disabled={universes.length === 0}
        >
          <PlusIcon />
          Команда по каналу
        </button>
      </div>
    </section>
  );
}
