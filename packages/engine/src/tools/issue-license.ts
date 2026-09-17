import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LicenseFile, LicensePayload } from '@fountain-studio/shared';
import { canonicalPayload } from '../license';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Инструмент вендора для выпуска и учёта лицензий (§27 доработки) — НЕ
 * входит в собираемое приложение, запускается вручную разработчиком/продавцом:
 *
 *   npx tsx src/tools/issue-license.ts keygen
 *   npx tsx src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --duration trial
 *   npx tsx src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --duration year --device "Комп на объекте"
 *   npx tsx src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --duration forever --out license.json
 *   npx tsx src/tools/issue-license.ts list
 *   npx tsx src/tools/issue-license.ts rename --machine <id> --device "Ноутбук прораба"
 *   npx tsx src/tools/issue-license.ts revoke --machine <id> --note "не заплатили"
 *   npx tsx src/tools/issue-license.ts unrevoke --machine <id>
 *   npx tsx src/tools/issue-license.ts export-revocations revoked.json
 *
 * Приватный ключ — license-keys/private.pem рядом с этим пакетом (см.
 * .gitignore — никогда не в репозитории). «machine» — отпечаток компьютера
 * покупателя, показывается ему в приложении в панели активации лицензии;
 * его нужно получить от покупателя (письмом/сообщением) перед выпуском.
 *
 * Три срока:
 *  · trial   — 30 дней, пробный период;
 *  · year    — 365 дней;
 *  · forever — бессрочно.
 *
 * Учёт выданного (issued-licenses.json рядом с ключом): каждый выпуск
 * дописывается в журнал, `list` показывает кому, на какой ПК, с какого по
 * какое число и что с лицензией сейчас. Журнал нужен именно потому, что
 * лицензии офлайновые: после отправки файла покупателю никакого другого
 * следа не остаётся.
 *
 * Имя компьютера (devices.json) — отдельно от журнала выпусков: один и тот
 * же компьютер может получать лицензию не раз (продление), а имя — это
 * подпись «чей это комп», проставляется один раз и правится командой rename.
 *
 * Отзыв (revoked.json + export-revocations) — см. licenseRevocation.ts:
 * офлайн-подпись отозвать саму по себе нельзя, поэтому это отдельный список,
 * который движок подтягивает по сети, когда она есть. export-revocations
 * готовит из него файл БЕЗ имён и пометок — то, что можно спокойно выложить
 * куда угодно (Gist, свой сайт): это просто список ID, ничего личного.
 */

const KEY_DIR = process.env.FS_LICENSE_KEYS_DIR ?? path.join(__dirname, '..', '..', 'license-keys');
const PRIVATE_KEY_FILE = path.join(KEY_DIR, 'private.pem');
const JOURNAL_FILE = path.join(KEY_DIR, 'issued-licenses.json');
const DEVICES_FILE = path.join(KEY_DIR, 'devices.json');
const REVOKED_FILE = path.join(KEY_DIR, 'revoked.json');

type Duration = 'trial' | 'year' | 'forever';

/** Запись журнала: то же, что подписано, плюс куда лёг файл и пометка продавца. */
interface JournalEntry {
  licenseeName: string;
  machineId: string;
  issuedAt: string;
  /** null — бессрочная. */
  expiresAt: string | null;
  duration: Duration;
  /** Путь к выпущенному файлу лицензии — как он назывался в момент выпуска. */
  file: string;
  /** Свободная пометка: номер договора, контакт, объект (--note). */
  note?: string;
}

/** Имя компьютера — «чей это ПК», отдельно от истории выпусков. */
interface DeviceEntry {
  name: string;
  updatedAt: string;
}

