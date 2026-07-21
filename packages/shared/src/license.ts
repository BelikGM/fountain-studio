/**
 * Лицензия (§27 доработки, раздел «Продукт») — привязка к 1 ПК: подписанный
 * офлайн-файл, без облачного сервера (тот потребовался бы для привязки к
 * аккаунту — отдельный проект). Подпись — Ed25519 через встроенный в Node
 * crypto, без внешней зависимости. Проверка целиком на стороне движка (см.
 * packages/engine/src/license.ts) — редактор только показывает статус и
 * шлёт содержимое файла на активацию.
 */

/** То, что реально подписывается — порядок полей фиксирован (см. canonicalPayload в engine/license.ts). */
export interface LicensePayload {
  licenseeName: string;
  /** sha256 отпечатка машины (см. machineFingerprint в engine/license.ts). */
  machineId: string;
  issuedAt: string;
  /** null — бессрочная лицензия. */
  expiresAt: string | null;
}

export interface LicenseFile {
  payload: LicensePayload;
  /** Ed25519-подпись payload, base64. */
  signature: string;
}

export interface LicenseStatus {
  licensed: boolean;
  licenseeName: string | null;
  expiresAt: string | null;
  /** Отпечаток ЭТОГО компьютера — показываем оператору, чтобы он мог отправить его для выпуска лицензии. */
  machineId: string;
  /** Причина отказа, когда licensed=false (нет файла / не тот ПК / истекла / подпись не сходится). */
  reason?: string;
}
