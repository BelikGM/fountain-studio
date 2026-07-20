import fs from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import {
  sanitizeProject,
  type ClientMessage,
  type ConfigUniverse,
  type RdmAction,
  type ServerMessage,
} from '@fountain-studio/shared';
import type { AudioStore } from './audio';
import type { BackupStore } from './backups';
import type { DmxCapture } from './dmxcapture';
import { eventLog } from './eventlog';
import type { Engine } from './engine';
import type { MqttController } from './mqttcontroller';
import type { NetworkMonitor } from './netmonitor';
import type { OscServer } from './oscserver';
import type { ProjectStore } from './project';
import {
  CC_GET_COMMAND,
  CC_SET_COMMAND,
  PID_DEVICE_INFO,
  PID_DEVICE_MODEL_DESCRIPTION,
  PID_DMX_START_ADDRESS,
  PID_IDENTIFY_DEVICE,
  PID_MANUFACTURER_LABEL,
  PID_SOFTWARE_VERSION_LABEL,
  encodeIdentify,
  encodeStartAddress,
  parseDeviceInfoResponse,
  parseIdentifyResponse,
  parseLabelResponse,
  parseStartAddressResponse,
} from './rdm';

export const ENGINE_VERSION = '0.6.0';

/** WebSocket API движка: команды от редактора, поток статистики, кадров и состояния. */
export function startServer(
  engine: Engine,
  store: ProjectStore,
  audio: AudioStore,
  backups?: BackupStore,
  net?: NetworkMonitor,
  capture?: DmxCapture,
  osc?: OscServer,
  mqtt?: MqttController,
): WebSocketServer {
  const port = engine.config.server.port;
  const wss = new WebSocketServer({ port });

  const broadcast = (msg: ServerMessage): void => {
    const json = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  };

  const broadcastPlayback = (): void => broadcast({ type: 'playback', state: engine.playbackState() });
  const configMessage = (): Extract<ServerMessage, { type: 'config' }> => ({
    type: 'config',
    tickMs: engine.config.timing.tickMs,
    universes: engine.config.universes as ConfigUniverse[],
  });
  const broadcastNetwork = (): void => {
    if (net) broadcast({ type: 'network', state: net.state() });
  };
  if (net) net.onChange = broadcastNetwork;
  const broadcastModbus = (): void => broadcast({ type: 'modbus', state: engine.modbusState() });
  engine.pumps.onChange = broadcastModbus;
  const remoteStatus = (): Extract<ServerMessage, { type: 'remoteStatus' }> => ({
    type: 'remoteStatus',
    osc: { enabled: osc !== undefined },
    mqtt: { enabled: mqtt !== undefined, connected: mqtt?.isConnected ?? false },
  });
  const broadcastRemoteStatus = (): void => broadcast(remoteStatus());
  if (mqtt) mqtt.onChange = broadcastRemoteStatus;
  const backupConfigMessage = (): Extract<ServerMessage, { type: 'backupConfig' }> => ({
    type: 'backupConfig',
    ...(backups?.config() ?? { enabled: false, intervalMin: 10 }),
  });
  const backupListMessage = (): Extract<ServerMessage, { type: 'backupList' }> => ({
    type: 'backupList',
    backups: backups?.list() ?? [],
  });
  // Журнал событий (§27 доработки, §3 п.1): новое событие — сразу всем
  // подключённым клиентам (не только тому, кто его вызвал).
  eventLog.onEvent = (event) => broadcast({ type: 'logEvent', event });

  wss.on('connection', (ws) => {
    const hello: ServerMessage = {
      type: 'hello',
      version: ENGINE_VERSION,
      tickMs: engine.config.timing.tickMs,
      universes: engine.universeInfos(),
    };
    ws.send(JSON.stringify(hello));
    ws.send(JSON.stringify(configMessage()));
    ws.send(JSON.stringify({ type: 'project', project: store.project } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'playback', state: engine.playbackState() } satisfies ServerMessage));
    if (net) ws.send(JSON.stringify({ type: 'network', state: net.state() } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'modbus', state: engine.modbusState() } satisfies ServerMessage));
    ws.send(JSON.stringify(backupConfigMessage()));
    ws.send(JSON.stringify(backupListMessage()));
    ws.send(JSON.stringify({ type: 'logHistory', events: eventLog.list() } satisfies ServerMessage));
    ws.send(JSON.stringify(remoteStatus()));

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
        case 'pauseAll':
          engine.pauseAll();
          broadcastPlayback();
          break;
        case 'resumeAll':
          engine.resumeAll();
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
        case 'refreshNetwork':
          net?.poll();
          broadcastNetwork();
          break;
        case 'getDmxCapture': {
          // Логическая вселенная проекта → Art-Net Port-Address первого artnet-выхода.
          const protoUniverse = engine.config.universes
            .find((u) => u.id === msg.universe)
            ?.outputs.find((o) => o.type === 'artnet')?.universe;
          const snap = protoUniverse !== undefined ? capture?.snapshot(protoUniverse) : null;
          ws.send(
            JSON.stringify({
              type: 'dmxCapture',
              universe: msg.universe,
              data: snap ? Buffer.from(snap.data).toString('base64') : '',
              ageMs: snap?.ageMs ?? -1,
              fromIp: snap?.fromIp ?? '',
              frames: snap?.frames ?? 0,
            } satisfies ServerMessage),
          );
          break;
        }
        case 'measureDmxCycle': {
          const protoUniverse = engine.config.universes
            .find((u) => u.id === msg.universe)
            ?.outputs.find((o) => o.type === 'artnet')?.universe;
          const m =
            protoUniverse !== undefined && capture
              ? capture.measureCycle(protoUniverse)
              : { periodMs: null, confidence: 0, analyzedMs: 0 };
          ws.send(
            JSON.stringify({
              type: 'dmxCycle',
              universe: msg.universe,
              periodMs: m.periodMs,
              confidence: m.confidence,
              analyzedMs: m.analyzedMs,
            } satisfies ServerMessage),
          );
          break;
        }
        case 'rdmRequest':
          void handleRdmRequest(net, msg, ws);
          break;
        case 'updateConfig': {
          // Валидация: непустой список, уникальные id, разумный тик.
          const tickMs = Math.round(msg.tickMs);
          const ids = msg.universes.map((u) => u.id);
          if (
            msg.universes.length === 0 ||
            new Set(ids).size !== ids.length ||
            ids.some((id) => !Number.isInteger(id) || id < 1) ||
            !Number.isFinite(tickMs) ||
            tickMs < 10 ||
            tickMs > 1000
          ) {
            console.error('[server] updateConfig отклонён: некорректные вселенные или тик');
            break;
          }
          engine.applyConfig(msg.universes, tickMs);
          // Калибровка и Modbus-насосы индексируются по вселенным — переиндексировать.
          engine.setProject(store.project);
          persistConfig(engine, tickMs, msg.universes);
          // hello повторно: UI обновит список вселенных и tickMs без переподключения.
          broadcast({
            type: 'hello',
            version: ENGINE_VERSION,
            tickMs,
            universes: engine.universeInfos(),
          });
          broadcast(configMessage());
          broadcastPlayback();
          break;
        }
        case 'uploadAudio':
          audio.save(msg.name, msg.dataBase64);
          break;
        case 'getAudio': {
          const data = audio.load(msg.name);
          ws.send(JSON.stringify({ type: 'audio', name: msg.name, dataBase64: data ?? '' } satisfies ServerMessage));
          break;
        }
        case 'updateBackupConfig': {
          if (!backups) break;
          backups.setConfig(msg.enabled, msg.intervalMin);
          const cfg = backups.config();
          persistBackupConfig(engine, cfg.enabled, cfg.intervalMin);
          broadcast(backupConfigMessage());
          break;
        }
        case 'listBackups':
          ws.send(JSON.stringify(backupListMessage()));
          break;
        case 'saveNow':
          store.flush();
          ws.send(JSON.stringify({ type: 'saved', atMs: Date.now() } satisfies ServerMessage));
          break;
        case 'takeBackupNow':
          if (!backups) break;
          backups.snapshot();
          broadcast(backupListMessage());
          break;
        case 'restoreBackup': {
          if (!backups) break;
          try {
            const project = sanitizeProject(backups.read(msg.file));
            store.update(project);
            engine.setProject(project);
            broadcast({ type: 'project', project });
            broadcastPlayback();
            eventLog.log('server', `проект восстановлен из бэкапа ${msg.file}`);
          } catch (err) {
            eventLog.log('server', `не удалось восстановить бэкап: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }
        // Источники на стороне редактора (клавиатурные привязки — движок сам
        // их не видит) сообщают о срабатывании явно, чтобы попасть в общий
        // журнал (§27 доработки, §3 п.1).
        case 'clientEvent':
          eventLog.log(msg.source, msg.message);
          break;
      }
    });
  });

  // Статистика раз в секунду, кадры для визуализации — с настроенной частотой.
  setInterval(() => broadcast({ type: 'stats', stats: engine.stats() }), 1000);
  // Сеть: раз в 3 с (обновление возрастов), плюс мгновенно из onChange.
  setInterval(() => {
    if (wss.clients.size > 0) broadcastNetwork();
  }, 3000);
  // Насосы Modbus: раз в 3 с (обновление возрастов), плюс мгновенно из onChange.
  setInterval(() => {
    if (wss.clients.size > 0) broadcastModbus();
  }, 3000);
  // Удалённое управление: раз в 5 с (статус MQTT-связи), плюс мгновенно из onChange.
  setInterval(() => {
    if (wss.clients.size > 0) broadcastRemoteStatus();
  }, 5000);
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

/**
 * Сохраняет новые вселенные/тик в fountain.config.json, не трогая остальные
 * поля файла (server, audio, osc, mqtt, spinMs, uiFrameMs).
 */
function persistConfig(engine: Engine, tickMs: number, universes: ConfigUniverse[]): void {
  const file = (engine.config as { configFile?: string }).configFile;
  if (!file) {
    console.error('[server] путь к fountain.config.json неизвестен — настройки применены, но не сохранены');
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw.timing = { ...(raw.timing as object | undefined), tickMs };
    raw.universes = universes;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
    console.log(`[server] настройки сохранены в ${file}`);
  } catch (err) {
    console.error('[server] не удалось сохранить fountain.config.json:', err);
  }
}

function persistBackupConfig(engine: Engine, enabled: boolean, intervalMin: number): void {
  const file = (engine.config as { configFile?: string }).configFile;
  if (!file) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw.backup = { enabled, intervalMin };
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  } catch (err) {
    console.error('[server] не удалось сохранить настройку бэкапов:', err);
  }
}

/**
 * Исполняет rdmRequest (§3 доработки) и шлёт rdmResponse тому же клиенту.
 * Ошибки (нет монитора сети, таймаут, прибор не в TOD) — не бросаем, а
 * отвечаем ok:false с текстом причины, чтобы UI мог показать её пользователю.
 */
async function handleRdmRequest(
  net: NetworkMonitor | undefined,
  msg: Extract<ClientMessage, { type: 'rdmRequest' }>,
  ws: WebSocket,
): Promise<void> {
  const fail = (action: RdmAction, error: string): void => {
    ws.send(JSON.stringify({ type: 'rdmResponse', uid: msg.uid, ok: false, action, error } satisfies ServerMessage));
  };
  if (!net) {
    fail(msg.action, 'мониторинг сети не активен (нет Art-Net-выходов в конфиге)');
    return;
  }
  try {
    if (msg.action === 'deviceInfo') {
      const resp = await net.rdmRequest(msg.uid, CC_GET_COMMAND, PID_DEVICE_INFO);
      const deviceInfo = parseDeviceInfoResponse(resp.paramData);
      if (!deviceInfo) throw new Error('не удалось разобрать ответ DEVICE_INFO');
      ws.send(JSON.stringify({ type: 'rdmResponse', uid: msg.uid, ok: true, action: 'deviceInfo', deviceInfo } satisfies ServerMessage));
    } else if (msg.action === 'labels') {
      const getLabel = (pid: number): Promise<string> =>
        net.rdmRequest(msg.uid, CC_GET_COMMAND, pid).then((r) => parseLabelResponse(r.paramData)).catch(() => '?');
      const [manufacturer, model, softwareVersion] = await Promise.all([
        getLabel(PID_MANUFACTURER_LABEL),
        getLabel(PID_DEVICE_MODEL_DESCRIPTION),
        getLabel(PID_SOFTWARE_VERSION_LABEL),
      ]);
      ws.send(
        JSON.stringify({ type: 'rdmResponse', uid: msg.uid, ok: true, action: 'labels', manufacturer, model, softwareVersion } satisfies ServerMessage),
      );
    } else if (msg.action === 'getIdentify' || msg.action === 'setIdentify') {
      let identify: boolean;
      if (msg.action === 'setIdentify') {
        await net.rdmRequest(msg.uid, CC_SET_COMMAND, PID_IDENTIFY_DEVICE, encodeIdentify(msg.on));
        identify = msg.on;
      } else {
        const resp = await net.rdmRequest(msg.uid, CC_GET_COMMAND, PID_IDENTIFY_DEVICE);
        identify = parseIdentifyResponse(resp.paramData);
      }
      ws.send(JSON.stringify({ type: 'rdmResponse', uid: msg.uid, ok: true, action: msg.action, identify } satisfies ServerMessage));
    } else if (msg.action === 'getAddress' || msg.action === 'setAddress') {
      let address: number;
      if (msg.action === 'setAddress') {
        await net.rdmRequest(msg.uid, CC_SET_COMMAND, PID_DMX_START_ADDRESS, encodeStartAddress(msg.address));
        address = msg.address;
      } else {
        const resp = await net.rdmRequest(msg.uid, CC_GET_COMMAND, PID_DMX_START_ADDRESS);
        address = parseStartAddressResponse(resp.paramData) ?? 0;
      }
      ws.send(JSON.stringify({ type: 'rdmResponse', uid: msg.uid, ok: true, action: msg.action, address } satisfies ServerMessage));
    }
  } catch (err) {
    fail(msg.action, err instanceof Error ? err.message : String(err));
  }
}
