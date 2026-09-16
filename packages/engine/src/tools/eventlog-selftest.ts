/**
 * Самопроверка журнала событий на диске (см. eventlog.ts).
 *
 * Проверяет то, ради чего он и заведён: события переживают перезапуск
 * программы, нумерация не начинается заново, битая строка не роняет чтение,
 * а файлы старше срока хранения убираются.
 *
 * Запуск: npm -w @fountain-studio/engine run eventlog-test
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventLog } from '../eventlog';

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passed++;
  else {
    failed++;
    console.error(`  ✖ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-eventlog-'));
const logs = path.join(dir, 'logs');

async function main(): Promise<void> {
  // ---- Первый «запуск»: пишем события -------------------------------------
  eventLog.attachFile(dir);
  check('папка журнала создана', fs.existsSync(logs));
  eventLog.log('расписание', 'запуск шоу по расписанию');
  eventLog.log('авария', 'узел Art-Net пропал', 'error');
  await eventLog.flush();

  const files = fs.readdirSync(logs);
  check('файл суток создан', files.length === 1 && /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(files[0]!), files.join(','));
  const text = fs.readFileSync(path.join(logs, files[0]!), 'utf8');
  check('записаны обе строки', text.trim().split('\n').length === 2, text);
  check('строка — читаемый JSON', (JSON.parse(text.trim().split('\n')[0]!) as { message: string }).message === 'запуск шоу по расписанию');

  // ---- «Перезапуск»: attachFile заново поднимает историю с диска ----------
  eventLog.attachFile(dir);
  const after = eventLog.list();
  check('после перезапуска события на месте', after.length === 2, String(after.length));
  check('порядок сохранён', after[0]?.message === 'запуск шоу по расписанию' && after[1]?.source === 'авария');
  check('уровень сохранён', after[1]?.level === 'error');

  // Нумерация продолжается, а не начинается с 1 — иначе в UI будут дубли id.
  const next = eventLog.log('проверка', 'после перезапуска');
  check('нумерация продолжена', next.id === (after[1]?.id ?? 0) + 1, `${next.id} vs ${after[1]?.id}`);
  await eventLog.flush();

  // ---- Битая строка (обрыв питания на записи) не ломает чтение ------------
  fs.appendFileSync(path.join(logs, files[0]!), '{это не JSON\n', 'utf8');
  eventLog.attachFile(dir);
  check('битая строка пропущена, остальное прочитано', eventLog.list().length === 3, String(eventLog.list().length));

  // ---- Старые файлы удаляются -------------------------------------------
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
  const oldName = `events-${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}.jsonl`;
  fs.writeFileSync(path.join(logs, oldName), '{"id":1,"tsMs":1,"source":"x","level":"info","message":"старое"}\n');
  eventLog.attachFile(dir);
  check('файл старше срока хранения удалён', !fs.existsSync(path.join(logs, oldName)));
  check('сегодняшний файл на месте', fs.existsSync(path.join(logs, files[0]!)));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`журнал: пройдено ${passed}, ошибок ${failed}`);
  process.exit(failed ? 1 : 0);
}

await main();
