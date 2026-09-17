/**
 * Самопроверка уведомлений: «✅ Восстановлено» и тихий режим — без сети.
 *
 * Токен подставляется фальшивый, отправка наружу не делается: проверяем ровно
 * то, что решает логика — что попадает в очередь сообщений, а что нет.
 *
 * Запуск: npm -w @fountain-studio/engine run telegram-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { namesForRdm, substituteRdmNames } from '@fountain-studio/shared';
import { eventLog } from '../eventlog';
import { TelegramNotifier } from '../telegram';
import { formatQuietOver, formatRecovery } from '../telegramFormat';
import type { SiteSnapshot } from '../telegramFormat';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-telegram-'));
const projectFile = path.join(dir, 'fountain.project.json');
fs.writeFileSync(projectFile, '{}');

const snapshot = (): SiteSnapshot =>
  ({
    site: 'Тестовый объект',
    atMs: Date.now(),
    playing: null,
    nextAt: null,
    universes: 1,
    nodes: [],
    rdmLost: [],
    pumps: [],
    windMs: null,
    backupAgeMin: null,
  }) as unknown as SiteSnapshot;

const tg = new TelegramNotifier(
  { secretsFile: path.join(dir, 'secrets.json'), queueFile: path.join(dir, 'telegram-queue.json') },
  () => 'Тестовый объект',
  snapshot,
);
// Фальшивый токен: нужен только чтобы подписка на журнал включилась.
tg.setConfig({ token: 'test:token', chatId: '1', enabled: true, alarms: true });

/** Очередь приватная — читаем через файл, который нотификатор сам пишет рядом. */
function queued(): { kind: string; html: string }[] {
  const f = path.join(dir, 'telegram-queue.json');
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, 'utf8')) as { kind: string; html: string }[];
}

// ---- Формат сообщений ------------------------------------------------------
{
  const r = formatRecovery('Саки Пруд', { source: 'net', message: 'Нода «N1» снова на связи', tsMs: Date.now() });
  check('«Восстановлено»: заголовок', r.includes('✅') && r.includes('Восстановлено'), r.slice(0, 60));
  check('«Восстановлено»: объект и текст', r.includes('Саки Пруд') && r.includes('снова на связи'));
  check('«Восстановлено»: без «что проверить»', !r.includes('Что проверить'));
  const q = formatQuietOver('Саки Пруд', 3);
  check('конец тишины: сколько смолчали', q.includes('3'), q.slice(0, 80));
  check('конец тишины: без аварий — другой текст', formatQuietOver('X', 0).includes('не было'));
}

// ---- Имена приборов вместо голых UID ---------------------------------------
{
  const names = namesForRdm([
    { id: 'd1', name: 'Прожектор левый борт 3', profileId: 'p', universe: 1, address: 10, rdmUid: '4950:00001234' },
  ]);
  const text = substituteRdmNames('RDM-прибор 4950:00001234 ПРОПАЛ С ЛИНИИ (вселенная 1)', names);
  check('UID заменён на имя прибора', text.includes('Прожектор левый борт 3 (4950:00001234)'), text);
  check('непривязанный UID остаётся как есть', substituteRdmNames('RDM-прибор 4950:0000ffff ПРОПАЛ', names).includes('4950:0000ffff'));
  check('без привязок текст не меняется', substituteRdmNames('RDM-прибор 4950:00001234 ПРОПАЛ', new Map()) === 'RDM-прибор 4950:00001234 ПРОПАЛ');
}

// ---- Поведение -------------------------------------------------------------
const before = queued().length;
eventLog.log('net', 'Нода «N1» (10.0.0.5) ПОТЕРЯНА — нет ответа 12 с', 'warn');
const afterAlarm = queued();
check('обычная авария попадает в очередь', afterAlarm.length === before + 1, `${afterAlarm.length}`);

eventLog.log('net', 'Нода «N1» (10.0.0.5) снова на связи', 'info', 'recovery');
const afterBack = queued();
check('возврат в строй попадает в очередь', afterBack.length === afterAlarm.length + 1);
check('и это именно «Восстановлено»', (afterBack.at(-1)?.html ?? '').includes('Восстановлено'), afterBack.at(-1)?.html?.slice(0, 60));

// Обычное info по-прежнему не шлётся.
const beforeInfo = queued().length;
eventLog.log('schedule', '20:00 → playShow (Вечернее шоу)');
check('обычные info в Telegram не уходят', queued().length === beforeInfo);

// Тихий режим глушит аварии, но не «Восстановлено».
tg.setQuiet(1);
check('тихий режим виден в статусе', tg.status().quietUntilMs > Date.now());
const beforeQuiet = queued().length;
eventLog.log('modbus', 'насос «P1»: код аварии 12', 'error');
check('в тихом режиме авария не уходит', queued().length === beforeQuiet);
eventLog.log('modbus', 'насос «P1»: авария снята (было 12)', 'info', 'recovery');
check('в тихом режиме «Восстановлено» уходит', queued().length === beforeQuiet + 1);

tg.setQuiet(0);
check('тихий режим снимается', tg.status().quietUntilMs === 0);
const beforeAfterQuiet = queued().length;
eventLog.log('modbus', 'насос «P2»: код аварии 7', 'error');
check('после снятия аварии снова уходят', queued().length === beforeAfterQuiet + 1);

tg.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`telegram: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
