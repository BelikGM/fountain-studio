import { useCallback, useEffect, useRef, useState } from 'react';
import { onConfigResult } from './settingsDraft';
import type {
  BackupInfo,
  ClientMessage,
  ConfigUniverse,
  EngineStats,
  FailsafeState,
  LicenseStatus,
  LogEvent,
  ModbusState,
  NetworkState,
  TelegramStatus,
  PlaybackState,
  Project,
  ProjectsState,
  ServerMessage,
  UniverseInfo,
  UsbDmxScan,
  WindLimitConfig,
  FrameMode,
} from '@fountain-studio/shared';

/** Сколько записей журнала событий держим на клиенте (движок и так капает историю до 500). */
const MAX_LOG_EVENTS = 500;

/** Точка графика джиттера — §27 доработки, §3 п.5. */
export interface JitterSample {
  tsMs: number;
  jitterMs: number;
}
/** Раз в секунду (частота 'stats' от движка) — час истории. */
const MAX_JITTER_SAMPLES = 3600;

/**
 * Диалог «в объекте есть несохранённые правки» — попытка переключиться на
 * другой объект (или закрыть текущий), пока в нём есть правки, ещё не
 * записанные на диск. Три исхода ровно как в обычных редакторах: сохранить и
 * продолжить, отменить правки и продолжить, передумать вовсе.
 */
export interface PendingProjectSwitch {
  /** Куда переключаемся; null — это закрытие объекта (цели нет, просто «закрыть»). */
  targetName: string | null;
  save: () => void;
  discard: () => void;
  cancel: () => void;
}

/** Автозапуск при входе в Windows (§27 доработки, §3 п.3). */
export interface AutostartState {
  supported: boolean;
  enabled: boolean;
  error?: string;
}

/** Ветер и текущее ограничение высоты струй (§27 доработки, §4 п.1). */
/** Ветер и текущее ограничение — как присылает движок. */
export type WindState = Omit<Extract<ServerMessage, { type: 'windState' }>, 'type'>;

export interface EngineConfigState {
  tickMs: number;
  universes: ConfigUniverse[];
  /** Выбранный режим подготовки кадров (настройка программы, не объекта). */
  frameMode: FrameMode;
  /** Что реально работает: отличается, если поток не поднялся. */
  frameModeActive: FrameMode;
  /** Громкость вечерней программы, дБ (−40…0). */
  audioVolumeDb: number;
  /** Звук вечерней программы выключен. */
  audioMuted: boolean;
  /** Тембр вечерней программы, дБ. */
  audioBassDb: number;
  audioTrebleDb: number;
  /** Нашёлся ли проигрыватель: без него вечерняя программа идёт в тишине. */
  audioReady: boolean;
}

/** Внешние пульты: что задано и что сейчас на самом деле (порт открыт, брокер на связи). */
export type RemoteStatus = Omit<Extract<ServerMessage, { type: 'remoteStatus' }>, 'type'>;

