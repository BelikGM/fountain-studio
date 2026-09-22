/**
 * Команды и кнопки из чата Telegram — разбор и решение, БЕЗ отправки.
 *
 * ── Почему отдельный файл и чистые функции ────────────────────────────────
 * Здесь живёт единственное место, где из сообщения в чате получается действие
 * на объекте: «остановить воспроизведение», «погасить», «тихий режим». Ошибка
 * тут стоит дорого — чужой человек глушит работающий фонтан. Поэтому разбор
 * сделан чистыми функциями без сети и без Engine: их можно прогнать
 * самопроверкой на сотне случаев, включая злонамеренные.
 *
 * ── Кто имеет право командовать ───────────────────────────────────────────
 * Только тот чат, который задан в настройках (`chatId`). Причина: у бота
 * может быть включён Guest Chat Mode, и тогда ему пишут из чужих чатов и
 * упоминанием — такое сообщение не должно ничего останавливать. Проверяем
 * именно ЧАТ, а не человека: чат владельца объекта — это и есть круг доверия,
 * а список людей пришлось бы вести руками и он расходился бы с реальностью.
 *
 * ── Почему опасные команды через подтверждение ────────────────────────────
 * «/stop» на телефоне в кармане — это остановленное шоу на объекте, где
 * стоят люди. Поэтому «стоп» и «погасить» не выполняются сразу: бот присылает
 * вопрос с кнопкой, и только нажатие кнопки останавливает. Безопасные
 * команды (состояние, отчёт) выполняются сразу — там нечего подтверждать.
 *
 * ── Почему команды и латиницей, и по-русски ───────────────────────────────
 * Telegram считает командой только `/латиница_и_цифры`: список в меню бота и
 * нажатие на команду работают лишь для них. Поэтому наружу (в меню) уходят
 * `/state`, `/report`, `/stop`, `/quiet`, `/help` с РУССКИМИ описаниями, а
 * разбор понимает и русские слова — их набирают руками, и отказывать в этом
 * глупо.
 */

import type { TelegramKind } from './telegramFormat';

/** Кнопка под сообщением. */
export interface TgButton {
  text: string;
  /** Что придёт обратно в callback_query.data (у Telegram предел 64 байта). */
  data: string;
}

/** Ряды кнопок — как их принимает Bot API (inline_keyboard). */
export type TgKeyboard = TgButton[][];

/** Что бот просит сделать на объекте. */
export type TelegramAction =
  | { type: 'state' }
  | { type: 'report' }
  | { type: 'stopAll' }
  | { type: 'blackout' }
  | { type: 'quiet'; hours: number };

/** Решение по одному обновлению: что отправить и что сделать. */
export type TgEffect =
  /** Отправить сообщение в тот же чат (и в ту же тему, если она была). */
  | { kind: 'reply'; tag: TelegramKind; html: string; keyboard?: TgKeyboard; topicId: number }
  /** Короткая всплывашка нажавшему кнопку — без неё Telegram крутит часики. */
  | { kind: 'toast'; callbackId: string; text: string }
  /** Заменить кнопки под сообщением (например, отметить аварию принятой). */
  | { kind: 'setButtons'; messageId: number; keyboard: TgKeyboard }
  /** Выполнить действие на объекте. */
  | { kind: 'do'; action: TelegramAction }
  /** Ничего не делаем; why — для журнала, наружу не уходит. */
  | { kind: 'skip'; why: string };

/** Обновление от Bot API — только те поля, которые нам нужны. */
export interface TgUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    message_thread_id?: number;
    chat?: { id?: number; type?: string };
    from?: { first_name?: string; last_name?: string; username?: string };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { first_name?: string; last_name?: string; username?: string };
    message?: {
      message_id?: number;
      message_thread_id?: number;
      chat?: { id?: number };
    };
  };
  my_chat_member?: { chat?: { id?: number; type?: string } };
}

