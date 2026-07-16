/**
 * Протокол сообщений между Редактором (UI) и Движком по WebSocket.
 * Все сообщения — JSON. Кадры DMX передаются в base64.
 */

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

/** UI → Движок */
export type ClientMessage =
  | { type: 'setChannel'; universe: number; channel: number; value: number }
  | { type: 'setChannels'; universe: number; start: number; values: number[] }
  | { type: 'blackout' }
  | { type: 'testPattern'; mode: TestPatternMode };

/** Движок → UI */
export type ServerMessage =
  | { type: 'hello'; version: string; tickMs: number; universes: UniverseInfo[] }
  | { type: 'stats'; stats: EngineStats }
  | { type: 'frame'; universe: number; data: string };
