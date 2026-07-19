import { uid, type MqttBinding, type OscBinding, type RemoteAction } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

const ACTION_LABEL: Record<RemoteAction['type'], string> = {
  scene: 'Включить сцену',
  sequence: 'Запустить секвенсор',
  show: 'Запустить шоу',
  playlist: 'Запустить плейлист',
  stopAll: 'Стоп всё',
  blackout: 'BLACKOUT',
};

/**
 * Удалённое управление: OSC-пульты (TouchOSC и т.п.) и MQTT (телеметрия +
 * команды). Включение/адрес брокера/порт — в fountain.config.json (как
 * Art-Net/sACN — это настройка конкретной инсталляции, не проекта); здесь —
 * только привязки «адрес/топик → действие», которые живут в проекте.
 */
export function RemoteView({ engine }: { engine: EngineConnection }) {
  const { project, remote, updateProject } = engine;
  if (!project) return <main className="view">Ожидание проекта от движка…</main>;

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
    <main className="view">
      <section className="panel">
        <h2>Статус</h2>
        {!remote ? (
          <p className="dim">Ожидание состояния от движка…</p>
        ) : (
          <ul className="list">
            <li className="list-item">
              OSC: {remote.osc.enabled ? '✔ включён (порт — в fountain.config.json)' : '— выключен (osc.enabled в конфиге)'}
            </li>
            <li className="list-item">
              MQTT:{' '}
              {!remote.mqtt.enabled
                ? '— выключен (mqtt.enabled в конфиге)'
                : remote.mqtt.connected
                  ? '✔ подключён к брокеру'
                  : '✖ включён, но нет связи с брокером'}
            </li>
          </ul>
        )}
      </section>

      <OscPanel project={project} updateProject={updateProject} refOptions={refOptions} defaultAction={defaultAction} />
      <MqttPanel project={project} updateProject={updateProject} refOptions={refOptions} defaultAction={defaultAction} />
    </main>
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
                <button className="btn btn-small" onClick={() => update(project.oscBindings.filter((x) => x.id !== b.id))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button
          className="btn"
          onClick={() => update([...project.oscBindings, { id: uid(), address: '/', action: defaultAction() }])}
        >
          + Привязка OSC
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
        Полный топик команды — «&lt;topicPrefix&gt;/cmd/&lt;суффикс&gt;» (префикс задан в конфиге движка,
        по умолчанию «fountain-studio»); здесь указывается только суффикс. Статус публикуется в
        «&lt;topicPrefix&gt;/status» раз в 5 с.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Суффикс топика</th>
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
                <button className="btn btn-small" onClick={() => update(project.mqttBindings.filter((x) => x.id !== b.id))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button
          className="btn"
          onClick={() => update([...project.mqttBindings, { id: uid(), topic: '', action: defaultAction() }])}
        >
          + Привязка MQTT
        </button>
      </div>
    </section>
  );
}
