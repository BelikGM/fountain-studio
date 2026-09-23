import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  applyAddressRemap,
  sanitizeProject,
  sanitizeRemoteSettings,
  type ClientMessage,
  type ConfigUniverse,
  type RdmAction,
  type RdmSensorReading,
  type ServerMessage,
  FRAME_MODES,
  frameModeToConfig,
  storedUniverseLabel,
  clampVolumeDb,
  clampToneDb,
} from '@fountain-studio/shared';
import type { AudioStore } from './audio';
import { sanitizeAutosave, saveAppConfigPatch } from './config';
import { isAutostartEnabled, isAutostartSupported, setAutostart, unsupportedReason } from './autostart';
import type { BackupStore } from './backups';
import type { MailNotifier } from './mailnotify';
import type { TelegramNotifier } from './telegram';
import type { DmxCapture } from './dmxcapture';
import { eventLog } from './eventlog';
import type { Engine } from './engine';
import { activateLicense, loadLicenseStatus } from './license';
import { refreshRevocationList } from './licenseRevocation';
import type { NetworkMonitor } from './netmonitor';
import type { RemoteControl } from './remotecontrol';
import type { AudioPlayer } from './audioplayer';
import type { ProjectStore } from './project';
import { linesUsable, peekProjectName, resolveProjectDir, type ProjectsApi } from './projects';
import { scanUsbDmx } from './usbscan';
import { createZip, readZip } from './zip';
import {
  CC_GET_COMMAND,
  CC_SET_COMMAND,
  PID_DEVICE_INFO,
  PID_SENSOR_DEFINITION,
  PID_SENSOR_VALUE,
  encodeSensorIndex,
  parseSensorDefinition,
  parseSensorValue,
  sensorScaled,
  sensorTypeName,
  sensorUnitName,
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

/**
 * Что кладём в резервную копию настроек ПРОГРАММЫ (папка данных приложения).
 * Рабочие данные объектов сюда не входят — у них свой перенос одним файлом.
 * Кэш отзыва лицензий (revoked-cache.json) не берём: он наживной, движок
 * обновит его сам, когда будет сеть.
 */
const APP_BACKUP_FILES: [file: string, what: string][] = [
  ['fountain.license.json', 'лицензия'],
  ['fountain.secrets.json', 'токен Telegram-бота'],
  ['app-config.json', 'настройки движка'],
  ['app-settings.json', 'недавние проекты'],
];

/** WebSocket API движка: команды от редактора, поток статистики, кадров и состояния. */
export function startServer(
  engine: Engine,
  store: ProjectStore,
  audio: AudioStore,
  backups?: BackupStore,
  net?: NetworkMonitor,
  capture?: DmxCapture,
  remote?: RemoteControl,
  telegram?: TelegramNotifier,
  projects?: ProjectsApi,
  player?: AudioPlayer,
  mail?: MailNotifier,
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
  /**
   * Состояние проектов для редактора. «Потерянные» папки не прячем: человек
   * должен видеть, что объект был, и сам решить — найти его или убрать из
   * списка.
   */
  const projectsMessage = (): Extract<ServerMessage, { type: 'projects' }> => ({
    type: 'projects',
    state: {
      current: projects?.current() ?? null,
      recent: (projects?.recent() ?? []).map((r) => ({ ...r, missing: !fs.existsSync(r.dir) })),
      projectsRoot: projects?.projectsRoot ?? '',
    },
  });
  /** После смены объекта редактор должен увидеть ВСЁ новое, а не половину. */
  const broadcastProjectSwitched = (): void => {
    broadcast({ type: 'hello', version: ENGINE_VERSION, tickMs: engine.config.timing.tickMs, universes: engine.universeInfos() });
    broadcast(configMessage());
    bumpRev();
    broadcast(projectMessage());
    broadcast(backupConfigMessage());
    broadcast(backupListMessage());
    broadcast({ type: 'logHistory', events: eventLog.list() });
    broadcastPlayback();
    broadcast(projectsMessage());
    if (telegram) broadcast({ type: 'telegram', state: telegram.status() });
    broadcastNetwork();
  };
  // Уведомления сами узнают, что у бота включили темы или нашёлся получатель, —
  // сразу показываем это в Настройках.
  if (telegram) telegram.onStatusChange = () => broadcast({ type: 'telegram', state: telegram.status() });
  if (mail) mail.onStatusChange = () => broadcast({ type: 'mail', state: mail.status() });
  const configMessage = (): Extract<ServerMessage, { type: 'config' }> => ({
    type: 'config',
    tickMs: engine.config.timing.tickMs,
    universes: engine.config.universes as ConfigUniverse[],
    frameMode: engine.frameModeChosen(),
    frameModeActive: engine.frameModeActive(),
    audioVolumeDb: engine.config.audio.volumeDb,
    audioMuted: engine.config.audio.muted,
    audioBassDb: engine.config.audio.bassDb,
    audioTrebleDb: engine.config.audio.trebleDb,
    audioReady: player?.ready() ?? false,
    benchMode: engine.benchModeOn(),
    autosaveEnabled: engine.config.autosave?.enabled !== false,
    autosaveMin: engine.config.autosave?.minutes ?? 5,
  });
  const dirtyMessage = (): Extract<ServerMessage, { type: 'projectDirty' }> => ({
    type: 'projectDirty',
    dirty: store.isDirty,
    savedAtMs: store.savedAtMs,
  });
  store.onDirtyChange = () => broadcast(dirtyMessage());
  const broadcastNetwork = (): void => {
    if (net) broadcast({ type: 'network', state: net.state() });
  };
  if (net) net.onChange = broadcastNetwork;
  const broadcastModbus = (): void => broadcast({ type: 'modbus', state: engine.modbusState() });
  // Аварийное отключение: показываем сразу, не дожидаясь следующего опроса.
  engine.onFailsafeChange = (state) => broadcast({ type: 'failsafe', state });
  engine.pumps.onChange = broadcastModbus;
  const remoteStatus = (): Extract<ServerMessage, { type: 'remoteStatus' }> =>
    remote?.status() ?? {
      type: 'remoteStatus',
      settings: sanitizeRemoteSettings(undefined),
      mqttHasPassword: false,
      osc: { enabled: false, listening: false, error: null },
      mqtt: { enabled: false, connected: false, error: null },
    };
  const broadcastRemoteStatus = (): void => broadcast(remoteStatus());
  // Ветер: показание датчика, вход и выход коррекции — сразу в редактор.
  engine.onWindChange = () => broadcast({ type: 'windState', ...engine.windState() } satisfies ServerMessage);
  if (remote) remote.onChange = broadcastRemoteStatus;
  const backupConfigMessage = (): Extract<ServerMessage, { type: 'backupConfig' }> => ({
    type: 'backupConfig',
    ...(backups?.config() ?? { enabled: false, intervalMin: 10 }),
  });
  const backupListMessage = (): Extract<ServerMessage, { type: 'backupList' }> => ({
    type: 'backupList',
    backups: backups?.list() ?? [],
  });
  /**
   * Лицензия привязана к КОМПЬЮТЕРУ, а не к объекту, поэтому лежит в данных
   * программы: иначе при каждом новом проекте её пришлось бы активировать
   * заново, а отдавая папку объекта коллеге, человек отдавал бы и лицензию.
   */
  const licenseDir = projects?.appDataDir ?? path.dirname(store.file);
  const licenseMessage = (): Extract<ServerMessage, { type: 'license' }> => ({
    type: 'license',
    status: loadLicenseStatus(licenseDir),
  });
  /*
   * Отзыв лицензии (см. licenseRevocation.ts): если издатель указал
   * revocationUrl, раз в час подтягиваем список отозванных и, если статус
   * поменялся, сразу говорим об этом уже подключённым редакторам — не нужно
   * ждать переподключения. Без revocationUrl блок ничего не делает.
   */
  const revocationUrl = engine.config.license?.revocationUrl;
  if (revocationUrl) {
    const checkRevocation = (): void => {
      void refreshRevocationList(licenseDir, revocationUrl).then((r) => {
        if (!r.ok) {
          console.log(`[лицензия] список отозванных не обновлён (нет сети?): ${r.error}`);
          return;
        }
        broadcast(licenseMessage());
      });
    };
    checkRevocation();
    setInterval(checkRevocation, 60 * 60 * 1000);
  }
  // Журнал событий (§27 доработки, §3 п.1): новое событие — сразу всем
  // подключённым клиентам (не только тому, кто его вызвал).
  eventLog.subscribe((event) => broadcast({ type: 'logEvent', event }));
  const autostartMessage = (error?: string): Extract<ServerMessage, { type: 'autostartState' }> => {
    const supported = isAutostartSupported();
    const reason = error ?? (supported ? undefined : (unsupportedReason() ?? undefined));
    return {
      type: 'autostartState',
      supported,
      enabled: supported && isAutostartEnabled(),
      ...(reason ? { error: reason } : {}),
    };
  };

  /**
   * Двое правят объект с разных машин — обычное дело: наладчик на объекте и
   * второй за столом. Раньше правки последнего затирали чужие МОЛЧА: каждый
   * редактор шлёт объект целиком. Теперь у объекта есть версия, редактор шлёт
   * ту, на которой правил, и правку «поверх чужой» движок не принимает.
   */
  /** Номера редакторов: «р1», «р2» — их видно в журнале и в предупреждении. */
  let editorSeq = 0;
  let projectRev = 1;
  let lastEditorId = '';
  const editors = new Map<WebSocket, { id: string; ip: string; sinceMs: number }>();
  const editorsMessage = (): ServerMessage => ({
    type: 'editors',
    list: [...editors.values()],
  });
  const projectMessage = (project = store.project, by?: string): ServerMessage => ({
    type: 'project',
    project,
    rev: projectRev,
    by,
  });
  /** Объект поменялся не через updateProject (импорт, восстановление, смена объекта). */
  const bumpRev = (): void => {
    projectRev++;
    lastEditorId = '';
  };

  wss.on('connection', (ws) => {
    const clientId = `р${++editorSeq}`;
    const ip = String((ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? '')
      .replace('::ffff:', '')
      .replace('::1', '127.0.0.1');
    editors.set(ws, { id: clientId, ip, sinceMs: Date.now() });
    ws.send(JSON.stringify({ type: 'clientId', id: clientId } satisfies ServerMessage));
    if (editors.size === 2) {
      eventLog.log(
        'server',
        `проект открыт сразу в двух редакторах (${[...editors.values()].map((e) => e.ip).join(' и ')}) — правки могут спорить`,
        'warn',
      );
    }
    broadcast(editorsMessage());
    ws.on('close', () => {
      editors.delete(ws);
      broadcast(editorsMessage());
    });
    const hello: ServerMessage = {
      type: 'hello',
      version: ENGINE_VERSION,
      tickMs: engine.config.timing.tickMs,
      universes: engine.universeInfos(),
    };
    ws.send(JSON.stringify(hello));
    ws.send(JSON.stringify(configMessage()));
    ws.send(JSON.stringify(projectMessage()));
    ws.send(JSON.stringify({ type: 'playback', state: engine.playbackState() } satisfies ServerMessage));
    if (net) ws.send(JSON.stringify({ type: 'network', state: net.state() } satisfies ServerMessage));
    if (telegram) ws.send(JSON.stringify({ type: 'telegram', state: telegram.status() } satisfies ServerMessage));
    if (mail) ws.send(JSON.stringify({ type: 'mail', state: mail.status() } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'modbus', state: engine.modbusState() } satisfies ServerMessage));
    ws.send(JSON.stringify({ type: 'failsafe', state: engine.failsafeState() } satisfies ServerMessage));
    ws.send(JSON.stringify(projectsMessage()));
    ws.send(JSON.stringify(backupConfigMessage()));
    ws.send(JSON.stringify(backupListMessage()));
    ws.send(JSON.stringify({ type: 'logHistory', events: eventLog.list() } satisfies ServerMessage));
    ws.send(JSON.stringify(autostartMessage()));
    ws.send(JSON.stringify({ type: 'windState', ...engine.windState() } satisfies ServerMessage));
    ws.send(JSON.stringify(remoteStatus()));
    ws.send(JSON.stringify(licenseMessage()));
    ws.send(JSON.stringify(dirtyMessage()));

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
          engine.setTestPattern(msg.mode, msg.scope ?? 'all', msg.speedSec);
          break;
        case 'updateProject': {
          /*
           * Правка «поверх чужой»: редактор основывался на версии, которую с
           * тех пор поменял ДРУГОЙ редактор. Не принимаем и возвращаем ему
           * текущий объект — пусть увидит чужую работу, а не затрёт её.
           * Свои же подряд идущие правки (отклик ещё не дошёл) принимаем: для
           * них lastEditorId — мы сами.
           */
          const stale = msg.rev !== undefined && msg.rev !== projectRev && lastEditorId !== clientId;
          if (stale) {
            const other = [...editors.values()].find((e) => e.id === lastEditorId);
            ws.send(
              JSON.stringify({
                type: 'projectRejected',
                message: `Правка не принята: проект уже изменён в другом редакторе${other ? ` (${other.ip})` : ''}. На экране — то, что в движке сейчас; повторите правку.`,
              } satisfies ServerMessage),
            );
            ws.send(JSON.stringify(projectMessage()));
            break;
          }
          const project = sanitizeProject(msg.project);
          store.update(project);
          engine.setProject(project);
          projectRev++;
          lastEditorId = clientId;
          // Эхо всем клиентам: свой отклик отправитель узнает по полю by.
          broadcast(projectMessage(project, clientId));
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
        case 'startSequenceGroup':
          engine.startSequenceGroup(msg.groupId);
          broadcastPlayback();
          break;
        case 'pauseSequenceGroup':
          engine.pauseSequenceGroup(msg.groupId);
          broadcastPlayback();
          break;
        case 'resumeSequenceGroup':
          engine.resumeSequenceGroup(msg.groupId);
          broadcastPlayback();
          break;
        case 'stopSequenceGroup':
          engine.stopSequenceGroup(msg.groupId);
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
        /*
         * У открытого объекта могут быть правки, ещё не долетевшие до диска
         * (окно короткое — до 500 мс, — но человек может кликнуть «Открыть
         * другой» именно в этот момент). Без force в такой момент не
         * переключаем, а спрашиваем: молча сохранить и молча потерять — оба
         * решения без спроса могут оказаться не тем, что нужно человеку.
         */
        case 'openProject':
        case 'createProject':
        case 'copyProject':
        case 'closeProject': {
          if (store.isDirty && !msg.force) {
            const targetName =
              msg.type === 'openProject'
                ? peekProjectName(resolveProjectDir(msg.dir))
                : msg.type === 'createProject' || msg.type === 'copyProject'
                  ? msg.name
                  : undefined; // closeProject — цели нет, просто «закрыть»
            ws.send(
              JSON.stringify({
                type: 'projectResult',
                ok: false,
                unsavedChanges: true,
                message: `В проекте «${projects?.current()?.name ?? ''}» есть несохранённые изменения`,
                ...(targetName ? { targetName } : {}),
              } satisfies ServerMessage),
            );
            break;
          }
          if (msg.discard) store.discard();

          if (msg.type === 'openProject') {
            const r = projects?.open(msg.dir) ?? { ok: false, error: 'управление проектами недоступно' };
            ws.send(
              JSON.stringify({
                type: 'projectResult',
                ok: r.ok,
                message: r.ok ? 'Проект открыт' : (r.error ?? 'Не удалось открыть проект'),
              } satisfies ServerMessage),
            );
            if (r.ok) broadcastProjectSwitched();
          } else if (msg.type === 'createProject') {
            const r = projects?.create(msg.name, msg.parentDir) ?? { ok: false, error: 'управление проектами недоступно' };
            ws.send(
              JSON.stringify({
                type: 'projectResult',
                ok: r.ok,
                message: r.ok ? `Создан проект «${msg.name}»` : (r.error ?? 'Не удалось создать проект'),
              } satisfies ServerMessage),
            );
            if (r.ok) broadcastProjectSwitched();
          } else if (msg.type === 'copyProject') {
            const r = projects?.copy(msg.name, msg.parentDir) ?? { ok: false, error: 'управление проектами недоступно' };
            ws.send(
              JSON.stringify({
                type: 'projectResult',
                ok: r.ok,
                message: r.ok ? `Сделана копия «${msg.name}», она и открыта` : (r.error ?? 'Не удалось скопировать проект'),
              } satisfies ServerMessage),
            );
            if (r.ok) broadcastProjectSwitched();
          } else {
            projects?.close();
            ws.send(JSON.stringify({ type: 'projectResult', ok: true, message: 'Проект закрыт' } satisfies ServerMessage));
            broadcastProjectSwitched();
          }
          break;
        }
        case 'forgetProject':
          projects?.forget(msg.dir);
          broadcast(projectsMessage());
          break;
        case 'scanUsbDmx':
          void scanUsbDmx().then((scan) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'usbDmxScan', scan } satisfies ServerMessage));
          });
          break;
        case 'activateLicense': {
          // Рассылаем именно результат этой попытки, а не перечитанный с диска
          // статус: при неудачной активации файл лицензии не пишется, и
          // loadLicenseStatus() тогда вернул бы общее «не активирована»,
          // потеряв конкретную причину отказа (чужая подпись/машина/истёк срок).
          const status = activateLicense(licenseDir, msg.fileText);
          broadcast({ type: 'license', status });
          break;
        }
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
        case 'setAudioVolume': {
          if (!Number.isFinite(Number(msg.volumeDb))) {
            console.error('[server] setAudioVolume отклонён: громкость не число', msg.volumeDb);
            break;
          }
          engine.config.audio = {
            ...engine.config.audio,
            volumeDb: clampVolumeDb(msg.volumeDb),
            muted: msg.muted === true,
            bassDb: clampToneDb(msg.bassDb),
            trebleDb: clampToneDb(msg.trebleDb),
          };
          player?.setConfig(engine.config.audio);
          // Настройка ПРОГРАММЫ: про усилитель на объекте, а не про шоу.
          saveAppConfigPatch(engine.config.configFile ?? '', { audio: engine.config.audio });
          broadcast(configMessage());
          break;
        }
        case 'setRemoteSettings': {
          if (!remote) break;
          const next = sanitizeRemoteSettings(msg.settings);
          const password = typeof msg.mqttPassword === 'string' ? msg.mqttPassword : undefined;
          void remote.apply(next, password).then(() => {
            const secret = remote.mqttSecret;
            // Настройка ПРОГРАММЫ: порт и брокер — про сеть этого компьютера,
            // а не про объект. Пароль и id клиента пишем рядом, но наружу не отдаём.
            engine.config.osc = next.osc;
            engine.config.mqtt = {
              ...next.mqtt,
              ...(secret.password ? { password: secret.password } : {}),
              ...(secret.clientId ? { clientId: secret.clientId } : {}),
            };
            saveAppConfigPatch(engine.config.configFile ?? '', { osc: engine.config.osc, mqtt: engine.config.mqtt });
            broadcastRemoteStatus();
          });
          break;
        }
        case 'setFrameMode': {
          if (!FRAME_MODES.some((m) => m.id === msg.mode)) {
            console.error('[server] setFrameMode отклонён: неизвестный режим', msg.mode);
            break;
          }
          engine.setFrameMode(msg.mode);
          // Это настройка ПРОГРАММЫ, не объекта: она про машину, на которой всё
          // крутится, и при переключении объектов меняться не должна.
          saveAppConfigPatch(engine.config.configFile ?? '', frameModeToConfig(msg.mode));
          broadcast(configMessage());
          broadcastPlayback();
          break;
        }
        case 'setAutosave': {
          // Настройка программы — пишем сразу, как и режим наладки.
          const next = sanitizeAutosave({ enabled: msg.enabled, minutes: msg.minutes });
          engine.config.autosave = next;
          store.setAutosave(next.enabled, next.minutes);
          saveAppConfigPatch(engine.config.configFile ?? '', { autosave: next });
          eventLog.log(
            'server',
            next.enabled ? `автосохранение проекта: раз в ${next.minutes} мин` : 'автосохранение проекта выключено — правки сохраняются по Ctrl+S',
          );
          broadcast(configMessage());
          break;
        }
        case 'setBenchMode': {
          // Настройка ПРОГРАММЫ: пишем в app-config.json сразу, чтобы режим
          // наладки переживал и перезагрузку страницы, и перезапуск программы.
          // В объект не лезем — он уезжает на фонтан, где гашение нужно.
          engine.setBenchMode(msg.on === true);
          saveAppConfigPatch(engine.config.configFile ?? '', { benchMode: engine.benchModeOn() });
          broadcast(configMessage());
          break;
        }
        case 'updateConfig': {
          // Валидация: непустой список, уникальные id, у каждой линии есть
          // выходы, разумный тик. Проверяем придирчиво не из педантизма: на
          // кривом списке движок падал на `u.outputs.map(...)`, а упавший
          // движок — это остановленное шоу на объекте.
          const tickMs = Math.round(msg.tickMs);
          const reply = (ok: boolean, message: string, changes: string[] = []): void =>
            ws.send(JSON.stringify({ type: 'configResult', ok, message, changes } satisfies ServerMessage));
          if (!linesUsable(msg.universes)) {
            reply(false, 'Не применено: нужна хотя бы одна вселенная, и номера вселенных не должны повторяться.');
            break;
          }
          if (!Number.isFinite(tickMs) || tickMs < 10 || tickMs > 1000) {
            reply(false, 'Не применено: такт должен быть от 10 до 1000 мс.');
            break;
          }
          // Имя, которое программа дала сама («Линия 2» у второй), не храним:
          // название на экране строится из номера (см. universes.ts).
          const lines = msg.universes.map((u) => ({ ...u, label: storedUniverseLabel(u) }));
          let changes: string[];
          try {
            changes = engine.applyConfig(lines, tickMs);
          } catch (err) {
            // Движок ничего не поменял: выходы новой конфигурации открываются
            // до любых изменений (см. Engine.applyConfig).
            reply(false, `Не применено: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
          // Калибровка и Modbus-насосы индексируются по вселенным — переиндексировать.
          engine.setProject(store.project);
          persistConfig(projects, tickMs, lines);
          reply(true, changes.length > 0 ? 'Применено и сохранено, воспроизведение продолжается.' : 'Изменений нет.', changes);
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
        case 'exportProject': {
          // Весь проект одним файлом: перенос между ПК и передача заказчику.
          //
          // Вместе с проектом кладём и НАСТРОЙКИ ЛИНИЙ DMX (вселенные,
          // протокол, номера выходов, шаг тика). Без них перенесённый на
          // другой компьютер объект оставался немым: схема и адреса
          // приезжали, а куда их слать — нет, и это приходилось
          // восстанавливать руками по памяти.
          const entries = [
            { name: 'project.json', data: Buffer.from(JSON.stringify(store.project, null, 2), 'utf8') },
            {
              name: 'config.json',
              data: Buffer.from(
                JSON.stringify(
                  { tickMs: engine.config.timing.tickMs, universes: engine.config.universes },
                  null,
                  2,
                ),
                'utf8',
              ),
            },
          ];
          if (fs.existsSync(audio.dir)) {
            for (const file of fs.readdirSync(audio.dir)) {
              const full = `${audio.dir}/${file}`;
              if (fs.statSync(full).isFile()) entries.push({ name: `audio/${file}`, data: fs.readFileSync(full) });
            }
          }
          const zipBuf = createZip(entries);
          const safeName = store.project.name.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'fountain-project';
          ws.send(
            JSON.stringify({
              type: 'projectExport',
              filename: `${safeName}.fsproj.zip`,
              dataBase64: zipBuf.toString('base64'),
            } satisfies ServerMessage),
          );
          break;
        }
        case 'exportAppSettings': {
          // Копия объекта НЕ содержит лицензию, токен бота и настройки
          // программы: они лежат в папке данных приложения. Умер диск — объект
          // восстановится из копии, а лицензию и бота пришлось бы заводить
          // заново. Здесь — «всё о программе» одним файлом.
          const dir = projects?.appDataDir ?? '';
          const entries: { name: string; data: Buffer }[] = [];
          const took: string[] = [];
          for (const [file, what] of APP_BACKUP_FILES) {
            const full = path.join(dir, file);
            if (!dir || !fs.existsSync(full)) continue;
            entries.push({ name: file, data: fs.readFileSync(full) });
            took.push(what);
          }
          entries.push({
            name: 'ЧТО-ЭТО.txt',
            data: Buffer.from(
              [
                'Резервная копия настроек программы Fountain Studio.',
                '',
                'Внутри: ' + (took.join(', ') || 'ничего не нашлось'),
                '',
                'Как восстановить: «Настройки» → «Резервная копия настроек программы»',
                '→ «Восстановить из файла…», затем перезапустить программу.',
                '',
                'ВАЖНО: в этом файле лежат токен Telegram-бота и лицензия — храните',
                'его как пароль и не выкладывайте никуда. Лицензия привязана к',
                'компьютеру: на другом ПК её придётся выпустить заново.',
                '',
                'Проекты (приборы, сцены, шоу, расписание, музыка) сюда НЕ входят —',
                'для них «Перенос проекта одним файлом» на той же вкладке.',
              ].join('\r\n'),
              'utf8',
            ),
          });
          const stamp = new Date().toISOString().slice(0, 10);
          ws.send(
            JSON.stringify({
              type: 'appSettingsExport',
              filename: `fountain-настройки-${stamp}.zip`,
              dataBase64: createZip(entries).toString('base64'),
            } satisfies ServerMessage),
          );
          break;
        }
        case 'importAppSettings': {
          const dir = projects?.appDataDir ?? '';
          let ok = false;
          let message = '';
          try {
            if (!dir) throw new Error('движок не знает, где папка настроек');
            const entries = readZip(Buffer.from(msg.dataBase64, 'base64'));
            const known = new Set(APP_BACKUP_FILES.map(([f]) => f));
            const restored: string[] = [];
            for (const e of entries) {
              if (!known.has(e.name)) continue;
              // Проверяем, что это JSON, ДО записи: битый app-config.json
              // движок при следующем запуске не прочитает вовсе.
              JSON.parse(e.data.toString('utf8'));
              fs.writeFileSync(path.join(dir, e.name), e.data);
              restored.push(APP_BACKUP_FILES.find(([f]) => f === e.name)?.[1] ?? e.name);
            }
            if (restored.length === 0) throw new Error('в файле нет настроек программы — это копия проекта или чужой архив');
            ok = true;
            message = `Восстановлено: ${restored.join(', ')}. Перезапустите программу, чтобы настройки вступили в силу.`;
          } catch (err) {
            message = err instanceof Error ? err.message : String(err);
          }
          ws.send(JSON.stringify({ type: 'appSettingsImportResult', ok, message } satisfies ServerMessage));
          break;
        }
        case 'importProject': {
          try {
            const entries = readZip(Buffer.from(msg.dataBase64, 'base64'));
            const projectEntry = entries.find((e) => e.name === 'project.json');
            if (!projectEntry) throw new Error('в архиве нет project.json — это не файл проекта Fountain Studio');
            const project = sanitizeProject(JSON.parse(projectEntry.data.toString('utf8')));
            for (const e of entries) {
              if (!e.name.startsWith('audio/')) continue;
              const name = e.name.slice('audio/'.length);
              if (name) audio.save(name, e.data.toString('base64'));
            }
            /**
             * Настройки линий DMX из архива применяем ДО проекта: калибровка и
             * Modbus-насосы индексируются по вселенным, и setProject должен
             * увидеть уже новый их состав. Архивы старых версий без config.json
             * импортируются как раньше — линии остаются текущие.
             */
            const configEntry = entries.find((e) => e.name === 'config.json');
            let linesApplied = 0;
            if (configEntry) {
              const raw = JSON.parse(configEntry.data.toString('utf8')) as {
                tickMs?: number;
                universes?: ConfigUniverse[];
              };
              const tickMs = Math.round(Number(raw.tickMs));
              const universes = Array.isArray(raw.universes) ? raw.universes : [];
              // Архив мог прийти откуда угодно — линии применяем только целые.
              const ok = linesUsable(universes) && Number.isFinite(tickMs) && tickMs >= 10 && tickMs <= 1000;
              if (ok) {
                // Импорт заменяет объект целиком: играть старое шоу на новых
                // вселенных нельзя. Раньше это делал сам applyConfig, теперь он
                // воспроизведение сохраняет — поэтому останавливаем явно.
                engine.stopAllPlayback();
                engine.applyConfig(
                  universes.map((u) => ({ ...u, label: storedUniverseLabel(u) })),
                  tickMs,
                );
                persistConfig(projects, tickMs, universes);
                linesApplied = universes.length;
              }
            }
            store.update(project);
            engine.setProject(project);
            bumpRev();
            broadcast(projectMessage(project));
            if (linesApplied > 0) {
              broadcast({
                type: 'hello',
                version: ENGINE_VERSION,
                tickMs: engine.config.timing.tickMs,
                universes: engine.universeInfos(),
              });
              broadcast(configMessage());
            }
            broadcastPlayback();
            ws.send(
              JSON.stringify({
                type: 'importResult',
                ok: true,
                message: `Загружен проект «${project.name}»`
                  + (linesApplied > 0 ? `, вселенных DMX: ${linesApplied}` : ''),
              } satisfies ServerMessage),
            );
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: 'importResult',
                ok: false,
                message: err instanceof Error ? err.message : String(err),
              } satisfies ServerMessage),
            );
          }
          break;
        }
        case 'updateBackupConfig': {
          if (!backups) break;
          backups.setConfig(msg.enabled, msg.intervalMin);
          const cfg = backups.config();
          persistBackupConfig(projects, cfg.enabled, cfg.intervalMin);
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
          // Кнопкой снимок делается всегда, даже если ничего не менялось:
          // человек нажал осознанно, значит хочет зафиксировать именно это.
          backups.snapshot(true);
          broadcast(backupListMessage());
          break;
        case 'setReferenceBackup':
          if (!backups) break;
          backups.setReference();
          eventLog.log('server', 'эталонная резервная копия проекта обновлена');
          broadcast(backupListMessage());
          break;
        case 'updateTelegram': {
          if (!telegram) break;
          const patch: Parameters<TelegramNotifier['setConfig']>[0] = {};
          if (typeof msg.token === 'string') patch.token = msg.token.trim();
          if (typeof msg.chatId === 'string') patch.chatId = msg.chatId.trim();
          if (typeof msg.enabled === 'boolean') patch.enabled = msg.enabled;
          if (typeof msg.dailyHour === 'number') patch.dailyHour = Math.max(0, Math.min(23, Math.round(msg.dailyHour)));
          if (typeof msg.alarms === 'boolean') patch.alarms = msg.alarms;
          if (typeof msg.commands === 'boolean') patch.commands = msg.commands;
          const topic = (v: unknown): number | undefined =>
            typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined;
          const ta = topic(msg.topicAlarm);
          const tr = topic(msg.topicReport);
          const ts = topic(msg.topicState);
          if (ta !== undefined) patch.topicAlarm = ta;
          if (tr !== undefined) patch.topicReport = tr;
          if (ts !== undefined) patch.topicState = ts;
          if (typeof msg.topicsBySite === 'boolean') patch.topicsBySite = msg.topicsBySite;
          // Дополнительные получатели приходят списком целиком: правки по
          // одному потребовали бы согласовывать порядок между редакторами.
          if (Array.isArray(msg.recipients)) {
            patch.recipients = msg.recipients
              .filter((r) => typeof r?.chatId === 'string' && r.chatId.trim() !== '')
              .slice(0, 20)
              .map((r) => ({
                chatId: r.chatId.trim(),
                name: String(r.name ?? '').slice(0, 60),
                alarms: r.alarms !== false,
                reports: r.reports !== false,
                state: r.state === true,
              }));
          }
          telegram.setConfig(patch);
          // В журнал уходит только ФАКТ настройки: токен туда попасть не должен.
          eventLog.log('server', 'настройки уведомлений в Telegram обновлены');
          broadcast({ type: 'telegram', state: telegram.status() });
          break;
        }
        case 'setTelegramQuiet':
          telegram?.setQuiet(msg.hours);
          if (telegram) broadcast({ type: 'telegram', state: telegram.status() });
          break;
        case 'updateMail': {
          if (!mail) break;
          const patch: Record<string, unknown> = {};
          for (const k of ['enabled', 'alarms', 'reports', 'state'] as const) {
            if (typeof msg[k] === 'boolean') patch[k] = msg[k];
          }
          for (const k of ['host', 'user', 'from', 'to'] as const) {
            if (typeof msg[k] === 'string') patch[k] = msg[k].trim();
          }
          if (typeof msg.port === 'number' && msg.port > 0 && msg.port < 65536) patch.port = Math.round(msg.port);
          if (msg.security === 'none' || msg.security === 'starttls' || msg.security === 'tls') patch.security = msg.security;
          // Пароль приходит только при смене: пустая строка НЕ стирает старый —
          // иначе любое сохранение других полей обнуляло бы его.
          if (typeof msg.password === 'string' && msg.password !== '') patch.password = msg.password;
          mail.setConfig(patch);
          // В журнал — только факт настройки: пароль туда попасть не должен.
          eventLog.log('server', 'настройки уведомлений на почту обновлены');
          broadcast({ type: 'mail', state: mail.status() });
          break;
        }
        case 'testMail': {
          if (!mail) break;
          void mail.testNow(store.project.name).then((r) => {
            ws.send(JSON.stringify({ type: 'mailTest', ...r } satisfies ServerMessage));
            broadcast({ type: 'mail', state: mail.status() });
          });
          break;
        }
        case 'testTelegram': {
          if (!telegram) break;
          void telegram.testNow().then((r) => {
            ws.send(JSON.stringify({ type: 'telegramTest', ...r } satisfies ServerMessage));
            broadcast({ type: 'telegram', state: telegram.status() });
          });
          break;
        }
        case 'restoreBackup': {
          if (!backups) break;
          try {
            const project = sanitizeProject(backups.read(msg.file));
            store.update(project);
            engine.setProject(project);
            bumpRev();
            broadcast(projectMessage(project));
            broadcastPlayback();
            eventLog.log('server', `проект восстановлен из резервной копии ${msg.file}`);
          } catch (err) {
            eventLog.log('server', `не удалось восстановить резервную копию: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
          break;
        }
        // Источники на стороне редактора (клавиатурные привязки — движок сам
        // их не видит) сообщают о срабатывании явно, чтобы попасть в общий
        // журнал (§27 доработки, §3 п.1).
        case 'clientEvent':
          eventLog.log(msg.source, msg.message);
          break;
        case 'getAutostart':
          ws.send(JSON.stringify(autostartMessage()));
          break;
        case 'setAutostart': {
          const result = setAutostart(msg.enabled);
          eventLog.log(
            'server',
            result.ok
              ? `автозапуск при входе в Windows: ${msg.enabled ? 'включён' : 'выключен'}`
              : `не удалось изменить автозапуск: ${result.error}`,
            result.ok ? 'info' : 'error',
          );
          broadcast(autostartMessage(result.ok ? undefined : result.error));
          break;
        }
        case 'setWindSpeed':
          // Принимается только при ручном вводе: при датчике поле с руки не
          // перебивает прибор. Состояние шлём в любом случае — чтобы поле
          // вернулось к тому, что на самом деле.
          engine.setManualWind(msg.speedMs);
          broadcast({ type: 'windState', ...engine.windState() } satisfies ServerMessage);
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
      // Переадресованный кадр шлём только когда он отличается: иначе это
      // ровно те же 512 байт второй раз, двадцать раз в секунду.
      const remap = engine.addressRemapFor(u.id);
      const wire = remap ? applyAddressRemap(u.out, remap) : undefined;
      broadcast({
        type: 'frame',
        universe: u.id,
        data: Buffer.from(u.out).toString('base64'),
        ...(wire ? { wire: Buffer.from(wire).toString('base64') } : {}),
      });
    }
  }, engine.config.timing.uiFrameMs);

  // Автопереходы шагов секвенсоров: рассылаем состояние, когда оно поменялось само.
  // «Выключено» и гашение по расписанию версию воспроизведения не меняют —
  // следим за ними отдельно, иначе строка состояния молчала бы о выключении.
  let lastVersion = engine.playback.version;
  let lastDark = engine.darkMode;
  setInterval(() => {
    if (wss.clients.size === 0) return;
    if (engine.playback.version !== lastVersion || engine.darkMode !== lastDark) {
      lastVersion = engine.playback.version;
      lastDark = engine.darkMode;
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
/**
 * Линии DMX и бэкапы — свойства ОБЪЕКТА, поэтому пишутся в lines.json его
 * папки, а не в настройки программы: перенесли папку на другой компьютер —
 * приехали и линии (см. projects.ts).
 */
function persistConfig(projects: ProjectsApi | undefined, tickMs: number, universes: ConfigUniverse[]): void {
  if (!projects?.current()) {
    console.error('[server] проект не открыт — вселенные применены, но сохранять их некуда');
    return;
  }
  projects.saveLines(tickMs, universes);
}

function persistBackupConfig(projects: ProjectsApi | undefined, enabled: boolean, intervalMin: number): void {
  projects?.saveBackupConfig(enabled, intervalMin);
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
    } else if (msg.action === 'sensors') {
      /**
       * Опрос датчиков — УНИВЕРСАЛЬНЫЙ, без списка «поддерживаемых марок».
       *
       * Сколько датчиков у прибора, он сообщает сам в DEVICE_INFO; дальше на
       * каждый номер спрашиваем описание и показание стандартными PID из
       * ANSI E1.20. Прибор, который такой датчик не заводил, отвечает отказом —
       * его пропускаем и идём дальше. Поэтому чужая или незнакомая марка ничего
       * не ломает: либо отвечает по стандарту, либо отказывается, и оба случая
       * разобраны. Никаких фирменных PID здесь нет намеренно — именно они у
       * всех разные и именно на них ломаются опросы «под конкретный бренд».
       */
      const info = await net.rdmRequest(msg.uid, CC_GET_COMMAND, PID_DEVICE_INFO);
      const parsed = parseDeviceInfoResponse(info.paramData);
      const count = parsed?.sensorCount ?? 0;
      const sensors: RdmSensorReading[] = [];
      for (let i = 0; i < count; i++) {
        try {
          const [defResp, valResp] = await Promise.all([
            net.rdmRequest(msg.uid, CC_GET_COMMAND, PID_SENSOR_DEFINITION, encodeSensorIndex(i)),
            net.rdmRequest(msg.uid, CC_GET_COMMAND, PID_SENSOR_VALUE, encodeSensorIndex(i)),
          ]);
          const def = parseSensorDefinition(defResp.paramData);
          const val = parseSensorValue(valResp.paramData);
          if (!val) continue;
          sensors.push({
            index: i,
            typeName: def ? sensorTypeName(def.type) : 'Датчик',
            description: def?.description ?? '',
            unit: def ? sensorUnitName(def.unit) : '',
            value: sensorScaled(def ?? undefined, val.value),
            lowest: sensorScaled(def ?? undefined, val.lowest),
            highest: sensorScaled(def ?? undefined, val.highest),
          });
        } catch {
          // Датчик под этим номером не поддержан — не повод рушить весь опрос.
        }
      }
      ws.send(
        JSON.stringify({ type: 'rdmResponse', uid: msg.uid, ok: true, action: 'sensors', sensors } satisfies ServerMessage),
      );
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
