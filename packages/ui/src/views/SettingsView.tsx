import { useEffect, useState } from 'react';
import {
  FRAME_MODE_ABOUT,
  FRAME_MODE_CONFIRM,
  FRAME_MODES,
  type FrameMode,
  frameModeLabel,
  plainWindNozzle,
  windAllowedLevel,
  windNozzleFor,
  type BackupInfo,
  type ConfigOutput,
  type ConfigUniverse,
  type UsbDmxScan,
  type UsbDriverProblem,
  FAILSAFE_TIMEOUT_MIN_SEC,
  FAILSAFE_TIMEOUT_MAX_SEC,
  describeLinesChange,
  nextUniverse,
  storedUniverseLabel,
  universeTitle,
  clampVolumeDb,
  clampToneDb,
  toneDbLabel,
  TONE_DB_MAX,
  TONE_DB_MIN,
  VOLUME_DB_MAX,
  VOLUME_DB_MIN,
  num,
  countOf,
} from '@fountain-studio/shared';
import { askConfirm } from '../components/ConfirmDialog';
import { TOUR_STORAGE_KEY } from '../tour';
import { applySettingsDraft, clearSettingsDraft, keepSettingsDraft, useSettingsDraft } from '../settingsDraft';
import { setViewPrefs, VIEW_PREF_DEFAULTS, VIEW_PREF_LIMITS, viewPrefs } from '../three/viewPrefs';
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
          <button className="btn btn-small" onClick={() => resetCombo(id)} data-hint="Вернуть по умолчанию">
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
        шоу конкретного объекта). Хранится на этом компьютере, с объектом не переносится.
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
        Упрощённый экран для дежурного или планшета: только запуск плейлистов и сцен, стоп, пауза и
        полное гашение — без доступа к редактированию. Пароль хранится на этом компьютере (не в
        объекте). Блокировка переживает перезапуск приложения и снимается только паролем — храните
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
  return bytes < 1024 ? `${bytes} Б` : `${num(bytes / 1024, 1)} КБ`;
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
    const ok = await askConfirm('Заменить весь объект содержимым файла?', {
      detail:
        'Импорт перезапишет приборы, сцены, шоу, расписание — всё. Текущие несохранённые правки будут потеряны.',
      okLabel: 'Импортировать',
    });
    if (!ok) return;
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
      <h2>Перенос объекта одним файлом</h2>
      <p className="dim">
        Один файл — весь объект (приборы, сцены, шоу, расписание) вместе с музыкой шоу. Удобно для переноса между ПК
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
        <h2>Резервные копии</h2>
        <p className="dim">Жду данные от движка…</p>
      </section>
    );
  }

  const restore = async (b: BackupInfo): Promise<void> => {
    const ok = await askConfirm(`Восстановить копию от ${fmtBackupTime(b.atMs)}?`, {
      detail:
        'Копия заменит текущий объект целиком — всё, что сделано после неё, будет потеряно.',
      okLabel: 'Восстановить',
    });
    if (!ok) return;
    send({ type: 'restoreBackup', file: b.file });
  };

  /** Зафиксировать нынешнее состояние эталоном — с подтверждением: оно затрёт прежний. */
  const makeReference = async (): Promise<void> => {
    const had = backups.some((b) => b.reference);
    const ok = await askConfirm('Сделать нынешнее состояние эталоном?', {
      detail: had
        ? 'Прежний эталон будет заменён. Эталон — это заведомо рабочее состояние объекта: он не прореживается и переписывается только этой кнопкой.'
        : 'Эталон — заведомо рабочее состояние объекта. Он не прореживается со временем и переписывается только этой кнопкой.',
      okLabel: 'Сделать эталоном',
      danger: false,
    });
    if (!ok) return;
    send({ type: 'setReferenceBackup' });
  };

  return (
    <section className="panel">
      <h2>Резервные копии</h2>
      <p className="dim">
        Копии объекта по расписанию — на случай, если в редакторе что-то испортили. Это отдельно от
        автосохранения: оно работает всегда.
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
          Сделать копию сейчас
        </button>
        <button
          className="btn btn-small"
          data-hint="Зафиксировать нынешнее состояние как ЭТАЛОН объекта. Эталон не прореживается и не переписывается автоматикой — к нему возвращаются, если кто-то всё переделал."
          onClick={() => void makeReference()}
        >
          Сделать эталоном
        </button>
      </div>
      <p className="dim">
        Копия делается, только если в объекте что-то изменилось. Хранятся: за последние 6 часов — по одному на
        каждые 10 минут, за два месяца — по одному на день, дальше — по одному на месяц. Поэтому
        полчаса правок не вытесняют рабочую версию месячной давности.
      </p>

      {backups.length === 0 ? (
        <p className="dim">Копий ещё нет.</p>
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
              <tr key={b.file} className={b.reference ? 'row-playing' : undefined}>
                <td>
                  {b.reference ? <b>Эталон</b> : fmtBackupTime(b.atMs)}
                  {b.reference && <span className="dim"> · {fmtBackupTime(b.atMs)}</span>}
                </td>
                <td className="dim">{fmtSize(b.sizeBytes)}</td>
                <td>
                  <button className="btn btn-small" onClick={() => void restore(b)}>
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
        <p className="dim">{autostart.error ?? 'Работает только на Windows.'}</p>
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
 * Уведомления в Telegram.
 *
 * Токен здесь ТОЛЬКО вводится и уходит на движок — обратно он не приходит
 * никогда, и в интерфейсе видно лишь «задан или нет». Так его не подсмотреть
 * ни через журнал, ни через экспорт проекта, ни заглянув в чужой экран.
 */
function TelegramPanel({ engine }: { engine: EngineConnection }) {
  const { telegram, telegramTest, send, project, updateProject } = engine;
  const [token, setToken] = useState('');
  /** Черновик названия объекта — уходит в проект по выходу из поля, а не на каждую букву. */
  const [siteDraft, setSiteDraft] = useState<string | null>(null);
  if (!telegram) return null;
  /**
   * Название объекта — это имя проекта. Им подписаны сообщения, по нему метка
   * #Саки_Пруд и тема «🏛 Саки Пруд». Раньше поменять его было негде, и все
   * объекты пришли бы в Telegram как «Демо-проект». Сохраняем по выходу из
   * поля: иначе на каждую набранную букву могла бы завестись своя тема.
   */
  const commitSite = (): void => {
    const next = (siteDraft ?? '').trim();
    setSiteDraft(null);
    if (!project || next === '' || next === project.name) return;
    updateProject({ ...project, name: next });
  };
  return (
    <section className="panel">
      <h2>Уведомления в Telegram</h2>
      <p className="dim">
        Аварии — сразу, отчёт — раз в сутки. Нет интернета — сообщения копятся на диске и уходят, когда
        связь появится. По объектам раскладываются темами, по разделам — метками (#авария, #отчёт,
        #состояние).
      </p>
      <div className="form-row">
        <label
          className="field"
          data-hint="Так этот фонтан называется в сообщениях, в метке для поиска и в названии его темы в Telegram. У каждого объекта своё: Саки Пруд, Севастополь Тюльпан, Севастополь 60 лет, Севастополь Дюльбер."
        >
          Объект:{' '}
          <input
            className="input"
            style={{ width: 240 }}
            value={siteDraft ?? project?.name ?? ''}
            onChange={(e) => setSiteDraft(e.target.value)}
            onBlur={commitSite}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') setSiteDraft(null);
            }}
          />
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          <input
            type="checkbox"
            checked={telegram.enabled}
            onChange={(e) => send({ type: 'updateTelegram', enabled: e.target.checked })}
          />{' '}
          Включено
        </label>
        <label className="field" data-hint="Аварии ПЧ, пропажа узлов Art-Net и приборов — то же, что попадает в журнал уровнями «предупреждение» и «ошибка»">
          <input
            type="checkbox"
            checked={telegram.alarms}
            onChange={(e) => send({ type: 'updateTelegram', alarms: e.target.checked })}
          />{' '}
          Слать аварии
        </label>
        <label
          className="field"
          data-hint="Разрешить управление из чата: /state, /report, /quiet, кнопка «Принято» под аварией. «Стоп» и «Погасить» спрашивают подтверждение кнопкой. Команды принимаются только из чата-получателя, указанного ниже."
        >
          <input
            type="checkbox"
            checked={telegram.commands}
            onChange={(e) => send({ type: 'updateTelegram', commands: e.target.checked })}
          />{' '}
          Команды из чата
        </label>
        <label className="field">
          Отчёт в:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={23}
            value={telegram.dailyHour}
            onChange={(e) => send({ type: 'updateTelegram', dailyHour: Number(e.target.value) || 0 })}
          />{' '}
          ч
        </label>
      </div>
      <div className="form-row">
        <label className="field" data-hint="Токен от @BotFather. Хранится в настройках программы на этом компьютере (fountain.secrets.json) и в перенос объекта не попадает.">
          Токен бота:{' '}
          <input
            className="input"
            style={{ width: 260 }}
            type="password"
            placeholder={telegram.hasToken ? 'задан — введите новый, чтобы заменить' : 'вставьте токен'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <button
          className="btn btn-small"
          disabled={token.trim() === ''}
          onClick={() => {
            send({ type: 'updateTelegram', token: token.trim() });
            setToken('');
          }}
        >
          Сохранить токен
        </button>
        <button
          className="btn btn-small"
          onClick={() => send({ type: 'testTelegram' })}
          disabled={!telegram.hasToken}
          data-hint="Пришлёт по одному сообщению каждого раздела — состояние, отчёт и пример аварии. Сразу видно и что связь есть, и как всё будет выглядеть."
        >
          Проверить связь
        </button>
      </div>
      {/* Тихий режим: на время работ на объекте авария за аварией — обычное дело. */}
      <div className="form-row">
        <span className="dim">Тихий режим:</span>
        {telegram.quietUntilMs > Date.now() ? (
          <>
            <span className="warn">
              аварии не шлются до {new Date(telegram.quietUntilMs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <button className="btn btn-small" onClick={() => send({ type: 'setTelegramQuiet', hours: 0 })}>
              Снять
            </button>
          </>
        ) : (
          <>
            {[1, 4, 8].map((h) => (
              <button
                key={h}
                className="btn btn-small"
                disabled={!telegram.hasToken}
                data-hint="На время работ на объекте: аварии в Telegram не уходят, но в журнал пишутся. Когда время выйдет, придёт одна строка — сколько их было. «Восстановлено» приходит всегда."
                onClick={() => send({ type: 'setTelegramQuiet', hours: h })}
              >
                {h} ч
              </button>
            ))}
          </>
        )}
      </div>
      <div className="form-row">
        <label
          className="field"
          data-hint={
            'У каждого объекта своя тема «🏛 Имя объекта» — как отдельная папка в чате. В личном чате с ботом темы включает владелец бота в мини-приложении @BotFather: ваш бот → Mode Settings → режим тем (не путать с Guest Chat Mode — это другое). Программа сама замечает включение в течение 5 минут. В группе-форуме бот должен быть администратором с правом управлять темами. Пока темы недоступны, всё идёт в общий чат, а разложить помогают метки.'
          }
        >
          <input
            type="checkbox"
            checked={telegram.topicsBySite}
            onChange={(e) => send({ type: 'updateTelegram', topicsBySite: e.target.checked })}
          />{' '}
          Темы по объектам
        </label>
        <span className="dim">
          {!telegram.topicsBySite
            ? 'выключено — всё в общий чат, раздел по меткам'
            : telegram.topicsAvailable === true
              ? `работают, тем объектов: ${telegram.siteTopicCount}`
              : telegram.topicsAvailable === false
                ? 'темы в чате не включены — пока идёт в общий чат (наведите на «Темы по объектам»)'
                : 'выяснится при первой отправке'}
        </span>
      </div>
      <div className="form-row">
        <span
          className="quick-row-label"
          data-hint="Только если чат — группа-форум, где темы «Аварии», «Отчёты», «Состояние» заведены вручную: впишите их номера, и разделы лягут туда (это главнее тем по объектам). Ноль — раздел не привязан к теме."
        >
          Темы разделов:
        </span>
        <label className="field">
          аварии:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            value={telegram.topicAlarm}
            onChange={(e) => send({ type: 'updateTelegram', topicAlarm: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="field">
          отчёты:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            value={telegram.topicReport}
            onChange={(e) => send({ type: 'updateTelegram', topicReport: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="field">
          состояние:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            value={telegram.topicState}
            onChange={(e) => send({ type: 'updateTelegram', topicState: Number(e.target.value) || 0 })}
          />
        </label>
      </div>
      <p className="dim">
        Состояние: {telegram.hasToken ? 'токен задан' : 'токен не задан'} ·{' '}
        {telegram.chatId
          ? `получатель ${telegram.chatId}`
          : `получатель не определён — откройте ${telegram.botName || 'бота'} и нажмите «Start»`}{' '}
        ·
        в очереди {telegram.queued}
      </p>
      {telegramTest && (
        <p className={telegramTest.ok ? 'dim' : 'error-text'}>
          {telegramTest.ok ? '✅ Сообщение доставлено.' : `Не получилось: ${telegramTest.error ?? 'нет связи'}`}
        </p>
      )}
    </section>
  );
}

/**
 * Датчик ветра → безопасное снижение струй.
 *
 * Настраивается здесь один раз при пусконаладке; текущее показание ветра
 * вводится оперативно на вкладке «Отладка» (пока нет датчика по Modbus/MQTT —
 * задел под него, сам расчёт менять не придётся).
 *
 * Порогов «начало» и «конец» здесь больше нет: ограничение считается из
 * физики сноса и ВЫСОТЫ каждой струи (см. windlimit.ts). Поэтому в настройках
 * задаётся не скорость ветра, а то, что человек действительно знает про свой
 * объект: сколько воды можно пустить мимо чаши и когда фонтан пора глушить.
 */
/**
 * Аварийное отключение (§ failsafe.ts). Живое состояние приходит от движка
 * отдельным сообщением, настройка живёт в проекте — как ветровое ограничение
 * и служебный свет: это свойство объекта, а не компьютера.
 */
function FailsafePanel({ engine }: { engine: EngineConnection }) {
  const { project, updateProject, failsafe } = engine;
  if (!project) return null;
  const cfg = project.failsafe;
  const update = (patch: Partial<typeof cfg>): void =>
    updateProject({ ...project, failsafe: { ...cfg, ...patch } });

  return (
    <section className="panel">
      <h2>Аварийное отключение</h2>
      <p className="dim">
        Если движок перестал выдавать кадры приборам — такт вставал или выход не доставляет
        (выдернули USB, закрылся порт), — насосы и клапаны принудительно уходят в 0. Без этого
        приборы держат ПОСЛЕДНЕЕ принятое значение: насос продолжит крутиться, струя останется
        поднятой. Когда вывод восстановится, движок сам вернётся к обычной картине.
      </p>
      {failsafe?.active ? (
        <p className="error-text" style={{ marginLeft: 0 }}>
          ✖ Сейчас сработало: {failsafe.reason}. Вода отключена.
        </p>
      ) : (
        <p className="ok-text">
          ✔ Вывод в норме{failsafe && failsafe.trips > 0 ? ` (срабатываний с запуска: ${failsafe.trips})` : ''}
        </p>
      )}
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{' '}
          Включено
        </label>
        <label
          className="field"
          data-hint="Сколько терпим пропажу вывода, прежде чем гасить воду. Меньше 3 с ставить не стоит: короткие подвисания Windows — обычное дело, и фонтан начнёт мигать."
        >
          Ждать, с:{' '}
          <input
            className="input input-num"
            type="number"
            min={FAILSAFE_TIMEOUT_MIN_SEC}
            max={FAILSAFE_TIMEOUT_MAX_SEC}
            step={1}
            disabled={!cfg.enabled}
            value={cfg.timeoutSec}
            onChange={(e) =>
              update({
                timeoutSec: Math.max(
                  FAILSAFE_TIMEOUT_MIN_SEC,
                  Math.min(FAILSAFE_TIMEOUT_MAX_SEC, Math.round(Number(e.target.value)) || 10),
                ),
              })
            }
          />
        </label>
        <label className="field" data-hint="Гасить ли заодно подсветку. Воду (насосы и клапаны) гасим всегда — это безопасность; свет иногда просят оставить, чтобы объект не стоял в темноте.">
          <input
            type="checkbox"
            checked={cfg.lights}
            disabled={!cfg.enabled}
            onChange={(e) => update({ lights: e.target.checked })}
          />{' '}
          Гасить и свет
        </label>
      </div>
      <p className="dim">
        Чего этим не закрыть: если процесс движка убит целиком, слать безопасный кадр уже некому —
        для этого есть сторож, который поднимает движок заново (он стартует с нулей). Закрытие
        редактора аварией НЕ считается: шоу играет движок, и оно должно продолжаться.
      </p>
    </section>
  );
}

/**
 * Звук вечерней программы: громкость в децибелах, «звук выключен» и видно ли,
 * чем играть.
 *
 * Децибелы — как в FontanPlay (заказчик прислал снимок её окна как образец) и
 * как на усилителе; почему не проценты и почему нет ползунка «Friq» — в
 * shared/audiovolume.ts.
 *
 * Зачем панелью, а не в файле: на объекте программой пользуется не тот, кто
 * её ставил, а громкость подкручивают на месте, по живому звуку из колонок.
 * Это настройка ПРОГРАММЫ, не объекта: усилитель и колонки принадлежат месту,
 * а не шоу, и при переносе проекта чужая громкость приехать не должна.
 */
function AudioPanel({ engine }: { engine: EngineConnection }) {
  const { engineConfig, send } = engine;
  /*
   * Пока тянут ползунок, показываем своё значение: ответ движка приходит
   * через сеть и рывками возвращал бы ручку назад.
   */
  const [local, setLocal] = useState<number | null>(null);
  if (!engineConfig) return null;
  const muted = engineConfig.audioMuted;
  const volumeDb = local ?? engineConfig.audioVolumeDb;

  const bassDb = engineConfig.audioBassDb;
  const trebleDb = engineConfig.audioTrebleDb;

  const commit = (db: number, mute = muted, bass = bassDb, treble = trebleDb): void => {
    const v = clampVolumeDb(db);
    setLocal(v);
    send({ type: 'setAudioVolume', volumeDb: v, muted: mute, bassDb: clampToneDb(bass), trebleDb: clampToneDb(treble) });
  };

  /** Ручка тембра: число со знаком — видно, подъём это или срез. */
  const tone = (label: string, hint: string, value: number, set: (v: number) => void): JSX.Element => (
    <label className="field" data-hint={hint}>
      {label}:{' '}
      <input
        type="range"
        min={TONE_DB_MIN}
        max={TONE_DB_MAX}
        step={1}
        value={value}
        disabled={muted}
        onChange={(e) => set(Number(e.target.value))}
      />{' '}
      <span className="tone-value">{toneDbLabel(value)}</span>
    </label>
  );

  return (
    <section className="panel">
      <h2>Звук вечерней программы</h2>
      <p className="dim">
        Громкость и тембр трека, который движок играет сам — по расписанию и в плейлистах, когда редактор
        закрыт. Меняются с ближайшего следующего трека: обрывать уже идущий нельзя — вода уйдёт из-под
        музыки.
      </p>
      <div className="form-row">
        <label
          className="field"
          data-hint={
            '0 дБ — как записано в файле. −6 дБ — заметно тише, −10 дБ — на слух примерно вдвое тише, −20 дБ — фоном.\n' +
            'Громче 0 дБ программа не делает: треки сведены почти в потолок, и усиление даёт хрип в колонках. Громче — ручкой усилителя.'
          }
        >
          Громкость:{' '}
          <input
            type="range"
            min={VOLUME_DB_MIN}
            max={VOLUME_DB_MAX}
            step={0.5}
            value={volumeDb}
            disabled={muted}
            onChange={(e) => setLocal(Number(e.target.value))}
            onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
          />
        </label>
        <label className="field">
          <input
            className="input input-num"
            type="number"
            min={VOLUME_DB_MIN}
            max={VOLUME_DB_MAX}
            step={0.5}
            value={volumeDb}
            disabled={muted}
            onChange={(e) => commit(Number(e.target.value))}
          />{' '}
          дБ
        </label>
        <span className="dim">0 дБ — как в файле</span>
        <label className="field" data-hint="Трек не звучит вовсе; вода и свет при этом работают по шоу.">
          <input type="checkbox" checked={muted} onChange={(e) => commit(volumeDb, e.target.checked)} /> звук выключен
        </label>
      </div>
      {/*
        Тембр — как ручки «Bass» и «Treble» на усилителе: подстроить звук под колонки
        конкретного места. На синхронизацию с водой не влияет.
      */}
      <div className="form-row">
        {tone(
          'Низкие',
          'Бас, ниже 100 Гц. Колонки бубнят — убавьте; звук плоский — добавьте. 0 — как в файле.',
          bassDb,
          (v) => commit(volumeDb, muted, v, trebleDb),
        )}
        {tone(
          'Высокие',
          'Верха, выше 6 кГц. Режут уши — убавьте; звук глухой — добавьте. 0 — как в файле.',
          trebleDb,
          (v) => commit(volumeDb, muted, bassDb, v),
        )}
        {(bassDb !== 0 || trebleDb !== 0) && (
          <button className="btn btn-small" onClick={() => commit(volumeDb, muted, 0, 0)}>
            Тембр как в файле
          </button>
        )}
        <span className="dim" data-hint="Подъём больше +6 дБ не даём: громкий трек начнёт хрипеть. Пики при подъёме срезаются мягко.">
          от −12 до +6 дБ
        </span>
      </div>
      {muted && (
        <p className="warn">Звук выключен — вечерняя программа отыграет в тишине, вода и свет при этом работают.</p>
      )}
      {engineConfig.audioReady ? (
        <p className="dim">✔ Проигрыватель найден — звук будет.</p>
      ) : (
        <p className="error-text">
          Проигрывателя нет: движку нечем открыть аудиофайл, и вечерняя программа отыграет в тишине —
          вода и свет при этом работают. Лечится установкой ffmpeg: в командной строке{" "}
          <code>winget install Gyan.FFmpeg</code>, потом перезапустить программу.
        </p>
      )}
    </section>
  );
}

/**
 * Как готовятся кадры для приборов.
 *
 * Вынесено в интерфейс потому, что в установленном приложении человек до
 * `app-config.json` руками не доберётся, а на объекте сравнить «как сейчас» с
 * «как было раньше» — это первое, что понадобится, если что-то покажется не так.
 *
 * Списком, а не полем с числом: глубина запаса замерена, и глубже сотни
 * миллисекунд она не даёт ничего (разбор — в `framemode.ts`). Свободное поле
 * приглашало бы искать там, где искать нечего.
 */
function FrameModePanel({ engine }: { engine: EngineConnection }) {
  const { engineConfig, send } = engine;
  /**
   * Панель свёрнута: видно только выбранное. Разворачивается кнопкой, а смена
   * спрашивает подтверждение.
   *
   * Так сделано потому, что это настройка «поставил и забыл»: в обычной работе
   * её трогать не надо вовсе, а случайно ткнуть в список из трёх строк легко —
   * и человек не поймёт, что только что переключил.
   */
  const [open, setOpen] = useState(false);
  if (!engineConfig) return null;
  const chosen = engineConfig.frameMode;
  const active = engineConfig.frameModeActive;
  const current = FRAME_MODES.find((m) => m.id === chosen);

  const pick = (mode: FrameMode): void => {
    if (mode === chosen) {
      setOpen(false);
      return;
    }
    if (!window.confirm(FRAME_MODE_CONFIRM)) return;
    send({ type: 'setFrameMode', mode });
    setOpen(false);
  };

  return (
    <section className="panel">
      <h2>Подготовка значений для приборов</h2>
      <div className="form-row">
        <span>
          Сейчас: <b>{frameModeLabel(chosen)}</b>
        </span>
        <button className="btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'Отмена' : 'Изменить'}
        </button>
      </div>
      {!open && current && <p className="dim">{current.hint}</p>}
      {!open && <p className="dim">{FRAME_MODE_ABOUT}</p>}
      {open && (
        <>
          <p className="dim">{FRAME_MODE_ABOUT}</p>
          <div className="form-column">
            {FRAME_MODES.map((m) => (
              <label key={m.id} className="field">
                <input type="radio" name="frame-mode" checked={chosen === m.id} onChange={() => pick(m.id)} />{' '}
                <span>
                  <b>{m.label}</b>
                  <br />
                  <span className="dim">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      {active !== chosen && (
        <p className="error-text">
          Выбрано «{frameModeLabel(chosen)}», но работает «{frameModeLabel(active)}»: отдельный поток
          расчёта не запустился, и программа считает одним потоком. Причина — в журнале событий на
          вкладке «Диагностика». Фонтан при этом работает как работал.
        </p>
      )}
    </section>
  );
}

function WindLimitPanel({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  if (!project) return null;
  const cfg = project.windLimit;
  const update = (patch: Partial<typeof cfg>): void => updateProject({ ...project, windLimit: { ...cfg, ...patch } });

  /**
   * Предпросмотр — таблицей по НАСТОЯЩИМ форсункам схемы, а не по абстрактным
   * высотам. Раньше хватало высоты, потому что и считалась только она. Теперь в
   * предел входят тип сопла (калибр капли), наклон и расстояние до борта — и
   * «струя 6 м» без этого ничего не говорит: у тумана и у ламинарной струи той
   * же высоты пределы разойдутся в разы.
   *
   * Показываем самые уязвимые: сортируем по пределу при среднем ветре и берём
   * первые шесть. Если схема пустая — опорные струи, чтобы настройки можно было
   * прикинуть заранее.
   */
  const speeds = [2, 3, 4, 6, 8, 10];
  const preview = (() => {
    const nozzles = project.layout.nozzles;
    if (nozzles.length === 0) {
      return [2, 6, 15].map((h) => ({ key: `ref-${h}`, name: `Опорная ${h} м`, nz: plainWindNozzle(h) }));
    }
    return nozzles
      .map((n) => ({ key: n.id, name: n.name, nz: windNozzleFor(n, project.layout.bowls) }))
      .sort((a, b) => windAllowedLevel(5, cfg, a.nz) - windAllowedLevel(5, cfg, b.nz))
      .slice(0, 6);
  })();

  return (
    <section className="panel">
      <h2>Датчик ветра</h2>
      <p className="dim">
        Ветер выше порога — мощность насосов (высота струй) снижается; свет не трогается. Предел считается
        по ТЕКУЩЕЙ высоте струи и по расстоянию до борта чаши, поэтому приглушённую струю коррекция не
        трогает, а форсунку у борта режет сильнее центральной. Пока датчик ветра не подключён, скорость
        вводится вручную на вкладке «Отладка» (поле появляется, когда здесь включено).
      </p>
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{' '}
          Включено
        </label>
        <label className="field" data-hint="Ниже этого ветра не делаем ничего и ни для каких струй. Ветер 1–2 м/с на объекте бывает постоянно, и реагировать на него — значит шевелить воду весь день без причины.">
          Порог, м/с:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={20}
            step={0.5}
            disabled={!cfg.enabled}
            value={cfg.deadbandSpeed}
            onChange={(e) => update({ deadbandSpeed: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="field" data-hint="Сколько секунд ветер должен держаться выше порога НЕПРЕРЫВНО, прежде чем снижать струи. Порыв короче этого игнорируется: мгновенно отреагировать всё равно нельзя — насос не сбрасывает частоту сразу, а вода уже в воздухе.">
          Ждать, с:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={120}
            step={1}
            disabled={!cfg.enabled}
            value={cfg.activateHoldSec}
            onChange={(e) => update({ activateHoldSec: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="field" data-hint="Сколько секунд ветер должен держаться НИЖЕ порога, чтобы коррекция снялась совсем и струи вернулись на полную высоту.">
          Отпускать, с:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={300}
            step={1}
            disabled={!cfg.enabled}
            value={cfg.deactivateHoldSec}
            onChange={(e) => update({ deactivateHoldSec: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="field" data-hint="Насколько далеко ветер может уводить струю от её обычного места. 0,6 м — «заметно, но ещё рисунок, а не косой столб». Этот предел работает для любой форсунки, где бы она ни стояла.">
          Допустимый снос, м:{' '}
          <input
            className="input input-num"
            type="number"
            min={0.05}
            max={10}
            step={0.1}
            disabled={!cfg.enabled}
            value={cfg.marginM}
            onChange={(e) => update({ marginM: Math.max(0.05, Math.min(10, Number(e.target.value) || 0.6)) })}
          />
        </label>
        <label className="field" data-hint="Насколько внутрь борта должна падать вода. Нужен потому, что вода падает не точкой, а пятном брызг: «ровно на борт» — это уже на дорожку. Считается по геометрии чаши из схемы.">
          Запас у борта, м:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={5}
            step={0.1}
            disabled={!cfg.enabled}
            value={cfg.edgeReserveM}
            onChange={(e) => update({ edgeReserveM: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })}
          />
        </label>
        <label
          className="field"
          data-hint="Запас поверх расчёта. 1,0 — как считает модель капли: она откалибрована по замерам с объекта (струю 20 мм высотой 5 м при ветре 15 м/с сносит ~2 м). Поставьте 1,3, если на открытой площадке видно, что сносит сильнее. Сцепку с ветром вводить больше не нужно — она считается по типу сопла, его диаметру и распылению из схемы."
        >
          Строгость, ×:{' '}
          <input
            className="input input-num"
            type="number"
            min={0.3}
            max={5}
            step={0.1}
            disabled={!cfg.enabled}
            value={cfg.driftFactor}
            onChange={(e) => update({ driftFactor: Math.max(0.3, Math.min(5, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="field" data-hint="Выше этого ветра фонтан глушится совсем: картины всё равно нет, а вода уходит за борт чаши. 0 — не глушить никогда.">
          Стоп при ветре, м/с:{' '}
          <input
            className="input input-num"
            type="number"
            min={0}
            max={60}
            step={0.5}
            disabled={!cfg.enabled}
            value={cfg.stopSpeed}
            onChange={(e) => update({ stopSpeed: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="field">
          Насосы не ниже, %:{' '}
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
        <>
          <p className="dim">
            Предел у каждой форсунки свой: он зависит от высоты струи, от типа сопла (туман сдувает в
            разы сильнее плотного столба) и от того, сколько до борта чаши. В таблице — предел мощности
            для струи, которая работает НА ПОЛНУЮ; приглушённой коррекция не касается, пока её высота
            укладывается в допуск. «стоп» — форсунка при таком ветре не работает.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Форсунка</th>
                <th>Высота</th>
                <th>До борта</th>
                {speeds.map((s) => (
                  <th key={s}>{s} м/с</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((row) => (
                <tr key={row.key}>
                  <td>{row.name}</td>
                  <td>{row.nz.maxHeightM} м</td>
                  <td className="dim">
                    {Number.isFinite(row.nz.roomM) ? `${Math.round(row.nz.roomM * 10) / 10} м` : '—'}
                  </td>
                  {speeds.map((s) => {
                    const p = Math.round(windAllowedLevel(s, cfg, row.nz) * 100);
                    return (
                      <td key={s} className={p === 0 ? 'error-text' : p < 100 ? 'warn' : 'dim'}>
                        {p === 0 ? 'стоп' : `${p}%`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {project.layout.nozzles.length === 0 && (
            <p className="dim">
              В схеме нет форсунок, поэтому показаны опорные: прямая струя 20 мм без чаши. Нарисуйте
              схему — и здесь появятся настоящие форсунки объекта со своим типом сопла и расстоянием
              до борта.
            </p>
          )}
        </>
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
      <h2>Сцена, когда ничего не играет</h2>
      <p className="dim">
        Горит, когда не играет ни сцена, ни секвенсор, ни шоу, — вместо полной темноты. В паузах между песнями
        плейлиста не включается: там темнота нужна.
      </p>
      <div className="form-row">
        <label className="field">
          Сцена:{' '}
          <select
            value={project.idleSceneId ?? ''}
            onChange={(e) => updateProject({ ...project, idleSceneId: e.target.value || null })}
          >
            <option value="">— нет (всё погашено) —</option>
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
        Включает и выключает выбранные приборы по времени суток (например, подсветку периметра) —
        независимо от расписания шоу и плейлистов. Пока включено, перекрывает сцены и шоу на этих приборах.
      </p>
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} />{' '}
          Включено
        </label>
        <label className="field" data-hint="Держать включённым всегда, не глядя на время">
          <input
            type="checkbox"
            checked={cfg.always}
            disabled={!cfg.enabled}
            onChange={(e) => update({ always: e.target.checked })}
          />{' '}
          Всегда включено
        </label>
        <label className="field">
          Включать в:{' '}
          <input
            className="input"
            type="time"
            value={cfg.onTime}
            disabled={!cfg.enabled || cfg.always}
            onChange={(e) => update({ onTime: e.target.value })}
          />
        </label>
        <label className="field">
          Выключать в:{' '}
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
        <p className="dim">Приборов пока нет — добавьте их на вкладке «Оборудование».</p>
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
 * Короткая строка о драйвере FTDI. Главное — не путать два случая: драйвера
 * нет вовсе (надо скачать и поставить) и драйвер есть, но интерфейс ни разу
 * не подключали к этому компьютеру (Windows положит библиотеку сама).
 */
function driverProblemText(p: UsbDriverProblem): string {
  switch (p) {
    case 'no-device':
      return '◐ драйвер установлен; библиотека появится, когда подключите интерфейс по USB';
    case 'no-driver':
      return '✖ драйвер FTDI не установлен — поставьте FTDI CDM, затем подключите интерфейс';
    case 'wrong-bitness':
      return '✖ найдена только 32-битная библиотека — нужен 64-разрядный драйвер FTDI CDM';
    case 'broken':
      return '✖ библиотека есть, но не загрузилась — переустановите драйвер FTDI CDM';
    default:
      return '✖ драйвер FTDI недоступен (наведите — подробности)';
  }
}

/** Варианты выбора интерфейса FountanPlay: FTDI по серийному номеру и COM-порты FTDI. */
function musidoraTargets(scan: UsbDmxScan | null, current: string): { value: string; label: string }[] {
  const list: { value: string; label: string }[] = [];
  for (const d of scan?.ftdi ?? []) {
    if (!d.serial) continue;
    list.push({ value: d.serial, label: `№ ${d.serial}${d.opened ? ' (занят)' : ''}` });
  }
  for (const p of scan?.ports ?? []) {
    if (p.vendorId.toLowerCase() !== '0403') continue;
    list.push({ value: p.path, label: `${p.path} (COM)` });
  }
  if (current && !list.some((x) => x.value === current)) {
    list.push({ value: current, label: `${current} (не подключён)` });
  }
  return list;
}

/**
 * Что происходит с USB-DMX прямо сейчас: есть ли драйвер FTDI, какие
 * устройства видны и уходят ли кадры в интерфейс FountanPlay. На объекте по
 * этой строке сразу понятно, где искать: драйвер, кабель, занятость другой
 * программой — или всё передаётся, и дело уже в адресах приборов.
 */
function UsbDmxStatus({ scan, universes }: { scan: UsbDmxScan | null; universes: ConfigUniverse[] }) {
  const musidora = universes.flatMap((u) =>
    u.outputs
      .filter((o) => o.type === 'musidora')
      .map((o) => ({ universe: u, out: o, key: /^COM\d+$/i.test(o.path ?? '') ? (o.path ?? '').toUpperCase() : (o.path ?? '') })),
  );
  if (!scan) {
    return (
      <div className="usb-status">
        <div className="usb-status-title">USB-DMX на этом компьютере</div>
        <div className="dim">опрос…</div>
      </div>
    );
  }
  const d2 = scan.d2xx;
  return (
    <div className="usb-status">
      <div className="usb-status-title">USB-DMX на этом компьютере</div>
      <div className="usb-status-row">
        <span className="usb-status-name">Драйвер FTDI</span>
        {d2.ok ? (
          <span className="ok-text" data-hint={d2.dll}>
            ✔ установлен{d2.version ? `, версия ${d2.version}` : ''}
          </span>
        ) : (
          <span className={d2.problem === 'no-device' ? 'warn' : 'error-text'} data-hint={d2.error}>
            {driverProblemText(d2.problem)}
          </span>
        )}
      </div>
      <div className="usb-status-row">
        <span className="usb-status-name">Устройства FTDI</span>
        {scan.ftdi.length === 0 ? (
          <span className="dim">{d2.ok ? 'не найдено — проверьте кабель USB' : 'интерфейс не подключён к этому ПК'}</span>
        ) : (
          <span>
            {scan.ftdi.map((d) => (
              <span key={`${d.index}-${d.serial}`} className="usb-dev" data-hint={`${d.type}, VID/PID ${d.id.toString(16).padStart(8, '0')}`}>
                № {d.serial || '—'} «{d.description || 'без названия'}»{d.opened ? ' · открыт' : ''}
              </span>
            ))}
          </span>
        )}
      </div>
      {musidora.map(({ universe, out, key }) => {
        const link = scan.links.find((l) => (l.target === 'авто' ? '' : l.target) === key);
        const fresh = !!link && link.phase === 'open' && link.lastOkMs > 0 && scan.atMs - link.lastOkMs < 2500;
        return (
          <div className="usb-status-row" key={universe.id}>
            <span className="usb-status-name">
              {universeTitle(universe)} → выход {out.musidoraOut ?? 1}
            </span>
            {!link ? (
              <span className="warn">не запущено — нажмите «Применить» под таблицей вселенных</span>
            ) : fresh ? (
              <span className="ok-text">
                ✔ кадры уходят в интерфейс{link.serial ? ` № ${link.serial}` : link.description ? ` ${link.description}` : ''} · {link.framesOk}
              </span>
            ) : link.phase === 'open' ? (
              <span className="dim">интерфейс открыт, ждём кадров…</span>
            ) : link.phase === 'error' ? (
              <span className="error-text">✖ {link.text}</span>
            ) : (
              <span className="dim">{link.text}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * «Применить» — сразу под таблицей вселенных, а не ниже трёх других панелей.
 *
 * Раньше кнопка стояла после такта, режима подготовки кадров и звука, да ещё
 * под абзацем «кнопка „Применить“ ниже к ней не относится». Заказчик добавил
 * вселенную, не нашёл, чем её применить, — и она не появилась ни на одной
 * вкладке. Здесь же сказано, ЧТО именно не применено, и итог — словами движка.
 */
function LinesApplyBar({
  dirty,
  valid,
  pending,
  status,
  message,
  changes,
  onApply,
  onDiscard,
}: {
  dirty: boolean;
  valid: boolean;
  pending: string[];
  status: 'idle' | 'pending' | 'applied' | 'error';
  message: string;
  changes: string[];
  onApply: () => void;
  onDiscard: () => void;
}) {
  const nothing = dirty && pending.length === 0;
  return (
    <div className={dirty ? 'lines-apply lines-apply-dirty' : 'lines-apply'}>
      <div className="form-row">
        <button className="btn active" disabled={!dirty || !valid || status === 'pending'} onClick={onApply}>
          {status === 'pending' ? 'Применяю…' : 'Применить'}
        </button>
        <button className="btn" disabled={!dirty || status === 'pending'} onClick={onDiscard}>
          Отменить правки
        </button>
        {!dirty && status !== 'applied' && <span className="dim">Правок нет — работает то, что в таблице.</span>}
        {dirty && !valid && <span className="error-text">Нужна хотя бы одна вселенная и такт 10–1000 мс.</span>}
      </div>
      {dirty && valid && !nothing && (
        <p className="warn">
          Не применено: {pending.join('; ')}. Пока не нажать «Применить», этого нет ни на других
          вкладках, ни на приборах. Воспроизведение при применении не останавливается.
        </p>
      )}
      {nothing && <p className="dim">Правка совпадает с тем, что уже работает, — применять нечего.</p>}
      {status === 'error' && <p className="error-text">{message}</p>}
      {status === 'applied' && (
        <p className="dim">
          ✔ {message}{changes.length > 0 ? ` ${changes.join('; ')}.` : ''}
        </p>
      )}
    </div>
  );
}

/**
 * Настройки движка: вселенные и такт — правка настроек объекта из
 * интерфейса, без текстового редактора. Движок применяет на ходу, НЕ
 * останавливая воспроизведение, и сохраняет сам.
 */
export function SettingsView({ engine }: { engine: EngineConnection }) {
  const { engineConfig, project, send } = engine;
  /*
   * Правка живёт в общем хранилище, а не в состоянии вкладки (см.
   * settingsDraft.ts): вкладка при уходе размонтируется, а правка должна
   * пережить уход и быть видна на других вкладках. Пока правки нет —
   * показываем то, что работает в движке.
   */
  const { draft, status, message, changes } = useSettingsDraft();
  const tickMs = draft?.tickMs ?? engineConfig?.tickMs ?? 50;
  const universes = draft?.universes ?? engineConfig?.universes ?? [];
  const dirty = draft !== null;
  const setTickMs = (t: number): void => keepSettingsDraft({ tickMs: t, universes });
  const setUniverses = (next: ConfigUniverse[]): void => keepSettingsDraft({ tickMs, universes: next });

  /**
   * USB-DMX: пока есть хоть одна USB-вселенная (в сохранённой конфигурации или
   * в правке), раз в 2 с спрашиваем движок, что с драйвером и интерфейсами.
   * На объекте это главный индикатор «нашёлся ли интерфейс и уходят ли кадры».
   */
  const usbInUse = [...universes, ...(engineConfig?.universes ?? [])].some((u) =>
    u.outputs.some((o) => o.type === 'musidora' || o.type === 'usb-dmx' || o.type === 'open-dmx'),
  );
  useEffect(() => {
    if (!engine.connected || !usbInUse) return;
    send({ type: 'scanUsbDmx' });
    const id = window.setInterval(() => send({ type: 'scanUsbDmx' }), 2000);
    return () => window.clearInterval(id);
  }, [engine.connected, usbInUse, send]);

  if (!engineConfig) {
    return (
      <main className="view">
        <section className="panel">
          <h2>Настройки</h2>
          <p className="dim">Жду данные от движка…</p>
        </section>
      </main>
    );
  }

  const patchUniverse = (id: number, patch: Partial<ConfigUniverse>): void => {
    setUniverses(universes.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  };

  const patchOutput = (id: number, patch: Partial<ConfigUniverse['outputs'][number]>): void => {
    setUniverses(
      universes.map((u) =>
        u.id === id
          ? { ...u, outputs: u.outputs.map((o, i) => (i === 0 ? { ...o, ...patch } : o)) }
          : u,
      ),
    );
  };

  /** Новая вселенная — такая же, как последняя (см. nextUniverse). */
  const addUniverse = (): void => {
    setUniverses([...universes, nextUniverse(universes)]);
  };

  const removeUniverse = async (id: number): Promise<void> => {
    const devices = project?.devices.filter((d) => d.universe === id) ?? [];
    if (devices.length > 0) {
      const names = devices
        .slice(0, 5)
        .map((d) => d.name)
        .join(', ');
      const ok = await askConfirm(`Удалить вселенную ${id}?`, {
        detail:
          `На ней стоят приборы: ${devices.length} шт. (${names}${devices.length > 5 ? '…' : ''}). ` +
          'После удаления они перестанут выводиться, пока вы не перенесёте их на другую вселенную на вкладке «Оборудование».',
      });
      if (!ok) return;
    }
    setUniverses(universes.filter((u) => u.id !== id));
  };

  const valid = universes.length > 0 && tickMs >= 10 && tickMs <= 1000;
  const pending = describeLinesChange(engineConfig, { tickMs, universes });

  return (
    <main className="view">
      <section className="panel">
        <h2>Вселенные DMX</h2>
        <p className="dim">
          Вселенная — это 512 адресов DMX, которые уходят в один выход: разъём интерфейса или
          номер Art-Net. Заводите столько, сколько выходов реально подключено на объекте. Приборы
          привязываются к вселенной по её номеру на вкладке «Оборудование».
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>№</th>
              <th>Имя</th>
              <th>Протокол</th>
              <th data-hint="IP узла Art-Net, COM-порт адаптера или какой из интерфейсов FountanPlay">Адрес</th>
              <th data-hint="Номер внутри протокола: у Art-Net считают с 0, у sACN — с 1. У интерфейса FountanPlay — номер разъёма DMX на коробке">
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
                      value={storedUniverseLabel(u)}
                      placeholder="без имени"
                      data-hint="Необязательно. Своё имя показывается рядом с номером везде, где выбирают вселенную: «Вселенная 2 · Северная чаша»."
                      onChange={(e) => patchUniverse(u.id, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      value={out?.type ?? 'artnet'}
                      data-hint={
                        'Все варианты USB-DMX используют один и тот же USB-переходник FTDI и один драйвер FTDI — разница только в том, ЧТО программа шлёт в кабель.\n' +
                        'Art-Net и sACN — по сети, через узел Art-Net: самый надёжный вариант для постоянного объекта (длинные кабели, развязка, много вселенных).\n' +
                        'USB-DMX (ENTTEC PRO) — адаптер с контроллером ENTTEC DMX USB PRO: тайминг сигнала DMX держит сам адаптер, программа шлёт кадр в его обёртке.\n' +
                        'USB-DMX (Open DMX) — простой адаптер без контроллера (ENTTEC Open DMX USB и клоны): весь сигнал DMX по микросекундам строит компьютер, под нагрузкой возможны рывки.\n' +
                        'USB-DMX (FountanPlay) — тот самый интерфейс из комплекта программы FontanPlay (USB1DMX/USB2DMX/USB3DMX): у него свой контроллер, программа шлёт кадр в его обёртке. На время работы закройте FontanPlay — интерфейс открывает только одна программа.'
                      }
                      onChange={(e) =>
                        patchOutput(u.id, {
                          type: e.target.value as ConfigOutput['type'],
                        })
                      }
                    >
                      <option value="artnet">Art-Net</option>
                      <option value="sacn">sACN</option>
                      <option value="usb-dmx">USB-DMX (ENTTEC PRO)</option>
                      <option value="open-dmx">USB-DMX (Open DMX)</option>
                      <option value="musidora">USB-DMX (FountanPlay)</option>
                    </select>
                  </td>
                  <td>
                    {out?.type === 'musidora' ? (
                      <select
                        style={{ width: 150 }}
                        value={out.path ?? ''}
                        data-hint={
                          '«Авто» — первое свободное FTDI-устройство, как делает FontanPlay.\n' +
                          'Если к компьютеру подключено несколько FTDI (например, ещё и USB-RS485), выберите интерфейс по серийному номеру. Вселенным одного интерфейса ставьте одно и то же значение.'
                        }
                        onChange={(e) => patchOutput(u.id, { path: e.target.value })}
                      >
                        <option value="">Авто</option>
                        {musidoraTargets(engine.usbScan, out.path ?? '').map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    ) : out?.type === 'artnet' ? (
                      <input
                        className="input"
                        style={{ width: 120 }}
                        value={out.host ?? ''}
                        placeholder="192.168.0.50"
                        onChange={(e) => patchOutput(u.id, { host: e.target.value })}
                      />
                    ) : out?.type === 'usb-dmx' || out?.type === 'open-dmx' ? (
                      <input
                        className="input"
                        style={{ width: 120 }}
                        value={out.path ?? ''}
                        placeholder="COM5"
                        list="usb-com-ports"
                        data-hint="COM-порт адаптера. Найденные порты подсказываются в списке; ещё их видно в Диспетчере устройств Windows, раздел «Порты (COM и LPT)»."
                        onChange={(e) => patchOutput(u.id, { path: e.target.value })}
                      />
                    ) : (
                      <span
                        className="dim"
                        data-hint="sACN рассылает значения всей сети сразу, на групповой адрес. Он получается из номера вселенной сам — вписывать ничего не нужно."
                      >
                        вся сеть
                      </span>
                    )}
                  </td>
                  <td>
                    {out?.type === 'musidora' ? (
                      <select
                        value={String(out.musidoraOut ?? 1)}
                        data-hint={
                          'Номер РАЗЪЁМА DMX на самом интерфейсе: у USB1DMX он один (1), у USB2DMX — два (1 и 2), у USB3DMX — три.\n' +
                          'Второй разъём — это отдельная вселенная с тем же интерфейсом и выходом 2.\n' +
                          'Ставьте номер строго по числу разъёмов на коробке. Если выбрать выход, которого на интерфейсе нет, его данные могут лечь на первый выход и перебить его — в FontanPlay это заметно потому, что она всегда шлёт все три выхода, даже когда разъём один. Наша программа шлёт только те выходы, что вы завели здесь.'
                        }
                        onChange={(e) => patchOutput(u.id, { musidoraOut: Number(e.target.value) })}
                      >
                        <option value="1">Выход 1</option>
                        <option value="2">Выход 2</option>
                        <option value="3">Выход 3</option>
                      </select>
                    ) : out?.type === 'usb-dmx' || out?.type === 'open-dmx' ? (
                      <span className="dim" data-hint="У провода нет номера вселенной: адаптер отдаёт один-единственный кадр DMX512 в свой разъём">
                        —
                      </span>
                    ) : (
                      <input
                        className="input input-num"
                        type="number"
                        min={0}
                        value={out?.universe ?? 0}
                        onChange={(e) =>
                          patchOutput(u.id, { universe: Math.max(0, Math.round(Number(e.target.value)) || 0) })
                        }
                      />
                    )}
                  </td>
                  <td>
                    {u.outputs.length > 1 && (
                      <span className="badge" data-hint="У вселенной несколько выходов; здесь редактируется первый, остальные сохраняются как есть">
                        ещё {countOf(u.outputs.length - 1, 'выход', 'выхода', 'выходов')}
                      </span>
                    )}{' '}
                    <button
                      className="btn btn-small"
                      disabled={universes.length <= 1}
                      data-hint={universes.length <= 1 ? 'Нужна хотя бы одна вселенная' : 'Удалить вселенную'}
                      onClick={() => void removeUniverse(u.id)}
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
        <div className="form-row">
          <label className="field" data-hint="Как часто значения уходят приборам. 50 мс (20 раз в секунду) — стандарт для фонтанов; 25 мс (40 раз) — плавнее для быстрого света.">
            Такт отправки, мс:{' '}
            <input
              className="input input-num"
              type="number"
              min={10}
              max={1000}
              step={5}
              value={tickMs}
              onChange={(e) => setTickMs(Math.round(Number(e.target.value)) || 50)}
            />
          </label>
          <span className="dim">= {tickMs >= 10 ? Math.round(1000 / tickMs) : '—'} раз в секунду</span>
        </div>
        <LinesApplyBar
          dirty={dirty}
          valid={valid}
          pending={pending}
          status={status}
          message={message}
          changes={changes}
          onApply={() => applySettingsDraft(send, engine.connected)}
          onDiscard={clearSettingsDraft}
        />
        <datalist id="usb-com-ports">
          {(engine.usbScan?.ports ?? []).map((p) => (
            <option key={p.path} value={p.path}>
              {[p.manufacturer, p.vendorId && `VID ${p.vendorId}`].filter(Boolean).join(' · ')}
            </option>
          ))}
        </datalist>
        {usbInUse && <UsbDmxStatus scan={engine.usbScan} universes={engineConfig.universes} />}
      </section>


      <FrameModePanel engine={engine} />
      <AudioPanel engine={engine} />


      <ExportImportPanel engine={engine} />
      <BackupPanel engine={engine} />
      <AutostartPanel engine={engine} />
      <TelegramPanel engine={engine} />
      <FailsafePanel engine={engine} />
      <WindLimitPanel engine={engine} />
      <IdleScenePanel engine={engine} />
      <UtilityLightPanel engine={engine} />
      <HotkeysPanel />
      <ViewControlsPanel />
      <OperatorPanel />
      <TourReplayPanel />
    </main>
  );
}

/**
 * Чувствительность мыши в 3D-виде. Умолчания OrbitControls (обе скорости 1.0)
 * на этой сцене несбалансированы: вращение уносит вид от одного движения, а
 * панорама еле ползёт. Здесь и выверенные значения, и регулировка — мыши и
 * коврики у всех разные. Хранится на этом компьютере, в проект не попадает.
 */
function ViewControlsPanel() {
  const [prefs, setPrefs] = useState(viewPrefs());
  const apply = (patch: Partial<typeof prefs>): void => {
    setViewPrefs(patch);
    setPrefs(viewPrefs());
  };
  const row = (
    label: string,
    hint: string,
    key: 'rotateSpeed' | 'panSpeed',
  ): JSX.Element => {
    const [lo, hi, step] = VIEW_PREF_LIMITS[key];
    return (
      <label className="field" data-hint={hint}>
        {label}
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={prefs[key]}
          onChange={(e) => apply({ [key]: Number(e.target.value) })}
        />
        <span className="dim">×{num(prefs[key], 2)}</span>
      </label>
    );
  };
  return (
    <section className="panel">
      <h2>Управление камерой в 3D</h2>
      <p className="dim">Насколько быстро вид отзывается на мышь на вкладке «3D».</p>
      {row('Вращение', 'Поворот камеры вокруг схемы — левой кнопкой мыши по пустому месту', 'rotateSpeed')}
      {row('Сдвиг вида', 'Сдвиг схемы без поворота — правой кнопкой мыши', 'panSpeed')}
      <button
        className="btn btn-small"
        onClick={() => apply({ ...VIEW_PREF_DEFAULTS })}
      >
        Вернуть значения по умолчанию
      </button>
    </section>
  );
}

/** Повторный показ тура первого запуска (§27 доработки) — на случай, если пропустили или хотите освежить. */
function TourReplayPanel() {
  return (
    <section className="panel">
      <h2>Тур по программе</h2>
      <p className="dim">Короткая подсказка по вкладкам «Отладка → Оборудование → 3D → Сцены → Шоу», которая показывается при первом запуске.</p>
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
