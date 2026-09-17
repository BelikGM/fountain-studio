import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccessLevel, LicenseFile, LicensePayload, LicensePlan, LicenseStatus } from '@fountain-studio/shared';
import { isMachineRevoked } from './licenseRevocation';

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
export const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
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
      // Лицензии до 18.09.2026 подписаны БЕЗ этого поля — p.plan там undefined,
      // а JSON.stringify молча выбрасывает ключи со значением undefined, так
      // что канонический текст получается БУКВАЛЬНО тем же самым, что и раньше.
      // Старые подписи от этого не ломаются — именно ради этого проверено
      // отдельным пунктом в license-test.
      plan: p.plan,
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

export interface LicenseCheck {
  valid: boolean;
  reason?: string;
  /**
   * Подпись настоящая, лицензия действительно для ЭТОГО компьютера — просто
   * вышел срок. Отличаем от «вообще не лицензия» специально: настоящая,
   * но просроченная лицензия даёт понижение до Pro (см. AccessLevel в
   * shared/license.ts), а не полную блокировку — фонтан не должен резко
   * замолчать из-за забытого продления.
   */
  expired?: boolean;
}

export function verifyLicenseFile(file: LicenseFile): LicenseCheck {
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
    return { valid: false, reason: `Срок лицензии истёк ${file.payload.expiresAt}`, expired: true };
  }
  return { valid: true };
}

/** Лицензии без явного plan выпущены до 18.09.2026, когда лицензия была «всё включено» — считаем их max. */
function effectivePlan(payload: LicensePayload): LicensePlan {
  return payload.plan ?? 'max';
}

/**
 * Что реально открыто — по результату проверки подписи/срока и уровню
 * подписки. Вынесена отдельно от loadLicenseStatus и экспортирована, чтобы
 * самопроверка могла прогнать все переходы (валидна/истекла/битая подпись ×
 * pro/max) без настоящего приватного ключа вендора — тут нет ни подписи, ни
 * файлов, чистая функция от готового результата проверки.
 */
export function accessFor(check: LicenseCheck, plan: LicensePlan | null): AccessLevel {
  if (check.valid) return plan ?? 'max';
  return check.expired ? 'pro' : 'none';
}

function licenseFilePath(projectDir: string): string {
  return path.join(projectDir, 'fountain.license.json');
}

/**
 * Собирает итоговый статус из результата проверки подписи и того, отозван
 * ли компьютер. Здесь и только здесь решается разница между «не лицензирован
 * вовсе» (access: none — совсем новая установка или испорченный/чужой файл)
 * и «лицензия была, но кончилась» (access: pro — понижение, не отключение).
 * Отзыв — умышленно строже отдельного истечения срока: это не «забыли
 * продлить», а решение продавца, поэтому сразу none, а не pro.
 */
function statusFrom(params: {
  machineId: string;
  reason?: string;
  licenseeName: string | null;
  expiresAt: string | null;
  plan: LicensePlan | null;
  licensed: boolean;
  access: AccessLevel;
}): LicenseStatus {
  return {
    licensed: params.licensed,
    licenseeName: params.licenseeName,
    expiresAt: params.expiresAt,
    machineId: params.machineId,
    plan: params.plan,
    access: params.access,
    ...(params.reason ? { reason: params.reason } : {}),
  };
}

export function loadLicenseStatus(projectDir: string): LicenseStatus {
  const machineId = machineFingerprint();
  // Отзыв проверяем ПЕРВЫМ и безусловно: отозванный компьютер теряет доступ
  // целиком (access: none), даже если файл лицензии сам по себе настоящий и
  // ещё не истёк (см. licenseRevocation.ts — список подтягивается сам, когда
  // есть интернет). Строже, чем истечение срока, — это осознанное решение
  // продавца, а не забытое продление.
  if (isMachineRevoked(projectDir, machineId)) {
    return statusFrom({ machineId, reason: 'Лицензия отозвана', licenseeName: null, expiresAt: null, plan: null, licensed: false, access: 'none' });
  }
  const file = licenseFilePath(projectDir);
  if (!fs.existsSync(file)) {
    return statusFrom({ machineId, reason: 'Лицензия не активирована', licenseeName: null, expiresAt: null, plan: null, licensed: false, access: 'none' });
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LicenseFile;
    const check = verifyLicenseFile(parsed);
    const plan = parsed.payload ? effectivePlan(parsed.payload) : null;
    return statusFrom({
      machineId,
      licenseeName: parsed.payload?.licenseeName ?? null,
      expiresAt: parsed.payload?.expiresAt ?? null,
      plan: check.valid ? plan : null,
      licensed: check.valid,
      access: accessFor(check, plan),
      ...(check.reason ? { reason: check.reason } : {}),
    });
  } catch {
    return statusFrom({ machineId, reason: 'Файл лицензии повреждён (не JSON)', licenseeName: null, expiresAt: null, plan: null, licensed: false, access: 'none' });
  }
}

/** Принимает СОДЕРЖИМОЕ файла лицензии (текст) — проверяет и, если годится, сохраняет. */
export function activateLicense(projectDir: string, fileText: string): LicenseStatus {
  const machineId = machineFingerprint();
  let parsed: LicenseFile;
  try {
    parsed = JSON.parse(fileText) as LicenseFile;
  } catch {
    return statusFrom({ machineId, reason: 'Не удалось разобрать файл — это не JSON', licenseeName: null, expiresAt: null, plan: null, licensed: false, access: 'none' });
  }
  const check = verifyLicenseFile(parsed);
  if (!check.valid) {
    return statusFrom({
      machineId,
      reason: check.reason,
      licenseeName: parsed.payload?.licenseeName ?? null,
      expiresAt: parsed.payload?.expiresAt ?? null,
      plan: null,
      licensed: false,
      access: accessFor(check, null),
    });
  }
  fs.writeFileSync(licenseFilePath(projectDir), JSON.stringify(parsed, null, 2), 'utf8');
  const plan = effectivePlan(parsed.payload);
  return statusFrom({
    machineId,
    licenseeName: parsed.payload.licenseeName,
    expiresAt: parsed.payload.expiresAt,
    plan,
    licensed: true,
    access: plan,
  });
}
