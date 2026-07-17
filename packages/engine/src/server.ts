import { WebSocketServer, WebSocket } from 'ws';
import { sanitizeProject, type ClientMessage, type ServerMessage } from '@fountain-studio/shared';
import type { AudioStore } from './audio';
import type { Engine } from './engine';
import type { ProjectStore } from './project';

export const ENGINE_VERSION = '0.3.0';

/** WebSocket API движка: команды от редактора, поток статистики, кадров и состояния. */
export function startServer(engine: Engine, store: ProjectStore, audio: AudioStore): WebSocketServer {
  const port = engine.config.server.port;
  const wss = new WebSocketServer({ port });

  const broadcast = (msg: ServerMessage): void => {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  };

  const broadcastPlayback = (): void => broadcast({ type: 'playback', state: engine.playbackState() });

  wss.on('connection', (ws) => {
    const hello: ServerMessage = {
      type: 'hello',
      version: ENGINE_VERSION,
      tickMs: engine.config.timing.tickMs,
      universes: engine.universeInfos(),
    };
    ws.send(JSON.stringify(hello));
    ws.send(JSON.stringify({ type: 'project', project: store.project } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'playback', state: engine.playbackState() } satisfies ServerMessage));

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'setChannel':
          engine.setChannel(msg.universe, msg.channel, msg.value);
          break;
        case 'setChannels':
          engine.setChannels(msg.universe, msg.start, msg.values);
          break;
        case 'blackout':
          engine.blackout();
          broadcastPlayback();
          break;
        case 'testPattern':
          engine.setTestPattern(msg.mode);
          break;
        case 'updateProject': {
          const project = sanitizeProject(msg.project);
          store.update(project);
          engine.setProject(project);
          // Эхо всем клиентам (включая отправителя — он отсеет по содержимому).
          broadcast({ type: 'project', project });
          broadcastPlayback();
          break;
        }
        case 'setScene':
          engine.setScene(msg.sceneId);
          broadcastPlayback();
          break;
        case 'startSequence':
          engine.startSequence(msg.sequenceId);
          broadcastPlayback();
          break;
        case 'pauseSequence':
          engine.pauseSequence(msg.sequenceId);
          broadcastPlayback();
          break;
        case 'resumeSequence':
          engine.resumeSequence(msg.sequenceId);
          broadcastPlayback();
          break;
        case 'stopSequence':
          engine.stopSequence(msg.sequenceId);
          broadcastPlayback();
          break;
        case 'stopAllPlayback':
          engine.stopAllPlayback();
          broadcastPlayback();
          break;
        case 'playShow':
          engine.playShow(msg.showId, msg.positionMs);
          broadcastPlayback();
          break;
        case 'pauseShow':
          engine.pauseShow();
          broadcastPlayback();
          break;
        case 'seekShow':
          engine.seekShow(msg.positionMs);
          broadcastPlayback();
          break;
        case 'syncShow':
          // Тихая коррекция позиции по аудио-часам редактора — без рассылки.
          engine.syncShow(msg.positionMs);
          break;
        case 'stopShow':
          engine.stopShow();
          broadcastPlayback();
          break;
        case 'playPlaylist':
          engine.playPlaylist(msg.playlistId, msg.itemIndex);
          broadcastPlayback();
          break;
        case 'skipPlaylist':
          engine.skipPlaylist(msg.dir);
          broadcastPlayback();
          break;
        case 'stopPlaylist':
          engine.stopPlaylist();
          broadcastPlayback();
          break;
        case 'uploadAudio':
          audio.save(msg.name, msg.dataBase64);
          break;
        case 'getAudio': {
          const data = audio.load(msg.name);
          ws.send(JSON.stringify({ type: 'audio', name: msg.name, dataBase64: data ?? '' } satisfies ServerMessage));
          break;
        }
      }
    });
  });

  // Статистика раз в секунду, кадры для визуализации — с настроенной частотой.
  setInterval(() => broadcast({ type: 'stats', stats: engine.stats() }), 1000);
  setInterval(() => {
    if (wss.clients.size === 0) return;
    for (const u of engine.universes) {
      broadcast({ type: 'frame', universe: u.id, data: Buffer.from(u.out).toString('base64') });
    }
  }, engine.config.timing.uiFrameMs);

  // Автопереходы шагов секвенсоров: рассылаем состояние, когда оно поменялось само.
  let lastVersion = engine.playback.version;
  setInterval(() => {
    if (wss.clients.size === 0) return;
    if (engine.playback.version !== lastVersion) {
      lastVersion = engine.playback.version;
      broadcastPlayback();
    }
  }, 250);

  wss.on('listening', () => console.log(`[server] WebSocket на ws://0.0.0.0:${port}`));
  return wss;
}
