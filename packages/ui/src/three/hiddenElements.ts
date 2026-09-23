/**
 * Скрытые в 3D элементы — «глазик» в списке слева.
 *
 * Это предпочтение ВИДА, а не свойство объекта: спрятал чашу, чтобы
 * посмотреть на форсунки снизу, — на объекте от этого ничего не меняется, и в
 * проект (который уезжает на фонтан и открывается вторым редактором) такое
 * писать нельзя. Поэтому хранится в localStorage этого компьютера. Ключ —
 * «тип:id»; id элементов уникальны, так что объекты между собой не путаются.
 */
const KEY = 'fountain.3d.hidden';

export function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveHidden(keys: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...keys]));
  } catch {
    // Приватный режим — скрытое просто не переживёт перезапуск.
  }
}