export interface TgContext {
  /** Кому разрешено командовать. Пусто — никому: получатель ещё не определён. */
  chatId: string;
  /** Имя бота без «@» — чтобы понимать «/stop@Foutain_bot» в группе. */
  botName: string;
  /** Разрешены ли команды вообще (галочка в настройках). */
  commands: boolean;
  /** Сколько часов тишины сейчас осталось — для текста ответа; 0 — тишины нет. */
  quietHoursLeft: number;
}

/** Коды в callback_data. Короткие: у Telegram на них 64 байта. */
export const CB = {
  state: 'st',
  report: 'rp',
  stopAsk: 'sp',
  stopYes: 'sp!',
  blackAsk: 'bo',
  blackYes: 'bo!',
  quiet: 'qt', // qt:4 — тихо на 4 часа, qt:0 — снять
  ack: 'ack',
  /** Кнопка-отметка: нажимать её незачем, она просто показывает, кто принял. */
  noop: 'x',
} as const;

/** Клавиатура под сообщением «Восстановлено»/аварией: кто взял в работу. */
export function ackKeyboard(): TgKeyboard {
  return [[{ text: '✅ Принято', data: CB.ack }]];
}

/** Клавиатура-отметка вместо «Принято»: авария уже за кем-то. */
export function ackedKeyboard(who: string, atMs: number): TgKeyboard {
  const time = new Date(atMs).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  // Имя может быть любой длины, а подпись кнопки читают с телефона: вместе с
  // «✅ Принял» и временем всё должно влезать в одну строку, поэтому длинное
  // имя ужимаем. 20 символов — «Константин Петрович» влезает целиком.
  const name = who.length > 20 ? who.slice(0, 19) + '…' : who;
  return [[{ text: `✅ Принял ${name} в ${time}`, data: CB.noop }]];
}

/** Главная клавиатура: самое частое — одним нажатием, без набора команд. */
export function mainKeyboard(): TgKeyboard {
  return [
    [
      { text: '📊 Состояние', data: CB.state },
      { text: '📋 Отчёт', data: CB.report },
    ],
    [
      { text: '🔇 Тихо 4 ч', data: `${CB.quiet}:4` },
      { text: '🔔 Снять тишину', data: `${CB.quiet}:0` },
    ],
    [{ text: '⏹ Остановить', data: CB.stopAsk }],
  ];
}

/** Список команд для меню бота (setMyCommands) — только латиница, как требует Telegram. */
export function botCommands(): { command: string; description: string }[] {
  return [
    { command: 'state', description: 'Состояние объекта сейчас' },
    { command: 'report', description: 'Отчёт за сутки' },
    { command: 'quiet', description: 'Тихий режим: /quiet 4 — на 4 ч, /quiet 0 — снять' },
    { command: 'stop', description: 'Остановить воспроизведение (спросит подтверждение)' },
    { command: 'blackout', description: 'Blackout — погасить всё (спросит подтверждение)' },
    { command: 'help', description: 'Что умеет бот' },
  ];
}

/**
 * Разбор строки в команду: возвращает нормализованное имя и аргумент.
 *
 * Понимает «/state», «/state@Бот», «/состояние», лишние пробелы и любой
 * регистр. Не команда — null: в чат объекта пишут и обычные сообщения, и
 * отвечать на каждое бот не должен.
 */
export function parseCommand(text: string, botName = ''): { cmd: string; arg: string } | null {
  const t = text.trim();
  if (!t.startsWith('/')) return null;
  const sp = t.search(/\s/);
  let head = (sp < 0 ? t : t.slice(0, sp)).slice(1);
  const arg = sp < 0 ? '' : t.slice(sp + 1).trim();
  // «/stop@Foutain_bot» в группе: адресовано боту — отбрасываем хвост. Если
  // адресовано ДРУГОМУ боту, команда не наша и разбирать её нельзя.
  const at = head.indexOf('@');
  if (at >= 0) {
    const to = head.slice(at + 1).toLowerCase();
    head = head.slice(0, at);
    const me = botName.replace(/^@/, '').toLowerCase();
    if (me !== '' && to !== me) return null;
  }
  const key = head.toLowerCase().replace(/ё/g, 'е');
  const cmd = ALIASES[key];
  return { cmd: cmd ?? 'unknown', arg };
}

