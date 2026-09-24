import { useEffect, useRef, useState } from 'react';
import { useCollapsiblePanels } from '../collapsiblePanels';
import { KeyArrowIcon } from '../components/Icons';
import { requestTab } from '../navigate';
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
  failsafeTargetsText,
  FAILSAFE_TIMEOUT_MAX_SEC,
  describeLinesChange,
  nextUniverse,
  sameOutputs,
  storedUniverseLabel,
  universeTitle,
  clampVolumeDb,
  clampEq,
  EQ_BANDS_HZ,
  EQ_CUSTOM_ID,
  EQ_DB_MAX,
  EQ_DB_MIN,
  EQ_PRESETS,
  eqBandLabel,
  eqIsFlat,
  eqPresetOf,
  toneDbLabel,
  VOLUME_DB_MAX,
  VOLUME_DB_MIN,
  num,
  countOf,
  durationRu,
  type WindLimitConfig,
  type WindSensorModbus,
  type WindSource,
  profileMap,
  type Project,
  type Scene,
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
import type { EngineConnection, WindState } from '../useEngine';
import { ComPortPicker, useUsbScan } from '../components/ComPortPicker';

/**
 * Переназначение горячих клавиш редактора (§27 доработки, УХ п.6) — те, что
 * относятся к самому приложению (отменить/сохранить/дублировать…), не к
 * «Клавиатуре» (та привязывает клавиши к сценам/шоу конкретного проекта и
 * живёт отдельной вкладкой). Хранится в localStorage — предпочтение этого
 * компьютера, не часть проекта.
 */
