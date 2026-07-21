import { useEffect, useState } from 'react';
import { computeWindLimitPercent, type BackupInfo, type ConfigUniverse } from '@fountain-studio/shared';
import { TOUR_STORAGE_KEY } from '../tour';
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
import {
  checkOperatorPassword,
  clearOperatorPassword,
  hasOperatorPassword,
  lockOperator,
  setOperatorPassword,
} from '../operatorMode';
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

/**
 * Режим оператора (§27 доработки, УХ п.8): упрощённый экран для дежурного
 * персонала, все вкладки редактора скрыты за паролем. Настройка — здесь;
 * сама блокировка переживает перезапуск приложения (снимается только паролем
 * на экране оператора), поэтому «Заблокировать» перезагружает страницу —
 * так App.tsx заново прочитает состояние с нуля, без протаскивания коллбэков
 * между вкладками.
 */
function OperatorPanel() {
  const [hasPw, setHasPw] = useState(hasOperatorPassword());
  const [mode, setMode] = useState<'idle' | 'set' | 'change'>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const reset = (): void => {
    setMode('idle');
    setCurrent('');
    setNext('');
    setConfirm('');
    setError('');
  };

  const submitNew = async (): Promise<void> => {
    if (mode === 'change' && !(await checkOperatorPassword(current))) {
      setError('Текущий пароль неверен');
      return;
    }
    if (next.length < 4) {
      setError('Минимум 4 символа');
      return;
    }
    if (next !== confirm) {
      setError('Пароли не совпадают');
      return;
    }
    await setOperatorPassword(next);
    setHasPw(true);
    reset();
  };

  const disable = async (): Promise<void> => {
    if (!(await checkOperatorPassword(current))) {
      setError('Пароль неверен');
      return;
    }
    clearOperatorPassword();
    setHasPw(false);
    reset();
  };

  return (
    <section className="panel">
      <h2>Режим оператора</h2>
      <p className="dim">
        Упрощённый экран для дежурного персонала/планшета: только запуск плейлистов и сцен, стоп,
        пауза, BLACKOUT — без доступа к редактированию. Пароль хранится на этом компьютере (не в
        проекте). Блокировка переживает перезапуск приложения и снимается только паролем — храните
        его в надёжном месте, сброса «забыли пароль» нет.
      </p>

      {!hasPw && mode === 'idle' && (
        <button className="btn" onClick={() => setMode('set')}>
          Установить пароль
        </button>
      )}

      {hasPw && mode === 'idle' && (
        <div className="form-row">
          <span className="ok-text">✔ пароль установлен</span>
          <button
            className="btn btn-warn"
            onClick={() => {
              lockOperator();
              window.location.reload();
            }}
          >
            🔒 Заблокировать интерфейс сейчас
          </button>
          <button className="btn btn-small" onClick={() => setMode('change')}>
            Сменить пароль
          </button>
        </div>
      )}

      {(mode === 'set' || mode === 'change') && (
        <div className="form-row">
          {mode === 'change' && (
            <label className="field">
              Текущий пароль:{' '}
              <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
          )}
          <label className="field">
            Новый пароль:{' '}
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="field">
            Повтор:{' '}
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <button className="btn active" onClick={() => void submitNew()}>
            Сохранить
          </button>
          <button className="btn btn-small" onClick={reset}>
            Отмена
          </button>
          {error && <span className="error-text">{error}</span>}
        </div>
      )}

      {hasPw && mode === 'idle' && (
        <details style={{ marginTop: 10 }}>
          <summary className="dim" style={{ cursor: 'pointer' }}>
            Отключить режим оператора
          </summary>
          <div className="form-row" style={{ marginTop: 8 }}>
            <label className="field">
              Пароль:{' '}
              <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <button className="btn btn-danger" onClick={() => void disable()}>
              Отключить и удалить пароль
            </button>
            {error && <span className="error-text">{error}</span>}
          </div>
        </details>
      )}
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
 * Экспорт/импорт проекта одним файлом (§27 доработки) — .zip с project.json
 * и всей папкой audio/: перенос между ПК или передача проекта заказчику в
 * один клик, вместо ручного копирования fountain.project.json и папки audio
 * по отдельности.
 */
function ExportImportPanel({ engine }: { engine: EngineConnection }) {
  const { requestExportProject, importProjectArchive } = engine;
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const doExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const { filename, dataBase64 } = await requestExportProject();
      const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const doImport = async (file: File): Promise<void> => {
    if (
      !window.confirm(
        'Импорт заменит ВЕСЬ текущий проект (приборы, сцены, шоу, расписание и т.д.) содержимым файла.\n\n' +
          'Текущие несохранённые правки будут потеряны. Продолжить?',
      )
    ) {
      return;
    }
    setImporting(true);
    setImportMsg(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const result = await importProjectArchive(btoa(bin));
      setImportMsg(result);
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="panel">
      <h2>Экспорт / импорт проекта</h2>
      <p className="dim">
        Один файл — весь проект (приборы, сцены, шоу, расписание) вместе с аудио шоу. Удобно для переноса между ПК
        или передачи заказчику.
      </p>
      <div className="form-row">
        <button className="btn" onClick={() => void doExport()} disabled={exporting}>
          {exporting ? 'Собираю…' : '⬇ Экспортировать в файл'}
        </button>
        <label className="btn">
          {importing ? 'Импортирую…' : '⬆ Импортировать из файла…'}
          <input
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            disabled={importing}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {importMsg && (
        <p className={importMsg.ok ? 'ok-text' : 'warn'}>
          {importMsg.ok ? '✔ ' : '⚠ '}
          {importMsg.message}
        </p>
      )}
    </section>
  );
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
 * Автозапуск движка при входе в Windows (§27 доработки, §3 п.3) — та же задача
 * планировщика, что раньше ставилась вручную (`tools/install-autostart.ps1`),
 * теперь по кнопке. Сторож (engine:watchdog) перезапускает движок при падении.
 */
function AutostartPanel({ engine }: { engine: EngineConnection }) {
  const { autostart, send } = engine;

  useEffect(() => {
    send({ type: 'getAutostart' });
  }, [send]);

  return (
    <section className="panel">
      <h2>Автозапуск</h2>
      {!autostart ? (
        <p className="dim">Ожидание состояния от движка…</p>
      ) : !autostart.supported ? (
        <p className="dim">{autostart.error ?? 'Поддержано только на Windows (планировщик задач).'}</p>
      ) : (
        <>
          <p className="dim">
            Движок запускается сам при входе в Windows и продолжает работать в фоне (сторож
            перезапускает его при падении) — фонтан отыграет расписание, даже если никто не открыл
            редактор после перезагрузки/отключения питания.
          </p>
          <div className="form-row">
            <label className="field">
              <input
                type="checkbox"
                checked={autostart.enabled}
                onChange={(e) => send({ type: 'setAutostart', enabled: e.target.checked })}
              />{' '}
              Запускать при старте Windows
            </label>
            {autostart.error && <span className="error-text">{autostart.error}</span>}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Датчик ветра → безопасное снижение струй (§27 доработки, §4 п.1) —
 * пороги настраиваются здесь один раз при пусконаладке; текущее показание
 * ветра вводится оперативно на вкладке «Пульт» (пока нет датчика по
 * Modbus/MQTT — задел под него, сам расчёт менять не придётся).
 */
function WindLimitPanel({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  if (!project) return null;
  const cfg = project.windLimit;
  const update = (patch: Partial<typeof cfg>): void => updateProject({ ...project, windLimit: { ...cfg, ...patch } });

  // Предпросмотр: что было бы при ветре чуть выше maxSpeed — наглядная проверка настроек.
  const previewSpeed = cfg.maxSpeed;
  const previewPercent = computeWindLimitPercent(previewSpeed, cfg);

  return (
    <section className="panel">
      <h2>Датчик ветра</h2>
      <p className="dim">
        Ветер выше порога — мощность насосов (высота струй) снижается; свет не трогается. Пока без реального
        датчика — оператор вводит текущую скорость ветра вручную на вкладке «Пульт».
      </p>
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{' '}
          Включено
        </label>
        <label className="field">
          Начало ограничения, м/с:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            step={0.5}
            disabled={!cfg.enabled}
            value={cfg.warnSpeed}
            onChange={(e) => update({ warnSpeed: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
        <label className="field">
          Полное ограничение, м/с:{' '}
          <input
            className="input input-num"
            type="number"
            min={cfg.warnSpeed + 0.1}
            step={0.5}
            disabled={!cfg.enabled}
            value={cfg.maxSpeed}
            onChange={(e) => update({ maxSpeed: Math.max(cfg.warnSpeed + 0.1, Number(e.target.value) || cfg.warnSpeed + 1) })}
          />
        </label>
        <label className="field">
          Мин. мощность, %:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={100}
            disabled={!cfg.enabled}
            value={cfg.minPercent}
            onChange={(e) => update({ minPercent: Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })}
          />
        </label>
      </div>
      {cfg.enabled && (
        <p className="dim">
          Проверка: при {previewSpeed} м/с (порог полного ограничения) мощность насосов будет снижена до{' '}
          {previewPercent}%.
        </p>
      )}
    </section>
  );
}

/**
 * Холостая сцена (§27 доработки, по примеру прежнего приложения —
 * «Color Form») — что держится на выходе, когда ничего не играет, вместо
 * гашения в чёрное. Пауза между элементами плейлиста — исключение (см.
 * Playback.tick), туда холостая сцена не подставляется.
 */
function IdleScenePanel({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  if (!project) return null;
  return (
    <section className="panel">
      <h2>Холостая сцена</h2>
      <p className="dim">
        Держится на выходе, когда ничего не играет (нет активной сцены/секвенсора/шоу) — вместо чёрного. Пауза между
        песнями плейлиста — исключение, там всегда чёрное намеренно.
      </p>
      <div className="form-row">
        <label className="field">
          Сцена:{' '}
          <select
            value={project.idleSceneId ?? ''}
            onChange={(e) => updateProject({ ...project, idleSceneId: e.target.value || null })}
          >
            <option value="">— нет (чёрное) —</option>
            {project.scenes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

/**
 * Служебное освещение (§27 доработки, по примеру прежнего приложения —
 * «Switches») — простое вкл/выкл по времени суток для выбранных приборов
 * (периметральная подсветка и т.п.), независимо от расписания шоу/плейлистов.
 */
function UtilityLightPanel({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  if (!project) return null;
  const cfg = project.utilityLight;
  const update = (patch: Partial<typeof cfg>): void =>
    updateProject({ ...project, utilityLight: { ...cfg, ...patch } });
  const toggleDevice = (id: string): void => {
    const has = cfg.deviceIds.includes(id);
    update({ deviceIds: has ? cfg.deviceIds.filter((x) => x !== id) : [...cfg.deviceIds, id] });
  };
  return (
    <section className="panel">
      <h2>Служебное освещение</h2>
      <p className="dim">
        Простое вкл/выкл по времени суток для выбранных приборов (например, периметральная подсветка) —
        независимо от расписания шоу/плейлистов. Перекрывает сцены/шоу на этих каналах, пока включено.
      </p>
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{' '}
          Включено
        </label>
        <label className="field" title="Ручной оверрайд — не доверять расписанию, держать включённым всегда">
          <input
            type="checkbox"
            checked={cfg.always}
            disabled={!cfg.enabled}
            onChange={(e) => update({ always: e.target.checked })}
          />{' '}
          Всегда включено
        </label>
        <label className="field">
          Вкл:{' '}
          <input
            className="input"
            type="time"
            value={cfg.onTime}
            disabled={!cfg.enabled || cfg.always}
            onChange={(e) => update({ onTime: e.target.value })}
          />
        </label>
        <label className="field">
          Выкл:{' '}
          <input
            className="input"
            type="time"
            value={cfg.offTime}
            disabled={!cfg.enabled || cfg.always}
            onChange={(e) => update({ offTime: e.target.value })}
          />
        </label>
      </div>
      {project.devices.length === 0 ? (
        <p className="dim">Нет приборов в патче.</p>
      ) : (
        <div className="utility-device-list">
          {project.devices.map((d) => (
            <label key={d.id} className="field">
              <input
                type="checkbox"
                checked={cfg.deviceIds.includes(d.id)}
                disabled={!cfg.enabled}
                onChange={() => toggleDevice(d.id)}
              />{' '}
              {d.name}
            </label>
          ))}
        </div>
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

      <ExportImportPanel engine={engine} />
      <BackupPanel engine={engine} />
      <AutostartPanel engine={engine} />
      <WindLimitPanel engine={engine} />
      <IdleScenePanel engine={engine} />
      <UtilityLightPanel engine={engine} />
      <HotkeysPanel />
      <OperatorPanel />
      <TourReplayPanel />
    </main>
  );
}

/** Повторный показ тура первого запуска (§27 доработки) — на случай, если пропустили или хотите освежить. */
function TourReplayPanel() {
  return (
    <section className="panel">
      <h2>Тур по программе</h2>
      <p className="dim">Короткая подсказка по вкладкам «Приборы → 3D → Сцены → Шоу», которая показывается при первом запуске.</p>
      <button
        className="btn"
        onClick={() => {
          localStorage.removeItem(TOUR_STORAGE_KEY);
          location.reload();
        }}
      >
        Показать тур снова
      </button>
    </section>
  );
}