export interface EngineConnection {
  connected: boolean;
  version: string | null;
  tickMs: number | null;
  universes: UniverseInfo[];
  stats: EngineStats | null;
  /** Последний кадр каждой вселенной (id → 512 байт). */
  frames: Record<number, Uint8Array>;
  /**
   * Кадры, уходящие в линию после переадресации. Совпадают с frames, пока
   * переадресации нет. По ним рисуется 3D-вид — он показывает объект, а не
   * расчёт.
   */
  wireFrames: Record<number, Uint8Array>;
  /** Проект (источник истины — движок; правки шлём через updateProject). */
  project: Project | null;
  playback: PlaybackState;
  /** Состояние сети Art-Net/RDM (null — мониторинг не активен). */
  network: NetworkState | null;
  /** Состояние уведомлений в Telegram — без токена, его движок наружу не отдаёт. */
  telegram: TelegramStatus | null;
  /** Результат разовой проверки связи: null — ещё не проверяли. */
  telegramTest: { ok: boolean; error?: string } | null;
  /** Состояние насосов на Modbus (null — движок ещё не прислал; пуст — насосов на Modbus нет). */
  modbus: ModbusState | null;
  /** Аварийное отключение: сработало ли и почему (null — движок ещё не прислал). */
  failsafe: FailsafeState | null;
  /** Какой объект открыт и какие открывали раньше (null — движок ещё не прислал). */
  projects: ProjectsState | null;
  /** Итог последней попытки открыть/создать объект. */
  projectResult: { ok: boolean; message: string } | null;
  /**
   * Открытый объект надо переключить (открыть другой/создать/закрыть), но в
   * нём есть правки, ещё не долетевшие до диска, — движок отказался
   * переключать сам и спрашивает. null, пока спрашивать не о чем.
   */
  pendingProjectSwitch: PendingProjectSwitch | null;
  /** Открыть объект по папке (или файлу project.json/.fsproj внутри неё). */
  openProject: (dir: string) => void;
  /** Завести новый объект; parentDir — если не в папке по умолчанию. */
  createProject: (name: string, parentDir?: string) => void;
  /** «Сохранить как»: копия открытого объекта под новым именем (и, если задано, в другой папке). */
  copyProject: (name: string, parentDir?: string) => void;
  /** Закрыть объект — редактор вернётся к выбору проекта. */
  closeProject: () => void;
  /** Статус OSC/MQTT (null — движок ещё не прислал). Включение — в fountain.config.json. */
  remote: RemoteStatus | null;
  /** Редактируемая конфигурация движка: вселенные и тик (вкладка «Настройки»). */
  engineConfig: EngineConfigState | null;
  /** Настройка авто-бэкапов проекта (null — движок ещё не прислал). */
  backupConfig: { enabled: boolean; intervalMin: number } | null;
  /** Список снимков, новые сверху. */
  backups: BackupInfo[];
  /** Unix-время последнего ответа на saveNow (Ctrl+S) — для краткого «✔ сохранено» в UI. */
  savedAtMs: number | null;
  /** Журнал событий (§27 доработки, §3 п.1): расписание/пульты/клавиши/аварии, новые в конце. */
  logEvents: LogEvent[];
  /** История джиттера тика (§27 доработки, §3 п.5) — до часа, ~1 точка/с, новые в конце. */
  jitterHistory: JitterSample[];
  /** Автозапуск при входе в Windows (null — движок ещё не прислал). */
  autostart: AutostartState | null;
  /** Ветер и текущее ограничение высоты струй (null — движок ещё не прислал). */
  windState: WindState | null;
  /** Статус лицензии этого ПК (null — движок ещё не прислал). §27 доработки. */
  licenseStatus: LicenseStatus | null;
  /** USB-DMX на ПК движка: драйвер FTDI, устройства, порты, интерфейсы Musidora (ответ на scanUsbDmx). */
  usbScan: UsbDmxScan | null;
  send: (msg: ClientMessage) => void;
  /** Применяет правку проекта локально и отправляет движку. */
  updateProject: (project: Project) => void;
  /** Запрашивает аудиофайл из хранилища движка (null — файла нет). */
  requestAudio: (name: string) => Promise<Uint8Array | null>;
  /** Экспорт/импорт проекта одним файлом (§27 доработки) — project.json + audio/ в .zip. */
  requestExportProject: () => Promise<{ filename: string; dataBase64: string }>;
  importProjectArchive: (dataBase64: string) => Promise<{ ok: boolean; message: string }>;
  /** Последний кадр внешнего ArtDMX по вселенной проекта (null — захвата нет). */
  requestDmxCapture: (
    universe: number,
  ) => Promise<{ data: Uint8Array; ageMs: number; fromIp: string; frames: number } | null>;
  /** Измерение периода цикла захваченного потока. */
  requestDmxCycle: (
    universe: number,
  ) => Promise<{ periodMs: number | null; confidence: number; analyzedMs: number }>;
  /** RDM GET/SET (§3 доработки) — резолвится ответом rdmResponse на этот же uid+action. */
  requestRdm: (
    req: Extract<ClientMessage, { type: 'rdmRequest' }>,
  ) => Promise<Extract<ServerMessage, { type: 'rdmResponse' }>>;
  /** Undo/Redo (§27 доработки, УХ п.4) — история правок проекта в памяти текущего сеанса. */
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Активация лицензии по содержимому файла — резолвится итоговым статусом. */
  activateLicense: (fileText: string) => Promise<LicenseStatus>;
}

