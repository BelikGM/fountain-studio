import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LicenseFile, LicensePayload } from '@fountain-studio/shared';
import { canonicalPayload } from '../license';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Инструмент вендора для выпуска лицензий (§27 доработки) — НЕ входит в
 * собираемое приложение, запускается вручную разработчиком/продавцом:
 *
 *   npx tsx src/tools/issue-license.ts keygen
 *   npx tsx src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --duration year
 *   npx tsx src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --duration forever --out license.json
 *   npx tsx src/tools/issue-license.ts list
 *
 * Приватный ключ — license-keys/private.pem рядом с этим пакетом (см.
 * .gitignore — никогда не в репозитории). «machine» — отпечаток компьютера
 * покупателя, показывается ему в приложении в панели активации лицензии;
 * его нужно получить от покупателя (письмом/сообщением) перед выпуском.
 *
 * Учёт выданного (issued-licenses.json рядом с ключом): каждый выпуск
 * дописывается в журнал, `list` показывает кому, на какой ПК, с какого по
 * какое число и что с лицензией сейчас. Журнал нужен именно потому, что
 * лицензии офлайновые: после отправки файла покупателю никакого другого
 * следа не остаётся, а отозвать выданное нельзя — можно только знать, что
 * и когда истекает, и вовремя перевыпустить.
 */

const KEY_DIR = path.join(__dirname, '..', '..', 'license-keys');
const PRIVATE_KEY_FILE = path.join(KEY_DIR, 'private.pem');
const JOURNAL_FILE = path.join(KEY_DIR, 'issued-licenses.json');

/** Запись журнала: то же, что подписано, плюс куда лёг файл и пометка продавца. */
interface JournalEntry {
  licenseeName: string;
  machineId: string;
  issuedAt: string;
  /** null — бессрочная. */
  expiresAt: string | null;
  duration: 'year' | 'forever';
  /** Путь к выпущенному файлу лицензии — как он назывался в момент выпуска. */
  file: string;
  /** Свободная пометка: номер договора, контакт, объект (--note). */
  note?: string;
}

function readJournal(): JournalEntry[] {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
  } catch (err) {
    // Битый журнал не затираем молча — иначе выпуск лицензии стёр бы всю историю продаж.
    const broken = `${JOURNAL_FILE}.broken`;
    fs.copyFileSync(JOURNAL_FILE, broken);
    console.error(`Журнал повреждён, копия сохранена: ${broken}`);
    console.error('Продолжаю с пустым журналом — старые записи восстановите из копии вручную.');
    console.error(String(err));
    return [];
  }
}

function appendJournal(entry: JournalEntry): void {
  const all = readJournal();
  all.push(entry);
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const tmp = `${JOURNAL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
  fs.renameSync(tmp, JOURNAL_FILE);
}

const DAY_MS = 24 * 3600 * 1000;

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

function issue(argv: string[]): void {
  const args = parseArgs(argv);
  const machineId = args.machine;
  const licenseeName = args.name;
  const duration = args.duration; // 'year' | 'forever'
  if (!machineId || !licenseeName || !duration) {
    console.error('Нужны --machine <id> --name "<имя>" --duration <year|forever>');
    process.exit(1);
  }
  if (!fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`Нет приватного ключа (${PRIVATE_KEY_FILE}) — сначала: npx tsx src/tools/issue-license.ts keygen`);
    process.exit(1);
  }
  if (duration !== 'year' && duration !== 'forever') {
    console.error('--duration должен быть "year" или "forever"');
    process.exit(1);
  }
  // Повторный выпуск на тот же ПК — обычное дело (продление, замена файла),
  // но продавец должен увидеть это до отправки, а не после.
  const previous = readJournal().filter((e) => e.machineId === machineId);
  if (previous.length > 0) {
    console.log(`Внимание: на этот компьютер уже выдавалось лицензий: ${previous.length}`);
    for (const p of previous) {
      console.log(`  ${formatDate(p.issuedAt)} → ${formatDate(p.expiresAt)}  ${p.licenseeName}  (${statusOf(p)})`);
    }
    console.log('Старые файлы продолжат работать до своего срока — отозвать офлайн-лицензию нельзя.\n');
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY_FILE, 'utf8'));
  const issuedAt = new Date();
  const expiresAt =
    duration === 'forever' ? null : new Date(issuedAt.getTime() + 365 * DAY_MS).toISOString();
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
  console.log(`Лицензия выпущена: ${out}`);
  console.log(`  получатель: ${licenseeName}`);
  console.log(`  компьютер:  ${machineId}`);
  console.log(`  выдана:     ${formatDate(payload.issuedAt)}`);
  console.log(`  действует:  ${expiresAt ? `до ${formatDate(expiresAt)}` : 'бессрочно'}`);
  if (args.note) console.log(`  пометка:    ${args.note}`);
  console.log(`  записано в журнал: ${JOURNAL_FILE}`);
}

/** Учёт выданного: кому, на какой ПК, с какого по какое и что сейчас. */
function list(): void {
  const all = readJournal();
  if (all.length === 0) {
    console.log(`Журнал пуст (${JOURNAL_FILE}).`);
    console.log('Записи появляются при каждом выпуске: issue-license.ts issue …');
    return;
  }
  const sorted = [...all].sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  console.log(`Выдано лицензий: ${sorted.length}   (журнал: ${JOURNAL_FILE})\n`);
  for (const e of sorted) {
    console.log(`${e.licenseeName}`);
    console.log(`  компьютер: ${e.machineId}`);
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

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'keygen') keygen();
else if (cmd === 'issue') issue(rest);
else if (cmd === 'list') list();
else {
  console.log('Использование:');
  console.log('  npx tsx src/tools/issue-license.ts keygen');
  console.log('  npx tsx src/tools/issue-license.ts issue --machine <id> --name "<имя>" --duration <year|forever> [--out <файл>] [--note "<пометка>"]');
  console.log('  npx tsx src/tools/issue-license.ts list        — журнал выданных лицензий');
  process.exit(1);
}
