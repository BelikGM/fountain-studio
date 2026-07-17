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

/** Состояние воспроизведения движка. */
export interface PlaybackState {
  /** Включённая статическая сцена (картина) или null. */
  activeSceneId: string | null;
  running: RunningSequenceInfo[];
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
  | { type: 'stopAllPlayback' };

/** Движок → UI */
export type ServerMessage =
  | { type: 'hello'; version: string; tickMs: number; universes: UniverseInfo[] }
  | { type: 'stats'; stats: EngineStats }
  | { type: 'frame'; universe: number; data: string }
  | { type: 'project'; project: Project }
  | { type: 'playback'; state: PlaybackState };
