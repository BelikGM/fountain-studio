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
import {
  ackKeyboard,
  ackedKeyboard,
  botCommands,
  handleTelegramUpdate,
  mainKeyboard,
  parseCommand,
  type TgEffect,
  type TgUpdate,
} from '../telegramCommands';
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
  const text = substituteRdmNames('RDM-прибор 4950:00001234 ПРОПАЛ (вселенная 1)', names);
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

// ---- Команды и кнопки из чата ----------------------------------------------
/**
 * Это единственная дорога СНАРУЖИ ВНУТРЬ: из чата можно остановить фонтан.
 * Поэтому проверяем не только «работает», но и «не срабатывает лишнего»:
 * чужой чат, команда без подтверждения, кнопка от прежней версии.
 */
{
  const OUR = '5504685140';
  const ctx = { chatId: OUR, botName: '@Foutain_bot', commands: true, quietHoursLeft: 0 };
  const site = 'Саки Пруд';

  // — разбор строки —
  const p = (t: string, bot = '@Foutain_bot'): string => parseCommand(t, bot)?.cmd ?? 'НЕ_КОМАНДА';
  check('разбор: /state', p('/state') === 'state');
  check('разбор: регистр не важен', p('/STATE') === 'state' && p('/State') === 'state');
  check('разбор: по-русски', p('/состояние') === 'state' && p('/статус') === 'state');
  check('разбор: «ё» и «е» — одно и то же', p('/отчёт') === 'report' && p('/отчет') === 'report');
  check('разбор: адресовано нашему боту', p('/stop@Foutain_bot') === 'stop');
  check('разбор: адресовано ЧУЖОМУ боту — не наше дело', p('/stop@OtherBot') === 'НЕ_КОМАНДА');
  check('разбор: без имени бота в настройках берём любое', p('/stop@Whoever', '') === 'stop');
  check('разбор: обычный текст — не команда', p('привет') === 'НЕ_КОМАНДА' && p('state') === 'НЕ_КОМАНДА');
  check('разбор: пустая строка — не команда', p('') === 'НЕ_КОМАНДА' && p('   ') === 'НЕ_КОМАНДА');
  check('разбор: незнакомая команда помечена', p('/чтототакое') === 'unknown');
  check('разбор: пробелы по краям не мешают', p('   /state   ') === 'state');
  check('разбор: аргумент отделён', parseCommand('/quiet 4', '')?.arg === '4');
  check('разбор: аргумент с табуляцией', parseCommand('/quiet\t8', '')?.arg === '8');
  check('разбор: аргумент из нескольких слов целиком', parseCommand('/quiet 4 часа', '')?.arg === '4 часа');

  // — вспомогательное —
  const msg = (text: string, chat = OUR, topic = 0): TgUpdate => ({
    update_id: 1,
    message: { message_id: 10, text, message_thread_id: topic, chat: { id: Number(chat), type: 'private' }, from: { first_name: 'Георгий' } },
  });
  const cb = (data: string, chat = OUR): TgUpdate => ({
    update_id: 2,
    callback_query: { id: 'q1', data, from: { first_name: 'Георгий', last_name: 'Б' }, message: { message_id: 77, chat: { id: Number(chat) } } },
  });
  const effects = (u: TgUpdate, c = ctx): TgEffect[] => handleTelegramUpdate(u, site, c);
  const kinds = (u: TgUpdate, c = ctx): string[] => effects(u, c).map((e) => e.kind);
  const actions = (u: TgUpdate, c = ctx): string[] =>
    effects(u, c).flatMap((e) => (e.kind === 'do' ? [e.action.type] : []));
  const replies = (u: TgUpdate, c = ctx): string[] =>
    effects(u, c).flatMap((e) => (e.kind === 'reply' ? [e.html] : []));

  // — права —
  check('чужой чат: команда пропущена молча', kinds(msg('/stop', '999')).join() === 'skip');
  check('чужой чат: даже отказа не отправляем', replies(msg('/stop', '999')).length === 0);
  check('чужой чат: нажатие кнопки пропущено', kinds(cb('sp!', '999')).join() === 'skip');
  check(
    'получатель не задан — не слушаемся никого',
    kinds(msg('/stop', OUR), { ...ctx, chatId: '' }).join() === 'skip',
  );
  check('команды выключены: отвечаем, но не выполняем', (() => {
    const e = effects(msg('/stop'), { ...ctx, commands: false });
    return e.length === 1 && e[0]!.kind === 'reply' && (e[0] as { html: string }).html.includes('выключены');
  })());
  check(
    'команды выключены: кнопка только всплывашкой',
    kinds(cb('sp!'), { ...ctx, commands: false }).join() === 'toast',
  );

  // — безопасные команды выполняются сразу —
  check('/state → сводка состояния', actions(msg('/state')).join() === 'state');
  check('/report → отчёт', actions(msg('/report')).join() === 'report');
  check('/состояние → то же самое', actions(msg('/состояние')).join() === 'state');
  check('/help → текст со всеми командами', (() => {
    const h = replies(msg('/help'))[0] ?? '';
    return ['/state', '/report', '/stop', '/blackout', '/quiet'].every((c) => h.includes(c));
  })());
  check('/start отвечает тем же, что /help', replies(msg('/start'))[0] === replies(msg('/help'))[0]);
  check('/help даёт клавиатуру', effects(msg('/help')).some((e) => e.kind === 'reply' && e.keyboard !== undefined));
  check('непонятная команда: подсказка, а не молчание', replies(msg('/абракадабра')).length === 1);
  check('непонятная команда ничего не делает', actions(msg('/абракадабра')).length === 0);

  // — опасные команды НЕ выполняются без подтверждения (главная проверка) —
  check('/stop сам по себе ничего не останавливает', actions(msg('/stop')).length === 0);
  check('/stop спрашивает подтверждение кнопкой', (() => {
    const e = effects(msg('/stop')).find((x) => x.kind === 'reply');
    return e?.kind === 'reply' && (e.keyboard?.[0]?.[0]?.data ?? '') === 'sp!';
  })());
  check('/blackout сам по себе ничего не гасит', actions(msg('/blackout')).length === 0);
  check('/blackout спрашивает подтверждение', (() => {
    const e = effects(msg('/blackout')).find((x) => x.kind === 'reply');
    return e?.kind === 'reply' && (e.keyboard?.[0]?.[0]?.data ?? '') === 'bo!';
  })());
  check('кнопка «стоп» без «!» тоже только спрашивает', actions(cb('sp')).length === 0);
  check('подтверждённый стоп останавливает', actions(cb('sp!')).join() === 'stopAll');
  check('подтверждённое гашение гасит', actions(cb('bo!')).join() === 'blackout');
  check('подтверждённый стоп отмечает, КТО остановил', (() => {
    const e = effects(cb('sp!')).find((x) => x.kind === 'setButtons');
    return e?.kind === 'setButtons' && (e.keyboard[0]?.[0]?.text ?? '').includes('Георгий');
  })());
  check('подтверждённый стоп пишет в чат, кто это сделал', (replies(cb('sp!'))[0] ?? '').includes('Георгий'));

  // — тихий режим —
  check('/quiet 4 → тишина на 4 ч', (() => {
    const a = effects(msg('/quiet 4')).find((e) => e.kind === 'do');
    return a?.kind === 'do' && a.action.type === 'quiet' && a.action.hours === 4;
  })());
  check('/тихо 8 по-русски', (() => {
    const a = effects(msg('/тихо 8')).find((e) => e.kind === 'do');
    return a?.kind === 'do' && a.action.type === 'quiet' && a.action.hours === 8;
  })());
  check('/quiet 0 → снять тишину', (() => {
    const a = effects(msg('/quiet 0')).find((e) => e.kind === 'do');
    return a?.kind === 'do' && a.action.type === 'quiet' && a.action.hours === 0;
  })());
  check('/quiet без числа спрашивает кнопками, а не решает сам', (() => {
    const e = effects(msg('/quiet'));
    return e.every((x) => x.kind !== 'do') && e.some((x) => x.kind === 'reply' && (x.keyboard?.length ?? 0) > 0);
  })());
  check('/quiet 25 — вне диапазона, объясняем', (() => {
    const e = effects(msg('/quiet 25'));
    return e.every((x) => x.kind !== 'do') && (replies(msg('/quiet 25'))[0] ?? '').includes('От 0 до 24');
  })());
  check('/quiet -1 не включает тишину', effects(msg('/quiet -1')).every((x) => x.kind !== 'do'));
  check('/quiet abc не включает тишину', effects(msg('/quiet abc')).every((x) => x.kind !== 'do'));
  check('/quiet 4,5 — запятая как разделитель дробной части', (() => {
    const a = effects(msg('/quiet 4,5')).find((e) => e.kind === 'do');
    return a?.kind === 'do' && a.action.type === 'quiet' && a.action.hours === 5;
  })());
  check('кнопка «Тихо 4 ч» из клавиатуры', (() => {
    const a = effects(cb('qt:4')).find((e) => e.kind === 'do');
    return a?.kind === 'do' && a.action.type === 'quiet' && a.action.hours === 4;
  })());

  // — «Принято» под аварией —
  check('«Принято»: всплывашка, отметка на кнопке и строка в чат', kinds(cb('ack')).join() === 'toast,setButtons,reply');
  check('«Принято»: в отметке видно, кто взял', (() => {
    const e = effects(cb('ack')).find((x) => x.kind === 'setButtons');
    return e?.kind === 'setButtons' && (e.keyboard[0]?.[0]?.text ?? '').includes('Георгий Б');
  })());
  check('«Принято»: отметка нажимается впустую, а не повторно', (() => {
    const e = effects(cb('ack')).find((x) => x.kind === 'setButtons');
    return e?.kind === 'setButtons' && e.keyboard[0]?.[0]?.data === 'x';
  })());
  check('нажатие отметки ничего не делает', actions(cb('x')).length === 0);
  check('длинное имя в отметке не разрывает кнопку', (() => {
    const k = ackedKeyboard('Александр Константинопольский-Задунайский', Date.now());
    return (k[0]?.[0]?.text ?? '').length <= 40;
  })());
  check('«Принято» без имени и ника — «кто-то», а не пустота', (() => {
    const u: TgUpdate = { callback_query: { id: 'q', data: 'ack', message: { message_id: 1, chat: { id: Number(OUR) } } } };
    const e = handleTelegramUpdate(u, site, ctx).find((x) => x.kind === 'setButtons');
    return e?.kind === 'setButtons' && (e.keyboard[0]?.[0]?.text ?? '').includes('кто-то');
  })());

  // — кнопка от прежней версии программы —
  check('незнакомая кнопка: всплывашка и подсказка', kinds(cb('чтототакое')).join() === 'toast,reply');
  check('незнакомая кнопка ничего не выполняет', actions(cb('чтототакое')).length === 0);

  // — тема, где спросили —
  check('ответ идёт в ту же тему', (() => {
    const e = effects(msg('/help', OUR, 42)).find((x) => x.kind === 'reply');
    return e?.kind === 'reply' && e.topicId === 42;
  })());

  // — обновления, которые нас не касаются —
  check('обновление без сообщения пропущено', kinds({ update_id: 5 }).join() === 'skip');
  check('сообщение без текста пропущено', kinds({ message: { chat: { id: Number(OUR) } } }).join() === 'skip');

  // — общий запрет: ни одно СООБЩЕНИЕ не останавливает фонтан —
  const dangerous = ['stopAll', 'blackout'];
  const everyText = ['/stop', '/blackout', '/стоп', '/погасить', '/stop@Foutain_bot', 'стоп', '/stop 1', '/STOP'];
  check(
    'ни одна текстовая команда не глушит фонтан без кнопки',
    everyText.every((t) => actions(msg(t)).every((a) => !dangerous.includes(a))),
    everyText.find((t) => actions(msg(t)).some((a) => dangerous.includes(a))),
  );
  check(
    'ни одно обновление из чужого чата не даёт действий',
    ['/stop', '/blackout', '/quiet 4', '/state'].every((t) => actions(msg(t, '111')).length === 0) &&
      ['sp!', 'bo!', 'qt:4', 'ack'].every((d) => actions(cb(d, '111')).length === 0),
  );

  // — меню команд у бота —
  const menu = botCommands();
  check('меню команд: только латиница и цифры', menu.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command)), menu.map((c) => c.command).join());
  check('меню команд: описания непустые и в пределах Telegram', menu.every((c) => c.description.length > 0 && c.description.length <= 256));
  check('меню команд: есть всё главное', ['state', 'report', 'stop', 'blackout', 'quiet', 'help'].every((c) => menu.some((m) => m.command === c)));
  check(
    'клавиатуры: callback_data влезает в 64 байта',
    [...mainKeyboard(), ...ackKeyboard()].every((row) => row.every((b) => Buffer.byteLength(b.data, 'utf8') <= 64)),
  );
  check('подписи кнопок не пустые', mainKeyboard().every((row) => row.every((b) => b.text.trim() !== '')));
}

// ---- Кнопка «Принято» прикрепляется к авариям -------------------------------
{
  const beforeAck = queued().length;
  eventLog.log('modbus', 'насос «P9»: код аварии 3', 'error');
  const last = queued().at(-1) as { keyboard?: { text: string; data: string }[][] } | undefined;
  check('авария уехала с кнопкой «Принято»', (last?.keyboard?.[0]?.[0]?.data ?? '') === 'ack', JSON.stringify(last?.keyboard));
  check('очередь выросла на одну', queued().length === beforeAck + 1);

  // Команды выключены — кнопке неоткуда сработать, значит её и не ставим:
  // иначе нажатие крутило бы часики и выглядело сломанным.
  tg.setConfig({ commands: false });
  eventLog.log('modbus', 'насос «P10»: код аварии 4', 'error');
  const noBtn = queued().at(-1) as { keyboard?: unknown } | undefined;
  check('с выключенными командами кнопки нет', noBtn?.keyboard === undefined);
  tg.setConfig({ commands: true });
}

tg.stop();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`telegram: пройдено ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
