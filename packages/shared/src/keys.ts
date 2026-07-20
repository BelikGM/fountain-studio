/**
 * Клавиатурные привязки: запуск сцен, секвенсоров, шоу и плейлистов с клавиш.
 * Привязка хранится по KeyboardEvent.code (физическая клавиша, не зависит от
 * раскладки): 'KeyA', 'Digit1', 'F5', 'Space', 'Numpad1'…
 * Действия-переключатели: повторное нажатие останавливает то, что запустило.
 */

export type KeyActionType = 'scene' | 'sequence' | 'show' | 'playlist' | 'stopAll' | 'blackout' | 'pauseAll';

export interface KeyAction {
  type: KeyActionType;
  /** Для scene/sequence/show/playlist — id цели. */
  refId?: string;
}

export interface KeyBinding {
  id: string;
  /** KeyboardEvent.code. */
  code: string;
  action: KeyAction;
}

export function sanitizeKeys(
  raw: unknown,
  ids: { scenes: Set<string>; sequences: Set<string>; shows: Set<string>; playlists: Set<string> },
): KeyBinding[] {
  if (!Array.isArray(raw)) return [];
  const out: KeyBinding[] = [];
  const usedCodes = new Set<string>();
  for (const k of raw as KeyBinding[]) {
    if (!k || typeof k.id !== 'string' || typeof k.code !== 'string' || k.code === '') continue;
    if (usedCodes.has(k.code)) continue; // одна клавиша — одно действие
    const a = k.action;
    if (!a) continue;
    let action: KeyAction | null = null;
    if (a.type === 'stopAll' || a.type === 'blackout' || a.type === 'pauseAll') action = { type: a.type };
    else if (a.type === 'scene' && a.refId !== undefined && ids.scenes.has(a.refId)) action = { type: 'scene', refId: a.refId };
    else if (a.type === 'sequence' && a.refId !== undefined && ids.sequences.has(a.refId)) action = { type: 'sequence', refId: a.refId };
    else if (a.type === 'show' && a.refId !== undefined && ids.shows.has(a.refId)) action = { type: 'show', refId: a.refId };
    else if (a.type === 'playlist' && a.refId !== undefined && ids.playlists.has(a.refId)) action = { type: 'playlist', refId: a.refId };
    if (!action) continue;
    usedCodes.add(k.code);
    out.push({ id: k.id, code: k.code, action });
  }
  return out;
}
