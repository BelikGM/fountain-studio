/**
 * Протокол сообщений между Редактором (UI) и Движком по WebSocket.
 * Все сообщения — JSON. Кадры DMX передаются в base64.
 */

import type { Project } from './project';

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
}

export interface ModbusState {
  pumps: PumpModbusStatus[];
}

/** UI → Движок */
export type ClientMessage =
  | { type: 'setChannel'; universe: number; channel: number; value: number }
  | { type: 'setChannels'; universe: number; start: number; values: number[] }
  | { type: 'blackout' }
  | { type: 'testPattern'; mode: TestPatternMode }
  // Проект: полная замена (редактор шлёт после каждого изменения, движок сохраняет на диск).
  | { type: 'updateProject'; project: Project }
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
  | { type: 'measureDmxCycle'; universe: number };

/** Движок → UI */
export type ServerMessage =
  | { type: 'hello'; version: string; tickMs: number; universes: UniverseInfo[] }
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
  | { type: 'remoteStatus'; osc: { enabled: boolean }; mqtt: { enabled: boolean; connected: boolean } };
