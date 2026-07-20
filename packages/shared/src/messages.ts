/**
 * Протокол сообщений между Редактором (UI) и Движком по WebSocket.
 * Все сообщения — JSON. Кадры DMX передаются в base64.
 */

import type { Project } from './project';
import type { WindLimitConfig } from './windlimit';

export type TestPatternMode = 'off' | 'sine' | 'chase' | 'ramp';

export interface UniverseInfo {
  /** Логический номер вселенной в проекте (1..N). */
  id: number;
  label: string;
  /** Человекочитаемое описание выходов (для отображения в UI). */
  outputs: string[];
}

/** Статистика движка: качество тайминга и счётчики. */
export interface EngineStats {
  ticks: number;
  intervalMs: number;
  /** Опоздание последнего тика относительно расчётного момента, мс. */
  lastJitterMs: number;
  avgJitterMs: number;
  maxJitterMs: number;
  /** Всего отправлено кадров вселенных во все выходы. */
  framesSent: number;
  pattern: TestPatternMode;
}

/** Состояние запущенного секвенсора для отображения в UI. */
export interface RunningSequenceInfo {
  sequenceId: string;
  stepIndex: number;
  paused: boolean;
}

/** Состояние транспорта шоу в движке. */
export interface ShowTransportState {
  showId: string;
  positionMs: number;
  playing: boolean;
}

/** Состояние плейлиста в движке. */
export interface PlaylistTransportState {
  playlistId: string;
  itemIndex: number;
  /** true — пауза между шоу (gap), шоу-слой пуст. */
  inGap: boolean;
}

/** Состояние воспроизведения движка. */
export interface PlaybackState {
  /** Включённая статическая сцена (картина) или null. */
  activeSceneId: string | null;
  running: RunningSequenceInfo[];
  show: ShowTransportState | null;
  playlist: PlaylistTransportState | null;
  /** Пауза всего (§27 доработки, УХ п.1): картина заморожена, таймеры не идут, в 0 не гасим. */
  pausedAll: boolean;
}

/** Art-Net нода, найденная опросом ArtPoll (§12 п.3: мониторинг из тех. помещения). */
export interface ArtNetNodeInfo {
  ip: string;
  shortName: string;
  longName: string;
  /** Port-Address выходных портов ноды (нумерация Art-Net с 0). */
  outputUniverses: number[];
  /** Мс с последнего ответа (на момент отправки состояния). */
  ageMs: number;
  lost: boolean;
}

/** RDM-прибор из TOD (Table of Devices) ноды. */
export interface RdmDeviceInfo {
  /** ESTA UID вида "4d4f:12345678" (производитель:устройство). */
  uid: string;
  nodeIp: string;
  /** Port-Address, где прибор обнаружен. */
  universe: number;
  ageMs: number;
  lost: boolean;
}

export interface NetworkEvent {
  /** Unix-время события, мс. */
  atMs: number;
  text: string;
}

/** Состояние сети: ноды, RDM-приборы, журнал появлений/пропаж. */
export interface NetworkState {
  enabled: boolean;
  nodes: ArtNetNodeInfo[];
  rdmDevices: RdmDeviceInfo[];
  log: NetworkEvent[];
}

/**
 * Универсальный слой RDM (§3 доработки, §22): GET/SET параметров, одинаковых
 * по спецификации ANSI E1.20 для любого прибора — DEVICE_INFO, ярлыки
 * (производитель/модель/версия ПО), IDENTIFY (мигнуть), DMX_START_ADDRESS
 * (прочитать/переставить адрес удалённо). Опциональные PID конкретных
 * производителей (сенсоры, статус-сообщения) сюда сознательно не входят —
 * их поддержка и формат различаются прибор от прибора.
 */
export interface RdmDeviceInfoPayload {
  protocolVersion: string;
  deviceModelId: number;
  productCategory: number;
  softwareVersionId: number;
  dmxFootprint: number;
  dmxStartAddress: number;
  subDeviceCount: number;
  sensorCount: number;
}

export type RdmAction = 'deviceInfo' | 'labels' | 'getIdentify' | 'setIdentify' | 'getAddress' | 'setAddress';

/** Состояние насоса, управляемого напрямую по Modbus (§12 п.9). */
export interface PumpModbusStatus {
  deviceId: string;
  connected: boolean;
  /** Последняя записанная уставка частоты, Гц. */
  lastFreqHz: number;
  /** Код аварии из faultRegister (0 = нет аварии); null — регистр не задан в конфиге. */
  faultCode: number | null;
  /** Мс с последней успешной записи/чтения; -1 — успешного обмена ещё не было. */
  ageMs: number;
  lastError: string | null;
  /** Телеметрия (§27 доработки, §4 п.2) — null, если соответствующий регистр не задан в конфиге. */
  currentA: number | null;
  speedRpm: number | null;
  tempC: number | null;
}

