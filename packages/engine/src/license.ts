import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LicenseFile, LicensePayload, LicenseStatus } from '@fountain-studio/shared';

/**
 * Лицензия, привязанная к 1 ПК (§27 доработки, раздел «Продукт»). Офлайн:
 * весь мир движка — этот компьютер, проверка подписи не требует сети.
 *
 * Публичный ключ ниже — НЕ секрет (публичные ключи подписи такими не
 * бывают), можно смело коммитить и распространять с приложением. Секрет —
 * приватный ключ, которым выпускаются лицензии: он лежит только у вендора,
 * в packages/engine/license-keys/private.pem (см. .gitignore — эта папка
 * никогда не попадает в репозиторий) и используется инструментом
 * tools/issue-license.ts, который в собранное приложение не входит.
 *
 * Модель угроз честно ограничена: локальное приложение на компьютере
 * пользователя нельзя защитить от владельца этого компьютера так же
 * надёжно, как облачный сервис — решительный человек с отладчиком всегда
 * может патчить бинарник. Это защита от случайного/небрежного
 * распространения ключей, не от целенаправленного взлома.
 */
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvH6nLiugAz1uJ1+7ZsN/WqZh/CkJhQMt6ZT6Qv8K8cM=
-----END PUBLIC KEY-----
`;

/** Порядок полей фиксирован — то же самое должен собрать issue-license.ts перед подписью. */
export function canonicalPayload(p: LicensePayload): Buffer {
  return Buffer.from(
    JSON.stringify({
      licenseeName: p.licenseeName,
      machineId: p.machineId,
      issuedAt: p.issuedAt,
      expiresAt: p.expiresAt,
    }),
    'utf8',
  );
}

/**
 * Отпечаток машины — хеш от имени хоста, платформы и MAC-адресов сетевых
 * интерфейсов. Не идеальный аппаратный ID (такого без нативных модулей в
 * Node нет), но достаточно стабильный для «эта лицензия — для этого ПК» и
 * не требует ничего, кроме встроенного os/crypto.
 */
export function machineFingerprint(): string {
  const nets = os.networkInterfaces();
  const macs = Object.values(nets)
    .flatMap((list) => list ?? [])
    .map((n) => n.mac)
    .filter((mac) => mac && mac !== '00:00:00:00:00:00')
    .sort();
  const raw = [os.hostname(), os.platform(), os.arch(), ...macs].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function verifyLicenseFile(file: LicenseFile): { valid: boolean; reason?: string } {
  if (!file || typeof file !== 'object' || !file.payload || typeof file.signature !== 'string') {
    return { valid: false, reason: 'Файл лицензии повреждён (неверный формат)' };
  }
  let publicKey: crypto.KeyObject;
  try {
    publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
  } catch {
    return { valid: false, reason: 'Не удалось прочитать публичный ключ приложения' };
  }
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, canonicalPayload(file.payload), publicKey, Buffer.from(file.signature, 'base64'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { valid: false, reason: 'Подпись не сходится — файл повреждён или не является настоящей лицензией' };
  if (file.payload.machineId !== machineFingerprint()) {
    return { valid: false, reason: 'Лицензия выдана для другого компьютера' };
  }
  if (file.payload.expiresAt && new Date(file.payload.expiresAt).getTime() < Date.now()) {
    return { valid: false, reason: `Срок лицензии истёк ${file.payload.expiresAt}` };
  }
  return { valid: true };
}

function licenseFilePath(projectDir: string): string {
  return path.join(projectDir, 'fountain.license.json');
}

export function loadLicenseStatus(projectDir: string): LicenseStatus {
  const machineId = machineFingerprint();
  const file = licenseFilePath(projectDir);
  if (!fs.existsSync(file)) {
    return { licensed: false, licenseeName: null, expiresAt: null, machineId, reason: 'Лицензия не активирована' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LicenseFile;
    const check = verifyLicenseFile(parsed);
    return {
      licensed: check.valid,
      licenseeName: parsed.payload?.licenseeName ?? null,
      expiresAt: parsed.payload?.expiresAt ?? null,
      machineId,
      reason: check.reason,
    };
  } catch {
    return { licensed: false, licenseeName: null, expiresAt: null, machineId, reason: 'Файл лицензии повреждён (не JSON)' };
  }
}

/** Принимает СОДЕРЖИМОЕ файла лицензии (текст) — проверяет и, если годится, сохраняет. */
export function activateLicense(projectDir: string, fileText: string): LicenseStatus {
  const machineId = machineFingerprint();
  let parsed: LicenseFile;
  try {
    parsed = JSON.parse(fileText) as LicenseFile;
  } catch {
    return { licensed: false, licenseeName: null, expiresAt: null, machineId, reason: 'Не удалось разобрать файл — это не JSON' };
  }
  const check = verifyLicenseFile(parsed);
  if (!check.valid) {
    return { licensed: false, licenseeName: parsed.payload?.licenseeName ?? null, expiresAt: parsed.payload?.expiresAt ?? null, machineId, reason: check.reason };
  }
  fs.writeFileSync(licenseFilePath(projectDir), JSON.stringify(parsed, null, 2), 'utf8');
  return { licensed: true, licenseeName: parsed.payload.licenseeName, expiresAt: parsed.payload.expiresAt, machineId };
}