/** Сколько шагов истории Undo/Redo держим в памяти. */
const MAX_HISTORY = 50;

/*
 * В Electron страница открывается с file:// — hostname пустой, движок локальный.
 *
 * `?engine=9531` — подключиться к другому движку. Нужно для проверки
 * интерфейса снимками (scripts/ui-shot.cjs): всё, что в проверке нажимается
 * («Применить», «+ Вселенная»), должно уходить в изолированный движок, а не в
 * рабочий объект на 9520 (правило 4 в CLAUDE.md). Принимаем только номер
 * порта — адрес остаётся локальным.
 */
const ENGINE_PORT = (() => {
  const p = Number(new URLSearchParams(location.search).get('engine'));
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : 9520;
})();
const ENGINE_URL = `ws://${location.hostname || '127.0.0.1'}:${ENGINE_PORT}`;

/** Подключение к движку с автопереподключением. */
export function useEngine(): EngineConnection {
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [tickMs, setTickMs] = useState<number | null>(null);
  const [universes, setUniverses] = useState<UniverseInfo[]>([]);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [frames, setFrames] = useState<Record<number, Uint8Array>>({});
  const [wireFrames, setWireFrames] = useState<Record<number, Uint8Array>>({});
  const [project, setProject] = useState<Project | null>(null);
  const [network, setNetwork] = useState<NetworkState | null>(null);
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [telegramTest, setTelegramTest] = useState<{ ok: boolean; error?: string } | null>(null);
  const [modbus, setModbus] = useState<ModbusState | null>(null);
  const [failsafe, setFailsafe] = useState<FailsafeState | null>(null);
  const [projects, setProjects] = useState<ProjectsState | null>(null);
  const [projectResult, setProjectResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pendingProjectSwitch, setPendingProjectSwitch] = useState<PendingProjectSwitch | null>(null);
  /**
   * Последняя отправленная команда переключения — если движок ответит
   * unsavedChanges, ровно её же нужно будет повторить с force (и, может
   * быть, discard). Ответы по WebSocket не носят id запроса, а тут он и не
   * нужен: команда переключения объекта всегда одна активная за раз.
   */
  const lastProjectCommandRef = useRef<
    Extract<ClientMessage, { type: 'openProject' | 'createProject' | 'copyProject' | 'closeProject' }> | null
  >(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [engineConfig, setEngineConfig] = useState<EngineConfigState | null>(null);
  const [backupConfig, setBackupConfig] = useState<{ enabled: boolean; intervalMin: number } | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [savedAtMs, setSavedAtMs] = useState<number | null>(null);
  const [logEvents, setLogEvents] = useState<LogEvent[]>([]);
  const [jitterHistory, setJitterHistory] = useState<JitterSample[]>([]);
  const [autostart, setAutostartState] = useState<AutostartState | null>(null);
  const [windState, setWindState] = useState<WindState | null>(null);
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [usbScan, setUsbScan] = useState<UsbDmxScan | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>({
    activeSceneId: null,
    running: [],
    show: null,
    playlist: null,
    pausedAll: false,
  });
  const wsRef = useRef<WebSocket | null>(null);
  /** Сколько наших правок ещё «в полёте» — их эхо от движка не применяем, чтобы не сбивать ввод. */
  const pendingEditsRef = useRef(0);
  /** История Undo/Redo — состояния проекта в памяти сеанса, не переживает перезагрузку страницы. */
  const undoStackRef = useRef<Project[]>([]);
  const redoStackRef = useRef<Project[]>([]);
  /** Ожидающие ответа getAudio: имя файла → колбэки. */
  const audioWaitersRef = useRef(new Map<string, ((data: Uint8Array | null) => void)[]>());
  const exportWaitersRef = useRef<((data: { filename: string; dataBase64: string }) => void)[]>([]);
  const importWaitersRef = useRef<((r: { ok: boolean; message: string }) => void)[]>([]);
  const licenseWaitersRef = useRef<((status: LicenseStatus) => void)[]>([]);
  /** Ожидающие ответов захвата DMX по вселенной. */
  const captureWaitersRef = useRef(
    new Map<number, ((snap: { data: Uint8Array; ageMs: number; fromIp: string; frames: number } | null) => void)[]>(),
  );
  const cycleWaitersRef = useRef(
    new Map<number, ((m: { periodMs: number | null; confidence: number; analyzedMs: number }) => void)[]>(),
  );
  /** Ожидающие rdmResponse, ключ "uid:action" — несколько действий на один прибор не путаются. */
  const rdmWaitersRef = useRef(
    new Map<string, ((msg: Extract<ServerMessage, { type: 'rdmResponse' }>) => void)[]>(),
  );

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;

    const connect = (): void => {
      const ws = new WebSocket(ENGINE_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) retryTimer = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as ServerMessage;
        switch (msg.type) {
          case 'hello':
            setVersion(msg.version);
            setTickMs(msg.tickMs);
            setUniverses(msg.universes);
            break;
          case 'config':
            setEngineConfig({
              tickMs: msg.tickMs,
              universes: msg.universes,
              frameMode: msg.frameMode,
              frameModeActive: msg.frameModeActive,
              audioVolumeDb: msg.audioVolumeDb,
              audioMuted: msg.audioMuted,
              audioBassDb: msg.audioBassDb,
              audioTrebleDb: msg.audioTrebleDb,
              audioReady: msg.audioReady,
            });
            break;
          case 'configResult':
            // Черновик вселенных живёт вне React (см. settingsDraft.ts): ответ
            // должен дойти, даже если вкладка «Настройки» уже закрыта.
            onConfigResult(msg.ok, msg.message, msg.changes);
            break;
          case 'stats':
            setStats(msg.stats);
            setJitterHistory((prev) => {
              const next = [...prev, { tsMs: Date.now(), jitterMs: msg.stats.lastJitterMs }];
              return next.length > MAX_JITTER_SAMPLES ? next.slice(next.length - MAX_JITTER_SAMPLES) : next;
            });
            break;
          case 'frame': {
            const logical = base64ToBytes(msg.data);
            setFrames((prev) => ({ ...prev, [msg.universe]: logical }));
            setWireFrames((prev) => ({
              ...prev,
              [msg.universe]: msg.wire ? base64ToBytes(msg.wire) : logical,
            }));
            break;
          }
          case 'project':
            if (pendingEditsRef.current > 0) {
              pendingEditsRef.current--;
            } else {
              setProject(msg.project);
            }
            break;
          case 'playback':
            setPlayback(msg.state);
            break;
          case 'telegram':
            setTelegram(msg.state);
            break;
          case 'telegramTest':
            setTelegramTest({ ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) });
            break;
          case 'network':
            setNetwork(msg.state);
            break;
          case 'modbus':
            setModbus(msg.state);
            break;
          case 'failsafe':
            setFailsafe(msg.state);
            break;
          case 'projects':
            setProjects(msg.state);
            break;
          case 'projectResult': {
            setProjectResult({ ok: msg.ok, message: msg.message });
            const cmd = lastProjectCommandRef.current;
            if (msg.unsavedChanges && cmd) {
              setPendingProjectSwitch({
                targetName: msg.targetName ?? null,
                save: () => {
                  send({ ...cmd, force: true });
                  setPendingProjectSwitch(null);
                },
                discard: () => {
                  send({ ...cmd, force: true, discard: true });
                  setPendingProjectSwitch(null);
                },
                cancel: () => setPendingProjectSwitch(null),
              });
            } else {
              setPendingProjectSwitch(null);
            }
            break;
          }
          case 'usbDmxScan':
            setUsbScan(msg.scan);
            break;
          case 'remoteStatus':
            setRemote({ settings: msg.settings, mqttHasPassword: msg.mqttHasPassword, osc: msg.osc, mqtt: msg.mqtt });
            break;
          case 'audio': {
            const waiters = audioWaitersRef.current.get(msg.name) ?? [];
            audioWaitersRef.current.delete(msg.name);
            const data = msg.dataBase64 === '' ? null : base64ToBytes(msg.dataBase64);
            for (const resolve of waiters) resolve(data);
            break;
          }
          case 'projectExport': {
            const waiters = exportWaitersRef.current;
            exportWaitersRef.current = [];
            for (const resolve of waiters) resolve({ filename: msg.filename, dataBase64: msg.dataBase64 });
            break;
          }
          case 'importResult': {
            const waiters = importWaitersRef.current;
            importWaitersRef.current = [];
            for (const resolve of waiters) resolve({ ok: msg.ok, message: msg.message });
            break;
          }
          case 'dmxCapture': {
            const waiters = captureWaitersRef.current.get(msg.universe) ?? [];
            captureWaitersRef.current.delete(msg.universe);
            const snap =
              msg.data === ''
                ? null
                : { data: base64ToBytes(msg.data), ageMs: msg.ageMs, fromIp: msg.fromIp, frames: msg.frames };
            for (const resolve of waiters) resolve(snap);
            break;
          }
          case 'dmxCycle': {
            const waiters = cycleWaitersRef.current.get(msg.universe) ?? [];
            cycleWaitersRef.current.delete(msg.universe);
            for (const resolve of waiters) {
              resolve({ periodMs: msg.periodMs, confidence: msg.confidence, analyzedMs: msg.analyzedMs });
            }
            break;
          }
          case 'rdmResponse': {
            const key = `${msg.uid}:${msg.action}`;
            const waiters = rdmWaitersRef.current.get(key) ?? [];
            rdmWaitersRef.current.delete(key);
            for (const resolve of waiters) resolve(msg);
            break;
          }
          case 'backupConfig':
            setBackupConfig({ enabled: msg.enabled, intervalMin: msg.intervalMin });
            break;
          case 'backupList':
            setBackups(msg.backups);
            break;
          case 'saved':
            setSavedAtMs(msg.atMs);
            break;
          case 'logHistory':
            setLogEvents(msg.events);
            break;
          case 'logEvent':
            setLogEvents((prev) => {
              const next = [...prev, msg.event];
              return next.length > MAX_LOG_EVENTS ? next.slice(next.length - MAX_LOG_EVENTS) : next;
            });
            break;
          case 'autostartState':
            setAutostartState({ supported: msg.supported, enabled: msg.enabled, error: msg.error });
            break;
          case 'windState':
            setWindState({
              speedMs: msg.speedMs,
              limitPercent: msg.limitPercent,
              config: msg.config,
              correcting: msg.correcting,
              calcSpeedMs: msg.calcSpeedMs,
              directionDeg: msg.directionDeg,
              sensor: msg.sensor,
            });
            break;
          case 'license': {
            setLicenseStatus(msg.status);
            const waiters = licenseWaitersRef.current;
            licenseWaitersRef.current = [];
            for (const resolve of waiters) resolve(msg.status);
            break;
          }
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const updateProject = useCallback(
    (next: Project) => {
      if (project) {
        undoStackRef.current.push(project);
        if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift();
      }
      redoStackRef.current = [];
      setProject(next);
      pendingEditsRef.current++;
      send({ type: 'updateProject', project: next });
    },
    [project, send],
  );

  /** Ctrl+Z — откат последней правки, по одному действию за вызов, в памяти сеанса. */
  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev || !project) return;
    redoStackRef.current.push(project);
    setProject(prev);
    pendingEditsRef.current++;
    send({ type: 'updateProject', project: prev });
  }, [project, send]);

  /** Ctrl+Y — вернуть то, что отменили Ctrl+Z. */
  const redo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next || !project) return;
    undoStackRef.current.push(project);
    setProject(next);
    pendingEditsRef.current++;
    send({ type: 'updateProject', project: next });
  }, [project, send]);

  const requestAudio = useCallback(
    (name: string) =>
      new Promise<Uint8Array | null>((resolve) => {
        const waiters = audioWaitersRef.current.get(name);
        if (waiters) {
          waiters.push(resolve);
        } else {
          audioWaitersRef.current.set(name, [resolve]);
          send({ type: 'getAudio', name });
        }
      }),
    [send],
  );

  const requestExportProject = useCallback(
    () =>
      new Promise<{ filename: string; dataBase64: string }>((resolve) => {
        exportWaitersRef.current.push(resolve);
        send({ type: 'exportProject' });
      }),
    [send],
  );

  const importProjectArchive = useCallback(
    (dataBase64: string) =>
      new Promise<{ ok: boolean; message: string }>((resolve) => {
        importWaitersRef.current.push(resolve);
        send({ type: 'importProject', dataBase64 });
      }),
    [send],
  );

  const requestDmxCapture = useCallback(
    (universe: number) =>
      new Promise<{ data: Uint8Array; ageMs: number; fromIp: string; frames: number } | null>((resolve) => {
        const waiters = captureWaitersRef.current.get(universe);
        if (waiters) {
          waiters.push(resolve);
        } else {
          captureWaitersRef.current.set(universe, [resolve]);
          send({ type: 'getDmxCapture', universe });
        }
      }),
    [send],
  );

  const requestDmxCycle = useCallback(
    (universe: number) =>
      new Promise<{ periodMs: number | null; confidence: number; analyzedMs: number }>((resolve) => {
        const waiters = cycleWaitersRef.current.get(universe);
        if (waiters) {
          waiters.push(resolve);
        } else {
          cycleWaitersRef.current.set(universe, [resolve]);
          send({ type: 'measureDmxCycle', universe });
        }
      }),
    [send],
  );

  const activateLicense = useCallback(
    (fileText: string) =>
      new Promise<LicenseStatus>((resolve) => {
        licenseWaitersRef.current.push(resolve);
        send({ type: 'activateLicense', fileText });
      }),
    [send],
  );

  const requestRdm = useCallback(
    (req: Extract<ClientMessage, { type: 'rdmRequest' }>) =>
      new Promise<Extract<ServerMessage, { type: 'rdmResponse' }>>((resolve) => {
        const key = `${req.uid}:${req.action}`;
        const waiters = rdmWaitersRef.current.get(key);
        if (waiters) {
          waiters.push(resolve);
        } else {
          rdmWaitersRef.current.set(key, [resolve]);
          send(req);
        }
      }),
    [send],
  );

  /*
   * Переключение объекта — обёртки над send(), которые запоминают команду,
   * чтобы при ответе unsavedChanges можно было послать её же снова, уже с
   * force. Голый send({ type: 'openProject', ... }) в компонентах больше не
   * используем — иначе диалог о несохранённых правках было бы нечем собрать.
   */
  const openProject = useCallback(
    (dir: string) => {
      const cmd = { type: 'openProject' as const, dir };
      lastProjectCommandRef.current = cmd;
      send(cmd);
    },
    [send],
  );
  const createProject = useCallback(
    (name: string, parentDir?: string) => {
      const cmd = { type: 'createProject' as const, name, ...(parentDir ? { parentDir } : {}) };
      lastProjectCommandRef.current = cmd;
      send(cmd);
    },
    [send],
  );
  const copyProject = useCallback(
    (name: string, parentDir?: string) => {
      const cmd = { type: 'copyProject' as const, name, ...(parentDir ? { parentDir } : {}) };
      lastProjectCommandRef.current = cmd;
      send(cmd);
    },
    [send],
  );
  const closeProject = useCallback(() => {
    const cmd = { type: 'closeProject' as const };
    lastProjectCommandRef.current = cmd;
    send(cmd);
  }, [send]);

  return {
    connected,
    version,
    tickMs,
    universes,
    stats,
    frames,
    wireFrames,
    project,
    playback,
    network,
    telegram,
    telegramTest,
    modbus,
    failsafe,
    projects,
    projectResult,
    pendingProjectSwitch,
    openProject,
    createProject,
    copyProject,
    closeProject,
    remote,
    engineConfig,
    backupConfig,
    backups,
    savedAtMs,
    logEvents,
    jitterHistory,
    autostart,
    windState,
    licenseStatus,
    usbScan,
    send,
    updateProject,
    requestAudio,
    requestExportProject,
    importProjectArchive,
    requestDmxCapture,
    requestDmxCycle,
    requestRdm,
    undo,
    redo,
    canUndo: undoStackRef.current.length > 0,
    canRedo: redoStackRef.current.length > 0,
    activateLicense,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
