import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@fountain-studio/shared';
import type { Engine } from './engine';

export const ENGINE_VERSION = '0.1.0';

/** WebSocket API движка: команды от редактора, поток статистики и кадров. */
export function startServer(engine: Engine): WebSocketServer {
  const port = engine.config.server.port;
  const wss = new WebSocketServer({ port });

  const broadcast = (msg: ServerMessage): void => {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  };

  wss.on('connection', (ws) => {
    const hello: ServerMessage = {
      type: 'hello',
      version: ENGINE_VERSION,
      tickMs: engine.config.timing.tickMs,
      universes: engine.universeInfos(),
    };
    ws.send(JSON.stringify(hello));

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
          break;
        case 'testPattern':
          engine.setTestPattern(msg.mode);
          break;
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

  wss.on('listening', () => console.log(`[server] WebSocket на ws://0.0.0.0:${port}`));
  return wss;
}
