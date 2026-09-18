/**
 * Самопроверка лицензии: подпись/срок (license.ts) и отзыв по сети
 * (licenseRevocation.ts).
 *
 * Отзыв — единственная часть лицензии, которая трогает сеть, поэтому тест
 * поднимает свой локальный HTTP-сервер и проверяет оба берега: движок должен
 * подхватить список, когда сервер отвечает, и не должен падать или сбрасывать
 * уже известный список, когда сервер недоступен или отвечает мусором —
 * отсутствие интернета на объекте не должно выглядеть как отзыв лицензии.
 *
 * Запуск: npm -w @fountain-studio/engine run license-test
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accessFor, canonicalPayload, loadLicenseStatus, machineFingerprint, verifyLicenseFile } from '../license';
import { isMachineRevoked, refreshRevocationList, revocationCacheInfo } from '../licenseRevocation';
import crypto from 'node:crypto';
import { EXPIRY_WARNING_DAYS, daysUntilExpiry, type LicenseFile, type LicensePayload } from '@fountain-studio/shared';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-license-'));

// Свой ключ — тестовая подпись должна быть настоящей, но проверяем публичным
// ключом ИЗ license.ts, который заранее не переопределить, поэтому эти
// сценарии считают signature-часть уже проверенной server-side (см. ниже
// verifyLicenseFile использует зашитый в license.ts публичный ключ). Тут же
// генерируем СВОЮ пару, чтобы проверить именно механику verifyLicenseFile
// на заведомо неправильной подписи — она обязана провалиться.
const { privateKey: otherPrivate } = crypto.generateKeyPairSync('ed25519');

const machineId = machineFingerprint();

function makeLicense(payload: Partial<LicensePayload>, signWith: crypto.KeyObject | 'garbage'): LicenseFile {
  const full: LicensePayload = {
    licenseeName: 'Тестовый покупатель',
    machineId,
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    ...payload,
  };
  const signature =
    signWith === 'garbage' ? Buffer.from('не подпись').toString('base64') : crypto.sign(null, canonicalPayload(full), signWith).toString('base64');
  return { payload: full, signature };
}

// ---- Проверка подписи и срока (без сети) -----------------------------------
{
  // Подписанный ЧУЖИМ ключом файл не должен пройти проверку публичным ключом
  // приложения — иначе кто угодно мог бы подписать себе лицензию.
  const foreign = makeLicense({}, otherPrivate);
  check('лицензия с чужой подписью не проходит проверку', !verifyLicenseFile(foreign).valid);

  const garbage = makeLicense({}, 'garbage');
  check('мусор вместо подписи не проходит проверку', !verifyLicenseFile(garbage).valid);

  const wrongMachine = makeLicense({ machineId: 'не-этот-компьютер' }, otherPrivate);
  check('чужой machineId тоже проваливает проверку (двойная защита)', !verifyLicenseFile(wrongMachine).valid);
}

// ---- loadLicenseStatus без файла лицензии ----------------------------------
{
  const noLicenseDir = path.join(tmp, 'no-license');
  fs.mkdirSync(noLicenseDir, { recursive: true });
  const status = loadLicenseStatus(noLicenseDir);
  check('без файла лицензии — licensed:false', status.licensed === false);
  check('причина понятная', status.reason === 'Лицензия не активирована', status.reason);
  check('machineId посчитан', typeof status.machineId === 'string' && status.machineId.length > 0);
  check('без лицензии доступ — none (совсем новая установка)', status.access === 'none', status.access);
  check('без лицензии уровень — null', status.plan === null);
}

// ---- Отказ из-за чужой подписи/битого файла — всегда access none -----------
{
  const wrongSig = path.join(tmp, 'wrong-signature-plan');
  fs.mkdirSync(wrongSig, { recursive: true });
  fs.writeFileSync(
    path.join(wrongSig, 'fountain.license.json'),
    JSON.stringify(makeLicense({ plan: 'pro' }, otherPrivate), null, 2),
  );
  const s1 = loadLicenseStatus(wrongSig);
  check('чужая подпись — access none, а не pro/max', s1.access === 'none', s1.access);
  check('чужая подпись — plan null', s1.plan === null);
}

/*
 * Уровни подписки и понижение при истечении/отзыве — это ЧИСТАЯ функция
 * accessFor(check, plan) в license.ts, вынесенная отдельно как раз ради
 * этого: настоящую подпись вендора (private.pem) самопроверке заводить
 * незачем и нельзя, а вот саму логику «что открыть по результату проверки»
 * проверить нужно на всех сочетаниях.
 */
{
  const valid = { valid: true } as const;
  const expired = { valid: false, expired: true, reason: 'истекла' } as const;
  const invalid = { valid: false, reason: 'подпись не сходится' } as const;

  check('валидна + план pro → доступ pro', accessFor(valid, 'pro') === 'pro');
  check('валидна + план max → доступ max', accessFor(valid, 'max') === 'max');
  check('валидна + плана нет (старая лицензия) → доступ max (грандфазеринг)', accessFor(valid, null) === 'max');
  check('истекла (была pro) → падает до pro (и так floor)', accessFor(expired, 'pro') === 'pro');
  check('истекла (была MAX) → падает до pro, а не остаётся max', accessFor(expired, 'max') === 'pro');
  check('истекла старая (плана не было) → тоже до pro, не до max', accessFor(expired, null) === 'pro');
  check('подпись не сошлась → доступ none, даже если план был указан', accessFor(invalid, 'max') === 'none');
}

