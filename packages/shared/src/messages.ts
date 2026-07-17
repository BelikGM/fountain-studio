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
  | { type: 'stopPlaylist' };

/** Движок → UI */
export type ServerMessage =
  | { type: 'hello'; version: string; tickMs: number; universes: UniverseInfo[] }
  | { type: 'stats'; stats: EngineStats }
  | { type: 'frame'; universe: number; data: string }
  | { type: 'project'; project: Project }
  | { type: 'playback'; state: PlaybackState }
  /** Ответ на getAudio (только запросившему клиенту); dataBase64 = '' — файла нет. */
  | { type: 'audio'; name: string; dataBase64: string };