/** Отозванный компьютер — с пометкой ПРОДАВЦА (в публичный список не идёт). */
interface RevokedEntry {
  machineId: string;
  revokedAt: string;
  note?: string;
}

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (err) {
    // Битый файл не затираем молча — иначе следующая же запись стёрла бы всю историю.
    const broken = `${file}.broken`;
    fs.copyFileSync(file, broken);
    console.error(`Файл повреждён, копия сохранена: ${broken}`);
    console.error('Продолжаю с пустым содержимым — старые записи восстановите из копии вручную.');
    console.error(String(err));
    return fallback;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const readJournal = (): JournalEntry[] => {
  const raw = readJson<unknown>(JOURNAL_FILE, []);
  return Array.isArray(raw) ? (raw as JournalEntry[]) : [];
};
const appendJournal = (entry: JournalEntry): void => writeJsonAtomic(JOURNAL_FILE, [...readJournal(), entry]);

const readDevices = (): Record<string, DeviceEntry> => readJson<Record<string, DeviceEntry>>(DEVICES_FILE, {});
function setDeviceName(machineId: string, name: string): void {
  const all = readDevices();
  all[machineId] = { name, updatedAt: new Date().toISOString() };
  writeJsonAtomic(DEVICES_FILE, all);
}

const readRevoked = (): RevokedEntry[] => {
  const raw = readJson<unknown>(REVOKED_FILE, []);
  return Array.isArray(raw) ? (raw as RevokedEntry[]) : [];
};
function writeRevoked(list: RevokedEntry[]): void {
  writeJsonAtomic(REVOKED_FILE, list);
}

const DAY_MS = 24 * 3600 * 1000;
const DURATION_DAYS: Record<Exclude<Duration, 'forever'>, number> = { trial: 30, year: 365 };

function formatDate(iso: string | null): string {
  if (!iso) return 'бессрочно';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU');
}

/** Что с лицензией прямо сейчас — считается от системных часов, как и проверка в движке. */
function statusOf(entry: JournalEntry): string {
  if (!entry.expiresAt) return 'бессрочная';
  const left = new Date(entry.expiresAt).getTime() - Date.now();
  if (Number.isNaN(left)) return 'срок неразборчив';
  if (left < 0) return `истекла ${Math.floor(-left / DAY_MS)} дн. назад`;
  const days = Math.floor(left / DAY_MS);
  return days <= 30 ? `истекает через ${days} дн.` : `активна, ещё ${days} дн.`;
}

function keygen(): void {
  if (fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`Уже есть приватный ключ: ${PRIVATE_KEY_FILE}. Удалите вручную, если точно хотите заменить —`);
    console.error('старые лицензии перестанут проверяться новым публичным ключом.');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
  console.log(`Приватный ключ сохранён: ${PRIVATE_KEY_FILE} (храните в секрете, не коммитьте)`);
  console.log('\nПубличный ключ — вставьте в PUBLIC_KEY_PEM в packages/engine/src/license.ts:\n');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]!.startsWith('--')) {
      const key = argv[i]!.slice(2);
      out[key] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

function deviceLabel(machineId: string): string {
  const d = readDevices()[machineId];
  return d ? d.name : '(без имени — issue-license.ts rename)';
}

function issue(argv: string[]): void {
  const args = parseArgs(argv);
  const machineId = args.machine;
  const licenseeName = args.name;
  const duration = args.duration as Duration;
  if (!machineId || !licenseeName || !duration) {
    console.error('Нужны --machine <id> --name "<имя>" --duration <trial|year|forever>');
    process.exit(1);
  }
  if (!fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`Нет приватного ключа (${PRIVATE_KEY_FILE}) — сначала: npx tsx src/tools/issue-license.ts keygen`);
    process.exit(1);
  }
  if (duration !== 'trial' && duration !== 'year' && duration !== 'forever') {
    console.error('--duration должен быть "trial" (30 дней), "year" или "forever"');
    process.exit(1);
  }
  const revoked = readRevoked().find((r) => r.machineId === machineId);
  if (revoked) {
    console.log(
      `Внимание: этот компьютер ОТОЗВАН ${formatDate(revoked.revokedAt)}${revoked.note ? ' (' + revoked.note + ')' : ''}.`,
    );
    console.log('Новый выпуск отзыв не снимает — если это ошибка, сначала: unrevoke --machine ' + machineId + '\n');
  }
  // Повторный выпуск на тот же ПК — обычное дело (продление, замена файла),
  // но продавец должен увидеть это до отправки, а не после.
  const previous = readJournal().filter((e) => e.machineId === machineId);
  if (previous.length > 0) {
    console.log(`Внимание: на этот компьютер уже выдавалось лицензий: ${previous.length}`);
    for (const p of previous) {
      console.log(`  ${formatDate(p.issuedAt)} → ${formatDate(p.expiresAt)}  ${p.licenseeName}  (${statusOf(p)})`);
    }
    console.log('Старые файлы продолжат работать до своего срока — сама подпись не отзывается.\n');
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_FILE, 'utf8'));
  const issuedAt = new Date();
  const expiresAt =
    duration === 'forever' ? null : new Date(issuedAt.getTime() + DURATION_DAYS[duration] * DAY_MS).toISOString();
  const payload: LicensePayload = {
    licenseeName,
    machineId,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
  };
  const signature = crypto.sign(null, canonicalPayload(payload), privateKey).toString('base64');
  const file: LicenseFile = { payload, signature };
  const out = args.out ?? `license-${licenseeName.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.json`;
  fs.writeFileSync(out, JSON.stringify(file, null, 2), 'utf8');
  // Журнал пишем только после того, как файл лёг на диск: не хочется учётной
  // записи о лицензии, которой на самом деле нет.
  const entry: JournalEntry = {
    licenseeName,
    machineId,
    issuedAt: payload.issuedAt,
    expiresAt,
    duration,
    file: path.resolve(out),
    ...(args.note ? { note: args.note } : {}),
  };
  appendJournal(entry);
  if (args.device) setDeviceName(machineId, args.device);
  console.log(`Лицензия выпущена: ${out}`);
  console.log(`  получатель: ${licenseeName}`);
  console.log(`  компьютер:  ${machineId}${args.device ? ` («${args.device}»)` : ''}`);
  console.log(`  срок:       ${duration === 'trial' ? 'пробный, 30 дней' : duration === 'year' ? 'год' : 'бессрочно'}`);
  console.log(`  выдана:     ${formatDate(payload.issuedAt)}`);
  console.log(`  действует:  ${expiresAt ? `до ${formatDate(expiresAt)}` : 'бессрочно'}`);
  if (args.note) console.log(`  пометка:    ${args.note}`);
  console.log(`  записано в журнал: ${JOURNAL_FILE}`);
}

