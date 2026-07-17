import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMessage,
  EngineStats,
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
  send: (msg: ClientMessage) => void;
  /** Применяет правку проекта локально и отправляет движку. */
  updateProject: (project: Project) => void;
}

const ENGINE_URL = `ws://${location.hostname}:9520`;

/** Подключение к движку с автопереподключением. */
export function useEngine(): EngineConnection {
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [tickMs, setTickMs] = useState<number | null>(null);
  const [universes, setUniverses] = useState<UniverseInfo[]>([]);
  const [stats, setStats] = useState<EngineStats | null>(null);
  const [frames, setFrames] = useState<Record<number, Uint8Array>>({});
  const [project, setProject] = useState<Project | null>(null);
  const [playback, setPlayback] = useState<PlaybackState>({ activeSceneId: null, running: [] });
  const wsRef = useRef<WebSocket | null>(null);
  /** Сколько наших правок ещё «в полёте» — их эхо от движка не применяем, чтобы не сбивать ввод. */
  const pendingEditsRef = useRef(0);

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

  return { connected, version, tickMs, universes, stats, frames, project, playback, send, updateProject };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