/**
 * Русские слова — рядом с латинскими. «ё» уже приведена к «е» выше, поэтому
 * «отчёт» и «отчет» попадают в один ключ.
 */
const ALIASES: Record<string, string> = {
  start: 'help',
  help: 'help',
  помощь: 'help',
  справка: 'help',
  state: 'state',
  status: 'state',
  состояние: 'state',
  статус: 'state',
  report: 'report',
  отчет: 'report',
  stop: 'stop',
  стоп: 'stop',
  остановить: 'stop',
  blackout: 'blackout',
  черное: 'blackout',
  погасить: 'blackout',
  quiet: 'quiet',
  тихо: 'quiet',
  тишина: 'quiet',
};

function fullName(f: { first_name?: string; last_name?: string; username?: string } | undefined): string {
  const name = [f?.first_name, f?.last_name].filter((s) => s && s.trim() !== '').join(' ').trim();
  if (name !== '') return name;
  if (f?.username) return '@' + f.username;
  return 'кто-то';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Текст «что умеет бот» — им же отвечаем на /start и на непонятную команду. */
export function helpText(site: string, quietHoursLeft: number): string {
  const quiet =
    quietHoursLeft > 0
      ? `\n\n🔇 Сейчас включён тихий режим, аварии молчат ещё ${quietHoursLeft} ${plural(quietHoursLeft, 'час', 'часа', 'часов')}.`
      : '';
  return (
    `🤖 <b>${esc(site)}</b> — бот объекта\n\n` +
    '<b>Смотреть:</b>\n' +
    '/state — что происходит сейчас\n' +
    '/report — отчёт за сутки\n\n' +
    '<b>Управлять:</b>\n' +
    '/stop — остановить воспроизведение\n' +
    '/blackout — погасить всё\n' +
    '<i>Обе спросят подтверждение кнопкой — случайно не сработают.</i>\n\n' +
    '<b>Тишина на время работ:</b>\n' +
    '/quiet 4 — аварии молчат 4 часа\n' +
    '/quiet 0 — снять тишину\n\n' +
    'Команды можно писать и по-русски: /состояние, /отчёт, /стоп, /тихо 4.' +
    quiet
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Вопрос перед опасным действием. */
function confirm(what: string, yes: string, data: string): { html: string; keyboard: TgKeyboard } {
  return {
    html: `⚠️ <b>${esc(what)}</b>\n\nНа объекте это видно сразу. Подтвердите кнопкой ниже — или просто не нажимайте, тогда ничего не случится.`,
    keyboard: [[{ text: yes, data }]],
  };
}

/**
 * Главный разбор: одно обновление → что делать.
 *
 * Возвращает список: одно нажатие кнопки почти всегда даёт и всплывашку
 * нажавшему, и действие, и ответ в чат — порядок в списке и есть порядок
 * выполнения.
 */
export function handleTelegramUpdate(u: TgUpdate, site: string, ctx: TgContext): TgEffect[] {
  if (u.callback_query) return handleCallback(u.callback_query, site, ctx);
  const m = u.message;
  if (!m) return [{ kind: 'skip', why: 'обновление не сообщение и не нажатие кнопки' }];
  const text = (m.text ?? '').trim();
  if (text === '') return [{ kind: 'skip', why: 'сообщение без текста' }];
  const chat = String(m.chat?.id ?? '');
  const topicId = m.message_thread_id ?? 0;

  // Права — до разбора команды: чужому чату не отвечаем вовсе, даже отказом.
  // Ответ «нельзя» подтвердил бы, что бот живой и чем-то управляет.
  if (ctx.chatId === '' || chat !== ctx.chatId) {
    return [{ kind: 'skip', why: `чужой чат ${chat || '?'} — команды принимаем только из ${ctx.chatId || 'не заданного'}` }];
  }
  const parsed = parseCommand(text, ctx.botName);
  if (!parsed) return [{ kind: 'skip', why: 'обычное сообщение, не команда' }];
  if (!ctx.commands) {
    return [
      {
        kind: 'reply',
        tag: 'state',
        html: '🚫 Команды из чата выключены в настройках программы («Настройки» → «Уведомления в Telegram»).',
        topicId,
      },
    ];
  }

  switch (parsed.cmd) {
    case 'help':
      return [{ kind: 'reply', tag: 'state', html: helpText(site, ctx.quietHoursLeft), keyboard: mainKeyboard(), topicId }];
    case 'state':
      return [{ kind: 'do', action: { type: 'state' } }];
    case 'report':
      return [{ kind: 'do', action: { type: 'report' } }];
    case 'stop': {
      const c = confirm('Остановить воспроизведение?', '⏹ Да, остановить', CB.stopYes);
      return [{ kind: 'reply', tag: 'state', html: c.html, keyboard: c.keyboard, topicId }];
    }
    case 'blackout': {
      const c = confirm('Погасить всё — воду и свет?', '⬛ Да, погасить', CB.blackYes);
      return [{ kind: 'reply', tag: 'state', html: c.html, keyboard: c.keyboard, topicId }];
    }
    case 'quiet':
      return quietEffects(parsed.arg, topicId);
    default:
      return [
        {
          kind: 'reply',
          tag: 'state',
          html: `Не понял команду. Вот что умею:\n\n${helpText(site, ctx.quietHoursLeft)}`,
          keyboard: mainKeyboard(),
          topicId,
        },
      ];
  }
}

/**
 * «/quiet 4» → тишина на 4 часа. Без аргумента спрашиваем кнопками, а не
 * молча включаем на своё усмотрение: 4 часа тишины — это четыре часа, когда
 * аварии не придут, и решать должен человек.
 */
function quietEffects(arg: string, topicId: number): TgEffect[] {
  if (arg === '') {
    return [
      {
        kind: 'reply',
        tag: 'state',
        html: '🔇 <b>Тихий режим</b>\n\nНа сколько замолчать? Аварии в это время не придут, но в журнал попадут как обычно. «Восстановлено» приходит всегда.',
        keyboard: [
          [
            { text: '1 ч', data: `${CB.quiet}:1` },
            { text: '4 ч', data: `${CB.quiet}:4` },
            { text: '8 ч', data: `${CB.quiet}:8` },
          ],
          [{ text: '🔔 Снять тишину', data: `${CB.quiet}:0` }],
        ],
        topicId,
      },
    ];
  }
  const n = Number(arg.replace(',', '.').split(/\s/)[0]);
  if (!Number.isFinite(n) || n < 0 || n > 24) {
    return [
      {
        kind: 'reply',
        tag: 'state',
        html: 'Сколько часов молчать? От 0 до 24: «/quiet 4» — на четыре часа, «/quiet 0» — снять тишину.',
        topicId,
      },
    ];
  }
  const hours = Math.round(n);
  return [
    { kind: 'do', action: { type: 'quiet', hours } },
    {
      kind: 'reply',
      tag: 'state',
      html:
        hours > 0
          ? `🔇 Тихий режим включён на ${hours} ${plural(hours, 'час', 'часа', 'часов')}. Аварии молчат, «Восстановлено» приходит. Когда тишина кончится — скажу, сколько аварий смолчали.`
          : '🔔 Тихий режим снят — аварии снова приходят сразу.',
      topicId,
    },
  ];
}

/** Нажатие кнопки под сообщением. */
function handleCallback(q: NonNullable<TgUpdate['callback_query']>, site: string, ctx: TgContext): TgEffect[] {
  const id = q.id ?? '';
  const chat = String(q.message?.chat?.id ?? '');
  const topicId = q.message?.message_thread_id ?? 0;
  const messageId = q.message?.message_id ?? 0;
  const who = fullName(q.from);
  if (ctx.chatId === '' || chat !== ctx.chatId) {
    return [{ kind: 'skip', why: `нажатие из чужого чата ${chat || '?'}` }];
  }
  if (!ctx.commands) {
    return [{ kind: 'toast', callbackId: id, text: 'Команды из чата выключены в настройках программы' }];
  }
  const data = q.data ?? '';
  const [head, tail] = data.split(':');

  switch (head) {
    case CB.noop:
      return [{ kind: 'toast', callbackId: id, text: 'Эта авария уже за кем-то' }];
    case CB.ack:
      // Кнопку заменяем отметкой — иначе непонятно, взял кто-то аварию или нет,
      // и двое поедут на объект одновременно.
      return [
        { kind: 'toast', callbackId: id, text: 'Записал: авария за вами' },
        { kind: 'setButtons', messageId, keyboard: ackedKeyboard(who, Date.now()) },
        { kind: 'reply', tag: 'alarm', html: `✅ <b>${esc(who)}</b> взял аварию в работу.`, topicId },
      ];
    case CB.state:
      return [
        { kind: 'toast', callbackId: id, text: 'Собираю состояние…' },
        { kind: 'do', action: { type: 'state' } },
      ];
    case CB.report:
      return [
        { kind: 'toast', callbackId: id, text: 'Собираю отчёт…' },
        { kind: 'do', action: { type: 'report' } },
      ];
    case CB.stopAsk: {
      const c = confirm('Остановить воспроизведение?', '⏹ Да, остановить', CB.stopYes);
      return [
        { kind: 'toast', callbackId: id, text: 'Нужно подтверждение' },
        { kind: 'reply', tag: 'state', html: c.html, keyboard: c.keyboard, topicId },
      ];
    }
    case CB.stopYes:
      return [
        { kind: 'toast', callbackId: id, text: 'Останавливаю' },
        { kind: 'do', action: { type: 'stopAll' } },
        { kind: 'setButtons', messageId, keyboard: [[{ text: `⏹ Остановил ${who}`, data: CB.noop }]] },
        { kind: 'reply', tag: 'state', html: `⏹ Воспроизведение остановлено — ${esc(who)} из Telegram.`, topicId },
      ];
    case CB.blackAsk: {
      const c = confirm('Погасить всё — воду и свет?', '⬛ Да, погасить', CB.blackYes);
      return [
        { kind: 'toast', callbackId: id, text: 'Нужно подтверждение' },
        { kind: 'reply', tag: 'state', html: c.html, keyboard: c.keyboard, topicId },
      ];
    }
    case CB.blackYes:
      return [
        { kind: 'toast', callbackId: id, text: 'Гашу' },
        { kind: 'do', action: { type: 'blackout' } },
        { kind: 'setButtons', messageId, keyboard: [[{ text: `⬛ Погасил ${who}`, data: CB.noop }]] },
        { kind: 'reply', tag: 'state', html: `⬛ Всё погашено — ${esc(who)} из Telegram.`, topicId },
      ];
    case CB.quiet: {
      const hours = Math.max(0, Math.min(24, Math.round(Number(tail ?? '0')) || 0));
      return [
        { kind: 'toast', callbackId: id, text: hours > 0 ? `Тишина на ${hours} ч` : 'Тишина снята' },
        { kind: 'do', action: { type: 'quiet', hours } },
        {
          kind: 'reply',
          tag: 'state',
          html:
            hours > 0
              ? `🔇 Тихий режим на ${hours} ${plural(hours, 'час', 'часа', 'часов')} — включил ${esc(who)}.`
              : `🔔 Тихий режим снят — ${esc(who)}.`,
          topicId,
        },
      ];
    }
    default:
      return [
        { kind: 'toast', callbackId: id, text: 'Кнопка от прежней версии программы' },
        { kind: 'reply', tag: 'state', html: helpText(site, ctx.quietHoursLeft), keyboard: mainKeyboard(), topicId },
      ];
  }
}
