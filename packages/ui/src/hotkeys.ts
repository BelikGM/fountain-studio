import { useEffect, useState } from 'react';

/**
 * Горячие клавиши редактора (§27 доработки, УХ п.6) — команды самого
 * приложения (отменить/сохранить/дублировать…), не путать с «Клавиатурой»
 * (project.keys): та привязывает клавиши к сценам/шоу конкретного проекта и
 * хранится в fountain.project.json, эти — предпочтение конкретного человека
 * на конкретном компьютере, поэтому живут в localStorage, не в проекте.
 */
export type HotkeyId =
  | 'undo'
  | 'redo'
  | 'save'
  | 'duplicate'
  | 'delete'
  | 'deselect'
  | 'nudgeUp'
  | 'nudgeDown'
  | 'nudgeLeft'
  | 'nudgeRight';

export interface HotkeyDef {
  id: HotkeyId;
  label: string;
  hint: string;
  default: string;
}

export const HOTKEY_DEFS: HotkeyDef[] = [
  { id: 'undo', label: 'Отменить', hint: 'глобально', default: 'Ctrl+KeyZ' },
  { id: 'redo', label: 'Повторить', hint: 'глобально', default: 'Ctrl+KeyY' },
  { id: 'save', label: 'Сохранить сейчас', hint: 'глобально', default: 'Ctrl+KeyS' },
  { id: 'duplicate', label: 'Дублировать выбранное', hint: '3D', default: 'Ctrl+KeyD' },
  { id: 'delete', label: 'Удалить выбранное', hint: '3D', default: 'Delete' },
  { id: 'deselect', label: 'Снять выделение', hint: '3D', default: 'Escape' },
  { id: 'nudgeUp', label: 'Сдвинуть вверх', hint: '3D, по Y', default: 'ArrowUp' },
  { id: 'nudgeDown', label: 'Сдвинуть вниз', hint: '3D, по Y', default: 'ArrowDown' },
  { id: 'nudgeLeft', label: 'Сдвинуть влево', hint: '3D, по X', default: 'ArrowLeft' },
  { id: 'nudgeRight', label: 'Сдвинуть вправо', hint: '3D, по X', default: 'ArrowRight' },
];

const STORAGE_KEY = 'fs-hotkeys';

function loadOverrides(): Partial<Record<HotkeyId, string>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<HotkeyId, string>>) : {};
  } catch {
    return {};
  }
}

let overrides = loadOverrides();
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((l) => l());

export function getCombo(id: HotkeyId): string {
  return overrides[id] ?? HOTKEY_DEFS.find((d) => d.id === id)!.default;
}

/** Другая команда уже занимает этот combo — id той команды, или null. */
export function findConflict(combo: string, excludeId: HotkeyId): HotkeyId | null {
  const hit = HOTKEY_DEFS.find((d) => d.id !== excludeId && getCombo(d.id) === combo);
  return hit ? hit.id : null;
}

export function setCombo(id: HotkeyId, combo: string): void {
  overrides = { ...overrides, [id]: combo };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  notify();
}

export function resetCombo(id: HotkeyId): void {
  overrides = { ...overrides };
  delete overrides[id];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  notify();
}

/** Живой combo команды — перерисовывает потребителя сразу после rebind в Настройках. */
export function useHotkey(id: HotkeyId): string {
  const [combo, setLocal] = useState(() => getCombo(id));
  useEffect(() => {
    setLocal(getCombo(id));
    const l = (): void => setLocal(getCombo(id));
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [id]);
  return combo;
}

/** Строковый combo из события клавиатуры — тот же формат, что default/getCombo. */
export function comboFromEvent(e: KeyboardEvent): string {
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${e.code}`;
}

/** Человекочитаемая подпись combo для таблицы в Настройках. */
export function comboLabel(combo: string): string {
  return combo
    .replace(/Key([A-Z])/, '$1')
    .replace(/Digit(\d)/, '$1')
    .replace('Arrow', '')
    .replace('Escape', 'Esc')
    .replace('Delete', 'Del');
}