// ---- Предупреждение «скоро закончится» ------------------------------------
{
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const inDays = (d: number): string => new Date(now + d * DAY).toISOString();

  check('бессрочная — предупреждать не о чем', daysUntilExpiry(null, now) === null);
  check('осталось 10 дней — так и считаем', daysUntilExpiry(inDays(10), now) === 10);
  check('последний день — 0, а не «уже истекла»', daysUntilExpiry(inDays(0.5), now) === 0);
  check('истекла позавчера — отрицательное число', daysUntilExpiry(inDays(-2), now) === -2);
  check('битая дата не роняет счёт', daysUntilExpiry('не дата', now) === null);
  check(
    'порог предупреждения — две недели, и он меньше месячного срока продавца',
    EXPIRY_WARNING_DAYS === 14 && EXPIRY_WARNING_DAYS < 30,
  );
}

// ---- Отзыв понижает access до none — строже, чем истечение срока ----------
await withServer(
  (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ revoked: [machineId] }));
  },
  async (url) => {
    const dir = path.join(tmp, 'revoked-access');
    fs.mkdirSync(dir, { recursive: true });
    await refreshRevocationList(dir, url);
    const status = loadLicenseStatus(dir);
    check('отозванный компьютер — access none (не pro)', status.access === 'none', status.access);
    check('причина явно «отозвана», не «не активирована»', status.reason === 'Лицензия отозвана', status.reason);
  },
);

// ---- Отзыв: без revocationUrl ничего не проверяем --------------------------
{
  const dir = path.join(tmp, 'no-revocation-configured');
  fs.mkdirSync(dir, { recursive: true });
  check('без кэша отзыва isMachineRevoked — false (не отозван)', !isMachineRevoked(dir, machineId));
  check('без кэша revocationCacheInfo — пусто', revocationCacheInfo(dir).checkedAt === null);
}

