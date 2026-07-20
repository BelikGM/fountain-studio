import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BackupInfo,
  ClientMessage,
  ConfigUniverse,
  EngineStats,
  LogEvent,
  ModbusState,
  NetworkState,
  PlaybackState,
  Project,
  ServerMessage,
  UniverseInfo,
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

export interface EngineConfigState {
  tickMs: number;
  universes: ConfigUniverse[];
}

export interface RemoteStatus {
  osc: { enabled: boolean };
  mqtt: { enabled: boolean; connected: boolean };
}

export interface EngineConnection {
  connected: boolean;
  version: string | null;
  tickMs: number | null;
  universes: UniverseInfo[];
  stats: EngineStats | null;
  /** Последний кадр каждой вселенной (id → 512 байт). */
  frames: Record<number, Uint8Array>;
  /** Проект (источник истины — движок; правки шлём через updateProject). */
  project: Project | null;
  playback: PlaybackState;
  /** Состояние сети Art-Net/RDM (null — мониторинг не активен). */
  network: NetworkState | null;
  /** Состояние насосов на Modbus (null — движок ещё не прислал; пуст — насосов на Modbus нет). */
  modbus: ModbusState | null;
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
  send: (msg: ClientMessage) => void;
  /** Применяет правку проекта локально и отправляет движку. */
  updateProject: (project: Project) => void;
  /** Запрашивает аудиофайл из хранилища движка (null — файла нет). */
  requestAudio: (name: string) => Promise<Uint8Array | null>;
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
}

/** Сколько шагов истории Undo/Redo держим в памяти. */
const MAX_HISTORY = 50;

// В Electron страница открывается с file:// — hostname пустой, движок локальный.
const ENGINE_URL = `ws://${location.hostname || '127.0.0.1'}:9520`;

/** Подключение к движку с автопереподключением. */
export function useEngine(): EngineConnection {
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [tickMs, setTickMs] = useState<number | null>(null);
  const [universes, setUniverses] = useState<UniverseInfo[]>([]);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [frames, setFrames] = useState<Record<number, Uint8Array>>({});
  const [project, setProject] = useState<Project | null>(null);
  const [network, setNetwork] = useState<NetworkState | null>(null);
  const [modbus, setModbus] = useState<ModbusState | null>(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [engineConfig, setEngineConfig] = useState<EngineConfigState | null>(null);
  const [backupConfig, setBackupConfig] = useState<{ enabled: boolean; intervalMin: number } | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [savedAtMs, setSavedAtMs] = useState<number | null>(null);
  const [logEvents, setLogEvents] = useState<LogEvent[]>([]);
  const [jitterHistory, setJitterHistory] = useState<JitterSample[]>([]);
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
            setEngineConfig({ tickMs: msg.tickMs, universes: msg.universes });
            break;
          case 'stats':
            setStats(msg.stats);
            setJitterHistory((prev) => {
              const next = [...prev, { tsMs: Date.now(), jitterMs: msg.stats.lastJitterMs }];
              return next.length > MAX_JITTER_SAMPLES ? next.slice(next.length - MAX_JITTER_SAMPLES) : next;
            });
            break;
          case 'frame':
            setFrames((prev) => ({ ...prev, [msg.universe]: base64ToBytes(msg.data) }));
            break;
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
          case 'network':
            setNetwork(msg.state);
            break;
          case 'modbus':
            setModbus(msg.state);
            break;
          case 'remoteStatus':
            setRemote({ osc: msg.osc, mqtt: msg.mqtt });
            break;
          case 'audio': {
            const waiters = audioWaitersRef.current.get(msg.name) ?? [];
            audioWaitersRef.current.delete(msg.name);
            const data = msg.dataBase64 === '' ? null : base64ToBytes(msg.dataBase64);
            for (const resolve of waiters) resolve(data);
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

  return {
    connected,
    version,
    tickMs,
    universes,
    stats,
    frames,
    project,
    playback,
    network,
    modbus,
    remote,
    engineConfig,
    backupConfig,
    backups,
    savedAtMs,
    logEvents,
    jitterHistory,
    send,
    updateProject,
    requestAudio,
    requestDmxCapture,
    requestDmxCycle,
    requestRdm,
    undo,
    redo,
    canUndo: undoStackRef.current.length > 0,
    canRedo: redoStackRef.current.length > 0,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