/** Задать/сменить имя компьютера — не переиздавая лицензию. */
function rename(argv: string[]): void {
  const args = parseArgs(argv);
  if (!args.machine || !args.device) {
    console.error('Нужны --machine <id> --device "<имя>"');
    process.exit(1);
  }
  setDeviceName(args.machine, args.device);
  console.log(`Компьютер ${args.machine} теперь называется «${args.device}».`);
}

/**
 * Отозвать компьютер: подпись остаётся настоящей (переиздать без сети
 * нельзя), но движок с настроенным revocationUrl перестанет считать себя
 * лицензированным, как только подтянет обновлённый список — см.
 * licenseRevocation.ts. До этого момента (нет интернета) ничего не меняется.
 */
function revoke(argv: string[]): void {
  const args = parseArgs(argv);
  if (!args.machine) {
    console.error('Нужен --machine <id> [--note "<причина>"]');
    process.exit(1);
  }
  const list = readRevoked().filter((r) => r.machineId !== args.machine);
  list.push({ machineId: args.machine, revokedAt: new Date().toISOString(), ...(args.note ? { note: args.note } : {}) });
  writeRevoked(list);
  console.log(`Компьютер ${args.machine} (${deviceLabel(args.machine)}) добавлен в список отозванных.`);
  console.log('Подействует, когда движок на объекте подтянет обновлённый список по сети (revocationUrl) —');
  console.log('офлайн он продолжит работать со старым решением до следующего подключения к интернету.');
  console.log('Не забудьте: export-revocations <файл> и выложить его туда, откуда движок его читает.');
}

/** Отменить ошибочный отзыв. */
function unrevoke(argv: string[]): void {
  const args = parseArgs(argv);
  if (!args.machine) {
    console.error('Нужен --machine <id>');
    process.exit(1);
  }
  const before = readRevoked();
  const after = before.filter((r) => r.machineId !== args.machine);
  if (after.length === before.length) {
    console.log(`Компьютер ${args.machine} и так не был отозван.`);
    return;
  }
  writeRevoked(after);
  console.log(`Отзыв компьютера ${args.machine} снят локально.`);
  console.log('Не забудьте: export-revocations <файл> и переопубликовать его — иначе движки, ещё не');
  console.log('обновившие кэш, продолжат считать компьютер отозванным до следующей проверки.');
}

