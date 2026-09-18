import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LicenseFile, LicensePayload, LicensePlan } from '@fountain-studio/shared';
import { canonicalPayload, PUBLIC_KEY_PEM } from '../license';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Инструмент вендора для выпуска и учёта лицензий — НЕ входит в собираемое
 * приложение, запускается вручную из терминала (PowerShell), из папки
 * репозитория (`cd C:\fountain-studio`, дальше все команды ниже):
 *
 *   npx tsx packages/engine/src/tools/issue-license.ts <команда> [параметры]
 *
 * Команды — что каждая делает:
 *
 *  · keygen                 — один раз в жизни проекта: создаёт пару ключей
 *                              (приватный + публичный). Если приватный ключ
 *                              уже есть, отказывается — не перезаписывает
 *                              молча (иначе все выданные раньше лицензии
 *                              перестанут проверяться).
 *  · issue                  — ВЫПУСКАЕТ лицензию: подписывает privateKey'ом
 *                              файл для конкретного --machine и печатает его
 *                              на диск (--out, по умолчанию рядом, в текущей
 *                              папке). Этот файл и отправляется покупателю —
 *                              он и есть «доступ», больше ничего передавать
 *                              не нужно. Заодно дописывает строку в журнал
 *                              (issued-licenses.json), чтобы `list` видел.
 *                              --plan pro|max — обязателен, какой уровень
 *                              открывает лицензия (см. AccessLevel в
 *                              shared/license.ts). Срок — либо готовый
 *                              пресет --duration trial|year|forever, либо
 *                              своё число дней --days <N> (не оба сразу).
 *                              --renew — ПРОДЛЕНИЕ: считать срок от прежней
 *                              даты окончания, а не от сегодня. Просрочил
 *                              неделю и оплатил — новый срок всё равно от
 *                              старой даты, чтобы платить с опозданием не
 *                              было выгодно.
 *  · list                   — НИЧЕГО не меняет, только печатает: все
 *                              выданные лицензии (из журнала) и все отозванные
 *                              компьютеры разом.
 *  · rename                 — даёт компьютеру человекочитаемое имя (или меняет
 *                              его), не трогая уже выпущенные лицензии.
 *  · import                 — если у вас СОХРАНИЛСЯ файл лицензии, который
 *                              выпустили ДО того, как появился журнал
 *                              (issue-license.ts начал вести list только с
 *                              16.09.2026 — раньше выпущенное в журнал не
 *                              попало и само туда не попадёт), эта команда
 *                              читает такой файл и дописывает по нему запись
 *                              задним числом. Файла нет — восстановить нечем,
 *                              никакого другого следа лицензия не оставляет.
 *  · revoke                 — помечает компьютер «отозван» в ВАШЕМ локальном
 *                              списке (revoked.json, у вас на диске, не
 *                              публикуется). Само по себе ни на что не влияет —
 *                              см. export-revocations.
 *  · unrevoke                — снимает пометку «отозван» (передумали/ошиблись).
 *  · export-revocations      — печатает из revoked.json ПУБЛИЧНУЮ версию: только
 *                              ID компьютеров, без имён и пометок. Это тот
 *                              файл, который нужно куда-то выложить в
 *                              интернет (адрес — в app-config.json →
 *                              license.revocationUrl), чтобы движки покупателей
 *                              сами его скачивали и проверяли себя.
 *
 * Примеры:
 *
 *   npx tsx packages/engine/src/tools/issue-license.ts keygen
 *   npx tsx packages/engine/src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --plan pro --duration trial
 *   npx tsx packages/engine/src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --plan max --duration year --device "Комп на объекте"
 *   npx tsx packages/engine/src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --plan max --duration forever --out "C:\...\license.json"
 *   npx tsx packages/engine/src/tools/issue-license.ts issue --machine <id> --name "ООО Ромашка" --plan pro --days 45
 *   npx tsx packages/engine/src/tools/issue-license.ts list
 *   npx tsx packages/engine/src/tools/issue-license.ts rename --machine <id> --device "Ноутбук прораба"
 *   npx tsx packages/engine/src/tools/issue-license.ts import старая-лицензия.json --device "Комп клиента"
 *   npx tsx packages/engine/src/tools/issue-license.ts revoke --machine <id> --note "не заплатили"
 *   npx tsx packages/engine/src/tools/issue-license.ts unrevoke --machine <id>
 *   npx tsx packages/engine/src/tools/issue-license.ts export-revocations revoked.json
 *
 * Где что лежит (ВСЕГДА эти пути, независимо от того, из какой папки
 * запущена команда — они привязаны к расположению САМОГО ФАЙЛА
 * issue-license.ts на диске, а не к текущей папке терминала):
 *
 *   packages/engine/license-keys/private.pem              приватный ключ — НИКОГДА не в git
 *   packages/engine/license-keys/issued-licenses.json      журнал: кто, какой ПК, когда, до какого числа
 *   packages/engine/license-keys/devices.json              имена компьютеров (rename)
 *   packages/engine/license-keys/revoked.json               ваш рабочий список отозванных (с пометками — не публикуется)
 *
 * «machine» — отпечаток компьютера покупателя, показывается ему в приложении
 * в панели активации лицензии; его нужно получить от покупателя (письмом/
 * сообщением) перед выпуском.
 *
 * Сроки: trial — 30 дней (пробный), year — 365 дней, forever — бессрочно,
 * либо --days <N> — своё число дней вместо готового пресета.
 *
 * Уровни (--plan): pro — воспроизведение готового (плейлисты, шоу,
 * расписание), max — полный доступ (разработка шоу, 3D-схема, оборудование,
 * протоколы, диагностика).
 *
 * Что бывает, когда доступа нет (всё это — access: none, экран приветствия
 * с тарифами вместо вкладок, см. shared/license.ts):
 *  · лицензии не было никогда — совсем новая установка;
 *  · срок вышел И прошли льготные дни (GRACE_PERIOD_DAYS = 7): первые семь
 *    дней после даты окончания программа работает как обычно и просит
 *    оплатить, дальше закрывается;
 *  · компьютер отозван.
 * Свои объекты этим не задеть: им выдаётся бессрочная лицензия (forever) —
 * у неё срока нет вовсе, и интернет для неё не нужен.
 *
 * Отзыв — по устройству офлайн-лицензию саму по себе не отозвать (файл с
 * подписью не перестаёт быть подлинным), поэтому это отдельный, необязательный
 * слой: движок сам подтягивает по сети опубликованный список отозванных
 * ID, если в app-config.json указан license.revocationUrl (разбор решения —
 * docs/ARCHITECTURE.md §28, код проверки — licenseRevocation.ts).
 */

