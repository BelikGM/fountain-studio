/**
 * Режим оператора с паролем (§27 доработки, УХ п.8): упрощённый экран для
 * дежурного персонала — только запуск плейлистов/сцен и аварийные кнопки, без
 * доступа к редактированию. Состояние — в localStorage, не в проекте:
 * специфика конкретного компьютера/установки. Блокировка переживает
 * перезапуск приложения (десктопная сборка может работать неделями без
 * перезапуска) — снимается только явной кнопкой «Заблокировать» и обратно
 * паролем, не таймером и не по факту закрытия окна.
 *
 * Пароль не хранится в открытом виде — только SHA-256 хеш. Это не защита от
 * целенаправленной атаки (локальные данные Electron всё равно читаемы), а
 * барьер от случайного/любопытного персонала — ровно то, что запрошено.
 */

const PW_KEY = 'fs-operator-pwhash';
const LOCK_KEY = 'fs-operator-locked';

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hasOperatorPassword(): boolean {
  return localStorage.getItem(PW_KEY) !== null;
}

export async function setOperatorPassword(pw: string): Promise<void> {
  localStorage.setItem(PW_KEY, await sha256Hex(pw));
}

export async function checkOperatorPassword(pw: string): Promise<boolean> {
  const hash = localStorage.getItem(PW_KEY);
  return hash !== null && hash === (await sha256Hex(pw));
}

export function clearOperatorPassword(): void {
  localStorage.removeItem(PW_KEY);
  localStorage.removeItem(LOCK_KEY);
}

export function isOperatorLocked(): boolean {
  return hasOperatorPassword() && localStorage.getItem(LOCK_KEY) === 'true';
}

export function lockOperator(): void {
  if (hasOperatorPassword()) localStorage.setItem(LOCK_KEY, 'true');
}

export function unlockOperator(): void {
  localStorage.removeItem(LOCK_KEY);
}
