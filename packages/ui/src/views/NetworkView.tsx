import type { NetworkState } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/**
 * Вкладка «Сеть»: Art-Net ноды и RDM-приборы на линиях — «жив/потерян»,
 * журнал появлений и пропаж. Данные собирает движок (ArtPoll + ArtTodRequest).
 */
export function NetworkView({ engine }: { engine: EngineConnection }) {
  const { network, send } = engine;

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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Журнал</h2>
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
    </main>
  );
}

function formatAge(ageMs: number): string {
  if (ageMs < 2000) return 'только что';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)} с назад`;
  return `${Math.round(ageMs / 60_000)} мин назад`;
}

export type { NetworkState };