/**
 * Публичный список отозванных — БЕЗ имён и пометок продавца, только ID.
 * Это то, что можно выложить в открытый доступ (Gist, свой сайт, что угодно):
 * движок читает ровно этот формат (см. licenseRevocation.ts).
 */
function exportRevocations(argv: string[]): void {
  const out = argv[0];
  if (!out) {
    console.error('Нужен путь к файлу: export-revocations <файл>');
    process.exit(1);
  }
  const revoked = readRevoked().map((r) => r.machineId);
  fs.writeFileSync(out, JSON.stringify({ revoked }, null, 2), 'utf8');
  console.log(`Публичный список отозванных (${revoked.length}) записан: ${path.resolve(out)}`);
  console.log('Дальше — выложить его туда, откуда движок читает revocationUrl (например, в публичный Gist).');
}

/** Учёт выданного: кому, на какой ПК, с какого по какое и что сейчас. */
function list(): void {
  const all = readJournal();
  const revokedIds = new Set(readRevoked().map((r) => r.machineId));
  if (all.length === 0) {
    console.log(`Журнал пуст (${JOURNAL_FILE}).`);
    console.log('Записи появляются при каждом выпуске: issue-license.ts issue …');
  } else {
    const sorted = [...all].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
    console.log(`Выдано лицензий: ${sorted.length}   (журнал: ${JOURNAL_FILE})\n`);
    for (const e of sorted) {
      const revokedMark = revokedIds.has(e.machineId) ? '  ⛔ ОТОЗВАН' : '';
      console.log(`${e.licenseeName}${revokedMark}`);
      console.log(`  компьютер: ${e.machineId}  («${deviceLabel(e.machineId)}»)`);
      console.log(`  срок:      ${e.duration === 'trial' ? 'пробный' : e.duration === 'year' ? 'год' : 'бессрочно'}`);
      console.log(`  период:    ${formatDate(e.issuedAt)} → ${e.expiresAt ? formatDate(e.expiresAt) : 'бессрочно'}`);
      console.log(`  состояние: ${statusOf(e)}`);
      console.log(`  файл:      ${e.file}`);
      if (e.note) console.log(`  пометка:   ${e.note}`);
      console.log('');
    }
    const expiring = sorted.filter((e) => e.expiresAt && statusOf(e).startsWith('истекает'));
    if (expiring.length > 0) {
      console.log(`Требуют внимания в ближайший месяц: ${expiring.length}`);
      for (const e of expiring) console.log(`  ${e.licenseeName} — ${statusOf(e)}`);
    }
  }
  const revokedList = readRevoked();
  if (revokedList.length > 0) {
    console.log(`\nОтозвано компьютеров: ${revokedList.length}`);
    for (const r of revokedList) {
      console.log(`  ${r.machineId} («${deviceLabel(r.machineId)}») — ${formatDate(r.revokedAt)}${r.note ? ': ' + r.note : ''}`);
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'keygen') keygen();
else if (cmd === 'issue') issue(rest);
else if (cmd === 'list') list();
else if (cmd === 'rename') rename(rest);
else if (cmd === 'revoke') revoke(rest);
else if (cmd === 'unrevoke') unrevoke(rest);
else if (cmd === 'export-revocations') exportRevocations(rest);
else {
  console.log('Использование:');
  console.log('  npx tsx src/tools/issue-license.ts keygen');
  console.log(
    '  npx tsx src/tools/issue-license.ts issue --machine <id> --name "<имя>" --duration <trial|year|forever> [--device "<комп>"] [--out <файл>] [--note "<пометка>"]',
  );
  console.log('  npx tsx src/tools/issue-license.ts list                              — все выданные лицензии и отозванные');
  console.log('  npx tsx src/tools/issue-license.ts rename --machine <id> --device "<имя>"   — назвать/переименовать компьютер');
  console.log('  npx tsx src/tools/issue-license.ts revoke --machine <id> [--note "<причина>"]');
  console.log('  npx tsx src/tools/issue-license.ts unrevoke --machine <id>');
  console.log('  npx tsx src/tools/issue-license.ts export-revocations <файл>          — публичный список для публикации');
  process.exit(1);
}