export interface ModbusState {
  pumps: PumpModbusStatus[];
}

/**
 * Периодический именованный снимок fountain.project.json (§27 доработки, УХ п.5) —
 * отдельно от непрерывного живого автосохранения: защита от «сам всё сломал»,
 * а не от потери процесса.
 */
export interface BackupInfo {
  /** Имя файла в папке backups/ рядом с проектом, содержит метку времени. */
  file: string;
  atMs: number;
  sizeBytes: number;
}

/**
 * Запись журнала событий (§27 доработки, §3 п.1) — что и когда сработало:
 * расписание, пульты (OSC/MQTT), клавиши, ошибки движка. Раньше это было
 * видно только в консоли процесса движка; source — короткий тег вида
 * «schedule»/«osc»/«mqtt»/«net»/«key»/«modbus», совпадает с префиксом [xxx]
 * в консольных логах движка.
 */
export interface LogEvent {
  id: number;
  tsMs: number;
  source: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/**
 * Конфигурация DMX-выхода вселенной — редактируемая часть fountain.config.json
 * (вкладка «Настройки»). Зеркало OutputConfig движка.
 */
export interface ConfigOutput {
  type: 'artnet' | 'sacn' | 'usb-dmx';
  /** IP ноды (artnet) — обязателен, если не broadcast. */
  host?: string;
  port?: number;
  /** Номер вселенной протокола: Art-Net с 0, sACN с 1. */
  universe: number;
  broadcast?: boolean;
  priority?: number;
  /** COM-порт (usb-dmx). */
  path?: string;
  baudRate?: number;
}

export interface ConfigUniverse {
  id: number;
  label?: string;
  outputs: ConfigOutput[];
}

/** UI → Движок */
export type ClientMessage =
  | { type: 'setChannel'; universe: number; channel: number; value: number }
  | { type: 'setChannels'; universe: number; start: number; values: number[] }
  | { type: 'blackout' }
  // Пауза всего: заморозить текущую картину (не гасить) и остановить все таймеры
  // воспроизведения до resumeAll. Отдельно от blackout — см. Console/ConsoleView.
  | { type: 'pauseAll' }
  | { type: 'resumeAll' }
  | { type: 'testPattern'; mode: TestPatternMode }
  // Проект: полная замена (редактор шлёт после каждого изменения, движок сохраняет на диск).
  | { type: 'updateProject'; project: Project }
  // Ctrl+S (§27 доработки, УХ п.6): принудительный немедленный flush на диск —
  // живое автосохранение и так непрерывное (дебаунс 500мс), эта команда просто
  // не даёт ждать и подтверждает результат в UI.
  | { type: 'saveNow' }
  // Транспорт воспроизведения.
  | { type: 'setScene'; sceneId: string | null }
  | { type: 'startSequence'; sequenceId: string }
  | { type: 'pauseSequence'; sequenceId: string }
  | { type: 'resumeSequence'; sequenceId: string }
  | { type: 'stopSequence'; sequenceId: string }
  | { type: 'stopAllPlayback' }
  // Транспорт шоу. Аудио играет редактор; syncShow — периодическая коррекция
  // позиции движка по аудио-часам (мастер-клок — звук).
  | { type: 'playShow'; showId: string; positionMs: number }
  | { type: 'pauseShow' }
  | { type: 'seekShow'; positionMs: number }
  | { type: 'syncShow'; positionMs: number }
  | { type: 'stopShow' }
  // Аудиофайлы шоу: хранятся движком в папке audio/ рядом с проектом.
  | { type: 'uploadAudio'; name: string; dataBase64: string }
  | { type: 'getAudio'; name: string }
  // Плейлисты: исполняет движок автономно (мастер-часы — тик движка).
  | { type: 'playPlaylist'; playlistId: string; itemIndex?: number }
  | { type: 'skipPlaylist'; dir: 1 | -1 }
  | { type: 'stopPlaylist' }
  // Немедленный опрос сети (ArtPoll + ArtTodRequest вне расписания).
  | { type: 'refreshNetwork' }
  // Захват входящего ArtDMX (§17 п.1): снимок кадра вселенной проекта и период цикла.
  | { type: 'getDmxCapture'; universe: number }
  | { type: 'measureDmxCycle'; universe: number }
  // RDM (§3 доработки): GET/SET по обнаруженному через TOD UID.
  | { type: 'rdmRequest'; uid: string; action: 'deviceInfo' | 'labels' | 'getIdentify' | 'getAddress' }
  | { type: 'rdmRequest'; uid: string; action: 'setIdentify'; on: boolean }
  | { type: 'rdmRequest'; uid: string; action: 'setAddress'; address: number }
  // Настройки движка (вкладка «Настройки»): вселенные и шаг тика. Движок
  // применяет на лету (воспроизведение останавливается) и сохраняет в
  // fountain.config.json.
  | { type: 'updateConfig'; tickMs: number; universes: ConfigUniverse[] }
  // Авто-бэкапы проекта (§27 доработки, УХ п.5) — отдельно от updateConfig: смена
  // интервала не трогает воспроизведение.
  | { type: 'updateBackupConfig'; enabled: boolean; intervalMin: number }
  | { type: 'listBackups' }
  | { type: 'takeBackupNow' }
  | { type: 'restoreBackup'; file: string }
  // Журнал событий (§27 доработки, §3 п.1): источники на стороне редактора
  // (сейчас — клавиатурные привязки из вкладки «Клавиши») сами не видны
  // движку, поэтому явно сообщают о срабатывании, чтобы попасть в общий
  // журнал наравне с расписанием/OSC/MQTT.
  | { type: 'clientEvent'; source: string; message: string }
  // Автозапуск движка при входе в Windows (§27 доработки, §3 п.3) — обёртка
  // над задачей планировщика (та же, что раньше ставилась PowerShell-скриптом).
  | { type: 'getAutostart' }
  | { type: 'setAutostart'; enabled: boolean }
  // Ручной ввод скорости ветра (§27 доработки, §4 п.1) — задел под будущий
  // датчик по Modbus/MQTT: тот будет слать то же самое сообщение сам.
  | { type: 'setWindSpeed'; speedMs: number | null };

/** Движок → UI */
export type ServerMessage =
  | { type: 'hello'; version: string; tickMs: number; universes: UniverseInfo[] }
  /** Редактируемая конфигурация движка (шлётся при подключении и после updateConfig). */
  | { type: 'config'; tickMs: number; universes: ConfigUniverse[] }
  | { type: 'stats'; stats: EngineStats }
  | { type: 'frame'; universe: number; data: string }
  | { type: 'project'; project: Project }
  | { type: 'playback'; state: PlaybackState }
  | { type: 'network'; state: NetworkState }
  | { type: 'modbus'; state: ModbusState }
  /** Ответ на getAudio (только запросившему клиенту); dataBase64 = '' — файла нет. */
  | { type: 'audio'; name: string; dataBase64: string }
  /** Ответ на getDmxCapture: последний кадр внешнего ArtDMX; data = '' — захвата нет. */
  | { type: 'dmxCapture'; universe: number; data: string; ageMs: number; fromIp: string; frames: number }
  /** Ответ на measureDmxCycle. */
  | { type: 'dmxCycle'; universe: number; periodMs: number | null; confidence: number; analyzedMs: number }
  /** Статус удалённого управления (§1 доработки): включено ли, есть ли связь. */
  | { type: 'remoteStatus'; osc: { enabled: boolean }; mqtt: { enabled: boolean; connected: boolean } }
  // Ответы на rdmRequest.
  | { type: 'rdmResponse'; uid: string; ok: false; action: RdmAction; error: string }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'deviceInfo'; deviceInfo: RdmDeviceInfoPayload }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'labels'; manufacturer: string; model: string; softwareVersion: string }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'getIdentify' | 'setIdentify'; identify: boolean }
  | { type: 'rdmResponse'; uid: string; ok: true; action: 'getAddress' | 'setAddress'; address: number }
  /** Настройка авто-бэкапов (шлётся при подключении и после updateBackupConfig). */
  | { type: 'backupConfig'; enabled: boolean; intervalMin: number }
  /** Список снимков (шлётся при подключении, после listBackups и после снятия нового снимка). */
  | { type: 'backupList'; backups: BackupInfo[] }
  /** Ответ на saveNow. */
  | { type: 'saved'; atMs: number }
  /** Новое событие в журнале (шлётся всем клиентам сразу при возникновении). */
  | { type: 'logEvent'; event: LogEvent }
  /** История журнала (шлётся при подключении). */
  | { type: 'logHistory'; events: LogEvent[] }
  /** Статус автозапуска (шлётся при подключении и после setAutostart). */
  | { type: 'autostartState'; supported: boolean; enabled: boolean; error?: string }
  /** Ветер и текущее ограничение (шлётся при подключении и после setWindSpeed). */
  | { type: 'windState'; speedMs: number | null; limitPercent: number; config: WindLimitConfig };
