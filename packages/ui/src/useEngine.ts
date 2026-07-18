import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMessage,
  EngineStats,
  NetworkState,
  PlaybackState,
  Project,
  ServerMessage,
  UniverseInfo,
} from '@fountain-studio/shared';

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
  send: (msg: ClientMessage) => void;
  /** Применяет правку проекта локально и отправляет движку. */
  updateProject: (project: Project) => void;
  /** Запрашивает аудиофайл из хранилища движка (null — файла нет). */
  requestAudio: (name: string) => Promise<Uint8Array | null>;
}

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
  const [playback, setPlayback] = useState<PlaybackState>({
    activeSceneId: null,
    running: [],
    show: null,
    playlist: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  /** Сколько наших правок ещё «в полёте» — их эхо от движка не применяем, чтобы не сбивать ввод. */
  const pendingEditsRef = useRef(0);
  /** Ожидающие ответа getAudio: имя файла → колбэки. */
  const audioWaitersRef = useRef(new Map<string, ((data: Uint8Array | null) => void)[]>());

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
          case 'stats':
            setStats(msg.stats);
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
          case 'audio': {
            const waiters = audioWaitersRef.current.get(msg.name) ?? [];
            audioWaitersRef.current.delete(msg.name);
            const data = msg.dataBase64 === '' ? null : base64ToBytes(msg.dataBase64);
            for (const resolve of waiters) resolve(data);
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
      setProject(next);
      pendingEditsRef.current++;
      send({ type: 'updateProject', project: next });
    },
    [send],
  );

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

  return { connected, version, tickMs, universes, stats, frames, project, playback, network, send, updateProject, requestAudio };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