/** Подпись комбинации; стрелки — значками (см. KeyArrowIcon). */
function ComboText({ combo }: { combo: string }) {
  const arrow = /Arrow(Up|Down|Left|Right)$/.exec(combo);
  if (!arrow) return <>{comboLabel(combo)}</>;
  const prefix = comboLabel(combo.slice(0, arrow.index));
  const dir = arrow[1]!.toLowerCase() as 'up' | 'down' | 'left' | 'right';
  return (
    <>
      {prefix}
      <KeyArrowIcon dir={dir} />
    </>
  );
}

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
          className={capturing ? 'btn active btn-combo' : 'btn btn-combo'}
          onClick={() => {
            setConflict(null);
            setCapturing(!capturing);
          }}
        >
          {capturing ? 'нажмите комбинацию… (Esc — отмена)' : <ComboText combo={combo} />}
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
    const ok = await askConfirm('Заменить весь проект содержимым файла?', {
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
      <h2>Перенос проекта одним файлом</h2>
      <p className="dim">
        Один файл — весь проект (приборы, сцены, шоу, расписание) вместе с музыкой шоу. Удобно для переноса между ПК
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
 * Резервная копия настроек САМОЙ ПРОГРАММЫ. Копия объекта их не содержит:
 * лицензия, токен бота и настройки движка лежат в папке данных приложения.
 * Умер диск — объект вернулся бы из копии, а лицензию и бота пришлось бы
 * заводить заново; здесь они уезжают одним файлом.
 */
function AppSettingsBackupPanel({ engine }: { engine: EngineConnection }) {
  const { requestExportAppSettings, importAppSettingsArchive } = engine;
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);

  const doExport = async (): Promise<void> => {
    setSaving(true);
    try {
      const { filename, dataBase64 } = await requestExportAppSettings();
      const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setSaving(false);
    }
  };

  const doImport = async (file: File): Promise<void> => {
    const ok = await askConfirm('Восстановить настройки программы из файла?', {
      detail:
        'Лицензия, токен бота и настройки движка на этом компьютере будут заменены тем, что в файле. Проекты не затрагиваются.',
      okLabel: 'Восстановить',
    });
    if (!ok) return;
    setRestoring(true);
    setMsg(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      setMsg(await importAppSettingsArchive(btoa(bin)));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <section className="panel">
      <h2>Резервная копия настроек программы</h2>
      <p className="dim">
        Проект и настройки программы лежат врозь: копия проекта не содержит ни лицензии, ни бота. Здесь — всё о самой
        программе одним файлом. Сделайте такую копию сразу после наладки и держите её не на том же диске.
      </p>
      {/* Точный состав — чтобы не гадать, «всё-всё» там или нет (вопрос заказчика 24.09.2026). */}
      <ul className="dim backup-list">
        <li>лицензия этого компьютера;</li>
        <li>токен Telegram-бота и пароль почты для уведомлений;</li>
        <li>настройки движка: громкость и эквалайзер, автосохранение, режим отладки, расчёт и отправка данных, внешние пульты (OSC, MQTT);</li>
        <li>список недавних проектов;</li>
        <li>настройки окна редактора: горячие клавиши, камера 3D, скрытое в 3D, свёрнутые панели, тема.</li>
      </ul>
      <p className="dim">
        Не входят: сами проекты (приборы, сцены, шоу, расписание, музыка — для них «Перенос проекта одним файлом») и
        блокировка режима оператора с паролем — она про этот компьютер.
      </p>
      <div className="form-row">
        <button className="btn" onClick={() => void doExport()} disabled={saving}>
          {saving ? 'Собираю…' : '⬇ Сохранить в файл'}
        </button>
        <label className="btn">
          {restoring ? 'Восстанавливаю…' : '⬆ Восстановить из файла…'}
          <input
            type="file"
            accept=".zip"
            style={{ display: 'none' }}
            disabled={restoring}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doImport(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      <p className="dim">
        В файле лежит токен бота — храните его как пароль. Лицензия привязана к компьютеру: на другом ПК по ней не
        заработает, её выпускают заново.
      </p>
      {msg && (
        <p className={msg.ok ? 'ok-text' : 'warn'}>
          {msg.ok ? '✔ ' : '⚠ '}
          {msg.message}
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
/**
 * Сохранение проекта: автосохранение вкл/выкл и как часто (решение заказчика
 * 23.09.2026: по умолчанию включено, раз в 5 минут).
 *
 * Это не «Резервные копии» ниже: копии — это СНИМКИ на случай ошибки, к ним
 * возвращаются; сохранение — запись текущего состояния в файл проекта.
 */
function AutosavePanel({ engine }: { engine: EngineConnection }) {
  const { engineConfig, send, projectDirty } = engine;
  const [draftSec, setDraftSec] = useState<string | null>(null);
  if (!engineConfig) return null;
  const enabled = engineConfig.autosaveEnabled;
  const seconds = engineConfig.autosaveSec;
  const apply = (en: boolean, sec: number): void =>
    send({ type: 'setAutosave', enabled: en, seconds: Math.min(3600, Math.max(1, Math.round(sec))) });
  const savedAt = projectDirty.savedAtMs ? new Date(projectDirty.savedAtMs).toLocaleTimeString('ru-RU') : null;
  return (
    <section className="panel">
      <h2>Автосохранение проекта</h2>
      <p className="dim">
        Правки проекта сразу работают в движке, а на диск записываются автосохранением или по Ctrl+S. Без
        автосохранения при переключении на другой проект программа спросит, сохранить ли правки. При закрытии
        программы несохранённое записывается всегда.
      </p>
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={enabled} onChange={(e) => apply(e.target.checked, seconds)} /> Автосохранение
        </label>
        <label className={enabled ? 'field' : 'field dim'} data-hint="Как часто записывать правки на диск, секунд (1–3600). По умолчанию — раз в секунду.">
          каждые{' '}
          <input
            className="input input-num"
            type="number"
            min={1}
            max={3600}
            step={1}
            disabled={!enabled}
            value={draftSec ?? String(seconds)}
            onChange={(e) => setDraftSec(e.target.value)}
            onBlur={() => {
              const v = Number(draftSec);
              if (draftSec !== null && Number.isFinite(v) && v > 0) apply(true, v);
              setDraftSec(null);
            }}
          />{' '}
          с
        </label>
      </div>
      <p className={projectDirty.dirty ? 'warn' : 'ok-text'} style={{ marginLeft: 0 }}>
        {projectDirty.dirty
          ? `● Есть несохранённые правки${enabled ? ` — запишутся в течение ${seconds} с` : ''}. Сохранить сейчас — Ctrl+S.`
          : `✔ Всё сохранено${savedAt ? ` (последний раз в ${savedAt})` : ''}.`}
      </p>
    </section>
  );
}

function BackupPanel({ engine }: { engine: EngineConnection }) {
  const { backupConfig, backups, send } = engine;

  useEffect(() => {
    send({ type: 'listBackups' });
  }, [send]);

  if (!backupConfig) {
    return (
      <section className="panel">
        <h2>Резервные копии проекта</h2>
        <p className="dim">Жду данные от движка…</p>
      </section>
    );
  }

  const restore = async (b: BackupInfo): Promise<void> => {
    const ok = await askConfirm(`Восстановить копию от ${fmtBackupTime(b.atMs)}?`, {
      detail:
        'Копия заменит текущий проект целиком — всё, что сделано после неё, будет потеряно.',
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
        ? 'Прежний эталон будет заменён. Эталон — это заведомо рабочее состояние проекта: он не прореживается и переписывается только этой кнопкой.'
        : 'Эталон — заведомо рабочее состояние проекта. Он не прореживается со временем и переписывается только этой кнопкой.',
      okLabel: 'Сделать эталоном',
      danger: false,
    });
    if (!ok) return;
    send({ type: 'setReferenceBackup' });
  };

  return (
    <section className="panel">
      <h2>Резервные копии проекта</h2>
      <p className="dim">
        Копии проекта по расписанию — на случай, если в редакторе что-то испортили. Это отдельно от
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
          data-hint="Зафиксировать нынешнее состояние как ЭТАЛОН проекта. Эталон не прореживается и не переписывается автоматикой — к нему возвращаются, если кто-то всё переделал."
          onClick={() => void makeReference()}
        >
          Сделать эталоном
        </button>
      </div>
      <p className="dim">
        Копия делается, только если в проекте что-то изменилось. Хранятся: за последние 6 часов — по одному на
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
            Программа запускается сама при входе в Windows — значком у часов, без окна — и держит фонтан:
            упавший движок поднимается заново, расписание играет, даже если никто не открыл редактор.
          </p>
          <p className="dim">
            После отключения питания Windows ждёт, пока кто-нибудь войдёт. Чтобы фонтан поднялся без
            человека, на компьютере объекта включают автоматический вход (см. памятку по установке).
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
        <label className="field" data-hint="Аварии ПЧ, пропажа Art-Net нод и приборов — то же, что попадает в журнал уровнями «предупреждение» и «ошибка»">
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
      <RecipientsBlock engine={engine} />
      <ReportHistory days={telegram.reportDays} hour={telegram.dailyHour} />
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
 * Приходил ли суточный отчёт каждый день.
 *
 * Молчание бота само по себе ничего не значит: может, на объекте всё спокойно,
 * а может, бот умер ещё неделю назад и никто этого не заметил. Здесь — неделя
 * по дням: «✔» отчёт дошёл, «—» нет. Отмечается именно ДОСТАВКА, а не отправка.
 */
function ReportHistory({ days, hour }: { days: string[]; hour: number }) {
  const today = new Date();
  const cells: { label: string; ok: boolean; today: boolean }[] = [];
  for (let back = 6; back >= 0; back--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    cells.push({
      label: `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`,
      ok: days.includes(key),
      today: back === 0,
    });
  }
  const pending = today.getHours() < hour;
  return (
    <div className="form-row">
      <span
        className="quick-row-label"
        data-hint="Приходил ли суточный отчёт по дням. Молчание бота само по себе не значит «всё хорошо» — по этой строке видно, что связь была."
      >
        Отчёты за неделю:
      </span>
      {cells.map((c) => (
        <span key={c.label} className={c.ok ? 'ok-text' : c.today && pending ? 'dim' : 'warn'}>
          {c.label} {c.ok ? '✔' : c.today && pending ? '⏳' : '—'}
        </span>
      ))}
    </div>
  );
}

/**
 * Ещё получатели уведомлений, помимо главного чата: дежурный, инженер,
 * начальник объекта. У каждого свои разделы — дежурному аварии ночью,
 * начальнику только утренний отчёт.
 *
 * Номер чата человек про себя не знает, и выспрашивать его неоткуда: поэтому
 * тех, кто написал боту, движок запоминает и показывает списком — добавить
 * можно одним нажатием. Кнопок («Принято», «Остановить») в копиях нет: команды
 * движок принимает только из главного чата, и кнопка у дежурного всё равно бы
 * не сработала.
 */
function RecipientsBlock({ engine }: { engine: EngineConnection }) {
  const { telegram, send } = engine;
  if (!telegram) return null;
  const list = telegram.recipients;
  const save = (next: typeof list): void => send({ type: 'updateTelegram', recipients: next });
  const patch = (i: number, p: Partial<(typeof list)[number]>): void =>
    save(list.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const known = telegram.knownChats.filter((k) => k.chatId !== telegram.chatId && !list.some((r) => r.chatId === k.chatId));

  return (
    <>
      <div className="form-row">
        <span
          className="quick-row-label"
          data-hint="Кому ещё слать, кроме главного чата. Команды и кнопки остаются только у главного: копии — для чтения."
        >
          Ещё получатели:
        </span>
        {list.length === 0 && <span className="dim">никого — всё идёт только в главный чат</span>}
      </div>
      {list.map((r, i) => (
        <div className="form-row" key={r.chatId + i}>
          <input
            className="input"
            style={{ width: 160 }}
            placeholder="Кто это"
            value={r.name}
            data-hint="Как подписан в настройках: «Дежурный», «Инженер». Нужно, чтобы отличать номера друг от друга."
            onChange={(e) => patch(i, { name: e.target.value })}
          />
          <span className="dim">чат {r.chatId}</span>
          <label className="field">
            <input type="checkbox" checked={r.alarms} onChange={(e) => patch(i, { alarms: e.target.checked })} /> аварии
          </label>
          <label className="field">
            <input type="checkbox" checked={r.reports} onChange={(e) => patch(i, { reports: e.target.checked })} /> отчёты
          </label>
          <label className="field">
            <input type="checkbox" checked={r.state} onChange={(e) => patch(i, { state: e.target.checked })} /> состояние
          </label>
          <button
            className="btn btn-small"
            data-hint="Убрать получателя — ему перестанут приходить копии"
            onClick={() => save(list.filter((_, j) => j !== i))}
          >
            Убрать
          </button>
        </div>
      ))}
      {known.length > 0 && (
        <div className="form-row">
          <span className="quick-row-label" data-hint="Кто писал боту за последнее время. Пусть человек откроет бота и нажмёт «Start» — и появится здесь.">
            Писали боту:
          </span>
          {known.map((k) => (
            <button
              key={k.chatId}
              className="btn btn-small"
              data-hint={`Добавить «${k.name}» (чат ${k.chatId}) в получатели: по умолчанию аварии и отчёты`}
              onClick={() => save([...list, { chatId: k.chatId, name: k.name, alarms: true, reports: true, state: false }])}
            >
              + {k.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Уведомления на почту — второй канал рядом с ботом.
 *
 * Нужен там, где Telegram не в ходу: эксплуатирующая организация, охрана,
 * начальник объекта. Уходит ровно то же, что и боту, с теми же разделами.
 * Пароль вводится здесь и обратно НИКОГДА не приходит — как токен бота:
 * наружу уходит только «задан или нет».
 */
function MailPanel({ engine }: { engine: EngineConnection }) {
  const { mail, mailTest, send } = engine;
  const [password, setPassword] = useState('');
  if (!mail) return null;
  const set = (patch: Record<string, unknown>): void => send({ type: 'updateMail', ...patch } as never);
  const when = (ms: number): string =>
    ms > 0 ? new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ещё ни разу';

  return (
    <section className="panel">
      <h2>Уведомления на почту</h2>
      <p className="dim">
        То же, что уходит боту: аварии сразу, отчёт раз в сутки. Нужно там, где Telegram не в ходу — эксплуатирующей
        организации, охране, начальнику объекта. Нет интернета — письма копятся и уходят, когда связь появится.
      </p>
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={mail.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Включено
        </label>
        <label className="field">
          <input type="checkbox" checked={mail.alarms} onChange={(e) => set({ alarms: e.target.checked })} /> Аварии
        </label>
        <label className="field">
          <input type="checkbox" checked={mail.reports} onChange={(e) => set({ reports: e.target.checked })} /> Отчёты
        </label>
        <label className="field">
          <input type="checkbox" checked={mail.state} onChange={(e) => set({ state: e.target.checked })} /> Состояние
        </label>
      </div>
      <div className="form-row">
        <label className="field" data-hint="Адрес SMTP-сервера почты. Яндекс — smtp.yandex.ru, Mail.ru — smtp.mail.ru, Gmail — smtp.gmail.com.">
          Сервер:{' '}
          <CommitInput width={180} placeholder="smtp.yandex.ru" value={mail.host} onCommit={(v) => set({ host: v })} />
        </label>
        <label className="field" data-hint="465 — сразу шифрованное соединение (SSL/TLS), 587 — обычное с переходом на шифрование (STARTTLS).">
          Порт:{' '}
          <CommitInput width={70} type="number" value={String(mail.port)} onCommit={(v) => set({ port: Number(v) || 587 })} />
        </label>
        <label className="field" data-hint="Как шифруется соединение. Почти везде подходит STARTTLS на 587 или SSL/TLS на 465; «без шифрования» — только для своего сервера в локальной сети.">
          Шифрование:{' '}
          <select value={mail.security} onChange={(e) => set({ security: e.target.value })}>
            <option value="starttls">STARTTLS (порт 587)</option>
            <option value="tls">SSL/TLS (порт 465)</option>
            <option value="none">без шифрования</option>
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="field" data-hint="Логин на почтовом сервере — обычно полный адрес ящика, с которого шлём.">
          Ящик:{' '}
          <CommitInput width={200} placeholder="fountain@yandex.ru" value={mail.user} onCommit={(v) => set({ user: v })} />
        </label>
        <label className="field" data-hint="Пароль приложения, а НЕ пароль от почты: у Яндекса, Mail.ru и Gmail обычный пароль для программ не работает — заведите пароль приложения в настройках ящика. Здесь он хранится в fountain.secrets.json и наружу не отдаётся.">
          Пароль:{' '}
          <input
            className="input"
            style={{ width: 160 }}
            type="password"
            placeholder={mail.hasPassword ? 'задан' : 'пароль приложения'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          className="btn"
          disabled={password === ''}
          onClick={() => {
            set({ password });
            setPassword('');
          }}
        >
          Сохранить пароль
        </button>
      </div>
      <div className="form-row">
        <label className="field" data-hint="Кому слать. Несколько адресов — через запятую или пробел.">
          Кому:{' '}
          <CommitInput width={320} placeholder="dezhurny@site.ru, engineer@site.ru" value={mail.to} onCommit={(v) => set({ to: v })} />
        </label>
        <button className="btn" onClick={() => send({ type: 'testMail' })} disabled={!mail.enabled}>
          Отправить проверочное
        </button>
      </div>
      <p className="dim">
        Состояние: {mail.hasPassword ? 'пароль задан' : 'пароль не задан'} · последнее письмо: {when(mail.lastOkMs)} ·
        в очереди {mail.queued}
        {mail.lastError !== '' && <span className="error-text"> · {mail.lastError}</span>}
      </p>
      {mailTest && (
        <p className={mailTest.ok ? 'ok-text' : 'error-text'}>
          {mailTest.ok ? '✔ Письмо отправлено — проверьте ящик.' : `Не получилось: ${mailTest.error ?? 'нет связи'}`}
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
  const { project, updateProject, failsafe, engineConfig, send } = engine;
  if (!project) return null;
  const cfg = project.failsafe;
  const bench = engineConfig?.benchMode === true;
  const update = (patch: Partial<typeof cfg>): void =>
    updateProject({ ...project, failsafe: { ...cfg, ...patch } });
  const targets = failsafeTargetsText(cfg);

  /*
   * Состояние — одной фразой, что происходит СЕЙЧАС. Раньше было «Сейчас
   * сработало: … Вода отключена» — и непонятно, что «сработало», и неверно:
   * гасится не только вода, но и клапаны и свет (по галочкам ниже).
   */
  const status: { cls: string; text: string } = failsafe?.active
    ? {
        cls: 'error-text',
        text: `✖ Аварийное отключение работает: ${failsafe.reason || 'причина не указана'}. Сейчас в 0: ${targets}. Как только кадры снова пойдут, всё вернётся само.`,
      }
    : failsafe?.linkBad
      ? {
          cls: 'warn',
          text: bench
            ? '⚠ Кадры в линию не уходят (интерфейс DMX не найден или кабель не подключён), но аварийное отключение не срабатывает — включён режим отладки.'
            : `⚠ Кадры в линию не уходят (интерфейс DMX не найден или кабель не подключён). Через ${cfg.timeoutSec} с аварийное отключение погасит: ${targets}.`,
        }
      : {
          cls: 'ok-text',
          text: `✔ Кадры доходят до приборов${failsafe && failsafe.trips > 0 ? ` (отключение срабатывало с запуска: ${failsafe.trips})` : ''}.`,
        };

  return (
    <section className="panel">
      <h2>Аварийное отключение</h2>
      <p className="dim">
        Если движок перестал выдавать кадры приборам — такт вставал или выход не доставляет (выдернули USB,
        закрылся порт), — выбранные ниже приборы принудительно уходят в 0. Без этого приборы держат ПОСЛЕДНЕЕ
        принятое значение: насос продолжит крутиться, струя останется поднятой. Когда вывод восстановится,
        движок сам вернётся к обычной картине.
      </p>
      <p className={status.cls} style={{ marginLeft: 0 }}>
        {status.text}
      </p>
      <div className="form-row">
        {/* Подпись — само название, а не «Включено»: сразу видно, ЧТО включено. */}
        <label className="field">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> Аварийное
          отключение
        </label>
        <label
          className={cfg.enabled ? 'field' : 'field dim'}
          data-hint="Сколько терпим пропажу вывода, прежде чем гасить. Меньше 3 секунд ставить не стоит: короткие подвисания Windows — обычное дело, и фонтан начнёт мигать."
        >
          Ждать, секунд:{' '}
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
      </div>
      {/*
        Что гасить — три отдельные галочки (заказчик 23.09.2026). Раньше вода
        гасилась всегда, а свет — одной галочкой «Гасить и свет».
      */}
      <div className="form-row">
        <span className={cfg.enabled ? 'field' : 'field dim'}>Гасить:</span>
        <label className="field" data-hint="Насосы в 0 — струи опускаются. Это главная защита: без неё струя останется поднятой.">
          <input type="checkbox" checked={cfg.pumps !== false} disabled={!cfg.enabled} onChange={(e) => update({ pumps: e.target.checked })} />{' '}
          насосы
        </label>
        <label className="field" data-hint="Клапаны в 0 — закрываются. Снимите, если на объекте клапаны должны оставаться открытыми (ливнёвка, перелив).">
          <input type="checkbox" checked={cfg.valves !== false} disabled={!cfg.enabled} onChange={(e) => update({ valves: e.target.checked })} />{' '}
          клапаны
        </label>
        <label className="field" data-hint="Свет в 0. Снимите, если подсветку просят оставить, чтобы объект не стоял в темноте.">
          <input type="checkbox" checked={cfg.lights} disabled={!cfg.enabled} onChange={(e) => update({ lights: e.target.checked })} />{' '}
          свет
        </label>
      </div>
      {/*
        Режим отладки — настройка ПРОГРАММЫ, поэтому стоит отдельной строкой
        ниже настроек проекта: проект уезжает на фонтан, и гашение там нужно
        включённым. Подробнее — в messages.ts (setBenchMode).
      */}
      <div className="form-row">
        <label
          className="field"
          data-hint="Отладка на столе: на ЭТОМ компьютере аварийное отключение не срабатывает, и приборами можно управлять руками без интерфейса DMX. В проект настройка не попадает — на фонтане отключение останется включённым. Хранится в настройках программы: переживает перезагрузку страницы и перезапуск."
        >
          <input type="checkbox" checked={bench} onChange={(e) => send({ type: 'setBenchMode', on: e.target.checked })} /> Режим
          отладки на этом компьютере
        </label>
        {bench && <span className="warn">⚠ перед сдачей объекта выключить</span>}
      </div>
      <p className="dim">
        Чего этим не закрыть: если процесс движка убит целиком, слать безопасный кадр уже некому — для этого
        есть сторож, который поднимает движок заново (он стартует с нулей). Закрытие редактора аварией НЕ
        считается: шоу играет движок, и оно должно продолжаться.
      </p>
    </section>
  );
}

/**
 * Звук музыки, которую играет движок: громкость в децибелах, «звук выключен»,
 * эквалайзер на десять полос с готовыми пресетами и видно ли, чем играть.
 *
 * Децибелы — как в FontanPlay (заказчик прислал снимок её окна как образец) и
 * как на усилителе; почему не проценты и почему нет ползунка «Friq» — в
 * shared/audiovolume.ts. Эквалайзер — как в настройках наушников и музыкальных
 * программ (заказчик 24.09.2026, с образцом списка пресетов): вертикальные
 * ползунки по полосам и список «По умолчанию / Классическая / Клубная…».
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
   * через сеть и рывками возвращал бы ручку назад. Движку отправляем, когда
   * ползунок отпустили: каждое движение — это запись настроек на диск.
   */
  const [localVol, setLocalVol] = useState<number | null>(null);
  const [localEq, setLocalEq] = useState<number[] | null>(null);
  if (!engineConfig) return null;
  const muted = engineConfig.audioMuted;
  const volumeDb = localVol ?? engineConfig.audioVolumeDb;
  const eq = localEq ?? engineConfig.audioEq;
  const presetId = eqPresetOf(eq);

  const commit = (next: { volumeDb?: number; muted?: boolean; eq?: number[]; custom?: boolean }): void => {
    const v = clampVolumeDb(next.volumeDb ?? volumeDb);
    const bands = clampEq(next.eq ?? eq);
    const preset = eqPresetOf(bands);
    setLocalVol(null);
    setLocalEq(null);
    send({
      type: 'setAudioVolume',
      volumeDb: v,
      muted: next.muted ?? muted,
      eq: bands,
      eqPreset: preset,
      // Своя настройка запоминается отдельно: выбрали пресет, потом «Своя
      // настройка» — вернулось накрученное руками, а не ровный ноль.
      eqCustom: preset === EQ_CUSTOM_ID ? bands : engineConfig.audioEqCustom,
    });
  };
  const choosePreset = (id: string): void => {
    if (id === EQ_CUSTOM_ID) commit({ eq: engineConfig.audioEqCustom });
    else commit({ eq: EQ_PRESETS.find((p) => p.id === id)?.gains ?? eq });
  };
  const release = (): void => {
    if (localVol !== null || localEq !== null) commit({});
  };

  return (
    <section className="panel">
      <h2>Громкость и эквалайзер</h2>
      <p className="dim">
        Музыка шоу, которую движок играет сам — когда шоу запускает плейлист или расписание, в том числе при
        закрытом редакторе. Громкость и эквалайзер меняются с ближайшего следующего трека: обрывать уже идущий
        нельзя — вода уйдёт из-под музыки.
      </p>
      <div className="form-row">
        <label
          className="field"
          data-hint={
            '0 дБ — как записано в файле. −6 дБ — заметно тише, −10 дБ — на слух примерно вдвое тише.\n' +
            'Выше 0 дБ — громче файла: тихий трек можно поднять. Громкие места при этом мягко прижимает ограничитель, чтобы колонки не хрипели.'
          }
        >
          Громкость:{' '}
          <input
            type="range"
            min={VOLUME_DB_MIN}
            max={VOLUME_DB_MAX}
            step={0.1}
            value={volumeDb}
            disabled={muted}
            onChange={(e) => setLocalVol(Number(e.target.value))}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={release}
          />
        </label>
        <span className="tone-value">{toneDbLabel(volumeDb)}</span>
        <span className="dim">0 дБ — как в файле, от −12 до +12</span>
        <label className="field" data-hint="Трек не звучит вовсе; вода и свет при этом работают по шоу.">
          <input type="checkbox" checked={muted} onChange={(e) => commit({ muted: e.target.checked })} /> звук выключен
        </label>
      </div>
      {/*
        Эквалайзер — подстроить звук под колонки конкретного места: где-то
        бубнит низ, где-то режут верха. На синхронизацию с водой не влияет.
      */}
      <div className="form-row">
        <label className="field" data-hint="Готовые настройки, как в музыкальных программах. Сдвинули любой ползунок — станет «Своя настройка».">
          Эквалайзер:{' '}
          <select value={presetId} disabled={muted} onChange={(e) => choosePreset(e.target.value)}>
            <option value={EQ_CUSTOM_ID}>Своя настройка</option>
            {EQ_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {!eqIsFlat(eq) && (
          <button className="btn btn-small" disabled={muted} onClick={() => choosePreset('flat')}>
            Сбросить
          </button>
        )}
      </div>
      <div className={muted ? 'eq eq-disabled' : 'eq'}>
        <div className="eq-scale" aria-hidden="true">
          <span>+12</span>
          <span>0</span>
          <span>−12</span>
        </div>
        {EQ_BANDS_HZ.map((hz, i) => (
          <label key={hz} className="eq-band" data-hint={`${hz >= 1000 ? `${hz / 1000} кГц` : `${hz} Гц`}: ${toneDbLabel(eq[i] ?? 0)}`}>
            <span className="eq-value">{toneDbLabel(eq[i] ?? 0).replace(' дБ', '')}</span>
            <input
              className="eq-slider"
              type="range"
              min={EQ_DB_MIN}
              max={EQ_DB_MAX}
              step={0.1}
              value={eq[i] ?? 0}
              disabled={muted}
              onChange={(e) => {
                const next = eq.slice();
                next[i] = Number(e.target.value);
                setLocalEq(next);
              }}
              onPointerUp={release}
              onKeyUp={release}
              onBlur={release}
              onDoubleClick={() => {
                const next = eq.slice();
                next[i] = 0;
                commit({ eq: next });
              }}
            />
            <span className="eq-hz">{eqBandLabel(hz)}</span>
          </label>
        ))}
      </div>
      <p className="dim">Гц · двойной щелчок по ползунку — вернуть полосу в 0.</p>
      {muted && (
        <p className="warn">Звук выключен — плейлисты и расписание отыграют в тишине, вода и свет при этом работают.</p>
      )}
      {engineConfig.audioReady ? (
        <p className="dim">✔ Проигрыватель найден — звук будет.</p>
      ) : (
        <p className="error-text">
          Проигрывателя нет: движку нечем открыть аудиофайл, и плейлисты с расписанием отыграют в тишине — вода
          и свет при этом работают. Лечится установкой ffmpeg: в командной строке{' '}
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
      <h2>Расчёт и отправка данных</h2>
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

/**
 * Поле, которое отдаёт значение, когда человек закончил ввод (ушёл с поля или
 * нажал Enter), а не на каждую букву. Нужно для адреса датчика ветра: каждая
 * правка открывает подключение заново, и «C», «CO», «COM» по очереди — это
 * три попытки открыть несуществующие порты.
 */
function CommitInput({
  value,
  onCommit,
  width,
  placeholder,
  type,
  list,
}: {
  value: string;
  onCommit: (v: string) => void;
  width: number;
  placeholder?: string;
  type?: 'text' | 'number';
  list?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      className="input"
      style={{ width }}
      type={type ?? 'text'}
      list={list}
      value={draft ?? value}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

type WindChoice = 'off' | WindSource;

/** Что сейчас с датчиком — словами, как человеку на объекте. */
function windSensorLine(ws: WindState | null): JSX.Element | null {
  const s = ws?.sensor;
  if (!ws || !s) return null;
  const dir = s.directionDeg !== null ? `, дует с ${Math.round(s.directionDeg)}°` : '';
  const raw = s.raw !== null ? ` (в регистре ${s.raw})` : '';
  if (s.online && ws.speedMs !== null) {
    return (
      <span className="ok-text status-note">
        ✔ датчик на связи: {num(ws.speedMs, 1)} м/с{dir}
        {raw}
      </span>
    );
  }
  if (s.holding && ws.speedMs !== null) {
    return (
      <span className="error-text">
        ✖ датчик не отвечает{s.lastOkAgoSec !== null ? ` ${durationRu(s.lastOkAgoSec * 1000)}` : ''}
        {s.error ? ` (${s.error})` : ''} — держим последнее показание {num(ws.speedMs, 1)} м/с
      </span>
    );
  }
  if (s.error) return <span className="error-text">✖ {s.error}</span>;
  return <span className="dim">жду первое показание…</span>;
}

/**
 * Откуда брать ветер. Одно место, где это решается: «не учитывать», ручной
 * ввод для проверки или датчик. Раньше была только галочка «Включено», а
 * скорость вводилась руками на «Отладке» — подключить датчик было некуда.
 */
function WindSourceBlock({
  engine,
  cfg,
  update,
}: {
  engine: EngineConnection;
  cfg: WindLimitConfig;
  update: (patch: Partial<WindLimitConfig>) => void;
}) {
  const choice: WindChoice = cfg.enabled ? cfg.source : 'off';
  const m = cfg.modbus;
  const setModbus = (patch: Partial<WindSensorModbus>): void => update({ modbus: { ...m, ...patch } });
  const conn = m.connection;
  const mqttOff = engine.remote !== null && !engine.remote.settings.mqtt.enabled;

  return (
    <>
      <div className="form-row">
        <label
          className="field"
          data-hint="Откуда программа узнаёт скорость ветра. Датчик подключается НЕ через USB-DMX: DMX идёт только от компьютера к приборам. Анемометр с выходом RS-485 Modbus — через USB-переходник RS-485 или шлюз Modbus TCP (можно на ту же линию, что частотники). Анемометр с выходом 0–10 В или 4–20 мА — через модуль «аналог → Modbus», дальше так же. Метеостанция или ПЛК — через MQTT."
        >
          Откуда брать ветер:{' '}
          <select
            value={choice}
            onChange={(e) => {
              const v = e.target.value as WindChoice;
              update(v === 'off' ? { enabled: false } : { enabled: true, source: v });
            }}
          >
            <option value="off">Не учитывать ветер</option>
            <option value="manual">Ручной ввод — проверка без датчика</option>
            <option value="modbus">Датчик по Modbus (RS-485 или шлюз)</option>
            <option value="mqtt">Датчик по MQTT</option>
          </select>
        </label>
        {choice === 'modbus' || choice === 'mqtt' ? windSensorLine(engine.windState) : null}
      </div>

      {choice === 'off' && (
        <p className="dim">Насосы от ветра не снижаются. Ветер в 3D — только для картинки.</p>
      )}
      {choice === 'manual' && (
        <p className="dim">
          Скорость вводится на вкладке «Отладка» (поле «Ветер, м/с») или ползунком ветра в 3D — насосы
          реагируют как на настоящий ветер. Для проверки без датчика; на объекте с датчиком выберите датчик.
        </p>
      )}

      {choice === 'modbus' && (
        <>
          <div className="form-row">
            <label className="field" data-hint="RS-485 — датчик на проводе, в компьютер через USB-переходник (COM-порт). TCP — датчик на линии RS-485 за шлюзом RS-485↔сеть.">
              Подключение:{' '}
              <select
                value={conn.kind}
                onChange={(e) =>
                  setModbus({
                    connection:
                      e.target.value === 'tcp'
                        ? { kind: 'tcp', host: '', port: 502 }
                        : { kind: 'rtu', serialPort: '', baudRate: 9600 },
                  })
                }
              >
                <option value="rtu">RS-485 (USB-переходник, COM-порт)</option>
                <option value="tcp">TCP (шлюз RS-485 ↔ сеть)</option>
              </select>
            </label>
            {conn.kind === 'rtu' ? (
              <>
                <label className="field" data-hint="COM-порт переходника RS-485. Если датчик на одной линии с частотниками — тот же порт, что у них.">
                  COM-порт:{' '}
                  <ComPortPicker
                    engine={engine}
                    value={conn.serialPort}
                    onChange={(v) => setModbus({ connection: { ...conn, serialPort: v } })}
                  />
                </label>
                <label className="field" data-hint="Скорость линии — как в паспорте датчика. На одной линии с частотниками у всех она одинаковая.">
                  Скорость:{' '}
                  <select
                    value={conn.baudRate ?? 9600}
                    onChange={(e) => setModbus({ connection: { ...conn, baudRate: Number(e.target.value) } })}
                  >
                    {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Чётность:{' '}
                  <select
                    value={conn.parity ?? 'none'}
                    onChange={(e) =>
                      setModbus({ connection: { ...conn, parity: e.target.value as 'none' | 'even' | 'odd' } })
                    }
                  >
                    <option value="none">нет</option>
                    <option value="even">чёт</option>
                    <option value="odd">нечёт</option>
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="field" data-hint="IP-адрес шлюза Modbus TCP">
                  IP шлюза:{' '}
                  <CommitInput
                    width={130}
                    placeholder="192.168.0.20"
                    value={conn.host}
                    onCommit={(v) => setModbus({ connection: { ...conn, host: v.trim() } })}
                  />
                </label>
                <label className="field">
                  Порт:{' '}
                  <CommitInput
                    width={70}
                    type="number"
                    value={String(conn.port ?? 502)}
                    onCommit={(v) => setModbus({ connection: { ...conn, port: Number(v) || 502 } })}
                  />
                </label>
              </>
            )}
          </div>
          <div className="form-row">
            <label className="field" data-hint="Адрес датчика на линии (1–247) — из паспорта или с наклейки. У частотников на той же линии адреса другие.">
              Адрес:{' '}
              <CommitInput
                width={60}
                type="number"
                value={String(m.unitId)}
                onCommit={(v) => setModbus({ unitId: Math.max(1, Math.min(247, Math.round(Number(v)) || 1)) })}
              />
            </label>
            <label className="field" data-hint="Регистр скорости ветра из паспорта датчика, с нуля: «0x0000» — это 0.">
              Регистр скорости:{' '}
              <CommitInput
                width={70}
                type="number"
                value={String(m.register)}
                onCommit={(v) => setModbus({ register: Math.max(0, Math.round(Number(v)) || 0) })}
              />
            </label>
            <label className="field" data-hint="Какой командой читать: в паспорте датчика написано «функция 03» или «функция 04».">
              Чтение:{' '}
              <select
                value={m.registerKind}
                onChange={(e) => setModbus({ registerKind: e.target.value as 'holding' | 'input' })}
              >
                <option value="holding">функция 03</option>
                <option value="input">функция 04</option>
              </select>
            </label>
            <label className="field" data-hint="Регистр направления ветра, если датчик его даёт (в градусах). Пусто — направления нет; тогда в расчёте ветер всегда дует в худшую сторону.">
              Регистр направления:{' '}
              <CommitInput
                width={70}
                type="number"
                placeholder="нет"
                value={m.directionRegister === null ? '' : String(m.directionRegister)}
                onCommit={(v) =>
                  setModbus({ directionRegister: v.trim() === '' ? null : Math.max(0, Math.round(Number(v)) || 0) })
                }
              />
            </label>
          </div>
          {/*
            Шкала — по типу выхода датчика. Компьютер читает только цифру: у
            аналогового датчика в регистре не скорость, а то, как модуль
            «аналог → Modbus» оцифровал напряжение или ток.
          */}
          <div className="form-row">
            <label
              className="field"
              data-hint="Какой сигнал выдаёт сам датчик — написано в его паспорте. Цифровой — сразу RS-485 Modbus. 0–10 В или 4–20 мА (например, Musidora «Wind» — 0–10 В) компьютер напрямую не читает: между датчиком и компьютером ставится модуль «аналог → Modbus»."
            >
              Выход датчика:{' '}
              <select
                value={m.signal}
                onChange={(e) => {
                  const signal = e.target.value as WindSensorModbus['signal'];
                  // Для аналоговых — типичная шкала модулей: милливольты или микроамперы.
                  setModbus(
                    signal === 'volt'
                      ? { signal, rawAtMin: 0, rawAtMax: 10000 }
                      : signal === 'current'
                        ? { signal, rawAtMin: 4000, rawAtMax: 20000 }
                        : { signal },
                  );
                }}
              >
                <option value="digital">цифровой (RS-485 Modbus)</option>
                <option value="volt">0–10 В через модуль</option>
                <option value="current">4–20 мА через модуль</option>
              </select>
            </label>
            {m.signal === 'digital' ? (
              <label className="field" data-hint="Сколько единиц регистра в 1 м/с. У большинства датчиков 10: они отдают скорость в десятых долях (32 = 3,2 м/с).">
                Единиц на 1 м/с:{' '}
                <CommitInput
                  width={60}
                  type="number"
                  value={String(m.unitsPerMs)}
                  onCommit={(v) => setModbus({ unitsPerMs: Number(v) > 0 ? Number(v) : 10 })}
                />
              </label>
            ) : (
              <>
                <label
                  className="field"
                  data-hint={`Что модуль показывает при ${m.signal === 'volt' ? '0 В' : '4 мА'} — это безветрие. Обычно ${m.signal === 'volt' ? '0' : '4000'}, но смотрите настройку модуля.`}
                >
                  При {m.signal === 'volt' ? '0 В' : '4 мА'}:{' '}
                  <CommitInput
                    width={70}
                    type="number"
                    value={String(m.rawAtMin)}
                    onCommit={(v) => setModbus({ rawAtMin: Math.max(0, Math.round(Number(v)) || 0) })}
                  />
                </label>
                <label className="field" data-hint={`Что модуль показывает при ${m.signal === 'volt' ? '10 В' : '20 мА'} — конце шкалы датчика.`}>
                  При {m.signal === 'volt' ? '10 В' : '20 мА'}:{' '}
                  <CommitInput
                    width={70}
                    type="number"
                    value={String(m.rawAtMax)}
                    onCommit={(v) => setModbus({ rawAtMax: Math.max(1, Math.round(Number(v)) || 1) })}
                  />
                </label>
                <label className="field" data-hint="Какая скорость ветра соответствует концу шкалы — из паспорта датчика. Если в паспорте нет — сверьте с ручным анемометром и подберите.">
                  Это ветер, м/с:{' '}
                  <CommitInput
                    width={60}
                    type="number"
                    value={String(m.speedAtMax)}
                    onCommit={(v) => setModbus({ speedAtMax: Number(v) > 0 ? Number(v) : 30 })}
                  />
                </label>
              </>
            )}
          </div>
          <p className="dim">
            Всё это — из паспорта датчика и настройки модуля. Число из регистра видно в строке состояния
            датчика — по нему удобно проверить шкалу.
            {m.signal === 'current' && ' Ток ниже 4 мА — обрыв линии: датчик считается неисправным, показание держится.'}
            {m.signal === 'volt' && ' У 0–10 В обрыв линии не отличить от безветрия — если есть выбор, берите 4–20 мА.'}
          </p>
        </>
      )}

      {choice === 'mqtt' && (
        <div className="form-row">
          <label
            className="field"
            data-hint='Полный топик, куда метеостанция или контроллер присылает ветер. В сообщении — число (3.2) или JSON: {"speed": 3.2, "direction": 270}.'
          >
            Топик:{' '}
            <CommitInput
              width={220}
              placeholder="weather/wind"
              value={cfg.mqtt.topic}
              onCommit={(v) => update({ mqtt: { topic: v.replace(/[#+]/g, '').trim() } })}
            />
          </label>
          {mqttOff && (
            <span className="warn">MQTT выключен — включите его на вкладке «Внешние пульты» → «Подключение»</span>
          )}
        </div>
      )}

      {(choice === 'modbus' || choice === 'mqtt') && (
        <div className="form-row">
          <label
            className="field"
            data-hint="Столько секунд без показаний — и датчик считается пропавшим: авария в журнал и в Telegram. Последнее показание при этом держится: поднять струи в ветер, которого мы просто перестали видеть, опаснее."
          >
            Датчик пропал, если молчит, с:{' '}
            <input
              className="input input-num"
              type="number"
              min={2}
              max={600}
              value={cfg.sensorLostSec}
              onChange={(e) => update({ sensorLostSec: Math.max(2, Math.min(600, Math.round(Number(e.target.value)) || 10)) })}
            />
          </label>
        </div>
      )}
    </>
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
      <h2>Ветер</h2>
      <p className="dim">
        Ветер выше порога — мощность насосов (высота струй) снижается; свет не трогается. Предел считается
        по ТЕКУЩЕЙ высоте струи и по расстоянию до борта чаши, поэтому приглушённую струю коррекция не
        трогает, а форсунку у борта режет сильнее центральной.
      </p>
      <WindSourceBlock engine={engine} cfg={cfg} update={update} />
      <div className="form-row">
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
 * Из чего состоит сцена — «насосы 2, клапаны 2, свет 2». Нужна, чтобы из
 * списка было понятно, что сцена сделает с фонтаном, а не только её имя
 * (замечание 24.09.2026: «что значит „Максимум“, как „Радуга“ действует на
 * насосы?»).
 */
function sceneSummary(project: Project, scene: Scene): string {
  const profiles = profileMap(project);
  const byId = new Map(project.devices.map((d) => [d.id, d]));
  const counts = { pump: 0, valve: 0, lamp: 0, other: 0 };
  for (const id of Object.keys(scene.values)) {
    const d = byId.get(id);
    const kind = d ? profiles.get(d.profileId)?.kind : undefined;
    if (kind === 'pump' || kind === 'valve' || kind === 'lamp') counts[kind]++;
    else counts.other++;
  }
  const parts = [
    counts.pump ? `насосы — ${counts.pump}` : '',
    counts.valve ? `клапаны — ${counts.valve}` : '',
    counts.lamp ? `свет — ${counts.lamp}` : '',
    counts.other ? `прочее — ${counts.other}` : '',
  ].filter(Boolean);
  return parts.length === 0 ? 'в сцене нет ни одного прибора — всё погашено' : `задаёт приборы: ${parts.join(', ')}`;
}

/**
 * Холостая сцена (§27 доработки, по примеру прежнего приложения —
 * «Color Form») — что держится на выходе, когда ничего не играет, вместо
 * гашения в чёрное. Пауза между элементами плейлиста — исключение (см.
 * Playback.tick), туда холостая сцена не подставляется.
 *
 * В списке — СЦЕНЫ ПРОЕКТА с вкладки «Сцены», а не режимы программы. Раньше
 * это не было сказано, и сцены демо-проекта («Всё выключено», «Максимум»,
 * «Радуга») читались как встроенные варианты с непонятным смыслом.
 */
function IdleScenePanel({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  if (!project) return null;
  const chosen = project.scenes.find((s) => s.id === project.idleSceneId) ?? null;
  return (
    <section className="panel">
      <h2>Сцена, когда ничего не играет</h2>
      <p className="dim">
        Горит, когда не играет ни сцена, ни секвенсор, ни шоу, — вместо полной темноты. В паузах между песнями
        плейлиста не включается: там темнота нужна. Выбирается одна из сцен вашего проекта (вкладка «Сцены»).
      </p>
      <div className="form-row">
        <label className="field" data-hint="Список — сцены этого проекта с вкладки «Сцены». Что делает сцена, написано под списком.">
          Сцена проекта:{' '}
          <select
            value={project.idleSceneId ?? ''}
            onChange={(e) => updateProject({ ...project, idleSceneId: e.target.value || null })}
          >
            <option value="">не нужна — темнота</option>
            {project.scenes.length > 0 && (
              <optgroup label="Сцены проекта">
                {project.scenes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {chosen && (
          <button className="btn btn-small" onClick={() => requestTab('scenes')} data-hint="Открыть вкладку «Сцены», чтобы посмотреть или поменять значения">
            Открыть сцены
          </button>
        )}
      </div>
      <p className="dim">
        {chosen
          ? `«${chosen.name}» ${sceneSummary(project, chosen)} — значения такие, как записаны в сцене.`
          : 'Сейчас, когда ничего не играет, все приборы погашены.'}
      </p>
    </section>
  );
}

/**
 * Служебное освещение (§27 доработки, по примеру прежнего приложения —
 * «Switches») — простое вкл/выкл по времени суток для приборов, которыми шоу
 * не управляет: подсветка периметра, фонари, прожекторы на здание.
 *
 * Вне окна времени прибор НЕ трогается (движок, см. engine.ts) — раньше его
 * держали в 0, и прибор, который участвует ещё и в шоу, гас посреди шоу.
 *
 * Приборов на объекте бывают сотни, поэтому список разложен по видам с
 * галочкой «все» у каждого (заказчик 24.09.2026).
 */
function UtilityLightPanel({ engine }: { engine: EngineConnection }) {
  const { project, updateProject } = engine;
  if (!project) return null;
  const cfg = project.utilityLight;
  const update = (patch: Partial<typeof cfg>): void =>
    updateProject({ ...project, utilityLight: { ...cfg, ...patch } });
  const profiles = profileMap(project);
  const groups: { kind: string; title: string; ids: string[] }[] = [
    { kind: 'lamp', title: 'Свет', ids: [] },
    { kind: 'pump', title: 'Насосы', ids: [] },
    { kind: 'valve', title: 'Клапаны', ids: [] },
    { kind: 'other', title: 'Прочее', ids: [] },
  ];
  for (const d of project.devices) {
    const kind = profiles.get(d.profileId)?.kind;
    (groups.find((g) => g.kind === kind) ?? groups[3]!).ids.push(d.id);
  }
  const selected = new Set(cfg.deviceIds);
  const setMany = (ids: string[], on: boolean): void => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    update({ deviceIds: project.devices.map((d) => d.id).filter((id) => next.has(id)) });
  };
  const byId = new Map(project.devices.map((d) => [d.id, d]));
  const waterPicked = groups.filter((g) => g.kind === 'pump' || g.kind === 'valve').some((g) => g.ids.some((id) => selected.has(id)));

  return (
    <section className="panel">
      <h2>Служебное освещение</h2>
      <p className="dim">
        Для приборов, которыми шоу не управляет: подсветка периметра, фонари, прожекторы на здание. В заданное время
        выбранные приборы горят на полную — на все их адреса уходит 255 (цветной светильник — белым), поверх сцен и
        шоу. Вне этого времени программа их не трогает: горят так, как велит сцена или шоу, а если никто не велит — не
        горят.
      </p>
      <div className="form-row">
        <label className="field">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => update({ enabled: e.target.checked })} /> Служебное
          освещение
        </label>
        <label className="field" data-hint="Гореть круглые сутки, не глядя на время ниже">
          <input
            type="checkbox"
            checked={cfg.always}
            disabled={!cfg.enabled}
            onChange={(e) => update({ always: e.target.checked })}
          />{' '}
          Круглосуточно
        </label>
        <label className={cfg.enabled && !cfg.always ? 'field' : 'field dim'}>
          Включать в:{' '}
          <input
            className="input"
            type="time"
            value={cfg.onTime}
            disabled={!cfg.enabled || cfg.always}
            onChange={(e) => update({ onTime: e.target.value })}
          />
        </label>
        <label className={cfg.enabled && !cfg.always ? 'field' : 'field dim'}>
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
        <>
          {groups
            .filter((g) => g.ids.length > 0)
            .map((g) => {
              const picked = g.ids.filter((id) => selected.has(id)).length;
              return (
                <div key={g.kind} className="utility-group">
                  <label className="field utility-group-head">
                    <input
                      type="checkbox"
                      checked={picked === g.ids.length}
                      ref={(el) => {
                        if (el) el.indeterminate = picked > 0 && picked < g.ids.length;
                      }}
                      disabled={!cfg.enabled}
                      onChange={(e) => setMany(g.ids, e.target.checked)}
                    />{' '}
                    <b>{g.title}</b> <span className="dim">({picked} из {g.ids.length})</span>
                  </label>
                  <div className="utility-device-list">
                    {g.ids.map((id) => (
                      <label key={id} className="field">
                        <input
                          type="checkbox"
                          checked={selected.has(id)}
                          disabled={!cfg.enabled}
                          onChange={(e) => setMany([id], e.target.checked)}
                        />{' '}
                        {byId.get(id)?.name}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          {waterPicked && (
            <p className="warn">
              ⚠ Выбраны насосы или клапаны: в заданное время они включатся на полную, поверх шоу. Обычно сюда ставят
              только свет.
            </p>
          )}
        </>
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

/**
 * Подсказка к столбцу «Выход на устройстве». Раньше он назывался «№ в
 * протоколе», и заказчик не понял его даже с подсказкой (24.09.2026): «номер
 * внутри протокола» — слова программиста. Здесь — что это на железе и пример.
 */
const OUT_ON_DEVICE_HINT =
  'Какой именно выход устройства получает эту вселенную.\n' +
  '• Интерфейс FountanPlay — разъём DMX на коробке. У USB2DMX их два: вселенная 1 — «Выход 1», вселенная 2 — «Выход 2». У USB1DMX разъём один, у USB3DMX — три.\n' +
  '• Art-Net — номер вселенной, выставленный на порту ноды (у первого порта обычно 0, у второго 1). Должен совпадать с настройкой самой ноды.\n' +
  '• sACN — номер вселенной sACN (с 1), как настроен приёмник.\n' +
  '• USB-DMX ENTTEC и Open DMX — у адаптера один разъём, выбирать нечего.';

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
  const { draft, status, message, changes, appliedIds } = useSettingsDraft();
  /** Панели сворачиваются до плашки с названием (см. collapsiblePanels.ts). */
  const rootRef = useRef<HTMLElement>(null);
  useCollapsiblePanels(rootRef, 'settings');
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
  useUsbScan(engine, usbInUse);

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
  /**
   * Чем строка правки отличается от того, что работает в движке: новая или
   * изменённая. Такие строки подсвечены, пока не нажато «Применить», — между
   * «добавил» и «добавил и применил» должна быть видимая разница.
   */
  const applied = new Map(engineConfig.universes.map((u) => [u.id, u]));
  const rowState = (u: ConfigUniverse): 'new' | 'changed' | null => {
    if (!dirty) return null;
    const was = applied.get(u.id);
    if (!was) return 'new';
    return !sameOutputs(u.outputs, was.outputs) || storedUniverseLabel(u) !== storedUniverseLabel(was) ? 'changed' : null;
  };
  const changedIds = universes.filter((u) => rowState(u) !== null).map((u) => u.id);

  return (
    <main className="view view-settings" ref={rootRef}>
      <section className="panel">
        {/* «DMX и RDM»: RDM — обратная связь с приборами по тому же кабелю DMX и в
            той же вселенной; отдельных «RDM-вселенных» не бывает. */}
        <h2>Вселенные (DMX и RDM)</h2>
        <p className="dim">
          Вселенная — это 512 адресов DMX, которые уходят в один выход: разъём интерфейса или
          номер Art-Net. RDM (ответы приборов: адрес, датчики, «мигни») идёт по тому же кабелю и в той
          же вселенной — отдельных вселенных для него нет. Заводите столько, сколько выходов реально подключено на объекте. Приборы
          привязываются к вселенной по её номеру на вкладке «Оборудование».
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>№</th>
              <th>Имя</th>
              <th>Протокол</th>
              <th data-hint="IP Art-Net ноды, COM-порт адаптера или какой из интерфейсов FountanPlay">Адрес</th>
              <th data-hint={OUT_ON_DEVICE_HINT}>Выход на устройстве</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {universes.map((u) => {
              const out = u.outputs[0];
              const rs = rowState(u);
              const justApplied = !dirty && appliedIds.includes(u.id);
              return (
                <tr key={u.id} className={rs ? 'row-pending' : justApplied ? 'row-applied' : undefined}>
                  <td className="dim">{u.id}</td>
                  <td>
                    <input
                      className="input"
                      style={{ width: 140 }}
                      value={dirty ? (u.label ?? '') : storedUniverseLabel(u)}
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
                        'Art-Net и sACN — по сети, через Art-Net ноду: самый надёжный вариант для постоянного объекта (длинные кабели, развязка, много вселенных).\n' +
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
                    {out?.type === 'musidora' && musidoraTargets(engine.usbScan, out.path ?? '').length === 0 ? (
                      /*
                       * Выбирать не из чего: подключённых переходников FTDI нет —
                       * список с единственным «Авто» только путал. Появятся — будет
                       * выпадающий список с серийными номерами.
                       */
                      <span
                        className="dim"
                        data-hint={
                          'Программа сама найдёт интерфейс FountanPlay — первый свободный USB-переходник FTDI.\n' +
                          'Выбирать тут нечего, пока к компьютеру не подключено несколько таких переходников (например, ещё и USB-RS485 для частотников). Тогда здесь появится список с их серийными номерами.'
                        }
                      >
                        авто
                      </span>
                    ) : out?.type === 'musidora' ? (
                      <select
                        style={{ width: 150 }}
                        value={out.path ?? ''}
                        data-hint={
                          '«Авто» — программа сама берёт первый свободный USB-переходник FTDI, как делает FontanPlay.\n' +
                          'Подключено несколько переходников (например, ещё и USB-RS485 для частотников) — выберите интерфейс FountanPlay по серийному номеру. Вселенным одного интерфейса ставьте одно и то же значение.'
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
                      <ComPortPicker engine={engine} value={out.path ?? ''} onChange={(v) => patchOutput(u.id, { path: v })} />
                    ) : (
                      <span
                        className="dim"
                        data-hint="sACN рассылает значения всей сети сразу, на групповой адрес (multicast). Он получается из номера вселенной сам — вписывать ничего не нужно."
                      >
                        multicast
                      </span>
                    )}
                  </td>
                  <td>
                    {out?.type === 'musidora' ? (
                      <select
                        value={String(out.musidoraOut ?? 1)}
                        data-hint={
                          'В какой разъём DMX на коробке FountanPlay уходит эта вселенная.\n' +
                          'Пример: у USB2DMX два разъёма. Вселенная 1 — «Выход 1», вселенная 2 — «Выход 2». У USB1DMX разъём один — всегда «Выход 1»; у USB3DMX — три.\n' +
                          'Номер больше, чем разъёмов на коробке, не ставьте: данные лягут на первый разъём и перебьют его.'
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
                  <td className="cell-actions">
                    {rs === 'new' && (
                      <span className="badge badge-pending" data-hint="Строка ещё только в правке: движок о ней не знает. Нажмите «Применить» под таблицей.">
                        новая · не применена
                      </span>
                    )}
                    {rs === 'changed' && (
                      <span className="badge badge-pending" data-hint="Правка ещё не дошла до движка. Нажмите «Применить» под таблицей.">
                        не применена
                      </span>
                    )}
                    {justApplied && <span className="badge badge-applied">✔ применена</span>}{' '}
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
          onApply={() => applySettingsDraft(send, engine.connected, changedIds)}
          onDiscard={clearSettingsDraft}
        />
        {usbInUse && <UsbDmxStatus scan={engine.usbScan} universes={engineConfig.universes} />}
      </section>


      <FrameModePanel engine={engine} />
      <AudioPanel engine={engine} />


      <AutosavePanel engine={engine} />
      <ExportImportPanel engine={engine} />
      <AppSettingsBackupPanel engine={engine} />
      <BackupPanel engine={engine} />
      <AutostartPanel engine={engine} />
      <TelegramPanel engine={engine} />
      <MailPanel engine={engine} />
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
  const row = (label: string, hint: string, key: 'rotateSpeed' | 'panSpeed'): JSX.Element => {
    const [lo, hi, step] = VIEW_PREF_LIMITS[key];
    return (
      <label className="view-pref-row" data-hint={hint}>
        <span className="view-pref-label">{label}</span>
        <input
          type="range"
          min={lo}
          max={hi}
          step={step}
          value={prefs[key]}
          onChange={(e) => apply({ [key]: Number(e.target.value) })}
        />
        <span className="view-pref-value">×{num(prefs[key], 2)}</span>
      </label>
    );
  };
  return (
    <section className="panel">
      <h2>Управление камерой в 3D</h2>
      <p className="dim">
        Насколько быстро вид отзывается на мышь на вкладке «3D». Больше — быстрее. «Перемещение» — это когда тянут
        правой кнопкой мыши: схема едет вбок и вверх-вниз, не поворачиваясь (как карта на экране).
      </p>
      <div className="view-prefs">
        {row('Вращение (левая кнопка)', 'Поворот камеры вокруг схемы — тянуть левой кнопкой мыши по пустому месту', 'rotateSpeed')}
        {row('Перемещение (правая кнопка)', 'Перемещение вида без поворота — тянуть правой кнопкой мыши: схема едет вбок и вверх-вниз', 'panSpeed')}
      </div>
      <div className="view-prefs-reset">
        <button className="btn btn-small" onClick={() => apply({ ...VIEW_PREF_DEFAULTS })}>
          Вернуть значения по умолчанию
        </button>
      </div>
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