// ---- Отзыв: живой сервер отдаёт список -------------------------------------
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, fn: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}/revoked.json`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await withServer(
  (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ revoked: [machineId, 'какой-то-другой-комп'] }));
  },
  async (url) => {
    const dir = path.join(tmp, 'revoked-live');
    fs.mkdirSync(dir, { recursive: true });
    const r = await refreshRevocationList(dir, url);
    check('обновление списка с живого сервера — успех', r.ok, r.error);
    check('этот компьютер отмечен отозванным', isMachineRevoked(dir, machineId));
    check('чужой ID в кэше тоже есть', isMachineRevoked(dir, 'какой-то-другой-комп'));
    check('время проверки записано', revocationCacheInfo(dir).checkedAt !== null);

    // И главное — loadLicenseStatus должен увидеть отзыв, даже если файл
    // лицензии сам по себе настоящий (в этом тесте его просто нет).
    const status = loadLicenseStatus(dir);
    check('loadLicenseStatus видит отзыв', status.licensed === false && status.reason === 'Лицензия отозвана', status.reason);
  },
);

// ---- Отзыв: сервер недоступен — используем старый кэш, не падаем ----------
{
  const dir = path.join(tmp, 'revoked-offline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'revoked-cache.json'),
    JSON.stringify({ revoked: [machineId], fetchedAt: new Date().toISOString() }),
  );
  // Порт, на котором заведомо никто не слушает.
  const r = await refreshRevocationList(dir, 'http://127.0.0.1:1/revoked.json');
  check('недоступный сервер — refreshRevocationList не бросает исключение, а отвечает ok:false', r.ok === false);
  check('старый кэш НЕ стёрт — компьютер остаётся отозванным по прежним данным', isMachineRevoked(dir, machineId));
}

// ---- Отзыв: сервер отвечает мусором — тоже не роняем и не портим кэш ------
await withServer(
  (_req, res) => {
    res.end('это не json');
  },
  async (url) => {
    const dir = path.join(tmp, 'revoked-garbage');
    fs.mkdirSync(dir, { recursive: true });
    const r = await refreshRevocationList(dir, url);
    check('мусор в ответе — ok:false, без исключения', r.ok === false);
    check('кэш не создан из мусора', !isMachineRevoked(dir, machineId));
  },
);

/*
 * Отзыв: хостинг «висит» и вообще не отвечает — самый реальный случай на
 * практике (сервер перегружен, DNS не резолвится и подвисает, спутниковый
 * канал). AbortController должен оборвать ожидание сам, а не заставить
 * движок ждать вечно. Таймаут в коде — 8 с, здесь укорачиваем его на время
 * теста монки-патчем через переменную окружения не делаем (не хотим менять
 * рабочий код ради теста) — просто ждём столько же, сколько ждал бы движок.
 */
await withServer(
  () => {
    /* нарочно ничего не отвечаем и не закрываем соединение — хостинг «висит» */
  },
  async (url) => {
    const dir = path.join(tmp, 'revoked-hanging');
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = Date.now();
    const r = await refreshRevocationList(dir, url);
    const tookMs = Date.now() - startedAt;
    check('зависший сервер — не исключение, а ok:false', r.ok === false, r.error);
    check('оборвано таймаутом, а не провисело минуты (< 15 с)', tookMs < 15_000, `${tookMs} мс`);
    check('кэш не создан из зависшего запроса', !isMachineRevoked(dir, machineId));
  },
);

// ---- Отзыв: сервер отвечает НЕ-массивом в поле revoked ---------------------
await withServer(
  (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ revoked: 'ABC123' }));
  },
  async (url) => {
    const dir = path.join(tmp, 'revoked-bad-shape');
    fs.mkdirSync(dir, { recursive: true });
    const r = await refreshRevocationList(dir, url);
    check('revoked не массивом — отклонено как неверный формат', r.ok === false);
  },
);

// ---- Снятие отзыва (переиздание публичного списка без этого ID) ----------
await withServer(
  (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ revoked: [] }));
  },
  async (url) => {
    const dir = path.join(tmp, 'un-revoked');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'revoked-cache.json'),
      JSON.stringify({ revoked: [machineId], fetchedAt: new Date().toISOString() }),
    );
    check('до обновления — отозван (старый кэш)', isMachineRevoked(dir, machineId));
    const r = await refreshRevocationList(dir, url);
    check('обновление прошло', r.ok);
    check('после публикации пустого списка — отзыв снят', !isMachineRevoked(dir, machineId));
  },
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`лицензия: пройдено ${passed}, ошибок ${failed}`);
/*
 * Без принудительного process.exit(): fetch (undici) держит сокеты с
 * keep-alive, и резкое завершение процесса гонится с их закрытием —
 * на Windows это иногда роняет процесс нативным assert в libuv уже ПОСЛЕ
 * того, как результат напечатан. exitCode позволяет циклу событий
 * доработать штатно и процессу закрыться самому.
 */
process.exitCode = failed ? 1 : 0;
