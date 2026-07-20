import { useEffect, useState } from 'react';
import type { BackupInfo, ConfigUniverse } from '@fountain-studio/shared';
import {
  HOTKEY_DEFS,
  comboFromEvent,
  comboLabel,
  findConflict,
  resetCombo,
  setCombo,
  useHotkey,
  type HotkeyId,
} from '../hotkeys';
import type { EngineConnection } from '../useEngine';

/**
 * Переназначение горячих клавиш редактора (§27 доработки, УХ п.6) — те, что
 * относятся к самому приложению (отменить/сохранить/дублировать…), не к
 * «Клавиатуре» (та привязывает клавиши к сценам/шоу конкретного проекта и
 * живёт отдельной вкладкой). Хранится в localStorage — предпочтение этого
 * компьютера, не часть проекта.
 */
function HotkeyRow({ id }: { id: HotkeyId }) {
  const def = HOTKEY_DEFS.find((d) => d.id === id)!;
  const combo = useHotkey(id);
  const [capturing, setCapturing] = useState(false);
  const [conflict, setConflict] = useState<HotkeyId | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setCapturing(false);
        return;
      }
      const next = comboFromEvent(e);
      const clash = findConflict(next, id);
      if (clash) {
        setConflict(clash);
        setCapturing(false);
        return;
      }
      setCombo(id, next);
      setCapturing(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [capturing, id]);

  return (
    <tr>
      <td>
        {def.label}
        {def.hint && <span className="dim"> · {def.hint}</span>}
      </td>
      <td>
        <button
          className={capturing ? 'btn active' : 'btn'}
          onClick={() => {
            setConflict(null);
            setCapturing(!capturing);
          }}
        >
          {capturing ? 'нажмите комбинацию… (Esc — отмена)' : comboLabel(combo)}
        </button>
        {conflict && (
          <span className="error-text">
            {' '}
            уже занято: «{HOTKEY_DEFS.find((d) => d.id === conflict)!.label}»
          </span>
        )}
      </td>
      <td>
        {combo !== def.default && (
          <button className="btn btn-small" onClick={() => resetCombo(id)} title="Вернуть по умолчанию">
            ↺
          </button>
        )}
      </td>
    </tr>
  );
}

function HotkeysPanel() {
  return (
    <section className="panel">
      <h2>Горячие клавиши</h2>
      <p className="dim">
        Команды самого редактора — не путать с «Клавиатурой» (та привязывает клавиши к сценам и
        шоу конкретного проекта). Хранится на этом компьютере, с проектом не переносится.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Команда</th>
            <th>Комбинация</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {HOTKEY_DEFS.map((d) => (
            <HotkeyRow key={d.id} id={d.id} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function fmtBackupTime(atMs: number): string {
  return new Date(atMs).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function fmtSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1)} КБ`;
}

/**
 * Авто-бэкапы проекта (§27 доработки, УХ п.5): именованные снимки по расписанию,
 * отдельно от непрерывного живого автосохранения (то всегда включено и невидимо).
 * Смена интервала применяется сразу, без кнопки «Применить» и без остановки
 * воспроизведения — в отличие от вселенных/тика выше на этой же вкладке.
 */
function BackupPanel({ engine }: { engine: EngineConnection }) {
  const { backupConfig, backups, send } = engine;

  useEffect(() => {
    send({ type: 'listBackups' });
  }, [send]);

  if (!backupConfig) {
    return (
      <section className="panel">
        <h2>Авто-бэкапы</h2>
        <p className="dim">Ожидание настройки от движка…</p>
      </section>
    );
  }

  const restore = (b: BackupInfo): void => {
    const ok = window.confirm(
      `Снимок от ${fmtBackupTime(b.atMs)} заменит собой ТЕКУЩИЙ проект целиком — всё, что сделано ` +
        'после этого снимка, будет потеряно (если это тоже не заскриптовано в другом снимке).\n\n' +
        'Восстановить?',
    );
    if (!ok) return;
    send({ type: 'restoreBackup', file: b.file });
  };

  return (
    <section className="panel">
      <h2>Авто-бэкапы</h2>
      <p className="dim">
        Именованные снимки проекта по расписанию — защита от «сам всё сломал в редакторе», отдельно
        от постоянного автосохранения (оно и так всегда включено, беречь есть что). Хранятся
        последние 20 штук.
      </p>
      <div className="form-row">
        <label className="field">
          <input
            type="checkbox"
            checked={backupConfig.enabled}
            onChange={(e) => send({ type: 'updateBackupConfig', enabled: e.target.checked, intervalMin: backupConfig.intervalMin })}
          />{' '}
          Включено
        </label>
        <label className="field">
          Интервал, мин:{' '}
          <input
            className="input input-num"
            type="number"
            min={1}
            max={30}
            disabled={!backupConfig.enabled}
            value={backupConfig.intervalMin}
            onChange={(e) => {
              const intervalMin = Math.max(1, Math.min(30, Math.round(Number(e.target.value)) || 10));
              send({ type: 'updateBackupConfig', enabled: backupConfig.enabled, intervalMin });
            }}
          />
        </label>
        <button className="btn btn-small" onClick={() => send({ type: 'takeBackupNow' })}>
          Сделать снимок сейчас
        </button>
      </div>

      {backups.length === 0 ? (
        <p className="dim">Снимков ещё нет.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Когда</th>
              <th>Размер</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.file}>
                <td>{fmtBackupTime(b.atMs)}</td>
                <td className="dim">{fmtSize(b.sizeBytes)}</td>
                <td>
                  <button className="btn btn-small" onClick={() => restore(b)}>
                    Восстановить
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

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

      <BackupPanel engine={engine} />
      <HotkeysPanel />
    </main>
  );
}