const KEY_DIR = process.env.FS_LICENSE_KEYS_DIR ?? path.join(__dirname, '..', '..', 'license-keys');
const PRIVATE_KEY_FILE = path.join(KEY_DIR, 'private.pem');
const JOURNAL_FILE = path.join(KEY_DIR, 'issued-licenses.json');
const DEVICES_FILE = path.join(KEY_DIR, 'devices.json');
const REVOKED_FILE = path.join(KEY_DIR, 'revoked.json');

/** custom — своё число дней через --days, а не один из готовых пресетов. */
type Duration = 'trial' | 'year' | 'forever' | 'custom';

/** Запись журнала: то же, что подписано, плюс куда лёг файл и пометка продавца. */
interface JournalEntry {
  licenseeName: string;
  machineId: string;
  issuedAt: string;
  /** null — бессрочная. */
  expiresAt: string | null;
  duration: Duration;
  /**
   * Уровень подписки. Необязательное поле — записи, восстановленные командой
   * import из лицензий до 18.09.2026 (когда уровней ещё не было), уровня не
   * знают; в таком случае и сама лицензия действует как max (см. license.ts).
   */
  plan?: LicensePlan;
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
const DURATION_DAYS: Record<'trial' | 'year', number> = { trial: 30, year: 365 };

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

/** Подпись срока для списка: у trial/year есть имя, у custom — считаем дни по факту (issuedAt→expiresAt). */
function durationLabel(entry: Pick<JournalEntry, 'duration' | 'issuedAt' | 'expiresAt'>): string {
  if (entry.duration === 'forever') return 'бессрочно';
  if (entry.duration === 'trial') return 'пробный (30 дн.)';
  if (entry.duration === 'year') return 'год';
  if (!entry.expiresAt) return 'свой срок';
  const days = Math.round((new Date(entry.expiresAt).getTime() - new Date(entry.issuedAt).getTime()) / DAY_MS);
  return `${days} дн.`;
}

/** Что открывает уровень — короткая подсказка рядом с ним в списке. */
function planLabel(plan: LicensePlan | undefined): string {
  if (plan === 'pro') return 'Pro — воспроизведение и расписание';
  if (plan === 'max') return 'Max — полный доступ';
  return 'max (выпущена до уровней подписки)';
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
    if (!argv[i]!.startsWith('--')) continue;
    const key = argv[i]!.slice(2);
    const next = argv[i + 1];
    // Флаг без значения (--renew): следующий аргумент — уже другой ключ или
    // конец строки. Раньше такой флаг СЪЕДАЛ следующий ключ как своё
    // значение, и «--renew --plan pro» молча терял план.
    if (next === undefined || next.startsWith('--')) {
      out[key] = '';
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function deviceLabel(machineId: string): string {
  const d = readDevices()[machineId];
  return d ? d.name : '(без имени — issue-license.ts rename)';
}

/**
 * Проверка подписи БЕЗ сверки с текущим компьютером — в отличие от
 * verifyLicenseFile в license.ts (та рассчитана на движок покупателя и всегда
 * сверяет machineId с СОБСТВЕННЫМ отпечатком). Здесь, на машине издателя, мы
 * импортируем чужую, уже выданную лицензию — сверять с этим компьютером
 * нечего, важно только что подпись настоящая (значит, файл действительно
 * выпущен ЭТИМ приватным ключом, а не подделан или испорчен).
 */
function verifySignatureOnly(file: LicenseFile): boolean {
  try {
    const publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
    return crypto.verify(null, canonicalPayload(file.payload), publicKey, Buffer.from(file.signature, 'base64'));
  } catch {
    return false;
  }
}

function issue(argv: string[]): void {
  const args = parseArgs(argv);
  const machineId = args.machine;
  const licenseeName = args.name;
  const plan = args.plan as LicensePlan;
  if (!machineId || !licenseeName) {
    console.error('Нужны --machine <id> --name "<имя>" --plan <pro|max> и --duration <trial|year|forever> ИЛИ --days <N>');
    process.exit(1);
  }
  if (plan !== 'pro' && plan !== 'max') {
    console.error('--plan должен быть "pro" (воспроизведение и расписание) или "max" (полный доступ)');
    process.exit(1);
  }
  // Срок — либо готовый пресет (--duration), либо своё число дней (--days).
  // Одновременно оба не даём: неясно, какой из них главный.
  if (args.duration && args.days) {
    console.error('Укажите либо --duration <trial|year|forever>, либо --days <N> — не оба сразу');
    process.exit(1);
  }
  let duration: Duration;
  let customDays: number | null = null;
  if (args.days) {
    customDays = Number(args.days);
    if (!Number.isInteger(customDays) || customDays <= 0) {
      console.error('--days должен быть целым числом дней больше нуля');
      process.exit(1);
    }
    duration = 'custom';
  } else {
    duration = args.duration as Duration;
    if (duration !== 'trial' && duration !== 'year' && duration !== 'forever') {
      console.error('--duration должен быть "trial" (30 дней), "year" или "forever" — либо используйте --days <N>');
      process.exit(1);
    }
  }
  if (!fs.existsSync(PRIVATE_KEY_FILE)) {
    console.error(`Нет приватного ключа (${PRIVATE_KEY_FILE}) — сначала: npx tsx src/tools/issue-license.ts keygen`);
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
  const days = duration === 'custom' ? customDays! : duration === 'forever' ? null : DURATION_DAYS[duration];
  /*
   * ПРОДЛЕНИЕ (--renew) считается от прежней даты окончания, а не от дня
   * оплаты: оплатил 17-го при сроке до 10-го — новый срок до 10-го
   * следующего месяца. Иначе платить с опозданием выгодно, и льготная
   * неделя превращается в бесплатную неделю каждый месяц.
   */
  let startFrom = issuedAt.getTime();
  if (args.renew !== undefined) {
    const prev = [...readJournal()]
      .filter((e) => e.machineId === machineId && e.expiresAt)
      .sort((a, b) => a.expiresAt!.localeCompare(b.expiresAt!))
      .pop();
    if (!prev) {
      console.log('Внимание: --renew, но в журнале нет прошлой срочной лицензии на этот компьютер —');
      console.log('считаю срок от сегодняшнего дня.\n');
    } else if (days === null) {
      console.log('Внимание: --renew с бессрочной лицензией смысла не имеет — прежняя дата не нужна.\n');
    } else {
      startFrom = new Date(prev.expiresAt!).getTime();
      console.log(`Продление от прежней даты окончания: ${formatDate(prev.expiresAt)} (а не от сегодня).\n`);
    }
  }
  const expiresAt = days === null ? null : new Date(startFrom + days * DAY_MS).toISOString();
  const payload: LicensePayload = {
    licenseeName,
    machineId,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
    plan,
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
    plan,
    file: path.resolve(out),
    ...(args.note ? { note: args.note } : {}),
  };
  appendJournal(entry);
  if (args.device) setDeviceName(machineId, args.device);
  console.log(`Лицензия выпущена: ${out}`);
  console.log(`  получатель: ${licenseeName}`);
  console.log(`  компьютер:  ${machineId}${args.device ? ` («${args.device}»)` : ''}`);
  console.log(`  уровень:    ${planLabel(plan)}`);
  console.log(`  срок:       ${durationLabel(entry)}`);
  console.log(`  выдана:     ${formatDate(payload.issuedAt)}`);
  console.log(`  действует:  ${expiresAt ? `до ${formatDate(expiresAt)}` : 'бессрочно'}`);
  if (args.note) console.log(`  пометка:    ${args.note}`);
  console.log(`  записано в журнал: ${JOURNAL_FILE}`);
}

/**
 * Восстановить запись в журнале по СОХРАНИВШЕМУСЯ файлу старой лицензии —
 * для тех, что выпущены до 16.09.2026, когда журнала ещё не было (см. шапку
 * файла). Ничего не подписывает и не меняет саму лицензию — только читает и
 * дописывает строку в issued-licenses.json, как будто issue сделал это сразу.
 */
function importLicense(argv: string[]): void {
  const [file, ...rest] = argv;
  const args = parseArgs(rest);
  if (!file) {
    console.error('Нужен путь к файлу лицензии: import <файл.json> [--device "<комп>"] [--note "<пометка>"]');
    process.exit(1);
  }
  let parsed: LicenseFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LicenseFile;
  } catch (err) {
    console.error(`Не удалось прочитать файл: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!parsed?.payload || typeof parsed.signature !== 'string') {
    console.error('Это не файл лицензии (нет payload/signature).');
    process.exit(1);
  }
  if (!verifySignatureOnly(parsed)) {
    console.error('Подпись не сходится с нашим публичным ключом — это не настоящая лицензия (или файл повреждён).');
    process.exit(1);
  }
  const already = readJournal().some(
    (e) => e.machineId === parsed.payload.machineId && e.issuedAt === parsed.payload.issuedAt,
  );
  if (already) {
    console.log('Эта лицензия уже есть в журнале — ничего не добавляю.');
    return;
  }
  // До 16.09.2026 duration в файле не хранился (его и сейчас там нет — это
  // поле только журнала). Различить старый trial/year по факту нечем, но
  // trial появился только 17.09.2026 — то есть все более ранние срочные
  // лицензии были годовыми, отсюда и вывод.
  const duration: Duration = parsed.payload.expiresAt === null ? 'forever' : 'year';
  // payload.plan у таких файлов нет (уровней ещё не было — сама лицензия
  // работает как max, см. license.ts). --plan здесь — только для ВАШЕЙ
  // памятки в списке, кто на самом деле каким планом пользовался; на то,
  // что реально откроет файл человеку, не влияет.
  const plan = parsed.payload.plan ?? (args.plan as LicensePlan | undefined);
  const entry: JournalEntry = {
    licenseeName: parsed.payload.licenseeName,
    machineId: parsed.payload.machineId,
    issuedAt: parsed.payload.issuedAt,
    expiresAt: parsed.payload.expiresAt,
    duration,
    ...(plan ? { plan } : {}),
    file: path.resolve(file),
    ...(args.note ? { note: args.note } : {}),
  };
  appendJournal(entry);
  if (args.device) setDeviceName(parsed.payload.machineId, args.device);
  console.log(`Восстановлено в журнале: «${entry.licenseeName}», компьютер ${entry.machineId}.`);
  console.log(`  выдана: ${formatDate(entry.issuedAt)}, действует: ${entry.expiresAt ? `до ${formatDate(entry.expiresAt)}` : 'бессрочно'}`);
  console.log('(срок определён по наличию expiresAt — trial появился позже этой лицензии, поэтому это не он)');
  if (!parsed.payload.plan) {
    console.log('(в самом файле уровня подписки нет — лицензия работает как max; --plan здесь только для вашей памятки)');
  }
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
      console.log(`  уровень:   ${planLabel(e.plan)}`);
      console.log(`  срок:      ${durationLabel(e)}`);
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
else if (cmd === 'import') importLicense(rest);
else if (cmd === 'revoke') revoke(rest);
else if (cmd === 'unrevoke') unrevoke(rest);
else if (cmd === 'export-revocations') exportRevocations(rest);
else {
  const P = 'npx tsx packages/engine/src/tools/issue-license.ts';
  console.log('Запускать из папки репозитория (cd C:\\fountain-studio), команда:\n');
  console.log(`  ${P} keygen`);
  console.log('    — один раз в жизни проекта: создать пару ключей.\n');
  console.log(`  ${P} issue --machine <id> --name "<имя>" --plan <pro|max> --duration <trial|year|forever> [--device "<комп>"] [--out <файл>] [--note "<пометка>"]`);
  console.log(`  ${P} issue --machine <id> --name "<имя>" --plan <pro|max> --days <N> [--device "<комп>"] [--out <файл>] [--note "<пометка>"]`);
  console.log('    — выпустить лицензию: файл в --out (или в текущей папке) и отдать покупателю. Срок — либо пресет, либо --days.\n');
  console.log(`  ${P} issue --renew --machine <id> --name "<имя>" --plan <pro|max> --days <N>`);
  console.log('    — ПРОДЛЕНИЕ: срок считается от прежней даты окончания, а не от дня оплаты.\n');
  console.log(`  ${P} list`);
  console.log('    — показать все выданные лицензии и все отозванные компьютеры (ничего не меняет).\n');
  console.log(`  ${P} rename --machine <id> --device "<имя>"`);
  console.log('    — назвать/переименовать компьютер, не переиздавая лицензию.\n');
  console.log(`  ${P} import <файл.json> [--device "<комп>"] [--note "<пометка>"]`);
  console.log('    — вписать в журнал лицензию, выпущенную до появления журнала (см. шапку файла).\n');
  console.log(`  ${P} revoke --machine <id> [--note "<причина>"]`);
  console.log('    — пометить компьютер отозванным у себя (само по себе ни на что не влияет).\n');
  console.log(`  ${P} unrevoke --machine <id>`);
  console.log('    — снять пометку «отозван».\n');
  console.log(`  ${P} export-revocations <файл>`);
  console.log('    — публичный список отозванных (только ID) — его выкладывать в интернет.');
  process.exit(1);
}
