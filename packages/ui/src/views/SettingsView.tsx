import { useEffect, useState } from 'react';
import type { ConfigUniverse } from '@fountain-studio/shared';
import type { EngineConnection } from '../useEngine';

/**
 * Настройки движка: вселенные (DMX-линии) и шаг тика — редактирование
 * fountain.config.json из интерфейса, без текстового редактора. Движок
 * применяет на лету (воспроизведение при этом останавливается) и сохраняет
 * файл сам.
 */
export function SettingsView({ engine }: { engine: EngineConnection }) {
  const { engineConfig, project, send } = engine;
  const [tickMs, setTickMs] = useState(50);
  const [universes, setUniverses] = useState<ConfigUniverse[]>([]);
  const [dirty, setDirty] = useState(false);
  const [applied, setApplied] = useState(false);

  // Загрузка из движка; пока правки не начаты — следуем за его состоянием.
  useEffect(() => {
    if (!engineConfig || dirty) return;
    setTickMs(engineConfig.tickMs);
    setUniverses(engineConfig.universes.map((u) => ({ ...u, outputs: u.outputs.map((o) => ({ ...o })) })));
  }, [engineConfig, dirty]);

  if (!engineConfig) {
    return (
      <main className="view">
        <section className="panel">
          <h2>Настройки</h2>
          <p className="dim">Ожидание конфигурации от движка…</p>
        </section>
      </main>
    );
  }

  const touch = (): void => {
    setDirty(true);
    setApplied(false);
  };

  const patchUniverse = (id: number, patch: Partial<ConfigUniverse>): void => {
    touch();
    setUniverses(universes.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  };

  const patchOutput = (id: number, patch: Partial<ConfigUniverse['outputs'][number]>): void => {
    touch();
    setUniverses(
      universes.map((u) =>
        u.id === id
          ? { ...u, outputs: u.outputs.map((o, i) => (i === 0 ? { ...o, ...patch } : o)) }
          : u,
      ),
    );
  };

  const addUniverse = (): void => {
    touch();
    const id = Math.max(0, ...universes.map((u) => u.id)) + 1;
    setUniverses([
      ...universes,
      {
        id,
        label: `Вселенная ${id}`,
        outputs: [{ type: 'artnet', host: '127.0.0.1', universe: id - 1 }],
      },
    ]);
  };

  const removeUniverse = (id: number): void => {
    const devices = project?.devices.filter((d) => d.universe === id) ?? [];
    if (devices.length > 0) {
      const ok = window.confirm(
        `На вселенной ${id} стоят приборы: ${devices.length} шт. (${devices
          .slice(0, 5)
          .map((d) => d.name)
          .join(', ')}${devices.length > 5 ? '…' : ''}).\n\n` +
          'После удаления вселенной они перестанут выводиться, пока вы не перенесёте их ' +
          'на другую вселенную на вкладке «Приборы». Удалить?',
      );
      if (!ok) return;
    }
    touch();
    setUniverses(universes.filter((u) => u.id !== id));
  };

  const apply = (): void => {
    send({ type: 'updateConfig', tickMs, universes });
    setDirty(false);
    setApplied(true);
  };

  const valid = universes.length > 0 && tickMs >= 10 && tickMs <= 1000;

  return (
    <main className="view">
      <section className="panel">
        <h2>Вселенные (DMX-линии)</h2>
        <p className="dim">
          Одна вселенная = одна физическая линия DMX на 512 адресов. Заводите столько, сколько
          линий реально есть на объекте — лишние только занимают место на экране. Применение
          останавливает воспроизведение; мониторинг сети подхватит новые адреса после
          перезапуска движка.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>№</th>
              <th>Название</th>
              <th>Протокол</th>
              <th>IP ноды</th>
              <th title="Номер вселенной внутри протокола: Art-Net считает с 0, sACN — с 1">
                № в протоколе
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {universes.map((u) => {
              const out = u.outputs[0];
              return (
                <tr key={u.id}>
                  <td className="dim">{u.id}</td>
                  <td>
                    <input
                      className="input"
                      style={{ width: 140 }}
                      value={u.label ?? ''}
                      placeholder={`Вселенная ${u.id}`}
                      onChange={(e) => patchUniverse(u.id, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={out?.type ?? 'artnet'}
                      onChange={(e) =>
                        patchOutput(u.id, { type: e.target.value as 'artnet' | 'sacn' })
                      }
                    >
                      <option value="artnet">Art-Net</option>
                      <option value="sacn">sACN</option>
                    </select>
                  </td>
                  <td>
                    {out?.type === 'artnet' ? (
                      <input
                        className="input"
                        style={{ width: 120 }}
                        value={out.host ?? ''}
                        placeholder="192.168.0.50"
                        onChange={(e) => patchOutput(u.id, { host: e.target.value })}
                      />
                    ) : (
                      <span className="dim">multicast</span>
                    )}
                  </td>
                  <td>
                    <input
                      className="input input-num"
                      type="number"
                      min={0}
                      value={out?.universe ?? 0}
                      onChange={(e) => patchOutput(u.id, { universe: Math.max(0, Math.round(Number(e.target.value)) || 0) })}
                    />
                  </td>
                  <td>
                    {u.outputs.length > 1 && (
                      <span className="badge" title="У вселенной несколько выходов; здесь редактируется первый, остальные сохраняются как есть">
                        +{u.outputs.length - 1} вых.
                      </span>
                    )}{' '}
                    <button
                      className="btn btn-small"
                      disabled={universes.length <= 1}
                      title={universes.length <= 1 ? 'Нужна хотя бы одна вселенная' : 'Удалить вселенную'}
                      onClick={() => removeUniverse(u.id)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="form-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={addUniverse}>
            + Вселенная
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Тайминг</h2>
        <div className="form-row">
          <label className="field">
            Шаг обновления (тик), мс:{' '}
            <input
              className="input input-num"
              type="number"
              min={10}
              max={1000}
              step={5}
              value={tickMs}
              onChange={(e) => {
                touch();
                setTickMs(Math.round(Number(e.target.value)) || 50);
              }}
            />
          </label>
          <span className="dim">
            = {tickMs >= 10 ? Math.round(1000 / tickMs) : '—'} обновлений в секунду. 50 мс (20 Гц) —
            стандарт для фонтанов; 25 мс (40 Гц) — плавнее для быстрого света.
          </span>
        </div>
      </section>

      <div className="form-row">
        <button className="btn active" disabled={!dirty || !valid} onClick={apply}>
          Применить и сохранить
        </button>
        {dirty && !valid && <span className="error-text">нужна хотя бы одна вселенная и тик 10–1000 мс</span>}
        {applied && <span className="dim">✔ применено и сохранено в fountain.config.json</span>}
        {dirty && valid && (
          <span className="warn">воспроизведение при применении будет остановлено</span>
        )}
      </div>
    </main>
  );
}
